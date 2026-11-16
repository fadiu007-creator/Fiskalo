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

alter table public.fiskalo_basic_sales
  add column if not exists stock_reconciliation_required boolean not null default false;

-- Respect a pre-reserved daily number on offline sale sync. Online checkout leaves
-- daily_number null and continues to use this same atomic counter.
create or replace function fiskalo_private.fiskalo_basic_assign_daily_number()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.daily_number is not null then return new; end if;
  insert into fiskalo_private.fiskalo_basic_daily_counters(pos_id,business_date,last_number)
  values (new.pos_id,current_date,1)
  on conflict (pos_id,business_date)
  do update set last_number=fiskalo_private.fiskalo_basic_daily_counters.last_number+1
  returning last_number into new.daily_number;
  return new;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_assign_daily_number() from public,anon,authenticated;
alter function fiskalo_private.fiskalo_basic_assign_daily_number() set timezone to 'Europe/Belgrade';

create or replace function fiskalo_private.fiskalo_basic_sync_offline_sale(
  p_business_id uuid,p_pos_id uuid,p_payment_method text,p_lines jsonb,
  p_checkout_idempotency_key uuid,p_coupon_id bigint,p_daily_number bigint,p_business_date date,
  p_operator_id uuid,p_operator_name text,p_operator_identifier text,p_expected_snapshot jsonb,
  p_created_at timestamptz
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_sale_id uuid:=gen_random_uuid();
  v_sale public.fiskalo_basic_sales%rowtype;
  v_reservation public.fiskalo_basic_coupon_reservations%rowtype;
  v_daily_claim public.fiskalo_basic_daily_number_consumptions%rowtype;
  v_expected_count integer;
  v_line record;
  v_total_net numeric(12,2):=0;
  v_total_vat numeric(12,2):=0;
  v_total_gross numeric(12,2):=0;
  v_stock_ok boolean:=true;
  v_normalized_lines jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_checkout_idempotency_key is null or p_coupon_id is null or p_coupon_id<=0 or
     p_daily_number is null or p_daily_number<=0 or p_business_date is null or p_created_at is null then
    raise exception 'Offline checkout identity is incomplete';
  end if;
  if p_payment_method not in ('cash','card','bank_transfer') then raise exception 'Unsupported payment method'; end if;
  if p_operator_id is null or char_length(trim(coalesce(p_operator_name,'')))<2 or
     char_length(trim(coalesce(p_operator_identifier,'')))<1 then
    raise exception 'Original operator identity is required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 or
     p_expected_snapshot is null or jsonb_typeof(p_expected_snapshot)<>'array' or jsonb_array_length(p_expected_snapshot)=0 then
    raise exception 'Offline checkout line snapshot is required';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()) then raise exception 'Not a member of this business'; end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=p_operator_id) then raise exception 'Original operator is no longer a member of this business'; end if;
  if not exists(select 1 from public.fiskalo_basic_pos p where p.id=p_pos_id and p.business_id=p_business_id) then
    raise exception 'POS does not belong to this business';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text||':'||p_checkout_idempotency_key::text,0)
  );
  select * into v_sale from public.fiskalo_basic_sales s
    where s.business_id=p_business_id and s.checkout_idempotency_key=p_checkout_idempotency_key for update;
  if found then
    if v_sale.pos_id<>p_pos_id or v_sale.coupon_id<>p_coupon_id or
       v_sale.daily_number<>p_daily_number or v_sale.payment_method<>p_payment_method then
      raise exception 'Offline checkout key already exists with different fiscal identity';
    end if;
    if exists(
      select 1 from jsonb_to_recordset(p_expected_snapshot) as x(
        product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
        atk_unit_code text,atk_item_category_code text,atk_vat_code text,
        line_net numeric,line_vat numeric,line_total numeric
      )
      left join public.fiskalo_basic_sale_items i on i.sale_id=v_sale.id and i.product_id=x.product_id
      where i.id is null or i.quantity is distinct from x.quantity or i.description is distinct from x.description or
        i.unit_price is distinct from x.unit_price or i.vat_rate is distinct from x.vat_rate or
        i.atk_unit_code is distinct from x.atk_unit_code or i.atk_item_category_code is distinct from x.atk_item_category_code or
        i.atk_vat_code is distinct from x.atk_vat_code or i.line_net is distinct from x.line_net or
        i.line_vat is distinct from x.line_vat or i.line_total is distinct from x.line_total
    ) then raise exception 'Offline checkout key was retried with different immutable line data'; end if;
    return v_sale.id;
  end if;

  select * into v_reservation from public.fiskalo_basic_coupon_reservations r
    where r.business_id=p_business_id and r.pos_id=p_pos_id and r.coupon_id=p_coupon_id for update;
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
    where d.business_id=p_business_id and d.checkout_idempotency_key=p_checkout_idempotency_key for update;
  if found then
    if v_daily_claim.pos_id<>p_pos_id or v_daily_claim.business_date<>p_business_date or
       v_daily_claim.daily_number<>p_daily_number then raise exception 'Checkout key already consumed a different daily number'; end if;
  elsif exists(select 1 from public.fiskalo_basic_daily_number_consumptions d
    where d.pos_id=p_pos_id and d.business_date=p_business_date and d.daily_number=p_daily_number) then
    raise exception 'Daily number has already been consumed';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('product_id',x.product_id,'quantity',x.quantity) order by x.product_id),'[]'::jsonb)
    into v_normalized_lines
  from (select q.product_id,sum(q.quantity)::numeric(12,3) quantity
    from jsonb_to_recordset(p_lines) as q(product_id uuid,quantity numeric)
    group by q.product_id) x;

  select count(*) into v_expected_count from jsonb_to_recordset(p_expected_snapshot) as x(
    product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
    atk_unit_code text,atk_item_category_code text,atk_vat_code text,
    line_net numeric,line_vat numeric,line_total numeric
  );
  if v_expected_count<>jsonb_array_length(v_normalized_lines) then raise exception 'Offline snapshot and checkout request line counts differ'; end if;

  for v_line in select x.* from jsonb_to_recordset(p_expected_snapshot) as x(
    product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
    atk_unit_code text,atk_item_category_code text,atk_vat_code text,
    line_net numeric,line_vat numeric,line_total numeric
  ) order by x.product_id
  loop
    if v_line.product_id is null or v_line.quantity<=0 or v_line.unit_price<0 or
       v_line.vat_rate not in (0,8,18) or v_line.atk_unit_code is null or
       v_line.atk_item_category_code is null or v_line.atk_vat_code !~ '^[A-Z]$' or
       v_line.line_net<>round(v_line.unit_price*v_line.quantity,2) or
       v_line.line_vat<>round(v_line.line_net*v_line.vat_rate/100,2) or
       v_line.line_total<>v_line.line_net+v_line.line_vat then
      raise exception 'Offline line snapshot has invalid prices, VAT or ATK mapping';
    end if;
    if not exists(select 1 from public.fiskalo_basic_products p
      where p.id=v_line.product_id and p.business_id=p_business_id for update) then
      raise exception 'Offline sale references a product that does not belong to this business';
    end if;
    v_total_net:=v_total_net+v_line.line_net;
    v_total_vat:=v_total_vat+v_line.line_vat;
    v_total_gross:=v_total_gross+v_line.line_total;
  end loop;
  if v_total_gross<>v_total_net+v_total_vat then raise exception 'Offline sale totals do not reconcile'; end if;

  -- Inventory is reconciled atomically when all products still have sufficient
  -- stock. Otherwise the fiscal sale is still preserved with an explicit stock
  -- reconciliation flag; no partial stock deduction is made.
  if exists(
    select 1 from jsonb_to_recordset(v_normalized_lines) as q(product_id uuid,quantity numeric)
    join public.fiskalo_basic_products p on p.id=q.product_id and p.business_id=p_business_id
    where p.stock<q.quantity
  ) then v_stock_ok:=false; end if;

  insert into public.fiskalo_basic_sales(
    id,business_id,pos_id,coupon_id,operator_id,status,subtotal,vat_total,total,payment_method,
    created_at,daily_number,checkout_idempotency_key,checkout_request_lines,
    operator_name,operator_identifier,stock_reconciliation_required
  ) values(
    v_sale_id,p_business_id,p_pos_id,p_coupon_id,p_operator_id,'paid',
    v_total_net,v_total_vat,v_total_gross,p_payment_method,p_created_at,p_daily_number,
    p_checkout_idempotency_key,v_normalized_lines,trim(p_operator_name),trim(p_operator_identifier),not v_stock_ok
  );

  insert into public.fiskalo_basic_sale_items(
    sale_id,product_id,description,quantity,unit_price,vat_rate,
    atk_unit_code,atk_item_category_code,atk_vat_code,line_net,line_vat,line_total
  )
  select v_sale_id,x.product_id,x.description,x.quantity,x.unit_price,x.vat_rate,
    x.atk_unit_code,x.atk_item_category_code,x.atk_vat_code,x.line_net,x.line_vat,x.line_total
  from jsonb_to_recordset(p_expected_snapshot) as x(
    product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
    atk_unit_code text,atk_item_category_code text,atk_vat_code text,
    line_net numeric,line_vat numeric,line_total numeric
  );

  if v_stock_ok then
    update public.fiskalo_basic_products p set stock=p.stock-q.quantity
    from jsonb_to_recordset(v_normalized_lines) as q(product_id uuid,quantity numeric)
    where p.id=q.product_id and p.business_id=p_business_id;
  end if;

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
revoke all on function fiskalo_private.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_sync_offline_sale(
  p_business_id uuid,p_pos_id uuid,p_payment_method text,p_lines jsonb,
  p_checkout_idempotency_key uuid,p_coupon_id bigint,p_daily_number bigint,p_business_date date,
  p_operator_id uuid,p_operator_name text,p_operator_identifier text,p_expected_snapshot jsonb,p_created_at timestamptz
) returns uuid language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select fiskalo_private.fiskalo_basic_sync_offline_sale(
    p_business_id,p_pos_id,p_payment_method,p_lines,p_checkout_idempotency_key,p_coupon_id,
    p_daily_number,p_business_date,p_operator_id,p_operator_name,p_operator_identifier,p_expected_snapshot,p_created_at
  )
$$;
revoke all on function public.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz) to authenticated;
