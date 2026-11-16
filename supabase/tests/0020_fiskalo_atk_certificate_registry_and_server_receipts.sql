-- Run after migrations 0001-0020 in a disposable Supabase database.
begin;
do $$
declare fn regprocedure; def text;
begin
  if to_regclass('public.fiskalo_basic_pos_certificates') is null then
    raise exception 'The existing Basic ATK POS certificate registry is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.fiskalo_basic_pos_certificates'::regclass) then
    raise exception 'ATK POS certificate registry must have RLS enabled';
  end if;
  if not exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_pos_certificates' and column_name='spki_sha256') then
    raise exception 'ATK certificate registry must bind the public key fingerprint';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_server_queue_atk_receipt_v2(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,timestamp with time zone,text)');
  if fn is null or not has_function_privilege('service_role',fn,'EXECUTE') or
     has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Offline receipt queue writer must be server-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('fiskalo_basic_pos_certificates' in def)=0 or
     position('p_offline_issued_at>now()' in replace(def,' ',''))=0 then
    raise exception 'Offline queue writer must bind an active POS certificate and reject future issue timestamps';
  end if;
  if position('p_offline_issued_at + interval ''48 hours'' <= now()' in def)>0 then
    raise exception 'Offline queue writer must not discard documents after the 48-hour escalation deadline';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_server_record_atk_receipt_v2(uuid,uuid,uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,text,bigint,timestamp with time zone,text)');
  if fn is null or not has_function_privilege('service_role',fn,'EXECUTE') or
     has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'ATK accepted receipt writer must be server-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('fiskalo_basic_pos_certificates' in def)=0 or
     position('fiskalo_basic_server_record_atk_receipt' in def)=0 then
    raise exception 'ATK accepted receipt writer must require active certificate and trusted server writer';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_server_register_pos_certificate_v1(uuid,uuid,bigint,text,text,text)');
  if fn is null or not has_function_privilege('service_role',fn,'EXECUTE') or
     has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'ATK certificate registration must remain server-only';
  end if;
end $$;
rollback;
