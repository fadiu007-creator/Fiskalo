begin;
do $test$
declare fn regprocedure; def text;
begin
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)');
  select pg_get_functiondef(fn) into def;
  if position('v_incident.restored_at<v_deadline' in replace(def,' ',''))=0 then
    raise exception 'Restoration at the start of the 11th must be treated as after the Article 44(6) deadline';
  end if;
  if position('v_incident.restored_at<=v_deadline' in replace(def,' ',''))>0 then
    raise exception 'Article 44(6) deadline comparison still treats midnight on the 11th as on time';
  end if;
end
$test$;
rollback;
