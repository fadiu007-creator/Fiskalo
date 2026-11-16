begin;
do $test$
declare fn regprocedure; def text;
begin
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)');
  select pg_get_functiondef(fn) into def;
  if position('v_incident.cause not in' in def)=0 then
    raise exception 'Article 44(6) monthly submission must be limited to eligible internet interruption causes';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)');
  select pg_get_functiondef(fn) into def;
  if position('fiskalo_basic_article44_incidents' in def)=0 then
    raise exception 'Article 44 export must be bound to a recorded eligible incident';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_sync_offline_sale_with_allocations(uuid,uuid,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz,jsonb)');
  select pg_get_functiondef(fn) into def;
  if position('v_existing.total*100' in replace(def,' ',''))=0 then
    raise exception 'Offline retry must re-check the immutable sale total against the original line snapshot';
  end if;
end
$test$;
rollback;
