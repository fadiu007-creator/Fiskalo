-- Owner-controlled VAT registration metadata used on fiscal receipts.
create or replace function fiskalo_private.fiskalo_basic_update_business_tax_profile(
  p_business_id uuid,p_vat_number text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if nullif(trim(coalesce(p_vat_number,'')),'') is not null and
     (char_length(trim(p_vat_number))<>9 or translate(trim(p_vat_number),'0123456789','')<>'') then
    raise exception 'VAT number must contain exactly 9 digits';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid() and m.role='owner'
  ) then raise exception 'Only a business owner may change VAT registration details'; end if;
  update public.fiskalo_basic_businesses
    set vat_number=nullif(trim(coalesce(p_vat_number,'')),'')
    where id=p_business_id;
  if not found then raise exception 'Business not found'; end if;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_update_business_tax_profile(uuid,text) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_update_business_tax_profile(uuid,text) to authenticated;

create or replace function public.fiskalo_basic_update_business_tax_profile(
  p_business_id uuid,p_vat_number text
) returns void
language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select fiskalo_private.fiskalo_basic_update_business_tax_profile(p_business_id,p_vat_number)
$$;
revoke all on function public.fiskalo_basic_update_business_tax_profile(uuid,text) from public,anon;
grant execute on function public.fiskalo_basic_update_business_tax_profile(uuid,text) to authenticated;
