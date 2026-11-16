begin;
do $test$
declare fn regprocedure; def text;
begin
  fn:=to_regprocedure('public.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Article 44 export RPC privileges are incorrect';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)');
  select pg_get_functiondef(fn) into def;
  if position('submission_state<>''accepted''' in replace(def,' ',''))=0 or
     position('d.offline_issued_at' in def)=0 or
     position('role=''owner''' in replace(def,' ',''))=0 then
    raise exception 'Article 44 export must include every unaccepted offline document and enforce owner access';
  end if;
end
$test$;
rollback;
