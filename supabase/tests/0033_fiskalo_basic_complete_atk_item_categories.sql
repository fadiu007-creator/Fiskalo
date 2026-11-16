begin;
do $test$
declare def text; present_count integer;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid='public.fiskalo_basic_products'::regclass
      and conname='fiskalo_basic_products_atk_category_2026_check';
  if def is null then raise exception 'ATK item category constraint is missing'; end if;
  select count(*) into present_count from unnest(array['TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB','KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA','KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM','PPD','PPH','PPP','PPA','PHN','SHH','SUA','SHZ','PJA','PAL','DUH','SHM','PRO','SFV','BSH','RPK','PTI']::text[]) as c(code)
    where position(quote_literal(c.code) in def)>0;
  if present_count<>52 then
    raise exception 'ATK item category constraint must contain all 52 unique codes from the 53 published rows; found %',present_count;
  end if;
end
$test$;
rollback;
