-- Run after migrations 0001-0014 in a Supabase SQL session.
-- Verifies the durable checkout idempotency contract and least-privilege RPC surface.
begin;
do $$
declare
  helper_oid oid;
  public_oid oid;
  definition text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_sales'
      and column_name='checkout_idempotency_key' and data_type='uuid'
  ) then raise exception 'Sales must persist the checkout idempotency key'; end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='fiskalo_basic_sales'
      and indexname='fiskalo_basic_sales_checkout_idempotency_uidx'
  ) then raise exception 'Business-scoped checkout idempotency unique index is missing'; end if;

  helper_oid:=to_regprocedure('fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)');
  public_oid:=to_regprocedure('public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)');
  if helper_oid is null or public_oid is null then
    raise exception 'Idempotent checkout RPC is missing';
  end if;
  if not has_function_privilege('authenticated',helper_oid,'EXECUTE') or
     has_function_privilege('anon',helper_oid,'EXECUTE') then
    raise exception 'Private checkout helper permissions are incorrect';
  end if;
  if not has_function_privilege('authenticated',public_oid,'EXECUTE') or
     has_function_privilege('anon',public_oid,'EXECUTE') then
    raise exception 'Public checkout wrapper permissions are incorrect';
  end if;
  if has_function_privilege('authenticated','public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb)','EXECUTE') then
    raise exception 'Legacy checkout RPC without an idempotency key remains executable';
  end if;
  select pg_get_functiondef(helper_oid) into definition;
  if position('pg_advisory_xact_lock' in definition)=0 or
     position('checkout_request_lines' in definition)=0 then
    raise exception 'Checkout helper must serialize retries and reject key/content mismatches';
  end if;
end $$;
rollback;
