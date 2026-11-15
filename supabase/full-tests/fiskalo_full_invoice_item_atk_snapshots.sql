-- Run after migrations 0001-0035 in disposable PostgreSQL.
begin;
do $$
declare
  config_text text;
  trigger_definition text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_invoice_items' and column_name='atk_unit_code'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_invoice_items' and column_name='atk_tax_code'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_invoice_items' and column_name='atk_item_category_code'
  ) then
    raise exception 'Invoice lines are missing immutable ATK mapping snapshot columns';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.fiskalo_invoice_items'::regclass
      and tgname='fiskalo_invoice_item_atk_snapshot'
      and not tgisinternal
      and tgenabled <> 'D'
  ) then
    raise exception 'Invoice-line ATK snapshot trigger is missing or disabled';
  end if;

  select pg_get_triggerdef(oid) into trigger_definition
  from pg_trigger
  where tgrelid='public.fiskalo_invoice_items'::regclass
    and tgname='fiskalo_invoice_item_atk_snapshot';
  if position('vat_rate' in trigger_definition) = 0 then
    raise exception 'Invoice-line ATK snapshot must refresh when VAT rate changes';
  end if;

  if has_function_privilege('anon','fiskalo_private.fiskalo_snapshot_invoice_item_atk_mapping()','EXECUTE')
     or has_function_privilege('authenticated','fiskalo_private.fiskalo_snapshot_invoice_item_atk_mapping()','EXECUTE') then
    raise exception 'ATK snapshot trigger function is directly executable by API roles';
  end if;

  select p.proconfig::text into config_text
  from pg_proc p
  where p.oid=to_regprocedure('fiskalo_private.fiskalo_snapshot_invoice_item_atk_mapping()');
  if config_text is null or position('search_path=' in config_text)=0 then
    raise exception 'ATK snapshot trigger must use a fixed empty search_path';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_invoice_items'::regclass
      and conname='fiskalo_invoice_items_atk_unit_2026_check'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_invoice_items'::regclass
      and conname='fiskalo_invoice_items_atk_tax_2026_check'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_invoice_items'::regclass
      and conname='fiskalo_invoice_items_atk_category_2026_check'
  ) then
    raise exception 'Invoice-line ATK snapshot constraints are incomplete';
  end if;
end $$;
rollback;
