-- Store the operator's business-issued identifier separately from the internal auth UUID.
alter table public.fiskalo_basic_members
  add column if not exists operator_identifier text;

alter table public.fiskalo_basic_sales
  add column if not exists operator_identifier text;

create or replace function fiskalo_private.fiskalo_basic_set_operator_identity(
  p_business_id uuid,
  p_operator_name text,
  p_operator_identifier text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(p_operator_name,'')))<2 or
     char_length(trim(coalesce(p_operator_name,'')))>100 then
    raise exception 'Operator name must contain between 2 and 100 characters';
  end if;
  if char_length(trim(coalesce(p_operator_identifier,'')))<1 or
     char_length(trim(coalesce(p_operator_identifier,'')))>32 then
    raise exception 'Operator identifier must contain between 1 and 32 characters';
  end if;
  update public.fiskalo_basic_members
    set operator_name=trim(p_operator_name),
        operator_identifier=trim(p_operator_identifier)
    where business_id=p_business_id and user_id=auth.uid();
  if not found then raise exception 'Business membership not found'; end if;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_set_operator_identity(uuid,text,text) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_set_operator_identity(uuid,text,text) to authenticated;

create or replace function public.fiskalo_basic_set_operator_identity(
  p_business_id uuid,p_operator_name text,p_operator_identifier text
) returns void
language sql
security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_set_operator_identity(
    p_business_id,p_operator_name,p_operator_identifier
  )
$$;
revoke all on function public.fiskalo_basic_set_operator_identity(uuid,text,text) from public,anon;
grant execute on function public.fiskalo_basic_set_operator_identity(uuid,text,text) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_snapshot_operator_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(trim(coalesce(new.operator_name,'')),'') is null or
     nullif(trim(coalesce(new.operator_identifier,'')),'') is null then
    select m.operator_name,m.operator_identifier
      into new.operator_name,new.operator_identifier
      from public.fiskalo_basic_members m
      where m.business_id=new.business_id and m.user_id=new.operator_id;
  end if;
  if char_length(trim(coalesce(new.operator_name,'')))<2 then
    raise exception 'Set the operator name in the POS profile before creating a sale';
  end if;
  if char_length(trim(coalesce(new.operator_identifier,'')))<1 then
    raise exception 'Set the operator identifier in the POS profile before creating a sale';
  end if;
  new.operator_name:=trim(new.operator_name);
  new.operator_identifier:=trim(new.operator_identifier);
  return new;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_snapshot_operator_name() from public,anon,authenticated;
