do $$
declare
  v_function_definition text;
  v_trigger_definition text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_fiscal_documents'
      and column_name='outage_heartbeat_evidence_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_fiscal_documents'
      and column_name='offline_time_evidence'
  ) then
    raise exception 'Fiscal documents are missing server heartbeat evidence linkage';
  end if;

  v_function_definition := pg_catalog.pg_get_functiondef(
    'fiskalo_private.fiskalo_basic_bind_offline_heartbeat_evidence()'::regprocedure
  );
  if position('old.offline_time_evidence is distinct from ''legacy_unverified''' in v_function_definition)=0
     or position('new.offline_issued_at >= h.previous_heartbeat_at - interval ''2 minutes''' in v_function_definition)=0
     or position('new.offline_issued_at <= h.server_time_utc + interval ''2 minutes''' in v_function_definition)=0
     or position('coalesce(v_gap_seconds, 0) > 90' in v_function_definition)=0
     or position('new.recovery_deadline_at := v_outage_started_at + interval ''48 hours''' in v_function_definition)=0 then
    raise exception 'Offline issue time must be bounded by a server heartbeat interval and deadline';
  end if;

  select pg_catalog.pg_get_triggerdef(t.oid) into v_trigger_definition
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid=t.tgrelid
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='fiskalo_basic_fiscal_documents'
    and t.tgname='fiskalo_basic_bind_offline_heartbeat_evidence' and not t.tgisinternal;

  if v_trigger_definition is null
     or position('outage_heartbeat_evidence_id' in v_trigger_definition)=0
     or position('offline_time_evidence' in v_trigger_definition)=0
     or position('recovery_deadline_at' in v_trigger_definition)=0
     or position('business_id' in v_trigger_definition)=0
     or position('sale_id' in v_trigger_definition)=0 then
    raise exception 'Evidence reference changes must invoke the heartbeat binding trigger';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='fiskalo_private'
      and p.proname='fiskalo_basic_bind_offline_heartbeat_evidence'
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
