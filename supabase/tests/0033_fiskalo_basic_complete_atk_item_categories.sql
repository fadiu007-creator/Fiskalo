begin;
do $test$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid='public.fiskalo_basic_products'::regclass
      and conname='fiskalo_basic_products_atk_category_2026_check';
  if def is null then raise exception 'ATK item category constraint is missing'; end if;
  if position('PTI' in def)=0 or position('TT' in def)=0 or position('PM' in def)=0 or
     position('RPK' in def)=0 or position('PSE' in def)=0 then
    raise exception 'ATK category constraint is missing official 2026 catalogue codes';
  end if;
  if position('ATK item category' in lower(def))>0 then raise exception 'Unexpected constraint definition'; end if;
end
$test$;
rollback;
