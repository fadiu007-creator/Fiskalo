-- Canonical mixed-tender support for online and offline Basic POS sales.
alter table public.fiskalo_basic_sales
  drop constraint if exists fiskalo_basic_sales_payment_method_check;
alter table public.fiskalo_basic_sales
  add constraint fiskalo_basic_sales_payment_method_check
  check (payment_method = any(array['cash','card','bank_transfer','voucher','cheque','crypto','mixed']));

create or replace function fiskalo_private.fiskalo_basic_normalize_payment_allocations(
  p_total_cents bigint,p_payment_allocations jsonb
) returns jsonb language plpgsql security definer set search_path='' as $payments$
declare v_total bigint; v_count integer; v_distinct integer; v_result jsonb;
begin
  if p_total_cents is null or p_total_cents<0 or p_payment_allocations is null or
     jsonb_typeof(p_payment_allocations)<>'array' or
     jsonb_array_length(p_payment_allocations)<1 or jsonb_array_length(p_payment_allocations)>6 then
    raise exception 'Payment allocations must contain one to six valid tender entries';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_payment_allocations) as x(method text,amount_cents numeric)
    where x.method is null or x.method not in ('cash','card','bank_transfer','voucher','cheque','crypto')
      or x.amount_cents is null or x.amount_cents<0 or trunc(x.amount_cents)<>x.amount_cents
      or x.amount_cents>9000000000000000) then
    raise exception 'Payment allocation method or integer-cent amount is invalid';
  end if;
  select count(*),count(distinct x.method),coalesce(sum(x.amount_cents),0)::bigint
    into v_count,v_distinct,v_total
  from jsonb_to_recordset(p_payment_allocations) as x(method text,amount_cents numeric);
  if v_count<>v_distinct then raise exception 'Each payment method can appear only once'; end if;
  if v_total<>p_total_cents then raise exception 'Payment allocations do not equal the sale total'; end if;
  select jsonb_agg(jsonb_build_object('method',x.method,'amount_cents',x.amount_cents::bigint) order by x.method)
    into v_result
  from jsonb_to_recordset(p_payment_allocations) as x(method text,amount_cents numeric);
  return v_result;
end;
$payments$;
revoke all on function fiskalo_private.fiskalo_basic_normalize_payment_allocations(bigint,jsonb)
  from public,anon,authenticated;

create or replace function fiskalo_private.fiskalo_basic_create_sale_with_allocations(
  p_business_id uuid,p_pos_id uuid,p_lines jsonb,p_idempotency_key uuid,p_payment_allocations jsonb
) returns uuid language plpgsql security definer set search_path='' as $payments$
declare
  v_existing public.fiskalo_basic_sales%rowtype;
  v_sale_id uuid;
  v_total_cents bigint;
  v_allocations jsonb;
  v_payment_method text;
  v_normalized_lines jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_idempotency_key is null then raise exception 'Checkout idempotency key is required'; end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()) then
    raise exception 'Not a member of this business';
  end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'Sale lines are required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',x.product_id,'quantity',x.quantity) order by x.product_id),'[]'::jsonb)
    into v_normalized_lines
  from (select q.product_id,sum(q.quantity)::numeric(12,3) quantity
    from jsonb_to_recordset(p_lines) as q(product_id uuid,quantity numeric)
    group by q.product_id) x;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text||':'||p_idempotency_key::text,0)
  );
  select * into v_existing from public.fiskalo_basic_sales s
    where s.business_id=p_business_id and s.checkout_idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.pos_id<>p_pos_id or v_existing.checkout_request_lines is distinct from v_normalized_lines then
      raise exception 'Checkout idempotency key already exists with different request content';
    end if;
    v_total_cents:=round(v_existing.total*100)::bigint;
    v_allocations:=fiskalo_private.fiskalo_basic_normalize_payment_allocations(v_total_cents,p_payment_allocations);
    v_payment_method:=case when jsonb_array_length(v_allocations)=1 then v_allocations->0->>'method' else 'mixed' end;
    if v_existing.payment_allocations is not null and
       (v_existing.payment_allocations is distinct from v_allocations or v_existing.payment_method<>v_payment_method) then
      raise exception 'Checkout idempotency key was retried with different payment allocations';
    end if;
    if v_existing.payment_allocations is null and v_existing.payment_method<>v_payment_method then
      raise exception 'Legacy checkout idempotency key has a different payment method';
    end if;
    update public.fiskalo_basic_sales set payment_method=v_payment_method,payment_allocations=v_allocations
      where id=v_existing.id and (payment_allocations is null or payment_method='cash');
    return v_existing.id;
  end if;

  -- The existing atomic checkout writer validates membership, product stock,
  -- tax mappings and idempotency. It uses cash as a temporary legacy tender;
  -- this same transaction replaces it with the validated canonical allocations.
  v_sale_id:=fiskalo_private.fiskalo_basic_create_sale(
    p_business_id,p_pos_id,'cash',p_lines,p_idempotency_key
  );
  select round(s.total*100)::bigint into v_total_cents
    from public.fiskalo_basic_sales s where s.id=v_sale_id;
  v_allocations:=fiskalo_private.fiskalo_basic_normalize_payment_allocations(v_total_cents,p_payment_allocations);
  v_payment_method:=case when jsonb_array_length(v_allocations)=1 then v_allocations->0->>'method' else 'mixed' end;
  update public.fiskalo_basic_sales
    set payment_method=v_payment_method,payment_allocations=v_allocations
    where id=v_sale_id;
  return v_sale_id;
