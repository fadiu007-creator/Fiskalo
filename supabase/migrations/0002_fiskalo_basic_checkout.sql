-- Minimal owner onboarding and atomic paid checkout for Fiskalo Basic.
create sequence if not exists public.fiskalo_basic_coupon_seq;
grant usage, select on sequence public.fiskalo_basic_coupon_seq to authenticated;

alter table public.fiskalo_basic_products
  add column if not exists vat_rate numeric(5,2) not null default 18
  check (vat_rate in (0,8,18));
alter table public.fiskalo_basic_pos
  add column if not exists verified_business_name text;

alter table public.fiskalo_basic_products
  add constraint fiskalo_basic_product_atk_mapping_check
  check (
    length(trim(atk_unit_code)) > 0 and
    length(trim(atk_item_category_code)) > 0 and
    ((vat_rate=18 and atk_vat_code='E') or
     (vat_rate=8 and atk_vat_code='D') or
     (vat_rate=0 and atk_vat_code in ('A','C')))
  );

create table if not exists public.fiskalo_basic_sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.fiskalo_basic_sales(id) on delete restrict,
  product_id uuid not null references public.fiskalo_basic_products(id) on delete restrict,
  description text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price numeric(12,4) not null check (unit_price >= 0),
  vat_rate numeric(5,2) not null check (vat_rate in (0,8,18)),
  atk_unit_code text not null,
  atk_item_category_code text not null,
  atk_vat_code text not null check (atk_vat_code ~ '^[A-Z]$'),
  line_net numeric(12,2) not null,
  line_vat numeric(12,2) not null,
  line_total numeric(12,2) not null
);
alter table public.fiskalo_basic_sale_items enable row level security;

create policy fiskalo_basic_sale_items_read on public.fiskalo_basic_sale_items
  for select to authenticated using (
    exists(
      select 1 from public.fiskalo_basic_sales s
      join public.fiskalo_basic_members m on m.business_id=s.business_id
      where s.id=public.fiskalo_basic_sale_items.sale_id and m.user_id=auth.uid()
    )
  );
create policy fiskalo_basic_sale_items_insert on public.fiskalo_basic_sale_items
  for insert to authenticated with check (
    exists(
      select 1 from public.fiskalo_basic_sales s
      join public.fiskalo_basic_members m on m.business_id=s.business_id
      where s.id=public.fiskalo_basic_sale_items.sale_id and m.user_id=auth.uid()
    )
  );

create or replace function public.fiskalo_basic_create_business(p_name text,p_nui text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(p_name)) < 2 or p_nui !~ '^[0-9]{9}$' then raise exception 'Business name or NUI is invalid'; end if;
  insert into public.fiskalo_basic_businesses(name,nui,created_by)
    values(trim(p_name),p_nui,auth.uid()) returning id into new_id;
  insert into public.fiskalo_basic_members(business_id,user_id,role)
    values(new_id,auth.uid(),'owner');
  return new_id;
end $$;
revoke all on function public.fiskalo_basic_create_business(text,text) from public,anon;
grant execute on function public.fiskalo_basic_create_business(text,text) to authenticated;

create or replace function public.fiskalo_basic_create_sale(
  p_business_id uuid,p_pos_id uuid,p_payment_method text,p_lines jsonb
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  sale_uuid uuid:=gen_random_uuid();
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
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.fiskalo_basic_members m where m.business_id=p_business_id and m.user_id=auth.uid()) then
    raise exception 'Not a member of this business';
  end if;
  if p_payment_method not in ('cash','card','bank_transfer') then raise exception 'Unsupported payment method'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Sale must contain at least one item'; end if;
  if not exists(select 1 from public.fiskalo_basic_pos p where p.id=p_pos_id and p.business_id=p_business_id) then
    raise exception 'POS does not belong to this business';
  end if;

  -- First pass locks every product and calculates totals. Group duplicate product
  -- IDs so a repeated cart line cannot bypass the stock check.
  for line in
    select x.product_id, sum(x.quantity)::numeric(12,3) as quantity
    from jsonb_to_recordset(p_lines) as x(product_id uuid, quantity numeric)
    group by x.product_id order by x.product_id
  loop
    qty:=line.quantity;
    if qty<=0 then raise exception 'Quantity must be positive'; end if;
    select * into product_row from public.fiskalo_basic_products
      where id=line.product_id and business_id=p_business_id and active=true for update;
    if not found then raise exception 'Product not found or inactive'; end if;
    if product_row.stock<qty then raise exception 'Insufficient stock for %',product_row.name; end if;
    net:=round(product_row.price*qty,2);
    vat:=round(net*product_row.vat_rate/100,2);
    gross:=net+vat;
    sum_net:=sum_net+net; sum_vat:=sum_vat+vat; sum_total:=sum_total+gross;
    item_count:=item_count+1;
  end loop;
  if item_count=0 then raise exception 'Sale must contain at least one valid item'; end if;

  next_coupon:=nextval('public.fiskalo_basic_coupon_seq');
  insert into public.fiskalo_basic_sales(id,business_id,pos_id,coupon_id,operator_id,status,subtotal,vat_total,total,payment_method)
    values(sale_uuid,p_business_id,p_pos_id,next_coupon,auth.uid(),'paid',sum_net,sum_vat,sum_total,p_payment_method);

  -- Second pass writes immutable line snapshots and deducts stock atomically.
  for line in
    select x.product_id, sum(x.quantity)::numeric(12,3) as quantity
    from jsonb_to_recordset(p_lines) as x(product_id uuid, quantity numeric)
    group by x.product_id order by x.product_id
  loop
    qty:=line.quantity;
    select * into product_row from public.fiskalo_basic_products
      where id=line.product_id and business_id=p_business_id and active=true for update;
    if not found or product_row.stock<qty then raise exception 'Stock changed while checkout was being committed'; end if;
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
end $$;
revoke all on function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) to authenticated;

grant select, insert on public.fiskalo_basic_sale_items to authenticated;
revoke all on public.fiskalo_basic_sale_items from anon;
