begin;
do $test$
declare fn regprocedure; def text;
begin
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)');
  select pg_get_functiondef(fn) into def;
  if position('v_incident.cause not in' in def)=0 then
    raise exception 'Article 44(6) monthly submission must be restricted to eligible internet interruption causes';
  end if;
  if position('v_incident.restored_at<v_deadline' in replace(def,' ',''))=0 then
    raise exception 'The 10th-day deadline boundary must treat restoration at midnight on the 11th as late';
  end if;
  if position('v_export_count<1' in replace(def,' ',''))=0 or position('v_proof_count<1' in replace(def,' ',''))=0 then
    raise exception 'Monthly filing must require both the coupon export and proof of actual ATK submission';
  end if;
end
$test$;
rollback;
