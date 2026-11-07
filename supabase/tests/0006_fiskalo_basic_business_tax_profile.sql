do $$
declare v_definer boolean;
begin
  select p.prosecdef into v_definer
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='fiskalo_private' and p.proname='fiskalo_basic_update_business_tax_profile';
  if v_definer is distinct from true then raise exception 'Tax profile implementation must be SECURITY DEFINER in private schema'; end if;
  select p.prosecdef into v_definer
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='fiskalo_basic_update_business_tax_profile';
  if v_definer is distinct from false then raise exception 'Public tax profile wrapper must be SECURITY INVOKER'; end if;
  if has_function_privilege('anon','public.fiskalo_basic_update_business_tax_profile(uuid,text)','EXECUTE') then
    raise exception 'anon must not update VAT profile';
  end if;
  if not has_function_privilege('authenticated','public.fiskalo_basic_update_business_tax_profile(uuid,text)','EXECUTE') then
    raise exception 'authenticated owners must be able to update VAT profile';
  end if;
end $$;
