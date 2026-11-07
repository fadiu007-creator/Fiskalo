do $$
declare v_definer boolean;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_sales' and column_name='operator_name'
  ) then raise exception 'Sale operator name snapshot column is missing'; end if;
  select p.prosecdef into v_definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='fiskalo_private' and p.proname='fiskalo_basic_snapshot_operator_name';
  if v_definer is distinct from true then raise exception 'Operator snapshot trigger must run as privileged private function'; end if;
  if not exists (
    select 1 from pg_trigger where tgname='fiskalo_basic_sales_snapshot_operator_name' and not tgisinternal
  ) then raise exception 'Operator snapshot trigger is missing'; end if;
end $$;
