begin;

do $test$
declare
  codes text[] := array['TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB','KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA','KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM','PPD','PPH','PPP','PPA','PHN','SHH','SUA','SHZ','PJA','PAL','DUH','SHM','PRO','SFV','BSH','RPK','PTI']::text[];
  target record;
  definition text;
  present_count integer;
  existing_count integer;
  code text;
begin
  for target in
    select 'public.fiskalo_products'::regclass as relation,
           'fiskalo_products_atk_category_2026_check'::text as constraint_name
    union all
    select 'public.fiskalo_invoice_items'::regclass,
           'fiskalo_invoice_items_atk_category_2026_check'
  loop
    select pg_catalog.pg_get_constraintdef(c.oid)
      into definition
    from pg_catalog.pg_constraint c
    where c.conrelid = target.relation
      and c.conname = target.constraint_name
      and c.contype = 'c';

    if definition is null then
      raise exception 'Full ATK category constraint % is missing', target.constraint_name;
    end if;
    if position('atk_item_category_code IS NULL' in definition) = 0 then
      raise exception 'Full ATK category constraint % must preserve nullable historical snapshots', target.constraint_name;
    end if;

    select count(*) into present_count
    from unnest(codes) as category(code)
    where position(quote_literal(category.code) in definition) > 0;

    if present_count <> cardinality(codes) then
      raise exception 'Full ATK category constraint % must contain all 52 unique codes; found %',
        target.constraint_name, present_count;
    end if;
  end loop;

  select count(*) into existing_count
  from public.fiskalo_products
  where atk_item_category_code = 'TT';
  if existing_count <> 1 then
    raise exception 'Existing Full product rows must survive category constraint expansion';
  end if;

  foreach code in array codes loop
    insert into public.fiskalo_products(atk_item_category_code) values (code);
    insert into public.fiskalo_invoice_items(atk_item_category_code) values (code);
  end loop;

  begin
    insert into public.fiskalo_products(atk_item_category_code) values ('NOT-AN-ATK-CODE');
    raise exception 'Full product category constraint accepted an unsupported code';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.fiskalo_invoice_items(atk_item_category_code) values ('NOT-AN-ATK-CODE');
    raise exception 'Full invoice item category constraint accepted an unsupported code';
  exception when check_violation then
    null;
  end;

  select count(*) into existing_count
  from public.fiskalo_products
  where atk_item_category_code is not null;
  if existing_count <> 53 then
    raise exception 'Expected one preserved product plus all 52 valid categories; found %', existing_count;
  end if;

  select count(*) into existing_count
  from public.fiskalo_invoice_items
  where atk_item_category_code is not null;
  if existing_count <> 52 then
    raise exception 'Expected all 52 valid invoice item categories; found %', existing_count;
  end if;

  if not exists (
    select 1 from public.fiskalo_invoice_items
    where atk_item_category_code is null
  ) then
    raise exception 'Historical NULL invoice-item category snapshots must remain valid';
  end if;
end
$test$;

rollback;
