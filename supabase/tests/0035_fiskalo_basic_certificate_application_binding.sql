begin;
do $$
declare
  status_definition text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_pos_certificates'
      and column_name='application_id' and is_nullable='NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_pos_certificates'
      and column_name='spki_sha256' and is_nullable='NO'
  ) then
    raise exception 'Basic certificate registry must bind Application ID and SPKI fingerprint';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_basic_pos_certificates'::regclass
      and conname='fiskalo_basic_pos_certificates_pos_id_key'
  ) then
    raise exception 'Basic certificate registry must retain multiple certificates per POS';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='fiskalo_basic_pos_certificates'
      and indexname='fiskalo_basic_one_active_certificate_per_pos'
  ) then
    raise exception 'Basic certificate registry must enforce one active certificate per POS';
  end if;

  select pg_get_constraintdef(oid) into status_definition
  from pg_constraint
  where conrelid='public.fiskalo_basic_pos_certificates'::regclass
    and conname='fiskalo_basic_pos_certificates_status_check';
  if status_definition is null or position('superseded' in status_definition)=0 then
    raise exception 'Basic certificate lifecycle must preserve superseded certificates';
  end if;

  if has_function_privilege('authenticated','public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)','EXECUTE')
     or not has_function_privilege('service_role','public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)','EXECUTE') then
    raise exception 'Only the server role may register Basic POS certificates';
  end if;
end $$;
rollback;
