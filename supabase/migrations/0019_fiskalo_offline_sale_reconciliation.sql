-- Reconcile an already-issued offline fiscal coupon into the cloud sale ledger
-- without changing its reserved business-wide CouponId or per-POS daily number.
create table if not exists public.fiskalo_basic_daily_number_consumptions (
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete restrict,
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  business_date date not null,
  daily_number bigint not null check (daily_number > 0),
  checkout_idempotency_key uuid not null,
  consumed_at timestamptz not null default now(),
  primary key (pos_id,business_date,daily_number),
  unique (business_id,checkout_idempotency_key)
);
alter table public.fiskalo_basic_daily_number_consumptions enable row level security;
create policy fiskalo_basic_daily_number_consumptions_read
  on public.fiskalo_basic_daily_number_consumptions for select to authenticated
  using (exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=fiskalo_basic_daily_number_consumptions.business_id and m.user_id=auth.uid()));
revoke all on public.fiskalo_basic_daily_number_consumptions from anon,authenticated;
grant select on public.fiskalo_basic_daily_number_consumptions to authenticated;

-- Allow a POS owner to reserve daily sequence capacity up to seven days ahead,
-- so a planned outage spanning midnight does not require online allocation.
create or replace function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(
  p_business_id uuid,p_pos_id uuid,p_business_date date,p_count integer
) returns table(first_number bigint,last_number bigint)
language plpgsql security definer set search_path='' as $$
declare v_first bigint; v_last bigint; v_today date;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_count is null or p_count<1 or p_count>500 then raise exception 'Reservation count must be between 1 and 500'; end if;
  v_today:=(now() at time zone 'Europe/Belgrade')::date;
  if p_business_date is null or p_business_date<v_today or p_business_date>v_today+7 then
    raise exception 'Daily numbers may only be reserved for today through seven days ahead in Kosovo time';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid() and m.role='owner') then
    raise exception 'Business owner access required';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_id and p.business_id=p_business_id
      and p.certificate_status in ('verified','certificate_issued')) then
    raise exception 'POS does not belong to this business or has no verified certificate';
  end if;
  insert into fiskalo_private.fiskalo_basic_daily_counters(pos_id,business_date,last_number)
    values(p_pos_id,p_business_date,p_count)
  on conflict(pos_id,business_date) do update
    set last_number=fiskalo_private.fiskalo_basic_daily_counters.last_number+p_count
  returning last_number-p_count+1,last_number into v_first,v_last;
  insert into public.fiskalo_basic_daily_number_reservations(
    business_id,pos_id,business_date,first_number,last_number
  ) values(p_business_id,p_pos_id,p_business_date,v_first,v_last);
  return query select v_first,v_last;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer) from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer) to authenticated;

