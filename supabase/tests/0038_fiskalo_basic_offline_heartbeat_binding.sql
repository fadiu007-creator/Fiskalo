do $$
declare
  v_definition text;
begin
  v_definition := pg_catalog.pg_get_functiondef(
    'fiskalo_private.fiskalo_basic_bind_offline_heartbeat_evidence()'::regprocedure
  );
  if position('h.previous_heartbeat_at <= new.offline_issued_at' in v_definition) = 0
     or position('h.server_time_utc >= new.offline_issued_at' in v_definition) = 0
     or position('new.offline_issued_at >= h.server_time_utc - interval ''48 hours''' in v_definition) = 0 then
    raise exception 'Offline issue time must be bounded by the server-measured outage interval and 48-hour recovery window';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'fiskalo_basic_fiscal_documents'
      and column_name = 'outage_heartbeat_evidence_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'fiskalo_basic_fiscal_documents'
      and column_name = 'offline_time_evidence'
  ) then
    raise exception 'Fiscal documents are missing server heartbeat evidence linkage';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'fiskalo_basic_fiscal_documents'
      and t.tgname = 'fiskalo_basic_bind_offline_heartbeat_evidence'
      and not t.tgisinternal
  ) then
    raise exception 'Offline fiscal document heartbeat evidence trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'fiskalo_basic_fiscal_documents'
      and t.tgname = 'fiskalo_basic_bind_offline_heartbeat_evidence'
      and (t.tgattr::text like '%outage_heartbeat_evidence_id%' or
           t.tgattr::text like '%offline_time_evidence%')
  ) then
    -- Column numbers are stored in tgattr, so verify the canonical trigger definition below.
    if position('outage_heartbeat_evidence_id' in (
      select pg_catalog.pg_get_triggerdef(t.oid)
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      where c.relname = 'fiskalo_basic_fiscal_documents'
        and t.tgname = 'fiskalo_basic_bind_offline_heartbeat_evidence'
    )) = 0 then
      raise exception 'Evidence reference changes must invoke the heartbeat binding trigger';
    end if;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'fiskalo_private'
      and p.proname = 'fiskalo_basic_bind_offline_heartbeat_evidence'
      and p.prosecdef
  ) then
    raise exception 'Offline heartbeat trigger must remain SECURITY INVOKER';
  end if;

  if has_function_privilege(
    'authenticated',
    'fiskalo_private.fiskalo_basic_bind_offline_heartbeat_evidence()',
    'EXECUTE'
  ) then
    raise exception 'Browser roles must not invoke the internal heartbeat trigger function';
  end if;
end
$$;
