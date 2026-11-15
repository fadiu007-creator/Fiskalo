begin;

-- Server-only registry of the public certificate issued for each Full Web POS.
-- The private key remains non-exportable in the browser profile and is never uploaded.
create table if not exists public.fiskalo_atk_pos_certificates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.fiskalo_organizations(id) on delete cascade,
  pos_installation_id uuid not null references public.fiskalo_atk_pos_installations(id) on delete cascade,
  certificate_pem text not null,
  spki_sha256 text not null check (spki_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active','revoked')),
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (pos_installation_id, spki_sha256),
  check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null))
);

create unique index if not exists fiskalo_atk_pos_certificates_one_active_per_pos
  on public.fiskalo_atk_pos_certificates(pos_installation_id)
  where status = 'active' and revoked_at is null;

create index if not exists fiskalo_atk_pos_certificates_org_pos_idx
  on public.fiskalo_atk_pos_certificates(organization_id, pos_installation_id, issued_at desc);

alter table public.fiskalo_atk_pos_certificates enable row level security;
revoke all on table public.fiskalo_atk_pos_certificates from public, anon, authenticated;
grant all on table public.fiskalo_atk_pos_certificates to service_role;
comment on table public.fiskalo_atk_pos_certificates is
  'Server-only registry of ATK-issued public POS certificates. Browser clients cannot insert, read, update, or revoke certificates.';

-- Enforce the current ATK product catalogues for Full as well as Basic.
-- NOT VALID preserves legacy rows for correction while checking every new/updated row.
do $catalogue$
begin
  if not exists (
    select 1 from pg_constraint where conrelid='public.fiskalo_products'::regclass
      and conname='fiskalo_products_atk_unit_2026_check'
  ) then
    alter table public.fiskalo_products add constraint fiskalo_products_atk_unit_2026_check
      check (atk_unit_code is not null and atk_unit_code in (
        'EA','CP','LTR','SEC','MIN','HUR','DAY','MON','ANN','KGB','KGN',
        'TN','GRM','M4','UDH','KMT','LM','MTS','MTV','MSK','KWH'
      )) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid='public.fiskalo_products'::regclass
      and conname='fiskalo_products_atk_category_2026_check'
  ) then
    alter table public.fiskalo_products add constraint fiskalo_products_atk_category_2026_check
      check (atk_item_category_code is not null and atk_item_category_code in (
        'TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB',
        'KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA',
        'KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM'
      )) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid='public.fiskalo_products'::regclass
      and conname='fiskalo_products_atk_vat_class_2026_check'
  ) then
    alter table public.fiskalo_products add constraint fiskalo_products_atk_vat_class_2026_check
      check (
        atk_tax_code is not null and vat_rate is not null and (
          (atk_tax_code in ('A','C') and vat_rate=0)
          or (atk_tax_code='D' and vat_rate=8)
          or (atk_tax_code='E' and vat_rate=18)
        )
      ) not valid;
  end if;
end
$catalogue$;

-- Fiscal acceptance and audit events are server-trusted facts, never browser-editable.
drop policy if exists fiskalo_atk_docs_insert_test on public.fiskalo_atk_fiscal_documents;
drop policy if exists fiskalo_atk_docs_update_test on public.fiskalo_atk_fiscal_documents;
drop policy if exists fiskalo_atk_events_insert_test on public.fiskalo_atk_fiscal_events;
drop policy if exists fiskalo_atk_verifications_insert_test on public.fiskalo_atk_pos_verifications;
drop policy if exists fiskalo_atk_verifications_update_test on public.fiskalo_atk_pos_verifications;
drop policy if exists fiskalo_atk_verifications_delete_test on public.fiskalo_atk_pos_verifications;
drop policy if exists fiskalo_atk_pos_update_test on public.fiskalo_atk_pos_installations;

revoke insert, update, delete on table public.fiskalo_atk_fiscal_documents from public, anon, authenticated;
revoke insert, update, delete on table public.fiskalo_atk_fiscal_events from public, anon, authenticated;
revoke insert, update, delete on table public.fiskalo_atk_pos_verifications from public, anon, authenticated;
revoke update, delete on table public.fiskalo_atk_pos_installations from public, anon, authenticated;

grant select on table public.fiskalo_atk_fiscal_documents to authenticated;
grant select on table public.fiskalo_atk_fiscal_events to authenticated;
grant select on table public.fiskalo_atk_pos_verifications to authenticated;
grant select, insert on table public.fiskalo_atk_pos_installations to authenticated;
grant all on table public.fiskalo_atk_pos_certificates to service_role;
grant all on table public.fiskalo_atk_fiscal_documents to service_role;
grant all on table public.fiskalo_atk_fiscal_events to service_role;
grant all on table public.fiskalo_atk_pos_verifications to service_role;
grant all on table public.fiskalo_atk_pos_installations to service_role;

commit;
