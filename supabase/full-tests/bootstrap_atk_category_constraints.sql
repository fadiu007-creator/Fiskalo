-- CI-only fixture for the existing Full schema's legacy category constraints.
-- Refuse to run if real Full tables already exist; this file must never be used
-- against a database containing application data.
do $bootstrap$
begin
  if to_regclass('public.fiskalo_products') is not null
     or to_regclass('public.fiskalo_invoice_items') is not null then
    raise exception 'Refusing to replace existing Full Fiskalo tables; use a disposable database';
  end if;
end
$bootstrap$;

create table public.fiskalo_products (
  id bigint generated always as identity primary key,
  atk_item_category_code text
);
alter table public.fiskalo_products
  add constraint fiskalo_products_atk_category_2026_check
  check (
    atk_item_category_code is null
    or atk_item_category_code = any(array['TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB','KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA','KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM']::text[])
  );

create table public.fiskalo_invoice_items (
  id bigint generated always as identity primary key,
  atk_item_category_code text
);
alter table public.fiskalo_invoice_items
  add constraint fiskalo_invoice_items_atk_category_2026_check
  check (
    atk_item_category_code is null
    or atk_item_category_code = any(array['TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB','KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA','KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM']::text[])
  );

insert into public.fiskalo_products(atk_item_category_code) values ('TT');
insert into public.fiskalo_invoice_items(atk_item_category_code) values (null);
