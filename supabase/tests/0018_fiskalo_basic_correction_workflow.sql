-- Run after migrations 0001-0018 in a disposable or approved staging database.
-- Static privilege and schema contract checks; authenticated runtime tests remain required.
begin;
do $$
declare
  prepare_private oid;
  prepare_public oid;
  store_private oid;
  store_public oid;
  definition text;
begin
  if to_regclass('public.fiskalo_basic_correction_requests') is null then
    raise exception 'Correction request journal is missing';
  end if;
  if not exists (
    select 1 from pg_class c
    where c.oid='public.fiskalo_basic_correction_requests'::regclass and c.relrowsecurity
  ) then raise exception 'Correction request journal must have RLS enabled'; end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='fiskalo_basic_correction_requests'
      and indexdef ilike '%UNIQUE% (sale_id)%'
  ) then raise exception 'Only one full correction request may be reserved per sale'; end if;

  prepare_private:=to_regprocedure('fiskalo_private.fiskalo_basic_prepare_correction(uuid,uuid,smallint)');
  prepare_public:=to_regprocedure('public.fiskalo_basic_prepare_correction(uuid,uuid,smallint)');
  store_private:=to_regprocedure('fiskalo_private.fiskalo_basic_store_correction_receipt(uuid,uuid,text,text,text,text,text,text,text,bigint,numeric,jsonb,timestamptz)');
  store_public:=to_regprocedure('public.fiskalo_basic_store_correction_receipt(uuid,uuid,text,text,text,text,text,text,text,bigint,numeric,jsonb,timestamptz)');
  if prepare_private is null or prepare_public is null or store_private is null or store_public is null then
    raise exception 'Correction prepare/store RPCs are incomplete';
  end if;
  if not has_function_privilege('authenticated',prepare_private,'EXECUTE') or
     has_function_privilege('anon',prepare_private,'EXECUTE') or
     not has_function_privilege('authenticated',prepare_public,'EXECUTE') or
     has_function_privilege('anon',prepare_public,'EXECUTE') then
    raise exception 'Correction prepare RPC privileges are incorrect';
  end if;
  if not has_function_privilege('authenticated',store_private,'EXECUTE') or
     has_function_privilege('anon',store_private,'EXECUTE') or
     not has_function_privilege('authenticated',store_public,'EXECUTE') or
     has_function_privilege('anon',store_public,'EXECUTE') then
    raise exception 'Correction store RPC privileges are incorrect';
  end if;

  select pg_get_functiondef(prepare_private) into definition;
  if position('role=''owner''' in definition)=0 or
     position('submission_state=''accepted''' in definition)=0 or
     position('atk_transaction_id>0' in definition)=0 or
     position('fiskalo_basic_daily_counters' in definition)=0 or
     position('Europe/Belgrade' in definition)=0 or
     position('parent_document_id' in definition)=0 then
    raise exception 'Correction preparation must be owner-only, accepted-sale-only, daily-numbered and duplicate-safe';
  end if;

  select pg_get_functiondef(store_private) into definition;
  if position('role=''owner''' in definition)=0 or
     position('fiskalo_basic_record_atk_correction' in definition)=0 or
     position('parent_document_id' in definition)=0 or
     position('atk_transaction_id' in definition)=0 or
     position('idempotency_key' in definition)=0 or
     position('48 hours' in definition)=0 then
    raise exception 'Correction receipt persistence must retain ATK evidence, parent linkage, idempotency and offline deadline';
  end if;
end $$;
rollback;
