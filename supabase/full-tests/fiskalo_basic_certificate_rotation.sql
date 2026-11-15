-- Live/staging-only Basic certificate rotation test.
-- Creates a temporary business/POS fixture and rolls it back after verifying
-- that a second Application ID supersedes, but does not revoke, the first cert.
begin;
do $$
declare
  actor_id uuid;
  test_business_id uuid := gen_random_uuid();
  test_pos_id uuid := gen_random_uuid();
  old_certificate uuid;
  new_certificate uuid;
  old_status text;
  old_revoked_at timestamptz;
  new_status text;
begin
  select created_by into actor_id
  from public.fiskalo_atk_pos_installations
  where created_by is not null
  order by id limit 1;
  if actor_id is null then raise exception 'No test actor is available'; end if;

  insert into public.fiskalo_basic_businesses(id,name,nui,created_by)
  values(test_business_id,'Fiskalo Certificate Test','987654321',actor_id);

  insert into public.fiskalo_basic_pos(
    id,business_id,label,location,branch_id,pos_id,fiscalization_number,
    application_id,certificate_status
  ) values(
    test_pos_id,test_business_id,'Test POS','Ferizaj',1,99,'987654321','111111','verified'
  );

  old_certificate := public.fiskalo_basic_server_register_pos_certificate_v1(
    test_business_id,test_pos_id,111111,
    '-----BEGIN CERTIFICATE-----\nTEST-OLD\n-----END CERTIFICATE-----',
    repeat('a',64),'Fiskalo Certificate Test'
  );
  update public.fiskalo_basic_pos set application_id='222222',certificate_status='verified'
  where id=test_pos_id;
  new_certificate := public.fiskalo_basic_server_register_pos_certificate_v1(
    test_business_id,test_pos_id,222222,
    '-----BEGIN CERTIFICATE-----\nTEST-NEW\n-----END CERTIFICATE-----',
    repeat('b',64),'Fiskalo Certificate Test'
  );

  select status,revoked_at into old_status,old_revoked_at
  from public.fiskalo_basic_pos_certificates where id=old_certificate;
  select status into new_status
  from public.fiskalo_basic_pos_certificates where id=new_certificate;
  if old_status <> 'superseded' or old_revoked_at is not null or new_status <> 'active' then
    raise exception 'Basic certificate rotation did not preserve the old certificate';
  end if;
  if (select application_id from public.fiskalo_basic_pos_certificates where id=old_certificate) <> 111111
     or (select application_id from public.fiskalo_basic_pos_certificates where id=new_certificate) <> 222222 then
    raise exception 'Basic certificate Application ID binding failed';
  end if;
end $$;
rollback;
