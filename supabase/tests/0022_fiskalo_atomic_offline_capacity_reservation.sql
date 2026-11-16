begin;
do $$
declare fn regprocedure; def text;
begin
  fn:=to_regprocedure('public.fiskalo_basic_reserve_offline_capacity(uuid,uuid,integer,integer)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') or
     has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Atomic offline capacity reservation must be authenticated-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('fiskalo_basic_reserve_offline_coupon_ids' in def)=0 or
     position('fiskalo_basic_reserve_offline_daily_numbers' in def)=0 or
     position('for v_offset in 0..p_days_ahead' in def)=0 or
     position('jsonb_build_object' in def)=0 then
    raise exception 'Atomic reservation must allocate CouponIds and all requested daily ranges together';
  end if;
end $$;
rollback;