end;
$payments$;
revoke all on function fiskalo_private.fiskalo_basic_create_sale_with_allocations(uuid,uuid,jsonb,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_create_sale_with_allocations(uuid,uuid,jsonb,uuid,jsonb)
  to authenticated;
create or replace function public.fiskalo_basic_create_sale_with_allocations(
  p_business_id uuid,p_pos_id uuid,p_lines jsonb,p_idempotency_key uuid,p_payment_allocations jsonb
) returns uuid language sql security invoker set search_path=pg_catalog,public,pg_temp as $payments$
  select fiskalo_private.fiskalo_basic_create_sale_with_allocations(
    p_business_id,p_pos_id,p_lines,p_idempotency_key,p_payment_allocations)
$payments$;
revoke all on function public.fiskalo_basic_create_sale_with_allocations(uuid,uuid,jsonb,uuid,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_create_sale_with_allocations(uuid,uuid,jsonb,uuid,jsonb) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_sync_offline_sale_with_allocations(
  p_business_id uuid,p_pos_id uuid,p_lines jsonb,p_checkout_idempotency_key uuid,
  p_coupon_id bigint,p_daily_number bigint,p_business_date date,p_operator_id uuid,
  p_operator_name text,p_operator_identifier text,p_expected_snapshot jsonb,
  p_created_at timestamptz,p_payment_allocations jsonb
) returns uuid language plpgsql security definer set search_path='' as $payments$
declare
  v_existing public.fiskalo_basic_sales%rowtype;
  v_sale_id uuid;
  v_total_cents bigint;
  v_allocations jsonb;
  v_payment_method text;
  v_normalized_lines jsonb;
  v_snapshot_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_checkout_idempotency_key is null or p_coupon_id is null or p_daily_number is null or
     p_business_date is null or p_created_at is null or p_expected_snapshot is null or
     jsonb_typeof(p_expected_snapshot)<>'array' then
    raise exception 'Offline checkout identity and immutable snapshot are required';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()) then raise exception 'Not a member of this business'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',x.product_id,'quantity',x.quantity) order by x.product_id),'[]'::jsonb)
    into v_normalized_lines
  from (select q.product_id,sum(q.quantity)::numeric(12,3) quantity
    from jsonb_to_recordset(p_lines) as q(product_id uuid,quantity numeric)
    group by q.product_id) x;
  select count(*) into v_snapshot_count from jsonb_to_recordset(p_expected_snapshot) as x(
    product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
    atk_unit_code text,atk_item_category_code text,atk_vat_code text,
    line_net numeric,line_vat numeric,line_total numeric
  );
  if v_snapshot_count<>jsonb_array_length(v_normalized_lines) or exists(
    select 1 from jsonb_to_recordset(v_normalized_lines) as q(product_id uuid,quantity numeric)
    full join jsonb_to_recordset(p_expected_snapshot) as x(
      product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
      atk_unit_code text,atk_item_category_code text,atk_vat_code text,
      line_net numeric,line_vat numeric,line_total numeric
    ) using(product_id)
    where q.product_id is null or x.product_id is null or q.quantity is distinct from x.quantity
  ) then raise exception 'Offline snapshot and checkout request line identities differ'; end if;
  select coalesce(sum(x.line_total*100),0)::bigint into v_total_cents
    from jsonb_to_recordset(p_expected_snapshot) as x(line_total numeric);
  v_allocations:=fiskalo_private.fiskalo_basic_normalize_payment_allocations(v_total_cents,p_payment_allocations);
  v_payment_method:=case when jsonb_array_length(v_allocations)=1 then v_allocations->0->>'method' else 'mixed' end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text||':'||p_checkout_idempotency_key::text,0)
  );
  select * into v_existing from public.fiskalo_basic_sales s
    where s.business_id=p_business_id and s.checkout_idempotency_key=p_checkout_idempotency_key for update;
  if found then
    if v_existing.pos_id<>p_pos_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.daily_number<>p_daily_number or v_existing.operator_id<>p_operator_id or
       v_existing.operator_name<>trim(p_operator_name) or
       v_existing.operator_identifier<>trim(p_operator_identifier) or
       v_existing.created_at<>p_created_at or
       v_existing.checkout_request_lines is distinct from v_normalized_lines or
       (v_existing.payment_allocations is not null and
         (v_existing.payment_allocations is distinct from v_allocations or v_existing.payment_method<>v_payment_method)) or
       (v_existing.payment_allocations is null and v_existing.payment_method<>v_payment_method) then
      raise exception 'Offline checkout key already exists with different fiscal identity or payment allocation';
    end if;
    if exists(
      select 1 from jsonb_to_recordset(p_expected_snapshot) as x(
        product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
        atk_unit_code text,atk_item_category_code text,atk_vat_code text,
        line_net numeric,line_vat numeric,line_total numeric
      )
      left join public.fiskalo_basic_sale_items i on i.sale_id=v_existing.id and i.product_id=x.product_id
      where i.id is null or i.quantity is distinct from x.quantity or i.description is distinct from x.description or
        i.unit_price is distinct from x.unit_price or i.vat_rate is distinct from x.vat_rate or
        i.atk_unit_code is distinct from x.atk_unit_code or i.atk_item_category_code is distinct from x.atk_item_category_code or
        i.atk_vat_code is distinct from x.atk_vat_code or i.line_net is distinct from x.line_net or
        i.line_vat is distinct from x.line_vat or i.line_total is distinct from x.line_total
    ) then raise exception 'Offline checkout key was retried with different immutable line data'; end if;
    update public.fiskalo_basic_sales set payment_method=v_payment_method,payment_allocations=v_allocations
      where id=v_existing.id;
    return v_existing.id;
  end if;

  v_sale_id:=fiskalo_private.fiskalo_basic_sync_offline_sale(
    p_business_id,p_pos_id,'cash',p_lines,p_checkout_idempotency_key,p_coupon_id,
    p_daily_number,p_business_date,p_operator_id,p_operator_name,p_operator_identifier,
    p_expected_snapshot,p_created_at
  );
  update public.fiskalo_basic_sales set payment_method=v_payment_method,payment_allocations=v_allocations
    where id=v_sale_id;
  return v_sale_id;
