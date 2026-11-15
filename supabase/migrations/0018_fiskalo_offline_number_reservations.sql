-- Offline identity reservations. Coupon IDs are business-wide unique; a POS receives
-- individual IDs from the same global sequence used by online checkout. We deliberately
-- store individual IDs (not ranges) because other online POSs may allocate between them.
create table if not exists public.fiskalo_basic_coupon_reservations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete restrict,
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  coupon_id bigint not null unique,
  reserved_at timestamptz not null default now(),
  state text not null default 'reserved'
    check (state in ('reserved','consumed','reconciled')),
  consumed_idempotency_key uuid,
  consumed_at timestamptz,
  unique (business_id,pos_id,coupon_id),
  check ((state='reserved' and consumed_idempotency_key is null and consumed_at is null)
      or (state in ('consumed','reconciled') and consumed_idempotency_key is not null and consumed_at is not null))
);
create index if not exists fiskalo_basic_coupon_reservations_device_idx
  on public.fiskalo_basic_coupon_reservations(business_id,pos_id,state);
alter table public.fiskalo_basic_coupon_reservations enable row level security;
create policy fiskalo_basic_coupon_reservations_read
  on public.fiskalo_basic_coupon_reservations for select to authenticated
  using (exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=fiskalo_basic_coupon_reservations.business_id and m.user_id=auth.uid()));
revoke all on public.fiskalo_basic_coupon_reservations from anon,authenticated;
grant select on public.fiskalo_basic_coupon_reservations to authenticated;

-- Daily numbers are allocated from the same per-POS/per-business-date counter used
-- by the online sale trigger. Reservations are for today's Kosovo business date only.
create table if not exists public.fiskalo_basic_daily_number_reservations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete restrict,
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  business_date date not null,
  first_number bigint not null check (first_number > 0),
  last_number bigint not null check (last_number >= first_number),
  reserved_at timestamptz not null default now(),
  unique (pos_id,business_date,first_number),
  check (last_number-first_number < 10000)
);
alter table public.fiskalo_basic_daily_number_reservations enable row level security;
create policy fiskalo_basic_daily_number_reservations_read
  on public.fiskalo_basic_daily_number_reservations for select to authenticated
  using (exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=fiskalo_basic_daily_number_reservations.business_id and m.user_id=auth.uid()));
revoke all on public.fiskalo_basic_daily_number_reservations from anon,authenticated;
grant select on public.fiskalo_basic_daily_number_reservations to authenticated;

create or replace function fiskalo_private.fiskalo_basic_reserve_offline_coupon_ids(
  p_business_id uuid,p_pos_id uuid,p_count integer
) returns table(coupon_ids bigint[])
language plpgsql security definer set search_path='' as $$
declare v_ids bigint[] := array[]::bigint[]; v_id bigint; i integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_count is null or p_count<1 or p_count>500 then raise exception 'Reservation count must be between 1 and 500'; end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()) then
    raise exception 'Not a member of this business';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_id and p.business_id=p_business_id
      and p.certificate_status in ('verified','certificate_issued')) then
    raise exception 'POS does not belong to this business or has no verified certificate';
  end if;
  -- nextval is globally atomic and shared with the online checkout allocator.
  for i in 1..p_count loop
    v_id:=pg_catalog.nextval('public.fiskalo_basic_coupon_seq'::regclass);
    insert into public.fiskalo_basic_coupon_reservations(business_id,pos_id,coupon_id)
      values(p_business_id,p_pos_id,v_id);
    v_ids:=pg_catalog.array_append(v_ids,v_id);
  end loop;
  return query select v_ids;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_reserve_offline_coupon_ids(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_reserve_offline_coupon_ids(uuid,uuid,integer) to authenticated;

create or replace function public.fiskalo_basic_reserve_offline_coupon_ids(
  p_business_id uuid,p_pos_id uuid,p_count integer
) returns table(coupon_ids bigint[])
language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select * from fiskalo_private.fiskalo_basic_reserve_offline_coupon_ids(p_business_id,p_pos_id,p_count)
$$;
revoke all on function public.fiskalo_basic_reserve_offline_coupon_ids(uuid,uuid,integer) from public,anon;
grant execute on function public.fiskalo_basic_reserve_offline_coupon_ids(uuid,uuid,integer) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(
  p_business_id uuid,p_pos_id uuid,p_business_date date,p_count integer
) returns table(first_number bigint,last_number bigint)
language plpgsql security definer set search_path='' as $$
declare v_first bigint; v_last bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_count is null or p_count<1 or p_count>500 then raise exception 'Reservation count must be between 1 and 500'; end if;
  if p_business_date is distinct from (now() at time zone 'Europe/Belgrade')::date then
    raise exception 'Offline daily numbers may only be reserved for the current Kosovo business date';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()) then
    raise exception 'Not a member of this business';
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
$$;
revoke all on function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer) from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer) to authenticated;

create or replace function public.fiskalo_basic_reserve_offline_daily_numbers(
  p_business_id uuid,p_pos_id uuid,p_business_date date,p_count integer
) returns table(first_number bigint,last_number bigint)
language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select * from fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(p_business_id,p_pos_id,p_business_date,p_count)
$$;
revoke all on function public.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer) from public,anon;
grant execute on function public.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer) to authenticated;

-- A reserved ID can be consumed exactly once, by the same business/POS and
-- idempotency key. This does not accept browser-supplied ATK responses or signatures.
create or replace function fiskalo_private.fiskalo_basic_consume_offline_coupon_id(
  p_business_id uuid,p_pos_id uuid,p_coupon_id bigint,p_idempotency_key uuid
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_row public.fiskalo_basic_coupon_reservations%rowtype;
begin
  if auth.uid() is null or p_idempotency_key is null then raise exception 'Authentication and idempotency key are required'; end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()) then
    raise exception 'Not a member of this business';
  end if;
  select * into v_row from public.fiskalo_basic_coupon_reservations r
    where r.business_id=p_business_id and r.pos_id=p_pos_id and r.coupon_id=p_coupon_id
    for update;
  if not found then raise exception 'Coupon ID was not reserved for this POS'; end if;
  if v_row.state='reserved' then
    update public.fiskalo_basic_coupon_reservations
      set state='consumed',consumed_idempotency_key=p_idempotency_key,consumed_at=now()
      where id=v_row.id;
    return true;
  end if;
  if v_row.consumed_idempotency_key=p_idempotency_key then return false; end if;
  raise exception 'Reserved coupon ID has already been consumed by another checkout';
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_consume_offline_coupon_id(uuid,uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_consume_offline_coupon_id(uuid,uuid,bigint,uuid) to authenticated;

create or replace function public.fiskalo_basic_consume_offline_coupon_id(
  p_business_id uuid,p_pos_id uuid,p_coupon_id bigint,p_idempotency_key uuid
) returns boolean language sql security invoker set search_path=pg_catalog,public,pg_temp as $$
  select fiskalo_private.fiskalo_basic_consume_offline_coupon_id(p_business_id,p_pos_id,p_coupon_id,p_idempotency_key)
$$;
revoke all on function public.fiskalo_basic_consume_offline_coupon_id(uuid,uuid,bigint,uuid) from public,anon;
grant execute on function public.fiskalo_basic_consume_offline_coupon_id(uuid,uuid,bigint,uuid) to authenticated;
