begin;
do $test$
declare
  old_notice_private regprocedure;
  old_notice_public regprocedure;
  old_monthly_private regprocedure;
  old_monthly_public regprocedure;
  new_notice_private regprocedure;
  new_notice_public regprocedure;
  new_monthly_private regprocedure;
  new_monthly_public regprocedure;
  definition text;
  wrapper_security_definer boolean;
begin
  old_notice_private := to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)');
  old_notice_public := to_regprocedure('public.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)');
  old_monthly_private := to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)');
  old_monthly_public := to_regprocedure('public.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)');
  new_notice_private := to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_notice_verified(uuid,uuid,text,text,jsonb)');
  new_notice_public := to_regprocedure('public.fiskalo_basic_record_article44_notice_verified(uuid,uuid,text,text,jsonb)');
  new_monthly_private := to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_monthly_submission_verified(uuid,uuid,text,text,jsonb)');
  new_monthly_public := to_regprocedure('public.fiskalo_basic_record_article44_monthly_submission_verified(uuid,uuid,text,text,jsonb)');

  if old_notice_private is null or old_notice_public is null or
     old_monthly_private is null or old_monthly_public is null or
     new_notice_private is null or new_notice_public is null or
     new_monthly_private is null or new_monthly_public is null then
    raise exception 'Article 44 verified filing RPC signatures are incomplete';
  end if;

  if has_function_privilege('authenticated',old_notice_private,'EXECUTE') or
     has_function_privilege('authenticated',old_notice_public,'EXECUTE') or
     has_function_privilege('service_role',old_notice_private,'EXECUTE') or
     has_function_privilege('service_role',old_notice_public,'EXECUTE') or
     has_function_privilege('authenticated',old_monthly_private,'EXECUTE') or
     has_function_privilege('authenticated',old_monthly_public,'EXECUTE') or
     has_function_privilege('service_role',old_monthly_private,'EXECUTE') or
     has_function_privilege('service_role',old_monthly_public,'EXECUTE') then
    raise exception 'Unverified legacy Article 44 filing RPCs must not remain executable';
  end if;

  if has_function_privilege('authenticated',new_notice_private,'EXECUTE') or
     has_function_privilege('anon',new_notice_private,'EXECUTE') or
     has_function_privilege('service_role',new_notice_private,'EXECUTE') or
     has_function_privilege('authenticated',new_notice_public,'EXECUTE') or
     has_function_privilege('anon',new_notice_public,'EXECUTE') or
     not has_function_privilege('service_role',new_notice_public,'EXECUTE') or
     has_function_privilege('authenticated',new_monthly_private,'EXECUTE') or
     has_function_privilege('anon',new_monthly_private,'EXECUTE') or
     has_function_privilege('service_role',new_monthly_private,'EXECUTE') or
     has_function_privilege('authenticated',new_monthly_public,'EXECUTE') or
     has_function_privilege('anon',new_monthly_public,'EXECUTE') or
     not has_function_privilege('service_role',new_monthly_public,'EXECUTE') then
    raise exception 'Only the server service role may invoke verified Article 44 filing wrappers';
  end if;

  select p.prosecdef into wrapper_security_definer from pg_proc p where p.oid=new_notice_public;
  if not coalesce(wrapper_security_definer,false) then
    raise exception 'The verified notice wrapper must use its protected function-owner privileges';
  end if;
  select p.prosecdef into wrapper_security_definer from pg_proc p where p.oid=new_monthly_public;
  if not coalesce(wrapper_security_definer,false) then
    raise exception 'The verified monthly wrapper must use its protected function-owner privileges';
  end if;

  select pg_get_functiondef(new_notice_private) into definition;
  if position('p_actor_id' in definition)=0 or
     position('auth.role()' in definition)=0 or
     position('service_role' in definition)=0 or
     position('storage.objects' in definition)=0 or
     position('o.owner_id=caller_id::text' in replace(definition,' ',''))=0 or
     position('o.metadata->>''mimetype''' in replace(definition,' ',''))=0 or
     position('o.metadata->>''size''' in replace(definition,' ',''))=0 or
     position('coalesce(v_incident.restored_at,now())' in replace(definition,' ',''))=0 then
    raise exception 'Notice RPC must repeat owner, server-role, private-storage and 48-hour eligibility checks';
  end if;

  select pg_get_functiondef(new_monthly_private) into definition;
  if position('p_actor_id' in definition)=0 or
     position('auth.role()' in definition)=0 or
     position('service_role' in definition)=0 or
     position('storage.objects' in definition)=0 or
     position('o.owner_id=caller_id::text' in replace(definition,' ',''))=0 or
     position('o.metadata->>''mimetype''' in replace(definition,' ',''))=0 or
     position('o.metadata->>''size''' in replace(definition,' ',''))=0 or
     position('text/csv' in definition)=0 or
     position('application/pdf' in definition)=0 then
    raise exception 'Monthly RPC must repeat owner, server-role, private-storage and CSV/delivery-proof checks';
  end if;
end
$test$;
rollback;
