-- Run after migrations 0001-0014 in a Supabase SQL session.
-- This is a catalog/privilege regression test; it does not replace an authenticated
-- owner-vs-cashier RLS integration test using real JWT claims.
do $$
declare
  function_name text;
  helper_oid oid;
  helper_is_definer boolean;
begin
  if has_table_privilege('authenticated','public.fiskalo_basic_sales','INSERT') then
    raise exception 'authenticated must not directly insert sales';
  end if;
  if has_table_privilege('authenticated','public.fiskalo_basic_sales','UPDATE') or
     has_column_privilege('authenticated','public.fiskalo_basic_sales','status','UPDATE') then
    raise exception 'authenticated must not directly update sale status';
  end if;
  if has_table_privilege('authenticated','public.fiskalo_basic_sale_items','INSERT') then
    raise exception 'authenticated must not directly insert sale lines';
  end if;
  if has_table_privilege('authenticated','public.fiskalo_basic_fiscal_documents','INSERT') then
    raise exception 'authenticated must not directly insert fiscal documents';
  end if;
  if has_table_privilege('authenticated','public.fiskalo_basic_products','SELECT') is false or
     has_table_privilege('authenticated','public.fiskalo_basic_pos','SELECT') is false then
    raise exception 'authenticated members require catalogue and POS read access';
  end if;
  if has_schema_privilege('anon','fiskalo_private','USAGE') then
    raise exception 'anon must not access the private routine schema';
  end if;

  foreach function_name in array array[
    'fiskalo_private.fiskalo_basic_create_business(text,text)',
    'fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)',
    'fiskalo_private.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb)'
  ] loop
    helper_oid := to_regprocedure(function_name);
    if helper_oid is null then raise exception 'Missing private helper: %',function_name; end if;
    select p.prosecdef into helper_is_definer from pg_proc p where p.oid=helper_oid;
    if helper_is_definer is distinct from true then
      raise exception 'Private privileged helper must execute with its owner: %',function_name;
    end if;
    if not has_function_privilege('authenticated',helper_oid,'EXECUTE') then
      raise exception 'Authenticated RPC wrapper cannot call private helper: %',function_name;
    end if;
    if has_function_privilege('anon',helper_oid,'EXECUTE') then
      raise exception 'anon must not execute private helper: %',function_name;
    end if;
  end loop;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='fiskalo_basic_products'
      and policyname='fiskalo_basic_products_insert_owner'
      and coalesce(with_check,'') like '%role = ''owner''%'
  ) then raise exception 'product inserts must be owner-only'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='fiskalo_basic_pos'
      and policyname='fiskalo_basic_pos_update_owner'
      and coalesce(qual,'') like '%role = ''owner''%'
      and coalesce(with_check,'') like '%role = ''owner''%'
  ) then raise exception 'POS updates must be owner-only on old and new row'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='fiskalo_basic_products'
      and policyname='fiskalo_basic_products_read_member' and cmd='SELECT'
  ) then raise exception 'business members require product catalogue read access'; end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'fiskalo_basic_%' and p.prosecdef
  ) then raise exception 'public Basic RPC wrappers must remain SECURITY INVOKER'; end if;

  if not has_function_privilege('authenticated','public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)','EXECUTE') or
     not has_function_privilege('authenticated','public.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb)','EXECUTE') then
    raise exception 'Authenticated public RPC wrappers are missing execute permission';
  end if;
  if has_function_privilege('authenticated','public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb)','EXECUTE') then
    raise exception 'Legacy checkout RPC without an idempotency key must not be executable';
  end if;
end $$;
