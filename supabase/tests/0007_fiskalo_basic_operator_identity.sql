do $$
declare v_definer boolean;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_members' and column_name='operator_name'
  ) then raise exception 'Operator display name field is missing'; end if;
  select p.prosecdef into v_definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='fiskalo_private' and p.proname='fiskalo_basic_set_operator_name';
  if v_definer is distinct from true then raise exception 'Private operator update must be SECURITY DEFINER'; end if;
  select p.prosecdef into v_definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='fiskalo_basic_set_operator_name';
  if v_definer is distinct from false then raise exception 'Public operator update must be SECURITY INVOKER'; end if;
  select p.prosecdef into v_definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='fiskalo_private' and p.proname='fiskalo_basic_is_owner';
  if v_definer is distinct from true then raise exception 'Owner roster helper must bypass RLS without recursive policy lookup'; end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='fiskalo_basic_members'
      and policyname='fiskalo_basic_member_read_owner'
      and coalesce(qual,'') like '%fiskalo_basic_is_owner%'
  ) then raise exception 'Owner roster visibility policy must use the private owner helper'; end if;
  if has_function_privilege('anon','public.fiskalo_basic_set_operator_name(uuid,text)','EXECUTE') then
    raise exception 'anon must not update operator identity';
  end if;
end $$;
