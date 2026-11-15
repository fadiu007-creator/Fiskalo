begin;
do $$
declare
  function_definition text;
begin
  select pg_get_functiondef('public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)'::regprocedure)
    into function_definition;
  if position('application_id::bigint=p_application_id' in function_definition)=0 then
    raise exception 'Basic certificate registration must safely compare the text Application ID to the verified bigint ID';
  end if;
  if has_function_privilege('authenticated','public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)','EXECUTE')
     or not has_function_privilege('service_role','public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)','EXECUTE') then
    raise exception 'Basic certificate registration must remain server-only';
  end if;
end $$;
rollback;
