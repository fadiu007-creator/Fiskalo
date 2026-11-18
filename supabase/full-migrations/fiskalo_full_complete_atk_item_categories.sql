-- Expand the existing Full application catalogue from its legacy 35-code
-- database constraint to the complete 2026 ATK annex (53 published rows,
-- 52 unique codes; PM appears twice in the source annex).
--
-- This is additive: existing values remain valid, NULL snapshots remain valid,
-- and new rows are checked immediately while existing rows are validated.
alter table public.fiskalo_products
  drop constraint if exists fiskalo_products_atk_category_2026_check;
alter table public.fiskalo_products
  add constraint fiskalo_products_atk_category_2026_check
  check (
    atk_item_category_code is null
    or atk_item_category_code = any(array['TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB','KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA','KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM','PPD','PPH','PPP','PPA','PHN','SHH','SUA','SHZ','PJA','PAL','DUH','SHM','PRO','SFV','BSH','RPK','PTI']::text[])
  ) not valid;
alter table public.fiskalo_products
  validate constraint fiskalo_products_atk_category_2026_check;

alter table public.fiskalo_invoice_items
  drop constraint if exists fiskalo_invoice_items_atk_category_2026_check;
alter table public.fiskalo_invoice_items
  add constraint fiskalo_invoice_items_atk_category_2026_check
  check (
    atk_item_category_code is null
    or atk_item_category_code = any(array['TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB','KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA','KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM','PPD','PPH','PPP','PPA','PHN','SHH','SUA','SHZ','PJA','PAL','DUH','SHM','PRO','SFV','BSH','RPK','PTI']::text[])
  ) not valid;
alter table public.fiskalo_invoice_items
  validate constraint fiskalo_invoice_items_atk_category_2026_check;
