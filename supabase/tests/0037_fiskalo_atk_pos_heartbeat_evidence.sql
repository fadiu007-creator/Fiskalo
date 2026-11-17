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

  if not has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'INSERT')
     or not has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'SELECT') then
    raise exception 'Service role must be able to append and inspect heartbeat evidence';
  end if;

  if has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'UPDATE')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'DELETE')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'TRUNCATE') then
    raise exception 'Heartbeat evidence must be append-only';
  end if;
end
$$;
