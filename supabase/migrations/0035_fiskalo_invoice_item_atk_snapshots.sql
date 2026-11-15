-- Snapshot ATK product classifications onto each invoice line.
-- This prevents a later product edit from changing the fiscal payload of an old sale.
alter table public.fiskalo_invoice_items
  add column if not exists atk_unit_code text,
  add column if not exists atk_tax_code text,
  add column if not exists atk_item_category_code text;

-- Keep product master values within the published ATK catalogues while allowing
-- legacy/unmapped products to remain editable until they are configured.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.fiskalo_products'::regclass and conname='fiskalo_products_atk_unit_2026_check') then
    alter table public.fiskalo_products add constraint fiskalo_products_atk_unit_2026_check
      check (atk_unit_code is null or atk_unit_code in (
        'EA','CP','LTR','SEC','MIN','HUR','DAY','MON','ANN','KGB','KGN',
        'TN','GRM','M4','UDH','KMT','LM','MTS','MTV','MSK','KWH'
      )) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.fiskalo_products'::regclass and conname='fiskalo_products_atk_tax_2026_check') then
    alter table public.fiskalo_products add constraint fiskalo_products_atk_tax_2026_check
      check (
        atk_tax_code is null or
        (atk_tax_code in ('A','C') and vat_rate=0) or
        (atk_tax_code='D' and vat_rate=8) or
        (atk_tax_code='E' and vat_rate=18)
      ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.fiskalo_products'::regclass and conname='fiskalo_products_atk_category_2026_check') then
    alter table public.fiskalo_products add constraint fiskalo_products_atk_category_2026_check
      check (atk_item_category_code is null or atk_item_category_code in (
        'TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB',
        'KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA',
        'KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM'
      )) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.fiskalo_invoice_items'::regclass and conname='fiskalo_invoice_items_atk_unit_2026_check') then
    alter table public.fiskalo_invoice_items add constraint fiskalo_invoice_items_atk_unit_2026_check
      check (atk_unit_code is null or atk_unit_code in (
        'EA','CP','LTR','SEC','MIN','HUR','DAY','MON','ANN','KGB','KGN',
        'TN','GRM','M4','UDH','KMT','LM','MTS','MTV','MSK','KWH'
      )) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.fiskalo_invoice_items'::regclass and conname='fiskalo_invoice_items_atk_tax_2026_check') then
    alter table public.fiskalo_invoice_items add constraint fiskalo_invoice_items_atk_tax_2026_check
      check (
        atk_tax_code is null or
        (atk_tax_code in ('A','C') and vat_rate=0) or
        (atk_tax_code='D' and vat_rate=8) or
        (atk_tax_code='E' and vat_rate=18)
      ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.fiskalo_invoice_items'::regclass and conname='fiskalo_invoice_items_atk_category_2026_check') then
    alter table public.fiskalo_invoice_items add constraint fiskalo_invoice_items_atk_category_2026_check
      check (atk_item_category_code is null or atk_item_category_code in (
        'TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB',
        'KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA',
        'KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM'
      )) not valid;
  end if;
end $$;

create or replace function fiskalo_private.fiskalo_snapshot_invoice_item_atk_mapping()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  invoice_org uuid;
  mapping record;
begin
  if new.product_id is null then
    new.atk_unit_code := null;
    new.atk_tax_code := null;
    new.atk_item_category_code := null;
    return new;
  end if;

  select i.organization_id into invoice_org
  from public.fiskalo_invoices i
  where i.id = new.invoice_id;

  if invoice_org is null then
    raise exception 'Invoice organization could not be resolved for ATK product snapshot';
  end if;

  select p.atk_unit_code, p.atk_tax_code, p.atk_item_category_code
    into mapping
  from public.fiskalo_products p
  where p.id = new.product_id
    and p.organization_id = invoice_org;

  if not found then
    raise exception 'Invoice product does not belong to the invoice organization';
  end if;

  new.atk_unit_code := mapping.atk_unit_code;
  new.atk_tax_code := mapping.atk_tax_code;
  new.atk_item_category_code := mapping.atk_item_category_code;
  return new;
end;
$$;

revoke all on function fiskalo_private.fiskalo_snapshot_invoice_item_atk_mapping() from public, anon, authenticated;

drop trigger if exists fiskalo_invoice_item_atk_snapshot on public.fiskalo_invoice_items;
create trigger fiskalo_invoice_item_atk_snapshot
before insert or update of invoice_id, product_id, atk_unit_code, atk_tax_code, atk_item_category_code
on public.fiskalo_invoice_items
for each row execute function fiskalo_private.fiskalo_snapshot_invoice_item_atk_mapping();
