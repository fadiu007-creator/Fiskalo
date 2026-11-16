-- The public orchestration wrapper does not need SECURITY DEFINER.
-- It delegates to private owner-checked SECURITY DEFINER allocators.
alter function public.fiskalo_basic_reserve_offline_capacity(uuid,uuid,integer,integer)
  security invoker;
revoke all on function public.fiskalo_basic_reserve_offline_capacity(uuid,uuid,integer,integer)
  from public,anon;
grant execute on function public.fiskalo_basic_reserve_offline_capacity(uuid,uuid,integer,integer)
  to authenticated;
