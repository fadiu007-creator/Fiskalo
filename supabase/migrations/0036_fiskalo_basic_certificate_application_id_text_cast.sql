-- Correctly compare the Basic POS Application ID stored as text with the
-- bigint application identifier returned by ATK verification.
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
