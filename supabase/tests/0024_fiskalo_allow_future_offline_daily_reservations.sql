-- Run after migrations 0001-0024 in a disposable Supabase database.
begin;
do $test$
declare
  fn regprocedure;
  definition text;
begin
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer)');
  if fn is null then raise exception 'Private daily-number reservation function is missing'; end if;
  if not has_function_privilege('authenticated',fn,'EXECUTE') then
    raise exception 'Authenticated owner workflow must be able to reserve bounded daily capacity';
  end if;
  select pg_get_functiondef(fn) into definition;
  if position('v_today+7' in replace(definition,' ',''))=0 or
     position('p_business_date<v_today' in replace(definition,' ',''))=0 or
     position('role=''owner''' in replace(definition,' ',''))=0 or
     position('Europe/Belgrade' in definition)=0 then
    raise exception 'Daily reservation must be Kosovo-local, owner-only and bounded to today through seven days ahead';
  end if;
  if position('p_business_dateisdistinctfrom' in replace(definition,' ',''))>0 then
    raise exception 'Daily reservation still rejects all future dates';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_reserve_offline_capacity(uuid,uuid,integer,integer)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') then
    raise exception 'Atomic offline-capacity RPC must be available to authenticated owners';
  end if;
  select pg_get_functiondef(fn) into definition;
  if position('fiskalo_private.fiskalo_basic_reserve_offline_coupon_ids' in definition)=0 or
     position('fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers' in definition)=0 or
     position('0..p_days_ahead' in replace(definition,' ',''))=0 then
    raise exception 'Atomic capacity RPC must reserve coupon IDs and every daily range in one transaction';
  end if;
end
$test$;
rollback;
