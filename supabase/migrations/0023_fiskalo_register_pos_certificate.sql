-- Atomically register the ATK-issued public certificate and POS state.
create or replace function public.fiskalo_basic_server_register_pos_certificate_v1(
  p_business_id uuid,
  p_pos_record_id uuid,
  p_certificate_pem text,
  p_verified_business_name text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_business_id is null or p_pos_record_id is null or
     coalesce(p_certificate_pem,'') !~ '-----BEGIN CERTIFICATE-----' or
     length(p_certificate_pem)>16384 or
     length(trim(coalesce(p_verified_business_name,'')))<2 then
    raise exception 'ATK certificate registration input is invalid';
  end if;

  update public.fiskalo_basic_pos
    set certificate_status='certificate_issued',
        verified_business_name=trim(p_verified_business_name)
    where id=p_pos_record_id and business_id=p_business_id;
  if not found then raise exception 'POS does not belong to the selected business'; end if;

  insert into public.fiskalo_basic_pos_certificates(business_id,pos_id,certificate_pem,updated_at)
  values(p_business_id,p_pos_record_id,p_certificate_pem,now())
  on conflict (pos_id) do update
    set business_id=excluded.business_id,
        certificate_pem=excluded.certificate_pem,
        updated_at=now();
end;
$$;

revoke all on function public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,text,text)
  to service_role;
