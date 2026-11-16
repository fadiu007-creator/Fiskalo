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
drop policy if exists fiskalo_basic_daily_number_consumptions_read on public.fiskalo_basic_daily_number_consumptions;
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
  add column if not exists stock_reconciliation_required boolean not null default false,
  add column if not exists payment_allocations jsonb;

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
  v_product public.fiskalo_basic_products%rowtype;
  v_total_net numeric(12,2):=0;
  v_total_vat numeric(12,2):=0;
  v_total_gross numeric(12,2):=0;
  v_stock_ok boolean:=true;
  v_normalized_lines jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_checkout_idempotency_key is null or p_coupon_id is null or p_coupon_id<=0 or
     p_daily_number is null or p_daily_number<=0 or p_business_date is null or p_created_at is null or
     (p_created_at at time zone 'Europe/Belgrade')::date<>p_business_date or p_created_at>now()+interval '5 minutes' then
    raise exception 'Offline checkout identity is incomplete';
  end if;
  if p_payment_method is null or p_payment_method not in ('cash','card','bank_transfer') then raise exception 'Unsupported payment method'; end if;
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
       v_sale.daily_number<>p_daily_number or v_sale.payment_method<>p_payment_method or
       v_sale.operator_id<>p_operator_id or v_sale.operator_name<>trim(p_operator_name) or
       v_sale.operator_identifier<>trim(p_operator_identifier) or v_sale.created_at<>p_created_at then
      raise exception 'Offline checkout key already exists with different fiscal identity';
    end if;
    if v_sale.payment_allocations is null then
      update public.fiskalo_basic_sales set payment_allocations=jsonb_build_array(
        jsonb_build_object('method',p_payment_method,'amount_cents',round(v_sale.total*100)::bigint)
      ) where id=v_sale.id;
    elsif v_sale.payment_allocations is distinct from jsonb_build_array(
      jsonb_build_object('method',p_payment_method,'amount_cents',round(v_sale.total*100)::bigint)
    ) then
      raise exception 'Offline checkout key was retried with different payment allocations';
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
  if v_expected_count<>jsonb_array_length(v_normalized_lines) or exists(
    select 1 from jsonb_to_recordset(v_normalized_lines) as q(product_id uuid,quantity numeric)
    full join jsonb_to_recordset(p_expected_snapshot) as x(
      product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
      atk_unit_code text,atk_item_category_code text,atk_vat_code text,
      line_net numeric,line_vat numeric,line_total numeric
    ) using(product_id)
    where q.product_id is null or x.product_id is null or q.quantity is distinct from x.quantity
  ) then raise exception 'Offline snapshot and checkout request line identities differ'; end if;

  for v_line in select x.* from jsonb_to_recordset(p_expected_snapshot) as x(
    product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
    atk_unit_code text,atk_item_category_code text,atk_vat_code text,
    line_net numeric,line_vat numeric,line_total numeric
  ) order by x.product_id
  loop
    if v_line.product_id is null or v_line.quantity is null or v_line.quantity<=0 or v_line.unit_price is null or v_line.unit_price<0 or
       v_line.vat_rate is null or v_line.vat_rate not in (0,8,18) or
       coalesce(trim(v_line.description),'')='' or char_length(v_line.description)>256 or
       coalesce(trim(v_line.atk_unit_code),'')='' or char_length(v_line.atk_unit_code)>16 or
       coalesce(trim(v_line.atk_item_category_code),'')='' or char_length(v_line.atk_item_category_code)>32 or
       v_line.atk_vat_code is null or v_line.atk_vat_code !~ '^[A-Z]$' or
       v_line.line_net is null or v_line.line_vat is null or v_line.line_total is null or
       v_line.line_net<>round(v_line.unit_price*v_line.quantity,2) or
       v_line.line_vat<>round(v_line.line_net*v_line.vat_rate/100,2) or
       v_line.line_total<>v_line.line_net+v_line.line_vat then
      raise exception 'Offline line snapshot has invalid prices, VAT or ATK mapping';
    end if;
    select * into v_product from public.fiskalo_basic_products p
      where p.id=v_line.product_id and p.business_id=p_business_id for update;
    if not found then raise exception 'Offline sale references a product that does not belong to this business'; end if;
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
    id,business_id,pos_id,coupon_id,operator_id,status,subtotal,vat_total,total,payment_method,payment_allocations,
    created_at,daily_number,checkout_idempotency_key,checkout_request_lines,
    operator_name,operator_identifier,stock_reconciliation_required
  ) values(
    v_sale_id,p_business_id,p_pos_id,p_coupon_id,p_operator_id,'paid',
    v_total_net,v_total_vat,v_total_gross,p_payment_method,
    jsonb_build_array(jsonb_build_object('method',p_payment_method,'amount_cents',round(v_total_gross*100)::bigint)),
    p_created_at,p_daily_number,p_checkout_idempotency_key,v_normalized_lines,
    trim(p_operator_name),trim(p_operator_identifier),not v_stock_ok
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


-- Trusted ATK TEST certificate registry and accepted-receipt server writer.
-- These objects were already present in the connected Supabase project; keeping
-- their baseline here makes a fresh database reproducible from repository SQL.
alter table public.fiskalo_basic_fiscal_documents
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error text,
  add column if not exists recovery_deadline_at timestamptz,
  add column if not exists offline_issued_at timestamptz;

create index if not exists fiskalo_basic_fiscal_documents_delivery_idx
  on public.fiskalo_basic_fiscal_documents(submission_state,next_attempt_at)
  where submission_state in ('queued','submitting');

create table if not exists public.fiskalo_basic_pos_certificates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete cascade,
  application_id bigint not null check (application_id>0),
  certificate_pem text not null check (length(certificate_pem) between 64 and 16384),
  spki_sha256 text not null check (spki_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active','superseded','revoked')),
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status='active' and revoked_at is null) or status<>'active')
);
create unique index if not exists fiskalo_basic_one_active_certificate_per_pos
  on public.fiskalo_basic_pos_certificates(pos_id) where status='active';
