-- Run after migrations 0001-0015 in a Supabase SQL session.
-- Static schema/privilege contract only; runtime authorization tests require JWT claims.
begin;
do $$
declare
  helper_oid oid;
  public_oid oid;
  definition text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_fiscal_documents'
      and column_name='parent_document_id' and data_type='uuid'
  ) then raise exception 'Correction documents must persist their original document link'; end if;

  helper_oid:=to_regprocedure(
    'fiskalo_private.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  public_oid:=to_regprocedure(
    'public.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  if helper_oid is null or public_oid is null then
    raise exception 'ATK correction persistence RPC is missing';
  end if;
  if not has_function_privilege('authenticated',helper_oid,'EXECUTE') or
     has_function_privilege('anon',helper_oid,'EXECUTE') then
    raise exception 'Private correction RPC permissions are incorrect';
  end if;
  if not has_function_privilege('authenticated',public_oid,'EXECUTE') or
     has_function_privilege('anon',public_oid,'EXECUTE') then
    raise exception 'Public correction RPC permissions are incorrect';
  end if;

  select pg_get_functiondef(helper_oid) into definition;
  if position('submission_state=''accepted''' in definition)=0 or
     position('atk_transaction_id>0' in definition)=0 or
     position('parent_document_id' in definition)=0 or
     position('idempotency_key' in definition)=0 then
    raise exception 'Correction persistence must require an accepted original and retain idempotent parent linkage';
  end if;
end $$;
rollback;
