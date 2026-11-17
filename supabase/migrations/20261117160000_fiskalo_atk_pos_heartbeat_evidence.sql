-- Server-authenticated, append-only POS heartbeat evidence for ATK TEST outage timing.
create table if not exists public.fiskalo_atk_pos_heartbeat_evidence (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete restrict,
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  environment text not null check (environment = 'ATK TEST'),
  server_time_utc timestamptz not null,
  previous_heartbeat_at timestamptz,
  gap_seconds integer check (gap_seconds is null or gap_seconds >= 0),
  nonce_sha256 text not null check (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  signature_base64 text not null check (signature_base64 ~ '^[A-Za-z0-9+/]{80,256}={0,2}$'),
  created_at timestamptz not null default now(),
  constraint fiskalo_atk_pos_heartbeat_nonce_unique unique (pos_id, nonce_sha256)
);

create index if not exists fiskalo_atk_pos_heartbeat_latest_idx
  on public.fiskalo_atk_pos_heartbeat_evidence (business_id, pos_id, server_time_utc desc);

alter table public.fiskalo_atk_pos_heartbeat_evidence enable row level security;
revoke all on table public.fiskalo_atk_pos_heartbeat_evidence from public, anon, authenticated;
revoke update, delete, truncate on table public.fiskalo_atk_pos_heartbeat_evidence from service_role;
grant select, insert on table public.fiskalo_atk_pos_heartbeat_evidence to service_role;

create or replace function public.fiskalo_record_atk_pos_heartbeat(
  p_business_id uuid,
  p_pos_id uuid,
  p_actor_id uuid,
  p_server_time_utc timestamptz,
  p_nonce_sha256 text,
  p_signature_base64 text
) returns table(previous_heartbeat_at timestamptz, gap_seconds integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_previous timestamptz;
  v_gap_seconds integer;
begin
  if p_business_id is null or p_pos_id is null or p_actor_id is null or
     p_server_time_utc is null or
     p_server_time_utc > now() + interval '2 minutes' or
     coalesce(p_nonce_sha256, '') !~ '^[0-9a-f]{64}
     coalesce(p_signature_base64, '') !~ '^[A-Za-z0-9+/]{80,256}={0,2}$' then
    raise exception 'Invalid signed POS heartbeat evidence';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_pos_id::text, 0)
  );

  select max(e.server_time_utc)
    into v_previous
  from public.fiskalo_atk_pos_heartbeat_evidence e
  where e.business_id = p_business_id
    and e.pos_id = p_pos_id;

  if v_previous is not null and p_server_time_utc <= v_previous then
    raise exception 'Heartbeat server timestamp must be strictly increasing';
  end if;

  if v_previous is null then
    v_gap_seconds := null;
  else
    v_gap_seconds := greatest(
      0,
      floor(extract(epoch from (p_server_time_utc - v_previous)))::integer
    );
  end if;

  insert into public.fiskalo_atk_pos_heartbeat_evidence (
    business_id, pos_id, actor_id, environment, server_time_utc,
    previous_heartbeat_at, gap_seconds, nonce_sha256, signature_base64
  ) values (
    p_business_id, p_pos_id, p_actor_id, 'ATK TEST', p_server_time_utc,
    v_previous, v_gap_seconds, p_nonce_sha256, p_signature_base64
  );

  return query select v_previous, v_gap_seconds;
end;
$$;

revoke all on function public.fiskalo_record_atk_pos_heartbeat(
  uuid, uuid, uuid, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.fiskalo_record_atk_pos_heartbeat(
  uuid, uuid, uuid, timestamptz, text, text
) to service_role;
 or
     coalesce(p_signature_base64, '') !~ '^[A-Za-z0-9+/]{80,256}={0,2}$' then
    raise exception 'Invalid signed POS heartbeat evidence';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_pos_id::text, 0)
  );

  select max(e.server_time_utc)
    into v_previous
  from public.fiskalo_atk_pos_heartbeat_evidence e
  where e.business_id = p_business_id
    and e.pos_id = p_pos_id;

  if v_previous is not null and p_server_time_utc <= v_previous then
    raise exception 'Heartbeat server timestamp must be strictly increasing';
  end if;

  if v_previous is null then
    v_gap_seconds := null;
  else
    v_gap_seconds := greatest(
      0,
      floor(extract(epoch from (p_server_time_utc - v_previous)))::integer
    );
  end if;

  insert into public.fiskalo_atk_pos_heartbeat_evidence (
    business_id, pos_id, actor_id, environment, server_time_utc,
    previous_heartbeat_at, gap_seconds, nonce_sha256, signature_base64
  ) values (
    p_business_id, p_pos_id, p_actor_id, 'ATK TEST', p_server_time_utc,
    v_previous, v_gap_seconds, p_nonce_sha256, p_signature_base64
  );

  return query select v_previous, v_gap_seconds;
end;
$$;

revoke all on function public.fiskalo_record_atk_pos_heartbeat(
  uuid, uuid, uuid, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.fiskalo_record_atk_pos_heartbeat(
  uuid, uuid, uuid, timestamptz, text, text
) to service_role;
