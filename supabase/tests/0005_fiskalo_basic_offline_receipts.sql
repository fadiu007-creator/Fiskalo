-- Run after migration 0005 in the Fiskalo Supabase project.
do $$
declare
  v record;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_fiscal_documents'
      and column_name='nui_kf'
  ) then raise exception 'NUIKF column is missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_fiscal_documents'
      and column_name='citizen_payload'
  ) then raise exception 'Signed CitizenCoupon payload is missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_sales'
      and column_name='daily_number'
  ) then raise exception 'Per-POS daily number is missing'; end if;
  if not exists (
    select 1 from pg_trigger
    where tgname='fiskalo_basic_sales_assign_daily_number' and not tgisinternal
  ) then raise exception 'Daily number trigger is missing'; end if;
  if has_table_privilege('authenticated','fiskalo_private.fiskalo_basic_daily_counters','SELECT') or
     has_table_privilege('anon','fiskalo_private.fiskalo_basic_daily_counters','SELECT') then
    raise exception 'Private daily counter must not be directly readable';
  end if;
  if has_schema_privilege('anon','fiskalo_private','USAGE') then
    raise exception 'Private helper schema must not be available to anon';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and indexname='fiskalo_basic_fiscal_nui_kf_unique'
  ) then raise exception 'NUIKF uniqueness index is missing'; end if;

  select p.prosecdef,p.proconfig into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='fiskalo_private' and p.proname='fiskalo_basic_assign_daily_number';
  if not found or v.prosecdef is distinct from true then
    raise exception 'Daily counter trigger must run as a privileged private function';
  end if;
  if not ('TimeZone=Europe/Belgrade'=any(v.proconfig)) then
    raise exception 'Daily counter must use Kosovo local time';
  end if;

  select p.prosecdef into v
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='fiskalo_basic_record_atk_receipt';
  if not found or v.prosecdef is distinct from false then
    raise exception 'Public receipt RPC must remain SECURITY INVOKER';
  end if;
  if not has_function_privilege('authenticated',
    'public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz)','EXECUTE') then
    raise exception 'Authenticated offline receipt RPC is not executable';
  end if;
  if has_function_privilege('anon',
    'public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz)','EXECUTE') then
    raise exception 'Anon must not execute offline receipt RPC';
  end if;
end $$;
