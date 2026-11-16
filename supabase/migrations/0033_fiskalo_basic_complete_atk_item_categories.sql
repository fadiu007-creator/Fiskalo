-- Expand the Basic product category constraint to the complete official
-- 2026 ATK Annex catalogue (53 published rows, 52 unique codes; PM is repeated).
alter table public.fiskalo_basic_products
  drop constraint if exists fiskalo_basic_products_atk_category_2026_check;
alter table public.fiskalo_basic_products
  add constraint fiskalo_basic_products_atk_category_2026_check
  check (atk_item_category_code = any(array['TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB','KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA','KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM','PPD','PPH','PPP','PPA','PHN','SHH','SUA','SHZ','PJA','PAL','DUH','SHM','PRO','SFV','BSH','RPK','PTI']::text[]));
