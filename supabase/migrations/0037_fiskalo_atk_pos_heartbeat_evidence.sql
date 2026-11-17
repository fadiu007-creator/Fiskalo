-- Append-only, service-role-only evidence of authenticated server-signed POS heartbeats.
create table if not exists public.fiskalo_atk_pos_heartbeat_evidence (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  pos_id uuid not null,
  actor_id uuid not null,
  environment text not null check (environment = 'ATK TEST'),
  server_time_utc timestamptz not null,
  nonce_sha256 text not null check (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  signature_base64 text not null check (length(signature_base64) between 80 and 256),
  created_at timestamptz not null default now(),
  constraint fiskalo_atk_pos_heartbeat_nonce_unique unique (pos_id, nonce_sha256)
);

create index if not exists fiskalo_atk_pos_heartbeat_latest_idx
  on public.fiskalo_atk_pos_heartbeat_evidence (business_id, pos_id, server_time_utc desc);

alter table public.fiskalo_atk_pos_heartbeat_evidence enable row level security;
revoke all on table public.fiskalo_atk_pos_heartbeat_evidence from public, anon, authenticated;
revoke update, delete, truncate on table public.fiskalo_atk_pos_heartbeat_evidence from service_role;
grant select, insert on table public.fiskalo_atk_pos_heartbeat_evidence to service_role;
