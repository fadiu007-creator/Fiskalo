-- Run after migrations 0001-0034 in disposable PostgreSQL.
begin;
do $$
declare
  fn oid;
  config text[];
begin
  foreach fn in array array[
    to_regprocedure('public.fiskalo_basic_apply_purchase_item()'),
    to_regprocedure('public.fiskalo_basic_apply_stock_movement()'),
    to_regprocedure('public.fiskalo_basic_block_audit_mutation()')
  ] loop
    if fn is null then raise exception 'Expected Fiskalo trigger function is missing'; end if;
    if has_function_privilege('anon', fn, 'EXECUTE') or
       has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'Trigger-only function remains directly executable by API roles';
    end if;
  end loop;
  select p.proconfig into config
  from pg_proc p
  where p.oid = to_regprocedure('public.fiskalo_basic_block_audit_mutation()');
  if not coalesce(config @> array['search_path=""'], false) and
     not coalesce(config @> array['search_path='], false) then
    raise exception 'Audit mutation trigger must have an empty search_path';
  end if;
end $$;
rollback;
