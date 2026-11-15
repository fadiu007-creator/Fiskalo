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

-- Enforce official ATK product codes for new products and changes to fiscal fields.
-- Existing legacy products can still receive non-fiscal stock/metadata updates, but
-- cannot be newly created or have fiscal fields changed with invalid ATK codes.
create or replace function public.fiskalo_validate_full_product_atk_catalogue()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if new.atk_unit_code is null or new.atk_unit_code not in (
    'EA','CP','LTR','SEC','MIN','HUR','DAY','MON','ANN','KGB','KGN',
    'TN','GRM','M4','UDH','KMT','LM','MTS','MTV','MSK','KWH'
  ) then
    raise exception 'Invalid ATK measurement unit code: %', new.atk_unit_code using errcode = '23514';
  end if;
  if new.atk_item_category_code is null or new.atk_item_category_code not in (
    'TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB',
    'KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA',
    'KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM'
  ) then
    raise exception 'Invalid ATK item category code: %', new.atk_item_category_code using errcode = '23514';
  end if;
  if not (
    (new.atk_tax_code in ('A','C') and new.vat_rate = 0)
    or (new.atk_tax_code = 'D' and new.vat_rate = 8)
    or (new.atk_tax_code = 'E' and new.vat_rate = 18)
  ) then
    raise exception 'ATK VAT code and VAT rate do not match.' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.fiskalo_validate_full_product_atk_catalogue() from public, anon, authenticated;
drop trigger if exists fiskalo_products_atk_catalogue_insert on public.fiskalo_products;
drop trigger if exists fiskalo_products_atk_catalogue_update on public.fiskalo_products;
create trigger fiskalo_products_atk_catalogue_insert
  before insert on public.fiskalo_products
  for each row execute function public.fiskalo_validate_full_product_atk_catalogue();
create trigger fiskalo_products_atk_catalogue_update
  before update of atk_unit_code, atk_item_category_code, atk_tax_code, vat_rate on public.fiskalo_products
  for each row execute function public.fiskalo_validate_full_product_atk_catalogue();

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
