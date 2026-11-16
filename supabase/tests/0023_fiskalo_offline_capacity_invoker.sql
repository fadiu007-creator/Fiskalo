begin;
do $$
declare fn regprocedure; is_definer boolean;
begin
  fn:=to_regprocedure('public.fiskalo_basic_reserve_offline_capacity(uuid,uuid,integer,integer)');
  if fn is null then raise exception 'Atomic offline capacity RPC is missing'; end if;
  select prosecdef into is_definer from pg_proc where oid=fn;
  if is_definer then raise exception 'Public atomic capacity wrapper must be SECURITY INVOKER'; end if;
  if not has_function_privilege('authenticated',fn,'EXECUTE') or
     has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Atomic capacity wrapper must be authenticated-only';
  end if;
end $$;
rollback;
