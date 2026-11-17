begin;
do $test$
declare
  fn regprocedure;
  def text;
  is_definer boolean;
  config text[];
  table_rls boolean;
  index_exists boolean;
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_basic_fiscal_documents'::regclass
      and conname='fiskalo_basic_fiscal_documents_submission_state_check'
      and position('submitting' in pg_get_constraintdef(oid))>0
  ) then
    raise exception 'Fiscal document journal must permit the pre-submission state';
  end if;

  select c.relrowsecurity into table_rls
  from pg_class c where c.oid='public.fiskalo_basic_correction_reservations'::regclass;
  if not table_rls then raise exception 'Correction reservations must have RLS enabled'; end if;
  if has_table_privilege('authenticated','public.fiskalo_basic_correction_reservations','SELECT')
     or has_table_privilege('authenticated','public.fiskalo_basic_correction_reservations','INSERT')
     or has_table_privilege('authenticated','public.fiskalo_basic_correction_reservations','UPDATE')
     or has_table_privilege('anon','public.fiskalo_basic_correction_reservations','SELECT')
     or has_table_privilege('anon','public.fiskalo_basic_correction_reservations','INSERT') then
    raise exception 'Correction reservation rows must not be directly accessible to browser roles';
  end if;
  if not has_table_privilege('service_role','public.fiskalo_basic_correction_reservations','SELECT')
     or not has_table_privilege('service_role','public.fiskalo_basic_correction_reservations','INSERT')
     or not has_table_privilege('service_role','public.fiskalo_basic_correction_reservations','UPDATE') then
    raise exception 'Trusted server role must own correction reservation persistence';
  end if;
  select exists(select 1 from pg_indexes
    where schemaname='public' and indexname='fiskalo_basic_correction_one_active_per_sale')
    into index_exists;
  if not index_exists then raise exception 'Only one active or unresolved correction may be reserved per sale'; end if;

  fn:=to_regprocedure('public.fiskalo_basic_reserve_atk_correction(uuid,uuid,smallint,text)');
  if fn is null then raise exception 'Correction reservation RPC is missing'; end if;
  select prosecdef,coalesce(proconfig,array[]::text[]),pg_get_functiondef(oid)
    into is_definer,config,def from pg_proc where oid=fn;
  if not is_definer or not config @> array['search_path=""']::text[] or
     position('m.role=''owner''' in def)=0 then
    raise exception 'Correction reservation must be owner-only and SECURITY DEFINER with an empty search_path';
  end if;
  if not has_function_privilege('authenticated',fn,'EXECUTE')
     or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Only authenticated owners may invoke correction reservation';
  end if;

  foreach fn in array array[
    'public.fiskalo_basic_server_begin_atk_correction_v1(uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,text)'::regprocedure,
    'public.fiskalo_basic_server_begin_atk_correction_v2(uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,text)'::regprocedure,
    'public.fiskalo_basic_server_queue_atk_correction_v1(uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,timestamp with time zone,text)'::regprocedure,
    'public.fiskalo_basic_server_record_atk_correction_v2(uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb,text,text,text,text,bigint,text)'::regprocedure,
    'public.fiskalo_basic_server_set_atk_correction_state_v1(text,text,text)'::regprocedure
  ] loop
    if not has_function_privilege('service_role',fn,'EXECUTE')
       or has_function_privilege('authenticated',fn,'EXECUTE')
       or has_function_privilege('anon',fn,'EXECUTE') then
      raise exception 'Trusted correction function % must be service-role only',fn;
    end if;
    select prosecdef,coalesce(proconfig,array[]::text[])
      into is_definer,config from pg_proc where oid=fn;
    if not is_definer or not config @> array['search_path=""']::text[] then
      raise exception 'Trusted correction function % must be SECURITY DEFINER with an empty search_path',fn;
    end if;
  end loop;

  fn:='public.fiskalo_basic_server_record_atk_correction_v2(uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb,text,text,text,text,bigint,text)'::regprocedure;
  select pg_get_functiondef(oid) into def from pg_proc where oid=fn;
  if position('set_config(''request.jwt.claim.sub''' in def)=0
     or position('public.fiskalo_basic_record_atk_correction(' in def)=0
     or position('status''<>''accepted''' in def)=0 then
    raise exception 'Accepted correction must be finalized only through the trusted ATK response path with actor context';
  end if;

  fn:='public.fiskalo_basic_server_begin_atk_correction_v2(uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,text)'::regprocedure;
  select pg_get_functiondef(oid) into def from pg_proc where oid=fn;
  if position('public.fiskalo_basic_server_begin_atk_correction_v1(' in def)=0
     or position('attempt_count' in def)=0 then
    raise exception 'Correction pre-submission journal must persist the attempt before the ATK call';
  end if;
end
$test$;
rollback;
