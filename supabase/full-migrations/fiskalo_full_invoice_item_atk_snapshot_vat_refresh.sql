-- Refresh the ATK line snapshot whenever the VAT rate changes on a draft line.
-- The companion catalogue trigger verifies the rate against the product master.
drop trigger if exists fiskalo_invoice_item_atk_snapshot on public.fiskalo_invoice_items;
create trigger fiskalo_invoice_item_atk_snapshot
before insert or update of invoice_id, product_id, vat_rate, atk_unit_code, atk_tax_code, atk_item_category_code
on public.fiskalo_invoice_items
for each row execute function fiskalo_private.fiskalo_snapshot_invoice_item_atk_mapping();
