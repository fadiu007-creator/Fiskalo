-- Run after migrations 0001-0021 in a disposable or approved staging database.
-- Verifies the owner-only report RPC surface and its bounded, read-only query contract.
begin;
do $$
declare
  private_oid oid;
  public_oid oid;
  private_definition text;
  public_is_definer boolean;
begin
  private_oid := to_regprocedure(
    'fiskalo_private.fiskalo_basic_sales_report(uuid,timestamptz,timestamptz,integer)'
  );
  public_oid := to_regprocedure(
    'public.fiskalo_basic_sales_report(uuid,timestamptz,timestamptz,integer)'
  );
  if private_oid is null or public_oid is null then
    raise exception 'Owner-scoped sales report functions are missing';
  end if;

  if not has_function_privilege('authenticated', public_oid, 'EXECUTE') or
     has_function_privilege('anon', public_oid, 'EXECUTE') then
    raise exception 'Public sales report wrapper permissions are incorrect';
  end if;
  if has_function_privilege('authenticated', private_oid, 'EXECUTE') or
     has_function_privilege('anon', private_oid, 'EXECUTE') then
    raise exception 'Private sales report helper must not be directly executable by API roles';
  end if;

  select p.prosecdef into public_is_definer
  from pg_proc p where p.oid = public_oid;
  if not coalesce(public_is_definer, false) then
    raise exception 'Public report wrapper must use SECURITY DEFINER to call the private owner-checked helper';
  end if;

  select pg_get_functiondef(private_oid) into private_definition;
  if position('m.role = ''owner''' in private_definition) = 0 or
     position('p_limit > 5000' in private_definition) = 0 or
     position('p_from' in private_definition) = 0 or
     position('p_to' in private_definition) = 0 or
     position('payment_allocations' in lower(private_definition)) = 0 then
    raise exception 'Private report helper must enforce owner membership, date range and row limit';
  end if;
  if position('update public.fiskalo_basic_sales' in lower(private_definition)) > 0 or
     position('delete from public.fiskalo_basic_sales' in lower(private_definition)) > 0 then
    raise exception 'Sales report helper must remain read-only';
  end if;
end $$;
rollback;
