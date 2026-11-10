-- Run after migrations 0001-0020 in a Supabase SQL session.
-- Verifies the split-tender persistence contract and least-privilege RPC surface.
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
      and column_name='payment_allocations' and data_type='jsonb'
  ) then raise exception 'Sales must persist the payment allocation array'; end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_basic_sales'::regclass
      and conname='fiskalo_basic_sales_payment_allocations_array'
  ) then raise exception 'Payment allocation array constraint is missing'; end if;

  helper_oid:=to_regprocedure('fiskalo_private.fiskalo_basic_create_sale_with_payments(uuid,uuid,jsonb,jsonb,uuid)');
  public_oid:=to_regprocedure('public.fiskalo_basic_create_sale_with_payments(uuid,uuid,jsonb,jsonb,uuid)');
  if helper_oid is null or public_oid is null then
    raise exception 'Split-tender checkout RPC is missing';
  end if;
  if not has_function_privilege('authenticated',helper_oid,'EXECUTE') or
     has_function_privilege('anon',helper_oid,'EXECUTE') then
    raise exception 'Private split-tender helper permissions are incorrect';
  end if;
  if not has_function_privilege('authenticated',public_oid,'EXECUTE') or
     has_function_privilege('anon',public_oid,'EXECUTE') then
    raise exception 'Public split-tender wrapper permissions are incorrect';
  end if;
  if has_function_privilege('authenticated','public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)','EXECUTE') then
    raise exception 'Legacy single-payment checkout RPC remains executable';
  end if;

  select pg_get_functiondef(helper_oid) into definition;
  if position('pg_advisory_xact_lock' in definition)=0 or
     position('payment_allocations' in definition)=0 or
     position('different payment allocations' in definition)=0 then
    raise exception 'Split-tender checkout must serialize retries and reject payment-content mismatches';
  end if;
end $$;
rollback;
