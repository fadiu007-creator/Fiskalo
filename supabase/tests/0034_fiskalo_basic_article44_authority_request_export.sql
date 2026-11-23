begin;
do $test$
declare
  old_private regprocedure;
  old_public regprocedure;
  legacy_private regprocedure;
  legacy_public regprocedure;
  new_private regprocedure;
  new_public regprocedure;
  definition text;
  fiscal_policy_qual text;
  fiscal_rls_enabled boolean;
  fiscal_select_policy_count integer;
  has_manifest_column boolean;
  has_incident_column boolean;
  evidence_mimes text[];
  wrapper_security_definer boolean;
begin
  old_private := to_regprocedure('fiskalo_private.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)');
  old_public := to_regprocedure('public.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)');
  new_private := to_regprocedure('fiskalo_private.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb,integer)');
  new_public := to_regprocedure('public.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb,integer)');
  legacy_private := to_regprocedure('fiskalo_private.fiskalo_basic_untransmitted_export(uuid,timestamptz,timestamptz,text,integer)');
  legacy_public := to_regprocedure('public.fiskalo_basic_untransmitted_export(uuid,timestamptz,timestamptz,text,integer)');

  if old_private is null or old_public is null or new_private is null or new_public is null then
    raise exception 'Article 44 authority export RPC signatures are incomplete';
  end if;
  if has_function_privilege('authenticated',old_private,'EXECUTE') or
     has_function_privilege('authenticated',old_public,'EXECUTE') then
    raise exception 'Legacy Article 44 export signature must not remain executable';
  end if;

  if legacy_private is not null and (
       has_function_privilege('authenticated',legacy_private,'EXECUTE') or
       has_function_privilege('anon',legacy_private,'EXECUTE')
     ) then
    raise exception 'Legacy untransmitted export helper must not remain API-executable';
  end if;
  if legacy_public is not null and (
       has_function_privilege('authenticated',legacy_public,'EXECUTE') or
       has_function_privilege('anon',legacy_public,'EXECUTE')
     ) then
    raise exception 'Legacy untransmitted export wrapper must not remain API-executable';
  end if;
  if has_function_privilege('authenticated',new_private,'EXECUTE') or
     has_function_privilege('anon',new_private,'EXECUTE') or
     has_function_privilege('service_role',new_private,'EXECUTE') or
     has_function_privilege('authenticated',new_public,'EXECUTE') or
     has_function_privilege('anon',new_public,'EXECUTE') or
     not has_function_privilege('service_role',new_public,'EXECUTE') then
    raise exception 'Only the server service role may invoke the verified authority export wrapper';
  end if;
  select p.prosecdef into wrapper_security_definer
  from pg_proc p where p.oid=new_public;
  if not coalesce(wrapper_security_definer,false) then
    raise exception 'The service-role wrapper must run with its protected function-owner privileges';
  end if;

  select allowed_mime_types into evidence_mimes
  from storage.buckets
  where id='fiskalo-article44-evidence';
  if not (array['application/json','text/csv']::text[] <@ coalesce(evidence_mimes,array[]::text[])) then
    raise exception 'Article 44(6) monthly CSV/JSON evidence must be accepted by the private evidence bucket';
  end if;

  select c.relrowsecurity into fiscal_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='fiskalo_basic_fiscal_documents';
  select qual into fiscal_policy_qual
  from pg_policies
  where schemaname='public'
    and tablename='fiskalo_basic_fiscal_documents'
    and policyname='fiskalo_basic_fiscal_access'
    and cmd='SELECT';
  select count(*) into fiscal_select_policy_count
  from pg_policies
  where schemaname='public'
    and tablename='fiskalo_basic_fiscal_documents'
    and cmd='SELECT';
  if not coalesce(fiscal_rls_enabled,false) or fiscal_policy_qual is null or
     fiscal_select_policy_count <> 1 or
     position('submission_state' in fiscal_policy_qual)=0 or
     position('accepted' in fiscal_policy_qual)=0 or
     position('auth.uid()' in fiscal_policy_qual)=0 then
    raise exception 'Direct fiscal-document reads must be limited to accepted documents for the authenticated business member';
  end if;

  select pg_get_functiondef(new_private) into definition;
  if position('authority_request_evidence_manifest' in definition)=0 or
     position('p_actor_id' in definition)=0 or
     position('auth.role()' in definition)=0 or
     position('service_role' in definition)=0 or
     position('storage.objects' in definition)=0 or
     position('o.metadata->>''mimetype''' in replace(definition,' ',''))=0 or
     position('o.metadata->>''size''' in replace(definition,' ',''))=0 or
     position('(o.metadata->>''size'')::bigint=(e->>''size_bytes'')::bigint' in replace(definition,' ',''))=0 or
     position('o.owner_id=caller_id::text' in replace(definition,' ',''))=0 or
     position('authority-request-' in definition)=0 or
     position('row_count > p_limit' in definition)=0 or
     position('m.role=''owner''' in replace(definition,' ',''))=0 or
     position('text/csv' in definition)>0 or
     position('application/json' in definition)>0 then
    raise exception 'Authority export must verify private request evidence, owner scope and complete bounded output';
  end if;

  select exists(select 1 from information_schema.columns
    where table_schema='fiskalo_private' and table_name='fiskalo_basic_authority_exports'
      and column_name='authority_request_evidence_manifest') into has_manifest_column;
  select exists(select 1 from information_schema.columns
    where table_schema='fiskalo_private' and table_name='fiskalo_basic_authority_exports'
      and column_name='incident_id') into has_incident_column;
  if not has_manifest_column or not has_incident_column then
    raise exception 'Authority export audit must retain the incident and request evidence manifest';
  end if;
  if has_table_privilege('authenticated','fiskalo_private.fiskalo_basic_authority_exports','SELECT') or
     has_table_privilege('authenticated','fiskalo_private.fiskalo_basic_authority_exports','INSERT') or
     has_table_privilege('anon','fiskalo_private.fiskalo_basic_authority_exports','SELECT') then
    raise exception 'Authority export audit table must not be directly accessible to client roles';
  end if;
end
$test$;
rollback;
