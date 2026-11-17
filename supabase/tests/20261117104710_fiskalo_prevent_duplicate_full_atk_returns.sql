-- Run after applying migration 20261117104710_fiskalo_prevent_duplicate_full_atk_returns in a Supabase SQL session.
-- Static function-definition contract for single full-return/cancellation protection.
begin;
do $$
declare
  helper_oid oid;
  wrapper_oid oid;
  wrapper_is_definer boolean;
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
  select pg_get_functiondef(helper_oid) into definition;
  if has_function_privilege('authenticated',helper_oid,'EXECUTE') then
    raise exception 'Authenticated clients must not execute the correction finalizer';
  end if;
  if not has_function_privilege('service_role',helper_oid,'EXECUTE') then
    raise exception 'Trusted service role must execute the correction finalizer';
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
  if position('for update of d' in definition)=0 or
     position('p_document_type in (2,3)' in definition)=0 or
     position('d.document_type in (2,3)' in definition)=0 or
     position('submitting' in definition)=0 or
     position('needs_reconciliation' in definition)=0 or
     position('An ATK cancellation or return already exists or is unresolved for this sale' in definition)=0 then
    raise exception 'Full correction guard must lock the original sale and prevent a second active, accepted or unresolved cancellation or return';
  end if;
end $$;
rollback;
