-- Reserve a business-wide CouponId batch and every requested POS daily-number
-- range in one transaction. If any date reservation fails, all reservation rows
-- and daily counter updates roll back together.
create or replace function public.fiskalo_basic_reserve_offline_capacity(
  p_business_id uuid,p_pos_id uuid,p_coupon_count integer,p_days_ahead integer
) returns jsonb
language plpgsql security invoker set search_path='' as $
declare
  v_coupon_ids bigint[];
  v_daily_ranges jsonb:='[]'::jsonb;
  v_today date;
  v_date date;
  v_first bigint;
  v_last bigint;
  v_offset integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_coupon_count is null or p_coupon_count<1 or p_coupon_count>500 then
    raise exception 'Coupon reservation count must be between 1 and 500';
  end if;
  if p_days_ahead is null or p_days_ahead<0 or p_days_ahead>7 then
    raise exception 'Offline daily capacity may cover today through seven days ahead';
  end if;
  v_today:=(now() at time zone 'Europe/Belgrade')::date;

  select r.coupon_ids into v_coupon_ids
  from fiskalo_private.fiskalo_basic_reserve_offline_coupon_ids(
    p_business_id,p_pos_id,p_coupon_count
  ) r;
  if coalesce(cardinality(v_coupon_ids),0)<>p_coupon_count then
    raise exception 'CouponId reservation returned an incomplete batch';
  end if;

  for v_offset in 0..p_days_ahead loop
    v_date:=v_today+v_offset;
    select r.first_number,r.last_number into v_first,v_last
    from fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(
      p_business_id,p_pos_id,v_date,p_coupon_count
    ) r;
    if v_first is null or v_last is null or v_last-v_first+1<>p_coupon_count then
      raise exception 'Daily-number reservation returned an incomplete range for %',v_date;
    end if;
    v_daily_ranges:=v_daily_ranges||pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'business_date',v_date::text,'first_number',v_first,'last_number',v_last
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'coupon_ids',pg_catalog.to_jsonb(v_coupon_ids),
    'daily_ranges',v_daily_ranges
  );
end;
$$;
revoke all on function public.fiskalo_basic_reserve_offline_capacity(uuid,uuid,integer,integer) from public,anon;
grant execute on function public.fiskalo_basic_reserve_offline_capacity(uuid,uuid,integer,integer) to authenticated;
