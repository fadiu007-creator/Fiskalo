-- ATK 2026 catalogue validation. NOT VALID keeps historical rows readable
-- while enforcing the official codes on every new or updated product row.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fiskalo_basic_products'::regclass
      and conname = 'fiskalo_basic_products_atk_unit_code_2026_check'
  ) then
    alter table public.fiskalo_basic_products
      add constraint fiskalo_basic_products_atk_unit_code_2026_check
      check (atk_unit_code in (
        'EA','CP','LTR','SEC','MIN','HUR','DAY','MON','ANN','KGB','KGN',
        'TN','GRM','M4','UDH','KMT','LM','MTS','MTV','MSK','KWH'
      )) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fiskalo_basic_products'::regclass
      and conname = 'fiskalo_basic_products_atk_category_2026_check'
  ) then
    alter table public.fiskalo_basic_products
      add constraint fiskalo_basic_products_atk_category_2026_check
      check (atk_item_category_code in (
        'TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB',
        'KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA',
        'KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM'
      )) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fiskalo_basic_products'::regclass
      and conname = 'fiskalo_basic_products_atk_vat_class_2026_check'
  ) then
    alter table public.fiskalo_basic_products
      add constraint fiskalo_basic_products_atk_vat_class_2026_check
      check (
        (atk_vat_code in ('A','C') and vat_rate = 0)
        or (atk_vat_code = 'D' and vat_rate = 8)
        or (atk_vat_code = 'E' and vat_rate = 18)
      ) not valid;
  end if;
end
$$;