end;
$payments$;
revoke all on function fiskalo_private.fiskalo_basic_sync_offline_sale_with_allocations(uuid,uuid,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz,jsonb)
  from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_sync_offline_sale_with_allocations(uuid,uuid,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz,jsonb)
  to authenticated;
create or replace function public.fiskalo_basic_sync_offline_sale_with_allocations(
  p_business_id uuid,p_pos_id uuid,p_lines jsonb,p_checkout_idempotency_key uuid,
  p_coupon_id bigint,p_daily_number bigint,p_business_date date,p_operator_id uuid,
  p_operator_name text,p_operator_identifier text,p_expected_snapshot jsonb,
  p_created_at timestamptz,p_payment_allocations jsonb
) returns uuid language sql security invoker set search_path=pg_catalog,public,pg_temp as $payments$
  select fiskalo_private.fiskalo_basic_sync_offline_sale_with_allocations(
    p_business_id,p_pos_id,p_lines,p_checkout_idempotency_key,p_coupon_id,p_daily_number,
    p_business_date,p_operator_id,p_operator_name,p_operator_identifier,p_expected_snapshot,
    p_created_at,p_payment_allocations)
$payments$;
revoke all on function public.fiskalo_basic_sync_offline_sale_with_allocations(uuid,uuid,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz,jsonb)
  from public,anon;
grant execute on function public.fiskalo_basic_sync_offline_sale_with_allocations(uuid,uuid,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz,jsonb)
  to authenticated;
