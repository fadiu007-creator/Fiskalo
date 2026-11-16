begin;
do $test$
declare
  fn regprocedure;
  def text;
begin
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='fiskalo_basic_article44_incidents' and c.relrowsecurity) then
    raise exception 'Article 44 incident register must have RLS enabled';
  end if;
  if has_table_privilege('anon','public.fiskalo_basic_article44_incidents','SELECT') or
     has_table_privilege('authenticated','public.fiskalo_basic_article44_incidents','INSERT') or
     has_table_privilege('authenticated','public.fiskalo_basic_article44_incidents','UPDATE') or
     has_table_privilege('authenticated','public.fiskalo_basic_article44_incidents','DELETE') then
    raise exception 'Article 44 incident register exposes an unsafe direct table write/read grant';
  end if;
  fn:=to_regprocedure('public.fiskalo_basic_create_article44_incident(uuid,uuid,timestamptz,text,text)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Owner incident creation RPC privileges are incorrect';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_create_article44_incident(uuid,uuid,timestamptz,text,text)');
  select pg_get_functiondef(fn) into def;
  if position('role=''owner''' in replace(def,' ',''))=0 then
    raise exception 'Incident creation must be owner-only';
  end if;
  fn:=to_regprocedure('public.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Article 44 notice RPC privileges are incorrect';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)');
  select pg_get_functiondef(fn) into def;
  if position('48 hours' in def)=0 or position('storage.objects' in def)=0 then
    raise exception 'Notice recording must enforce the 48-hour rule and evidence storage';
  end if;
  fn:=to_regprocedure('public.fiskalo_basic_restore_article44_incident(uuid,timestamptz)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Incident restoration RPC privileges are incorrect';
  end if;
end
$test$;
rollback;
