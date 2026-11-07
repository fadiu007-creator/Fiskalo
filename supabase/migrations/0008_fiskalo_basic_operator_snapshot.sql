-- Snapshot the registered operator name into each sale so reprints remain complete
-- even if the user later changes profile or leaves the business.
alter table public.fiskalo_basic_sales
  add column if not exists operator_name text;

create or replace function fiskalo_private.fiskalo_basic_snapshot_operator_name()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(trim(coalesce(new.operator_name,'')),'') is null then
    select m.operator_name into new.operator_name
      from public.fiskalo_basic_members m
      where m.business_id=new.business_id and m.user_id=new.operator_id;
  end if;
  if char_length(trim(coalesce(new.operator_name,'')))<2 then
    raise exception 'Set the operator name in the POS profile before creating a sale';
  end if;
  new.operator_name:=trim(new.operator_name);
  return new;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_snapshot_operator_name() from public,anon,authenticated;

drop trigger if exists fiskalo_basic_sales_snapshot_operator_name on public.fiskalo_basic_sales;
create trigger fiskalo_basic_sales_snapshot_operator_name
before insert on public.fiskalo_basic_sales
for each row execute function fiskalo_private.fiskalo_basic_snapshot_operator_name();