create index if not exists fiskalo_basic_pos_certificates_lookup_idx
  on public.fiskalo_basic_pos_certificates(business_id,pos_id,application_id,issued_at desc);
alter table public.fiskalo_basic_pos_certificates enable row level security;
revoke all on public.fiskalo_basic_pos_certificates from public,anon,authenticated;
grant select,insert,update,delete on public.fiskalo_basic_pos_certificates to service_role;

create or replace function public.fiskalo_basic_server_record_atk_receipt(
  p_actor_id uuid,p_business_id uuid,p_sale_id uuid,p_pos_record_id uuid,p_coupon_id bigint,
  p_idempotency_key text,p_signed_payload text,p_signature text,p_atk_transaction_id numeric,
  p_atk_response jsonb,p_nui_kf text,p_citizen_payload text,p_citizen_signature text,
  p_daily_number bigint,p_offline_issued_at timestamptz,p_qr_svg_base64 text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_sale public.fiskalo_basic_sales%rowtype;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
  v_id uuid;
begin
  if p_actor_id is null or p_business_id is null or p_sale_id is null or p_pos_record_id is null then
    raise exception 'Authenticated actor, business, sale and POS are required';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=p_actor_id) then
    raise exception 'Actor is not a member of this business';
  end if;
  select s.* into v_sale
  from public.fiskalo_basic_sales s
  join public.fiskalo_basic_pos p on p.id=s.pos_id and p.business_id=s.business_id
  where s.id=p_sale_id and s.business_id=p_business_id
    and s.pos_id=p_pos_record_id and s.coupon_id=p_coupon_id;
  if not found or v_sale.status not in ('paid','fiscalized') then
    raise exception 'Sale, POS and coupon identity do not match';
  end if;
  if p_atk_transaction_id is null or p_atk_transaction_id<=0
     or p_atk_transaction_id>18446744073709551615 then
    raise exception 'A valid ATK uint64 transaction_id is required';
  end if;
  if p_atk_response is null
     or coalesce(p_atk_response->>'status','')<>'accepted'
     or coalesce(p_atk_response->>'transactionId','')<>p_atk_transaction_id::text
     or coalesce(p_atk_response->>'environment','')<>'ATK TEST' then
    raise exception 'Trusted ATK TEST response does not match the transaction ID';
  end if;
  if coalesce(p_idempotency_key,'')='' or coalesce(p_signed_payload,'')=''
     or coalesce(p_signature,'')='' or coalesce(p_citizen_payload,'')=''
     or coalesce(p_citizen_signature,'')='' then
    raise exception 'Signed POS and CitizenCoupon payloads are required';
  end if;
  if coalesce(p_nui_kf,'') !~ '^[A-Z0-9]{16}$'
     or p_daily_number is null or p_daily_number<=0 then
    raise exception 'NUIKF or daily coupon number is invalid';
  end if;
  if p_qr_svg_base64 is null or length(p_qr_svg_base64)>1500000 then
    raise exception 'A valid persisted CitizenCoupon QR SVG is required';
  end if;

  select * into v_existing from public.fiskalo_basic_fiscal_documents d
    where d.idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.business_id<>p_business_id or v_existing.sale_id<>p_sale_id
       or v_existing.coupon_id<>p_coupon_id or v_existing.document_type<>1
       or v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature
       or v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload
       or v_existing.citizen_signature<>p_citizen_signature
       or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal document data';
    end if;
    if v_existing.submission_state='accepted'
       and v_existing.atk_transaction_id<>p_atk_transaction_id then
      raise exception 'Accepted fiscal document cannot be assigned a different ATK transaction';
    end if;
    update public.fiskalo_basic_fiscal_documents
      set atk_transaction_id=p_atk_transaction_id,
          submission_state='accepted',atk_response=p_atk_response,
          qr_svg_base64=p_qr_svg_base64,
          offline_issued_at=coalesce(offline_issued_at,p_offline_issued_at),
          recovery_deadline_at=coalesce(recovery_deadline_at,
            case when p_offline_issued_at is null then null else p_offline_issued_at+interval '48 hours' end)
      where id=v_existing.id returning id into v_id;
  else
    insert into public.fiskalo_basic_fiscal_documents(
      business_id,sale_id,coupon_id,idempotency_key,document_type,
      signed_payload,signature,atk_transaction_id,submission_state,atk_response,
      nui_kf,citizen_payload,citizen_signature,daily_number,qr_svg_base64,
      offline_issued_at,recovery_deadline_at
    ) values(
      p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,
      p_signed_payload,p_signature,p_atk_transaction_id,'accepted',p_atk_response,
      p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_qr_svg_base64,
      p_offline_issued_at,
      case when p_offline_issued_at is null then null else p_offline_issued_at+interval '48 hours' end
    ) returning id into v_id;
  end if;
  update public.fiskalo_basic_sales set status='fiscalized'
    where id=p_sale_id and business_id=p_business_id and status='paid';
  return v_id;
