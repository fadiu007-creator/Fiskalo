-- Preserve certificate/application identity so corrections use the certificate
-- that signed the original accepted sale, even after a POS is re-verified.
alter table public.fiskalo_atk_pos_certificates
  add column if not exists application_id bigint;

do $$
begin
  if exists (
    select 1 from public.fiskalo_atk_pos_certificates
    where application_id is null or application_id <= 0
  ) then
    raise exception 'Existing ATK certificate records need an application ID before this migration can continue';
  end if;
  alter table public.fiskalo_atk_pos_certificates
    alter column application_id set not null;
end $$;

alter table public.fiskalo_atk_pos_certificates
  drop constraint if exists fiskalo_atk_pos_certificates_check;
alter table public.fiskalo_atk_pos_certificates
  drop constraint if exists fiskalo_atk_pos_certificates_status_check;
alter table public.fiskalo_atk_pos_certificates
  add constraint fiskalo_atk_pos_certificates_application_id_check
    check (application_id > 0);
alter table public.fiskalo_atk_pos_certificates
  add constraint fiskalo_atk_pos_certificates_status_check
    check (status in ('active','superseded','revoked'));
alter table public.fiskalo_atk_pos_certificates
  add constraint fiskalo_atk_pos_certificates_lifecycle_check
    check (
      (status in ('active','superseded') and revoked_at is null)
      or (status='revoked' and revoked_at is not null)
    );

create or replace function public.fiskalo_server_register_atk_pos_certificate_v1(
  p_organization_id uuid,
  p_pos_installation_id uuid,
  p_application_id bigint,
  p_certificate_pem text,
  p_spki_sha256 text,
  p_issued_at timestamptz,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  certificate_id uuid := gen_random_uuid();
begin
  if p_organization_id is null or p_pos_installation_id is null or
     p_application_id is null or p_application_id <= 0 or
     coalesce(p_certificate_pem,'') !~ '-----BEGIN CERTIFICATE-----' or
     length(p_certificate_pem)>20000 or
     coalesce(p_spki_sha256,'') !~ '^[a-f0-9]{64}$' or
     p_issued_at is null or p_created_by is null then
    raise exception 'ATK certificate registration input is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_pos_installation_id::text,0)
  );

  if not exists (
    select 1 from public.fiskalo_atk_pos_installations p
    where p.id=p_pos_installation_id
      and p.organization_id=p_organization_id
      and p.environment='test'
  ) then
    raise exception 'ATK TEST POS does not belong to this organization';
  end if;

  -- Superseded certificates are retained for corrections referencing sales
  -- originally signed under their application ID. Only actual ATK revocation
  -- sets revoked_at and makes a certificate unusable.
  update public.fiskalo_atk_pos_certificates
  set status='superseded'
  where organization_id=p_organization_id
    and pos_installation_id=p_pos_installation_id
    and status='active'
    and revoked_at is null;

  insert into public.fiskalo_atk_pos_certificates(
    id,organization_id,pos_installation_id,application_id,certificate_pem,
    spki_sha256,status,issued_at,revoked_at,created_by
  ) values (
    certificate_id,p_organization_id,p_pos_installation_id,p_application_id,
    p_certificate_pem,p_spki_sha256,'active',p_issued_at,null,p_created_by
  );

  update public.fiskalo_atk_pos_installations
  set status='active'
  where id=p_pos_installation_id
    and organization_id=p_organization_id
    and environment='test';

  return certificate_id;
end;
$$;

revoke all on function public.fiskalo_server_register_atk_pos_certificate_v1(uuid,uuid,bigint,text,text,timestamptz,uuid)
  from public,anon,authenticated;
grant execute on function public.fiskalo_server_register_atk_pos_certificate_v1(uuid,uuid,bigint,text,text,timestamptz,uuid)
  to service_role;

comment on column public.fiskalo_atk_pos_certificates.application_id is
  'ATK TEST Application ID bound to this issued certificate; corrections must select the certificate matching the original accepted coupon.';
