-- Run after migrations 0001-0020 in a disposable Supabase database.
begin;
do $$
declare fn regprocedure; def text;
begin
  if to_regclass('public.fiskalo_basic_pos_certificates') is null then
    raise exception 'ATK POS certificate registry is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.fiskalo_basic_pos_certificates'::regclass) then
    raise exception 'ATK POS certificate registry must have RLS enabled';
  end if;
  if has_table_privilege('authenticated','public.fiskalo_basic_pos_certificates','SELECT') or
     has_table_privilege('authenticated','public.fiskalo_basic_pos_certificates','INSERT') or
     has_table_privilege('anon','public.fiskalo_basic_pos_certificates','SELECT') then
    raise exception 'Browser roles must not read or write registered ATK certificates';
  end if;
  if not has_table_privilege('service_role','public.fiskalo_basic_pos_certificates','SELECT,INSERT,UPDATE') then
    raise exception 'ATK receipt Edge Function service role must manage the certificate registry';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_register_pos_certificate_v1(uuid,uuid,uuid,bigint,text,text,text)');
  if fn is null or not has_function_privilege('service_role',fn,'EXECUTE') or
     has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Certificate registration must be server-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('m.role=''owner''' in def)=0 or position('certificate_status' in def)=0 then
    raise exception 'Certificate registration must require owner membership and matching POS state';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_store_offline_receipt_v2(uuid,uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamp with time zone,text)');
  if fn is null or not has_function_privilege('service_role',fn,'EXECUTE') or
     has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Offline receipt persistence must be server-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('p_actor_id' in def)=0 or position('fiskalo_basic_members' in def)=0 or
     position('submission_state=''queued''' in def)=0 then
    raise exception 'Offline receipt persistence must bind an authenticated actor and preserve queued state';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_server_record_atk_receipt_v2(uuid,uuid,uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,text,bigint,timestamp with time zone,text)');
  if fn is null or not has_function_privilege('service_role',fn,'EXECUTE') or
     has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'ATK accepted receipt persistence must be server-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('fiskalo_basic_pos_certificates' in def)=0 or
     position('p_atk_transaction_id' in def)=0 or
     position('submission_state=''accepted''' in def)=0 then
    raise exception 'ATK accepted receipt persistence must require active certificate and actual ATK transaction';
  end if;
end $$;
rollback;