end;
$$;
revoke all on function public.fiskalo_basic_server_record_atk_receipt(
  uuid,uuid,uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz,text
) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_record_atk_receipt(
  uuid,uuid,uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz,text
) to service_role;

create or replace function public.fiskalo_basic_server_register_pos_certificate_v1(
  p_business_id uuid,p_pos_record_id uuid,p_application_id bigint,
  p_certificate_pem text,p_spki_sha256 text,p_verified_business_name text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare certificate_id uuid:=gen_random_uuid();
begin
  if p_business_id is null or p_pos_record_id is null or p_application_id is null or p_application_id<=0 or
     coalesce(p_certificate_pem,'') !~ '-----BEGIN CERTIFICATE-----' or length(p_certificate_pem)>16384 or
     coalesce(p_spki_sha256,'') !~ '^[a-f0-9]{64}$' or
     length(trim(coalesce(p_verified_business_name,'')))<2 then
    raise exception 'ATK Basic certificate registration input is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_pos_record_id::text,0));
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_record_id and p.business_id=p_business_id
      and p.application_id ~ '^[0-9]+$' and p.application_id::bigint=p_application_id
      and p.certificate_status='verified') then
    raise exception 'ATK Application ID is not verified for this Basic POS';
  end if;
  update public.fiskalo_basic_pos_certificates set status='superseded',updated_at=now()
    where business_id=p_business_id and pos_id=p_pos_record_id and status='active' and revoked_at is null;
  insert into public.fiskalo_basic_pos_certificates(
    id,business_id,pos_id,application_id,certificate_pem,spki_sha256,status,issued_at,revoked_at,updated_at
  ) values(
    certificate_id,p_business_id,p_pos_record_id,p_application_id,p_certificate_pem,p_spki_sha256,
    'active',now(),null,now()
  );
  update public.fiskalo_basic_pos set certificate_status='certificate_issued',
    verified_business_name=trim(p_verified_business_name)
    where id=p_pos_record_id and business_id=p_business_id;
  return certificate_id;
end;
$$;
revoke all on function public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)
  from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)
  to service_role;
