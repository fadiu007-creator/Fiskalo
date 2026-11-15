-- Live/staging-only contract for the Full Fiskalo server-trusted fiscal-write migration.
-- Run against a database containing the Full Fiskalo schema after applying
-- fiskalo_full_server_trusted_fiscal_writes.sql.
begin;
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_atk_pos_certificates'
      and column_name='application_id' and is_nullable='NO'
  ) then
    raise exception 'ATK certificate registry must require the bound application ID';
  end if;
  if has_function_privilege('authenticated','public.fiskalo_server_register_atk_pos_certificate_v1(uuid,uuid,bigint,text,text,timestamp with time zone,uuid)','EXECUTE')
     or not has_function_privilege('service_role','public.fiskalo_server_register_atk_pos_certificate_v1(uuid,uuid,bigint,text,text,timestamp with time zone,uuid)','EXECUTE') then
    raise exception 'Only the server role may register an ATK certificate';
  end if;
  if not has_table_privilege('authenticated','public.fiskalo_atk_fiscal_documents','SELECT')
     or has_table_privilege('authenticated','public.fiskalo_atk_fiscal_documents','INSERT')
     or has_table_privilege('authenticated','public.fiskalo_atk_fiscal_documents','UPDATE')
     or has_table_privilege('authenticated','public.fiskalo_atk_fiscal_documents','DELETE') then
    raise exception 'Full fiscal documents must be readable but not client-writable';
  end if;
  if has_table_privilege('authenticated','public.fiskalo_atk_fiscal_events','INSERT')
     or has_table_privilege('authenticated','public.fiskalo_atk_fiscal_events','UPDATE')
     or has_table_privilege('authenticated','public.fiskalo_atk_fiscal_events','DELETE') then
    raise exception 'Full fiscal events must be server-write-only';
  end if;
  if has_table_privilege('authenticated','public.fiskalo_atk_pos_verifications','INSERT')
     or has_table_privilege('authenticated','public.fiskalo_atk_pos_verifications','UPDATE')
     or has_table_privilege('authenticated','public.fiskalo_atk_pos_verifications','DELETE') then
    raise exception 'ATK POS verifications must be server-write-only';
  end if;
  if has_table_privilege('authenticated','public.fiskalo_atk_pos_certificates','SELECT')
     or has_table_privilege('authenticated','public.fiskalo_atk_pos_certificates','INSERT')
     or has_table_privilege('authenticated','public.fiskalo_atk_pos_certificates','UPDATE')
     or has_table_privilege('authenticated','public.fiskalo_atk_pos_certificates','DELETE') then
    raise exception 'ATK POS certificate registry must remain server-only';
  end if;
  if not has_table_privilege('authenticated','public.fiskalo_atk_pos_installations','SELECT')
     or not has_table_privilege('authenticated','public.fiskalo_atk_pos_installations','INSERT')
     or has_table_privilege('authenticated','public.fiskalo_atk_pos_installations','UPDATE')
     or has_table_privilege('authenticated','public.fiskalo_atk_pos_installations','DELETE') then
    raise exception 'Browser POS installation privileges do not match the approved setup boundary';
  end if;
  if not has_table_privilege('service_role','public.fiskalo_atk_fiscal_documents','INSERT')
     or not has_table_privilege('service_role','public.fiskalo_atk_fiscal_events','INSERT')
     or not has_table_privilege('service_role','public.fiskalo_atk_pos_certificates','INSERT') then
    raise exception 'Cloudflare service role is missing trusted fiscal write access';
  end if;

  select organization_id,id,created_by into test_org,test_pos,test_user
  from public.fiskalo_atk_pos_installations
  where environment='test' and created_by is not null
  order by id limit 1;
  if test_org is null or test_pos is null or test_user is null then
    raise exception 'A test POS fixture is required to verify certificate rotation';
  end if;

  first_certificate := public.fiskalo_server_register_atk_pos_certificate_v1(
    test_org,test_pos,111111,
    '-----BEGIN CERTIFICATE-----\nTEST-OLD-CERTIFICATE\n-----END CERTIFICATE-----',
    repeat('a',64),now(),test_user
  );
  second_certificate := public.fiskalo_server_register_atk_pos_certificate_v1(
    test_org,test_pos,222222,
    '-----BEGIN CERTIFICATE-----\nTEST-NEW-CERTIFICATE\n-----END CERTIFICATE-----',
    repeat('b',64),now(),test_user
  );
  select status,revoked_at into old_status,old_revoked_at
  from public.fiskalo_atk_pos_certificates where id=first_certificate;
  select status into new_status
  from public.fiskalo_atk_pos_certificates where id=second_certificate;
  if old_status <> 'superseded' or old_revoked_at is not null or new_status <> 'active' then
    raise exception 'Certificate rotation did not preserve the historical application certificate';
  end if;
  if (select application_id from public.fiskalo_atk_pos_certificates where id=first_certificate) <> 111111
     or (select application_id from public.fiskalo_atk_pos_certificates where id=second_certificate) <> 222222 then
    raise exception 'Certificate application ID binding was not preserved';
  end if;
end $$;
rollback;
