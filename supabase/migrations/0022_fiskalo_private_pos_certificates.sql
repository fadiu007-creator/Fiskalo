-- Public certificate material is server-managed and must not be writable by browser roles.
create table if not exists public.fiskalo_basic_pos_certificates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  pos_id uuid not null unique references public.fiskalo_basic_pos(id) on delete cascade,
  certificate_pem text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fiskalo_basic_pos_certificates enable row level security;
revoke all on table public.fiskalo_basic_pos_certificates from public,anon,authenticated;
grant select,insert,update,delete on table public.fiskalo_basic_pos_certificates to service_role;

alter table public.fiskalo_basic_pos drop column if exists atk_certificate_pem;

notify pgrst, 'reload schema';
