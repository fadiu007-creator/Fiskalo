-- Run after migrations 0001-0033 in disposable PostgreSQL.
-- Verifies authority-requested export is owner-only, bounded and audited.
begin;
do $$
declare
  private_oid oid;
  public_oid oid;
  private_definition text;
  public_is_definer boolean;
begin
  private_oid := to_regprocedure(
    'fiskalo_private.fiskalo_basic_untransmitted_export(uuid,timestamptz,timestamptz,text,integer)'
  );
  public_oid := to_regprocedure(
    'public.fiskalo_basic_untransmitted_export(uuid,timestamptz,timestamptz,text,integer)'
  );
  if private_oid is null or public_oid is null then
    raise exception 'Authority export functions are missing';
  end if;
  if not has_function_privilege('authenticated', public_oid, 'EXECUTE') or
     has_function_privilege('anon', public_oid, 'EXECUTE') then
    raise exception 'Authority export wrapper permissions are incorrect';
  end if;
  if has_function_privilege('authenticated', private_oid, 'EXECUTE') or
     has_function_privilege('anon', private_oid, 'EXECUTE') then
    raise exception 'Private authority export helper must not be directly executable';
  end if;
  select p.prosecdef into public_is_definer from pg_proc p where p.oid = public_oid;
  if not coalesce(public_is_definer, false) then
    raise exception 'Public authority export wrapper must be SECURITY DEFINER';
  end if;
  if has_table_privilege('authenticated','fiskalo_private.fiskalo_basic_authority_exports','SELECT') or
     has_table_privilege('authenticated','fiskalo_private.fiskalo_basic_authority_exports','INSERT') or
     has_table_privilege('anon','fiskalo_private.fiskalo_basic_authority_exports','SELECT') then
    raise exception 'Authority export audit table must not be directly accessible to API roles';
  end if;

  select pg_get_functiondef(private_oid) into private_definition;
  if position('m.role = ''owner''' in private_definition) = 0 or
     position('p_authority_request_reference' in private_definition) = 0 or
     position('p_limit > 5000' in private_definition) = 0 or
     position('submission_state in (''queued'',''submitted'',''needs_reconciliation'')' in lower(private_definition)) = 0 or
     position('signed_payload' in lower(private_definition)) = 0 or
     position('citizen_signature' in lower(private_definition)) = 0 then
    raise exception 'Authority export must be owner-gated, request-referenced, bounded and contain signed offline data';
  end if;
  if position('update public.fiskalo_basic_sales' in lower(private_definition)) > 0 or
     position('delete from public.fiskalo_basic_fiscal_documents' in lower(private_definition)) > 0 then
    raise exception 'Authority export must remain read-only for fiscal records';
  end if;
end $$;
rollback;
