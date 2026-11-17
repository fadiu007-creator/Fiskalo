begin;
do $$
declare fn regprocedure;
begin
  fn:=to_regprocedure('public.fiskalo_basic_store_offline_receipt_v2(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamp with time zone,text)');
  if fn is not null and (has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE')) then
    raise exception 'Legacy offline receipt v2 must not be callable by browser roles';
  end if;
  fn:=to_regprocedure('public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamp with time zone)');
  if fn is null or has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Legacy offline receipt RPC must not be callable by browser roles';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamp with time zone)');
  if fn is null or has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Private legacy offline receipt writer must not be callable by authenticated users';
  end if;
  fn:=to_regprocedure('public.fiskalo_basic_consume_offline_coupon_id(uuid,uuid,bigint,uuid)');
  if fn is not null and (has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE')) then
    raise exception 'Browser roles must not consume pre-reserved offline CouponIds';
  end if;
  fn:=to_regprocedure('public.fiskalo_basic_server_queue_atk_receipt_v2(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,timestamp with time zone,text)');
  if fn is null or not has_function_privilege('service_role',fn,'EXECUTE') or
     has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Verified server queue RPC must remain service-role only';
  end if;
end $$;
rollback;
