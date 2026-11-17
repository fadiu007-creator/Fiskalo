-- Run after applying migration 20261117110216_fiskalo_prevent_duplicate_full_atk_returns in a Supabase SQL session.
-- Static function-definition contract for single full-return/cancellation protection.
begin;
do $$
declare
  helper_oid oid;
  wrapper_oid oid;
  wrapper_is_definer boolean;
  server_finalizer_oid oid;
  server_finalizer_is_definer boolean;
  server_finalizer_config text[];
  server_finalizer_definition text;
  definition text;
begin
  helper_oid:=to_regprocedure(
    'fiskalo_private.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  if helper_oid is null then raise exception 'ATK correction persistence RPC is missing'; end if;
  wrapper_oid:=to_regprocedure(
    'public.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  if wrapper_oid is null then raise exception 'Trusted public correction wrapper is missing'; end if;
  select prosecdef into wrapper_is_definer from pg_proc where oid=wrapper_oid;
  if wrapper_is_definer then raise exception 'Public correction wrapper must remain SECURITY INVOKER'; end if;
  if not exists (
    select 1 from pg_proc
    where oid=helper_oid and prosecdef
      and coalesce(proconfig,array[]::text[]) @> array['search_path=""']::text[]
  ) then
    raise exception 'Private correction helper must remain SECURITY DEFINER with an empty search_path';
  end if;
  select pg_get_functiondef(helper_oid) into definition;
  if has_function_privilege('authenticated',helper_oid,'EXECUTE') then
    raise exception 'Authenticated clients must not execute the correction finalizer';
  end if;
  if has_function_privilege('service_role',helper_oid,'EXECUTE') then
    raise exception 'The private correction helper must remain owner-only';
  end if;
  if not has_function_privilege('service_role',
    'public.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Trusted service role must execute the public correction wrapper';
  end if;
  if has_function_privilege('authenticated',
    'public.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated clients must not execute the public correction wrapper';
  end if;
  server_finalizer_oid:=to_regprocedure(
    'public.fiskalo_basic_server_record_atk_correction_v2(uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb,text,text,text,text,bigint,text)'
  );
  if server_finalizer_oid is null then
    raise exception 'Trusted server correction finalizer is missing';
  end if;
  select prosecdef,coalesce(proconfig,array[]::text[])
    into server_finalizer_is_definer,server_finalizer_config
    from pg_proc where oid=server_finalizer_oid;
  if not server_finalizer_is_definer or
     not server_finalizer_config @> array['search_path=""']::text[] then
    raise exception 'Server correction finalizer must be SECURITY DEFINER with an empty search_path';
  end if;
  if not has_function_privilege('service_role',server_finalizer_oid,'EXECUTE') or
     has_function_privilege('authenticated',server_finalizer_oid,'EXECUTE') or
     has_function_privilege('anon',server_finalizer_oid,'EXECUTE') then
    raise exception 'Server correction finalizer must be service-role only';
  end if;
  select pg_get_functiondef(server_finalizer_oid) into server_finalizer_definition;
  if position('set_config(''request.jwt.claim.sub''' in server_finalizer_definition)=0 or
     position('public.fiskalo_basic_record_atk_correction(' in server_finalizer_definition)=0 then
    raise exception 'Server correction finalizer must set the verified actor context and call the protected wrapper';
  end if;
  if position('for update of d' in definition)=0 or
     position('p_document_type not in (2,3)' in definition)=0 or
     position('d.document_type in (2,3)' in definition)=0 or
     position('queued' in definition)=0 or
     position('submitting' in definition)=0 or
     position('accepted' in definition)=0 or
     position('needs_reconciliation' in definition)=0 or
     position('An ATK cancellation or return already exists or is unresolved for this sale' in definition)=0 then
    raise exception 'Full correction guard must lock the original sale and prevent a second active, accepted or unresolved cancellation or return';
  end if;
end $$;
rollback;
