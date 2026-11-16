-- Atomic offline-capacity provisioning reserves today's and upcoming daily
-- number ranges together. Allow a bounded future window so the POS can continue
-- fiscalizing across a short outage that crosses Kosovo midnight.
create or replace function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(
  p_business_id uuid,p_pos_id uuid,p_business_date date,p_count integer
) returns table(first_number bigint,last_number bigint)
language plpgsql security definer set search_path='' as $offline$
declare
  v_first bigint;
  v_last bigint;
  v_today date;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_count is null or p_count<1 or p_count>500 then
    raise exception 'Reservation count must be between 1 and 500';
  end if;
  v_today:=(now() at time zone 'Europe/Belgrade')::date;
  if p_business_date is null or p_business_date<v_today or p_business_date>v_today+7 then
    raise exception 'Offline daily numbers may only be reserved from today through seven days ahead in Kosovo time';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid() and m.role='owner') then
    raise exception 'Business owner access required';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_id and p.business_id=p_business_id
      and p.certificate_status in ('verified','certificate_issued')) then
    raise exception 'POS does not belong to this business or has no verified certificate';
  end if;
  insert into fiskalo_private.fiskalo_basic_daily_counters(pos_id,business_date,last_number)
    values(p_pos_id,p_business_date,p_count)
  on conflict(pos_id,business_date) do update
    set last_number=fiskalo_private.fiskalo_basic_daily_counters.last_number+p_count
  returning last_number-p_count+1,last_number into v_first,v_last;
  insert into public.fiskalo_basic_daily_number_reservations(
    business_id,pos_id,business_date,first_number,last_number
  ) values(p_business_id,p_pos_id,p_business_date,v_first,v_last);
  return query select v_first,v_last;
end;
$offline$;
revoke all on function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer)
  from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer)
  to authenticated;
