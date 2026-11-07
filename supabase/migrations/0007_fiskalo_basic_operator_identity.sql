-- Every printed fiscal receipt needs a named operator and a stable operator identifier.
alter table public.fiskalo_basic_members
  add column if not exists operator_name text;

create or replace function fiskalo_private.fiskalo_basic_set_operator_name(
  p_business_id uuid,p_operator_name text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(p_operator_name,'')))<2 or
     char_length(trim(coalesce(p_operator_name,'')))>100 then
    raise exception 'Operator name must contain between 2 and 100 characters';
  end if;
  update public.fiskalo_basic_members
    set operator_name=trim(p_operator_name)
    where business_id=p_business_id and user_id=auth.uid();
  if not found then raise exception 'Business membership not found'; end if;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_set_operator_name(uuid,text) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_set_operator_name(uuid,text) to authenticated;

create or replace function public.fiskalo_basic_set_operator_name(
  p_business_id uuid,p_operator_name text
) returns void
language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select fiskalo_private.fiskalo_basic_set_operator_name(p_business_id,p_operator_name)
$$;
revoke all on function public.fiskalo_basic_set_operator_name(uuid,text) from public,anon;
grant execute on function public.fiskalo_basic_set_operator_name(uuid,text) to authenticated;
