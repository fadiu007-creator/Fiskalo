-- Bind Basic POS certificates to the ATK Application ID and retain superseded
-- certificates so corrections can be signed under the original sale identity.
alter table public.fiskalo_basic_pos_certificates
  add column if not exists application_id bigint,
  add column if not exists spki_sha256 text,
  add column if not exists status text not null default 'active',
  add column if not exists issued_at timestamptz not null default now(),
  add column if not exists revoked_at timestamptz;

do $$
begin
  if exists (
    select 1 from public.fiskalo_basic_pos_certificates
    where application_id is null or application_id <= 0
       or spki_sha256 is null or spki_sha256 !~ '^[a-f0-9]{64}$'
  ) then
    raise exception 'Existing Basic POS certificate records need an application ID and SPKI fingerprint before migration';
  end if;
  alter table public.fiskalo_basic_pos_certificates alter column application_id set not null;
  alter table public.fiskalo_basic_pos_certificates alter column spki_sha256 set not null;
end $$;

alter table public.fiskalo_basic_pos_certificates
  drop constraint if exists fiskalo_basic_pos_certificates_pos_id_key;
alter table public.fiskalo_basic_pos_certificates
  add constraint fiskalo_basic_pos_certificates_application_id_check check (application_id > 0);
alter table public.fiskalo_basic_pos_certificates
  add constraint fiskalo_basic_pos_certificates_spki_sha256_check check (spki_sha256 ~ '^[a-f0-9]{64}$');
alter table public.fiskalo_basic_pos_certificates
  add constraint fiskalo_basic_pos_certificates_status_check check (status in ('active','superseded','revoked'));
alter table public.fiskalo_basic_pos_certificates
  add constraint fiskalo_basic_pos_certificates_lifecycle_check
  check (
    (status in ('active','superseded') and revoked_at is null)
    or (status='revoked' and revoked_at is not null)
  );
create unique index if not exists fiskalo_basic_one_active_certificate_per_pos
  on public.fiskalo_basic_pos_certificates(pos_id)
  where status='active' and revoked_at is null;
create index if not exists fiskalo_basic_certificate_pos_application_idx
  on public.fiskalo_basic_pos_certificates(pos_id,application_id,issued_at desc)
  where revoked_at is null;

drop function if exists public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,text,text);

create or replace function public.fiskalo_basic_server_register_pos_certificate_v1(
  p_business_id uuid,
  p_pos_record_id uuid,
  p_application_id bigint,
  p_certificate_pem text,
  p_spki_sha256 text,
  p_verified_business_name text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  certificate_id uuid := gen_random_uuid();
begin
  if p_business_id is null or p_pos_record_id is null or
     p_application_id is null or p_application_id <= 0 or
     coalesce(p_certificate_pem,'') !~ '-----BEGIN CERTIFICATE-----' or
     length(p_certificate_pem)>16384 or
     coalesce(p_spki_sha256,'') !~ '^[a-f0-9]{64}$' or
     length(trim(coalesce(p_verified_business_name,'')))<2 then
    raise exception 'ATK Basic certificate registration input is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_pos_record_id::text,0)
  );

  if not exists (
    select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_record_id
      and p.business_id=p_business_id
      and p.application_id ~ '^[0-9]+$'
      and p.certificate_status='verified'
  ) then
    raise exception 'ATK Application ID is not verified for this Basic POS';
  end if;

  update public.fiskalo_basic_pos_certificates
  set status='superseded'
  where business_id=p_business_id
    and pos_id=p_pos_record_id
    and status='active'
    and revoked_at is null;

  insert into public.fiskalo_basic_pos_certificates(
    id,business_id,pos_id,application_id,certificate_pem,spki_sha256,
    status,issued_at,revoked_at,updated_at
  ) values (
    certificate_id,p_business_id,p_pos_record_id,p_application_id,
    p_certificate_pem,p_spki_sha256,'active',now(),null,now()
  );

  update public.fiskalo_basic_pos
  set certificate_status='certificate_issued',
      verified_business_name=trim(p_verified_business_name)
  where id=p_pos_record_id and business_id=p_business_id;

  return certificate_id;
end;
$$;

revoke all on function public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)
  from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)
  to service_role;

notify pgrst, 'reload schema';

      and p.application_id::bigint=p_application_id
      and p.certificate_status='verified'
  ) then
    raise exception 'ATK Application ID is not verified for this Basic POS';
  end if;

  update public.fiskalo_basic_pos_certificates
  set status='superseded'
  where business_id=p_business_id
    and pos_id=p_pos_record_id
    and status='active'
    and revoked_at is null;

  insert into public.fiskalo_basic_pos_certificates(
    id,business_id,pos_id,application_id,certificate_pem,spki_sha256,
    status,issued_at,revoked_at,updated_at
  ) values (
    certificate_id,p_business_id,p_pos_record_id,p_application_id,
    p_certificate_pem,p_spki_sha256,'active',now(),null,now()
  );

  update public.fiskalo_basic_pos
  set certificate_status='certificate_issued',
      verified_business_name=trim(p_verified_business_name)
  where id=p_pos_record_id and business_id=p_business_id;

  return certificate_id;
end;
$$;

revoke all on function public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)
  from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)
  to service_role;

notify pgrst, 'reload schema';
