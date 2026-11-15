-- Run after migrations 0001-0034 in disposable PostgreSQL.
begin;
do $$
declare
  config_text text;
begin
  if has_function_privilege('anon','public.fiskalo_basic_apply_purchase_item()','EXECUTE') or
     has_function_privilege('authenticated','public.fiskalo_basic_apply_purchase_item()','EXECUTE') or
     has_function_privilege('anon','public.fiskalo_basic_apply_stock_movement()','EXECUTE') or
     has_function_privilege('authenticated','public.fiskalo_basic_apply_stock_movement()','EXECUTE') or
     has_function_privilege('anon','public.fiskalo_basic_block_audit_mutation()','EXECUTE') or
     has_function_privilege('authenticated','public.fiskalo_basic_block_audit_mutation()','EXECUTE') then
    raise exception 'Trigger-only functions remain directly executable by API roles';
  end if;
  select p.proconfig::text into config_text
  from pg_proc p
  where p.oid = to_regprocedure('public.fiskalo_basic_block_audit_mutation()');
  if config_text is null or position('search_path=' in config_text) = 0 then
    raise exception 'Audit mutation trigger must have a fixed empty search_path';
  end if;
end $$;
rollback;
