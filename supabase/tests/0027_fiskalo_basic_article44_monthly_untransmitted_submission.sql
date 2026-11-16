begin;
do $test$
declare fn regprocedure; def text;
begin
  fn:=to_regprocedure('public.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Monthly un-fiscalized coupon submission RPC privileges are incorrect';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)');
  select pg_get_functiondef(fn) into def;
  if position('Europe/Belgrade' in def)=0 or position('10 days' in def)=0 or position('storage.objects' in def)=0 then
    raise exception 'Monthly export must use Kosovo time, tenth-of-following-month deadline and private evidence';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)');
  select pg_get_functiondef(fn) into def;
  if position('coalesce(v_incident.restored_at,now())' in replace(def,' ',''))=0 then
    raise exception 'Paragraph 5 notice must depend on actual restoration time, not just current time';
  end if;
end
$test$;
rollback;
