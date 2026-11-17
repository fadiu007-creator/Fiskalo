-- Run after migrations 0001-0033 in a Supabase SQL session.
-- Static function-definition contract for single full-return/cancellation protection.
begin;
do $$
declare
  helper_oid oid;
  definition text;
begin
  helper_oid:=to_regprocedure(
    'fiskalo_private.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  if helper_oid is null then raise exception 'ATK correction persistence RPC is missing'; end if;
  select pg_get_functiondef(helper_oid) into definition;
  if position('p_document_type in (2,3)' in definition)=0 or
     position('d.document_type=p_document_type' in definition)=0 or
     position('A full ATK return already exists or is unresolved for this sale' in definition)=0 or
     position('An ATK cancellation already exists or is unresolved for this sale' in definition)=0 then
    raise exception 'Full cancellation and full return must each be idempotently limited to one active/accepted correction per original sale';
  end if;
end $$;
rollback;
