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

-- These functions perform the privileged writes only after validating auth.uid(),
-- business membership, POS ownership, sale identity and ATK response identity.
-- Pin built-ins ahead of writable schemas; the functions fully qualify table and
-- auth references. Keep temporary objects last in the path.
alter function public.fiskalo_basic_create_business(text,text) security definer;
alter function public.fiskalo_basic_create_business(text,text) set search_path = pg_catalog,public,pg_temp;
alter function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) security definer;
alter function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb) set search_path = pg_catalog,public,pg_temp;
alter function public.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) security definer;
alter function public.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) set search_path = pg_catalog,public,pg_temp;

-- Coupon numbers are allocated only inside the checkout RPC.
revoke usage,select on sequence public.fiskalo_basic_coupon_seq from authenticated;
