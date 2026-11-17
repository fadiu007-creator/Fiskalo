do $$
begin
  if to_regclass('public.fiskalo_atk_pos_heartbeat_evidence') is null then
    raise exception 'Signed POS heartbeat evidence table is missing';
  end if;

  if has_table_privilege('anon', 'public.fiskalo_atk_pos_heartbeat_evidence', 'SELECT')
     or has_table_privilege('anon', 'public.fiskalo_atk_pos_heartbeat_evidence', 'INSERT')
     or has_table_privilege('authenticated', 'public.fiskalo_atk_pos_heartbeat_evidence', 'SELECT')
     or has_table_privilege('authenticated', 'public.fiskalo_atk_pos_heartbeat_evidence', 'INSERT') then
    raise exception 'Browser roles must not read or write server heartbeat evidence';
  end if;

  if not has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'SELECT')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'INSERT')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'UPDATE')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'DELETE')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'TRUNCATE') then
    raise exception 'Heartbeat evidence must be readable but append-only through the trusted RPC';
  end if;

  if has_function_privilege(
       'anon',
       'public.fiskalo_record_atk_pos_heartbeat(uuid,uuid,uuid,timestamptz,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.fiskalo_record_atk_pos_heartbeat(uuid,uuid,uuid,timestamptz,text,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.fiskalo_record_atk_pos_heartbeat(uuid,uuid,uuid,timestamptz,text,text)',
       'EXECUTE'
     ) then
    raise exception 'Only service_role may append signed heartbeat evidence';
  end if;
end
$$;
