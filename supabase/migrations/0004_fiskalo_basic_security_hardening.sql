-- Security hardening for Fiskalo Basic: owner-only configuration writes,
-- cashier checkout through narrowly scoped SECURITY DEFINER RPCs, and immutable
-- fiscal records. This migration is additive and does not touch other app schemas.

-- A business and its initial owner must be created through the validated RPC.
drop policy if exists fiskalo_basic_business_insert on public.fiskalo_basic_businesses;
revoke insert on public.fiskalo_basic_businesses from authenticated;

-- Membership creation is performed by the business-creation RPC. Do not let a
-- client assign itself or another user arbitrary roles by inserting rows.
drop policy if exists fiskalo_basic_member_insert on public.fiskalo_basic_members;
revoke insert on public.fiskalo_basic_members from authenticated;

-- All members may read the POS configuration, but only an owner may change it.
drop policy if exists fiskalo_basic_pos_access on public.fiskalo_basic_pos;
create policy fiskalo_basic_pos_read_member on public.fiskalo_basic_pos
  for select to authenticated using (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_pos.business_id
        and m.user_id=auth.uid()
    )
  );
create policy fiskalo_basic_pos_insert_owner on public.fiskalo_basic_pos
  for insert to authenticated with check (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_pos.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  );
create policy fiskalo_basic_pos_update_owner on public.fiskalo_basic_pos
  for update to authenticated
  using (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_pos.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  )
  with check (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_pos.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  );
create policy fiskalo_basic_pos_delete_owner on public.fiskalo_basic_pos
  for delete to authenticated using (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_pos.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  );
revoke all on public.fiskalo_basic_pos from authenticated;
grant select,insert,update,delete on public.fiskalo_basic_pos to authenticated;

-- Cashiers need catalogue reads for checkout. Product maintenance is owner-only.
drop policy if exists fiskalo_basic_products_access on public.fiskalo_basic_products;
create policy fiskalo_basic_products_read_member on public.fiskalo_basic_products
  for select to authenticated using (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_products.business_id
        and m.user_id=auth.uid()
    )
  );
create policy fiskalo_basic_products_insert_owner on public.fiskalo_basic_products
  for insert to authenticated with check (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_products.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  );
create policy fiskalo_basic_products_update_owner on public.fiskalo_basic_products
  for update to authenticated
  using (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_products.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  )
  with check (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_products.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  );
create policy fiskalo_basic_products_delete_owner on public.fiskalo_basic_products
  for delete to authenticated using (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_products.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  );
revoke all on public.fiskalo_basic_products from authenticated;
grant select,insert,update,delete on public.fiskalo_basic_products to authenticated;

-- Sales, sale lines and fiscal documents are append-only from the client.
-- Checkout and accepted ATK response persistence happen through validated RPCs.
drop policy if exists fiskalo_basic_sales_insert on public.fiskalo_basic_sales;
drop policy if exists fiskalo_basic_sales_update_status on public.fiskalo_basic_sales;
drop policy if exists fiskalo_basic_sale_items_insert on public.fiskalo_basic_sale_items;
drop policy if exists fiskalo_basic_fiscal_insert on public.fiskalo_basic_fiscal_documents;

revoke insert,update,delete on public.fiskalo_basic_sales from authenticated;
revoke update(status) on public.fiskalo_basic_sales from authenticated;
grant select on public.fiskalo_basic_sales to authenticated;
revoke insert,update,delete on public.fiskalo_basic_sale_items from authenticated;
grant select on public.fiskalo_basic_sale_items to authenticated;
revoke insert,update,delete on public.fiskalo_basic_fiscal_documents from authenticated;
grant select on public.fiskalo_basic_fiscal_documents to authenticated;

-- Put the privileged implementations in a non-exposed schema. The public RPC
-- entry points remain SECURITY INVOKER wrappers; the private implementations
-- are callable only by authenticated users and validate auth.uid() internally.
-- Do not add fiskalo_private to Supabase's exposed Data API schemas.
create schema if not exists fiskalo_private;
revoke all on schema fiskalo_private from public,anon;
grant usage on schema fiskalo_private to authenticated;

alter function public.fiskalo_basic_create_business(text,text) set schema fiskalo_private;
alter function fiskalo_private.fiskalo_basic_create_business(text,text) security definer;
alter function fiskalo_private.fiskalo_basic_create_business(text,text) set search_path = '';
revoke all on function fiskalo_private.fiskalo_basic_create_business(text,text) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_create_business(text,text) to authenticated;

create function public.fiskalo_basic_create_business(p_name text,p_nui text)
returns uuid language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select fiskalo_private.fiskalo_basic_create_business(p_name,p_nui)
$$;
revoke all on function public.fiskalo_basic_create_business(text,text) from public,anon;
grant execute on function public.fiskalo_basic_create_business(text,text) to authenticated;

alter function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) set schema fiskalo_private;
alter function fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) security definer;
alter function fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) set search_path = '';
revoke all on function fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) to authenticated;

create function public.fiskalo_basic_create_sale(
  p_business_id uuid,p_pos_id uuid,p_payment_method text,p_lines jsonb
) returns uuid language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select fiskalo_private.fiskalo_basic_create_sale(p_business_id,p_pos_id,p_payment_method,p_lines)
$$;
revoke all on function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) to authenticated;

alter function public.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) set schema fiskalo_private;
alter function fiskalo_private.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) security definer;
alter function fiskalo_private.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) set search_path = '';
revoke all on function fiskalo_private.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) to authenticated;

create function public.fiskalo_basic_record_atk_sale(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_atk_transaction_id numeric,p_atk_response jsonb
) returns uuid language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select fiskalo_private.fiskalo_basic_record_atk_sale(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_atk_transaction_id,p_atk_response
  )
$$;
revoke all on function public.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) to authenticated;

-- Coupon numbers are allocated only inside the checkout RPC.
revoke usage,select on sequence public.fiskalo_basic_coupon_seq from authenticated;
