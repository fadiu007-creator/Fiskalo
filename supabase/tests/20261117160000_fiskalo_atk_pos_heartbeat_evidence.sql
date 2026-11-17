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
     or not has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'INSERT')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'UPDATE')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'DELETE')
     or has_table_privilege('service_role', 'public.fiskalo_atk_pos_heartbeat_evidence', 'TRUNCATE') then
    raise exception 'Heartbeat evidence must remain append-only';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'fiskalo_record_atk_pos_heartbeat'
      and p.prosecdef
  ) then
    raise exception 'Heartbeat RPC must remain SECURITY INVOKER';
  end if;

  if has_function_privilege(
       'anon',
       'public.fiskalo_record_atk_pos_heartbeat(uuid,uuid,uuid,timestamptz,text,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.fiskalo_record_atk_pos_heartbeat(uuid,uuid,uuid,timestamptz,text,text,text)',
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

begin;
insert into auth.users(id,email)
values ('11111111-1111-4111-8111-111111111111','heartbeat-test@example.invalid');
insert into public.fiskalo_basic_businesses(id,name,nui,created_by)
values ('22222222-2222-4222-8222-222222222222','Heartbeat Test','123456789','11111111-1111-4111-8111-111111111111');
insert into public.fiskalo_basic_pos(id,business_id,label,location,branch_id,pos_id,fiscalization_number)
values ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','Test POS','Test location',1,1,'123456789');

set local role service_role;
do $$
declare
  v_first record;
  v_second record;
  v_count integer;
begin
  select * into v_first from public.fiskalo_record_atk_pos_heartbeat(
    '22222222-2222-4222-8222-222222222222'::uuid,
    '33333333-3333-4333-8333-333333333333'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    '2026-11-17T10:00:00Z'::timestamptz,
    repeat('A',43),
    repeat('a',64),
    repeat('A',86) || '=='
  );
  if v_first.previous_heartbeat_at is not null or v_first.gap_seconds is not null then
    raise exception 'First heartbeat must not report a previous heartbeat or gap';
  end if;

  select * into v_second from public.fiskalo_record_atk_pos_heartbeat(
    '22222222-2222-4222-8222-222222222222'::uuid,
    '33333333-3333-4333-8333-333333333333'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    '2026-11-17T10:01:00Z'::timestamptz,
    repeat('B',43),
    repeat('b',64),
    repeat('A',86) || '=='
  );
  if v_second.previous_heartbeat_at is distinct from '2026-11-17T10:00:00Z'::timestamptz
     or v_second.gap_seconds is distinct from 60 then
    raise exception 'Heartbeat ledger must atomically return the previous timestamp and gap';
  end if;

  begin
    perform public.fiskalo_record_atk_pos_heartbeat(
      '22222222-2222-4222-8222-222222222222'::uuid,
      '33333333-3333-4333-8333-333333333333'::uuid,
      '11111111-1111-4111-8111-111111111111'::uuid,
      '2026-11-17T10:01:00Z'::timestamptz,
      repeat('C',43),
      repeat('c',64),
      repeat('A',86) || '=='
    );
    raise exception 'A distinct nonce with a duplicate timestamp must be rejected';
  exception when raise_exception then
    if sqlerrm = 'A distinct nonce with a duplicate timestamp must be rejected' then raise; end if;
  end;

  begin
    perform public.fiskalo_record_atk_pos_heartbeat(
      '22222222-2222-4222-8222-222222222222'::uuid,
      '33333333-3333-4333-8333-333333333333'::uuid,
      '11111111-1111-4111-8111-111111111111'::uuid,
      '2026-11-17T10:02:00Z'::timestamptz,
      repeat('B',43),
      repeat('b',64),
      repeat('A',86) || '=='
    );
    raise exception 'A replayed nonce must be rejected';
  exception when unique_violation then
    null;
  end;

  select count(*) into v_count from public.fiskalo_atk_pos_heartbeat_evidence
  where business_id='22222222-2222-4222-8222-222222222222'
    and pos_id='33333333-3333-4333-8333-333333333333';
  if v_count <> 2 then raise exception 'Rejected heartbeat attempts must not append evidence'; end if;
end
$$;
rollback;