create or replace function public.fiskalo_basic_reserve_offline_daily_numbers(
  p_business_id uuid,p_pos_id uuid,p_business_date date,p_count integer
) returns table(first_number bigint,last_number bigint)
language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select * from fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(p_business_id,p_pos_id,p_business_date,p_count)
$$;
revoke all on function public.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer) from public,anon;
grant execute on function public.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_sync_offline_sale(
  p_business_id uuid,p_pos_id uuid,p_payment_method text,p_lines jsonb,
  p_checkout_idempotency_key uuid,p_coupon_id bigint,p_daily_number bigint,p_business_date date,
  p_operator_id uuid,p_operator_name text,p_operator_identifier text,p_expected_snapshot jsonb
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_sale_id uuid;
  v_sale public.fiskalo_basic_sales%rowtype;
  v_reservation public.fiskalo_basic_coupon_reservations%rowtype;
  v_daily_claim public.fiskalo_basic_daily_number_consumptions%rowtype;
  v_expected_count integer;
  v_actual_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_checkout_idempotency_key is null or p_coupon_id is null or p_coupon_id<=0 or
     p_daily_number is null or p_daily_number<=0 or p_business_date is null then
    raise exception 'Offline checkout identity is incomplete';
  end if;
  if p_operator_id is null or char_length(trim(coalesce(p_operator_name,'')))<2 or
     char_length(trim(coalesce(p_operator_identifier,'')))<1 then
    raise exception 'Original operator identity is required';
  end if;
  if p_expected_snapshot is null or jsonb_typeof(p_expected_snapshot)<>'array' or jsonb_array_length(p_expected_snapshot)=0 then
    raise exception 'Immutable offline line snapshot is required';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()) then
    raise exception 'Not a member of this business';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=p_operator_id) then
    raise exception 'Original operator is no longer a member of this business';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_id and p.business_id=p_business_id) then
    raise exception 'POS does not belong to this business';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text||':'||p_checkout_idempotency_key::text,0)
  );
  select * into v_sale from public.fiskalo_basic_sales s
    where s.business_id=p_business_id and s.checkout_idempotency_key=p_checkout_idempotency_key
    for update;
  if found then
    if v_sale.pos_id<>p_pos_id or v_sale.coupon_id<>p_coupon_id or
       v_sale.daily_number<>p_daily_number or v_sale.payment_method<>p_payment_method then
      raise exception 'Offline checkout key already exists with different fiscal identity';
    end if;
    return v_sale.id;
  end if;

  select * into v_reservation from public.fiskalo_basic_coupon_reservations r
    where r.business_id=p_business_id and r.pos_id=p_pos_id and r.coupon_id=p_coupon_id
    for update;
  if not found then raise exception 'CouponId was not reserved for this business POS'; end if;
  if v_reservation.state<>'reserved' and
     v_reservation.consumed_idempotency_key is distinct from p_checkout_idempotency_key then
    raise exception 'Reserved CouponId has already been consumed by another checkout';
  end if;
  if not exists(select 1 from public.fiskalo_basic_daily_number_reservations r
    where r.business_id=p_business_id and r.pos_id=p_pos_id and r.business_date=p_business_date
      and p_daily_number between r.first_number and r.last_number) then
    raise exception 'Daily number was not reserved for this POS and business date';
  end if;
  select * into v_daily_claim from public.fiskalo_basic_daily_number_consumptions d
    where d.business_id=p_business_id and d.checkout_idempotency_key=p_checkout_idempotency_key
    for update;
  if found and (v_daily_claim.pos_id<>p_pos_id or v_daily_claim.business_date<>p_business_date or
                v_daily_claim.daily_number<>p_daily_number) then
    raise exception 'Checkout key already consumed a different daily number';
  end if;
  if not found and exists(select 1 from public.fiskalo_basic_daily_number_consumptions d
    where d.pos_id=p_pos_id and d.business_date=p_business_date and d.daily_number=p_daily_number) then
    raise exception 'Daily number has already been consumed';
  end if;

  -- Reuse the existing atomic stock/price calculation, then restore the original
  -- reserved identities. Any product/price/tax change is detected below and rolls
  -- the entire transaction back rather than silently rewriting the issued coupon.
  v_sale_id:=fiskalo_private.fiskalo_basic_create_sale(
    p_business_id,p_pos_id,p_payment_method,p_lines,p_checkout_idempotency_key
  );
  select * into v_sale from public.fiskalo_basic_sales where id=v_sale_id for update;
  select count(*) into v_expected_count from jsonb_to_recordset(p_expected_snapshot) as x(
    product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
    atk_unit_code text,atk_item_category_code text,atk_vat_code text,
    line_net numeric,line_vat numeric,line_total numeric
  );
  select count(*) into v_actual_count from public.fiskalo_basic_sale_items i where i.sale_id=v_sale_id;
  if v_expected_count<>v_actual_count or exists(
    select 1 from jsonb_to_recordset(p_expected_snapshot) as x(
      product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
      atk_unit_code text,atk_item_category_code text,atk_vat_code text,
      line_net numeric,line_vat numeric,line_total numeric
    )
    left join public.fiskalo_basic_sale_items i
      on i.sale_id=v_sale_id and i.product_id=x.product_id
    where i.id is null or i.quantity is distinct from x.quantity or
      i.description is distinct from x.description or i.unit_price is distinct from x.unit_price or
      i.vat_rate is distinct from x.vat_rate or i.atk_unit_code is distinct from x.atk_unit_code or
      i.atk_item_category_code is distinct from x.atk_item_category_code or i.atk_vat_code is distinct from x.atk_vat_code or
      i.line_net is distinct from x.line_net or i.line_vat is distinct from x.line_vat or i.line_total is distinct from x.line_total
  ) then
    raise exception 'Offline sale snapshot differs from current product/stock records; manual stock and catalog reconciliation is required';
  end if;

  update public.fiskalo_basic_sales set
    coupon_id=p_coupon_id,daily_number=p_daily_number,operator_id=p_operator_id,
    operator_name=trim(p_operator_name),operator_identifier=trim(p_operator_identifier)
  where id=v_sale_id and business_id=p_business_id;
  update public.fiskalo_basic_coupon_reservations set
    state='consumed',consumed_idempotency_key=p_checkout_idempotency_key,consumed_at=coalesce(consumed_at,now())
  where id=v_reservation.id and state='reserved';
  insert into public.fiskalo_basic_daily_number_consumptions(
    business_id,pos_id,business_date,daily_number,checkout_idempotency_key
  ) values(p_business_id,p_pos_id,p_business_date,p_daily_number,p_checkout_idempotency_key)
  on conflict (business_id,checkout_idempotency_key) do nothing;
  return v_sale_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb) to authenticated;

create or replace function public.fiskalo_basic_sync_offline_sale(
  p_business_id uuid,p_pos_id uuid,p_payment_method text,p_lines jsonb,
  p_checkout_idempotency_key uuid,p_coupon_id bigint,p_daily_number bigint,p_business_date date,
  p_operator_id uuid,p_operator_name text,p_operator_identifier text,p_expected_snapshot jsonb
) returns uuid language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select fiskalo_private.fiskalo_basic_sync_offline_sale(
    p_business_id,p_pos_id,p_payment_method,p_lines,p_checkout_idempotency_key,p_coupon_id,
    p_daily_number,p_business_date,p_operator_id,p_operator_name,p_operator_identifier,p_expected_snapshot
  )
$$;
revoke all on function public.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb) to authenticated;
