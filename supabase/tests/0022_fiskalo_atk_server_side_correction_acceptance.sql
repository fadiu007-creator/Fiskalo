-- Run after migrations 0001-0017 and 0022 in disposable PostgreSQL CI.
begin;
do $$
declare
  helper_oid oid;
  public_oid oid;
  index_definition text;
begin
  helper_oid := to_regprocedure(
    'fiskalo_private.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  public_oid := to_regprocedure(
    'public.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  if helper_oid is null or public_oid is null then
    raise exception 'Legacy ATK correction functions must remain present for controlled internal workflow compatibility';
  end if;

  if has_function_privilege('authenticated', helper_oid, 'EXECUTE') or
     has_function_privilege('anon', helper_oid, 'EXECUTE') or
     has_function_privilege('authenticated', public_oid, 'EXECUTE') or
     has_function_privilege('anon', public_oid, 'EXECUTE') then
    raise exception 'Browser roles must not execute the legacy correction persistence RPC';
  end if;

  if has_table_privilege('authenticated', 'public.fiskalo_basic_fiscal_documents', 'INSERT') or
     has_table_privilege('authenticated', 'public.fiskalo_basic_fiscal_documents', 'UPDATE') or
     has_table_privilege('authenticated', 'public.fiskalo_basic_fiscal_documents', 'DELETE') or
     has_table_privilege('anon', 'public.fiskalo_basic_fiscal_documents', 'INSERT') then
    raise exception 'Browser roles must not directly mutate fiscal documents';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='fiskalo_basic_fiscal_documents'
      and policyname='fiskalo_basic_fiscal_insert'
  ) then
    raise exception 'Legacy browser fiscal-document insert policy must be removed';
  end if;

  select indexdef into index_definition
  from pg_indexes
  where schemaname='public'
    and tablename='fiskalo_basic_fiscal_documents'
    and indexname='fiskalo_basic_fiscal_one_active_correction_per_parent_uidx';
  if index_definition is null or position('UNIQUE INDEX' in upper(index_definition))=0 then
    raise exception 'One-active-cancellation uniqueness index is missing';
  end if;
end
$$;
rollback;
