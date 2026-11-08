-- Durable checkout idempotency for paid sales.
-- Repeated requests with the same business-scoped key and identical content return
-- the original sale without allocating another coupon or decrementing stock again.
alter table public.fiskalo_basic_sales
  add column if not exists checkout_idempotency_key uuid,
  add column if not exists checkout_request_lines jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_basic_sales'::regclass
      and conname='fiskalo_basic_sales_checkout_request_lines_array'
  ) then
    alter table public.fiskalo_basic_sales
      add constraint fiskalo_basic_sales_checkout_request_lines_array
      check (checkout_request_lines is null or pg_catalog.jsonb_typeof(checkout_request_lines)='array');
  end if;
end $$;

create unique index if not exists fiskalo_basic_sales_checkout_idempotency_uidx
  on public.fiskalo_basic_sales(business_id,checkout_idempotency_key)
  where checkout_idempotency_key is not null;

create or replace function fiskalo_private.fiskalo_basic_create_sale(
  p_business_id uuid,
  p_pos_id uuid,
  p_payment_method text,
  p_lines jsonb,
  p_idempotency_key uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  sale_uuid uuid:=gen_random_uuid();
  existing_sale public.fiskalo_basic_sales%rowtype;
  next_coupon bigint;
  line record;
  product_row public.fiskalo_basic_products%rowtype;
  qty numeric(12,3);
  net numeric(12,2);
  vat numeric(12,2);
  gross numeric(12,2);
  sum_net numeric(12,2):=0;
  sum_vat numeric(12,2):=0;
  sum_total numeric(12,2):=0;
  item_count integer:=0;
  normalized_lines jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_idempotency_key is null then raise exception 'Checkout idempotency key is required'; end if;
  if not exists(
    select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()
  ) then raise exception 'Not a member of this business'; end if;
  if p_payment_method is null or p_payment_method not in ('cash','card','bank_transfer') then
    raise exception 'Unsupported payment method';
  end if;
  if p_lines is null or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Sale lines must be a JSON array';
  end if;
  if pg_catalog.jsonb_array_length(p_lines)=0 then raise exception 'Sale must contain at least one item'; end if;
  if exists(
    select 1 from pg_catalog.jsonb_to_recordset(p_lines) as x(product_id uuid,quantity numeric)
    where x.product_id is null or x.quantity is null or x.quantity<=0
  ) then raise exception 'Every sale line needs a product and a positive quantity'; end if;
  if not exists(
    select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_id and p.business_id=p_business_id
  ) then raise exception 'POS does not belong to this business'; end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('product_id',x.product_id,'quantity',x.quantity)
      order by x.product_id
    ),
    '[]'::jsonb
  )
  into normalized_lines
  from (
    select source.product_id,sum(source.quantity)::numeric(12,3) as quantity
    from pg_catalog.jsonb_to_recordset(p_lines) as source(product_id uuid,quantity numeric)
    group by source.product_id
  ) x;

  -- Serialize concurrent retries of the same business/key before checking the
  -- unique index. The lock is transaction-scoped and never crosses tenants.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text||':'||p_idempotency_key::text,0)
  );
  select * into existing_sale
  from public.fiskalo_basic_sales s
  where s.business_id=p_business_id
    and s.checkout_idempotency_key=p_idempotency_key
  for update;
  if found then
    if existing_sale.pos_id<>p_pos_id or
       existing_sale.payment_method<>p_payment_method or
       existing_sale.checkout_request_lines is distinct from normalized_lines then
      raise exception 'Checkout idempotency key already exists with different request content';
    end if;
    return existing_sale.id;
  end if;

  -- Lock and validate every product before allocating a coupon number.
  for line in
    select x.product_id,sum(x.quantity)::numeric(12,3) as quantity
    from pg_catalog.jsonb_to_recordset(p_lines) as x(product_id uuid,quantity numeric)
    group by x.product_id order by x.product_id
  loop
    qty:=line.quantity;
    select * into product_row
    from public.fiskalo_basic_products
    where id=line.product_id and business_id=p_business_id and active=true
    for update;
    if not found then raise exception 'Product not found or inactive'; end if;
    if product_row.stock<qty then raise exception 'Insufficient stock for %',product_row.name; end if;
    net:=round(product_row.price*qty,2);
    vat:=round(net*product_row.vat_rate/100,2);
    gross:=net+vat;
    sum_net:=sum_net+net;sum_vat:=sum_vat+vat;sum_total:=sum_total+gross;
    item_count:=item_count+1;
  end loop;
  if item_count=0 then raise exception 'Sale must contain at least one valid item'; end if;

  next_coupon:=pg_catalog.nextval('public.fiskalo_basic_coupon_seq'::regclass);
  insert into public.fiskalo_basic_sales(
    id,business_id,pos_id,coupon_id,operator_id,status,subtotal,vat_total,total,
    payment_method,checkout_idempotency_key,checkout_request_lines
  ) values(
    sale_uuid,p_business_id,p_pos_id,next_coupon,auth.uid(),'paid',
    sum_net,sum_vat,sum_total,p_payment_method,p_idempotency_key,normalized_lines
  );

  -- The immutable sale lines and stock deduction commit atomically with the key.
  for line in
    select x.product_id,sum(x.quantity)::numeric(12,3) as quantity
    from pg_catalog.jsonb_to_recordset(p_lines) as x(product_id uuid,quantity numeric)
    group by x.product_id order by x.product_id
  loop
    qty:=line.quantity;
    select * into product_row
    from public.fiskalo_basic_products
    where id=line.product_id and business_id=p_business_id and active=true
    for update;
    if not found or product_row.stock<qty then
      raise exception 'Stock changed while checkout was being committed';
    end if;
    net:=round(product_row.price*qty,2);
    vat:=round(net*product_row.vat_rate/100,2);
    gross:=net+vat;
    update public.fiskalo_basic_products set stock=stock-qty where id=product_row.id;
    insert into public.fiskalo_basic_sale_items(
      sale_id,product_id,description,quantity,unit_price,vat_rate,
      atk_unit_code,atk_item_category_code,atk_vat_code,line_net,line_vat,line_total
    ) values(
      sale_uuid,product_row.id,product_row.name,qty,product_row.price,product_row.vat_rate,
      product_row.atk_unit_code,product_row.atk_item_category_code,product_row.atk_vat_code,net,vat,gross
    );
  end loop;
  return sale_uuid;
end;
$$;

revoke all on function fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)
  from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)
  to authenticated;

-- The old RPC can create duplicate sales on an ambiguous retry; disable it.
revoke all on function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb)
  from public,anon,authenticated;
revoke all on function fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb)
  from public,anon,authenticated;

create or replace function public.fiskalo_basic_create_sale(
  p_business_id uuid,p_pos_id uuid,p_payment_method text,p_lines jsonb,p_idempotency_key uuid
) returns uuid
language sql
security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_create_sale(
    p_business_id,p_pos_id,p_payment_method,p_lines,p_idempotency_key
  )
$$;
revoke all on function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)
  from public,anon;
grant execute on function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)
  to authenticated;
