-- Run after migrations 0001-0018 in a disposable Supabase database.
-- Static contract checks; JWT-backed runtime tests are required before release.
begin;
do $$
declare
  fn regprocedure;
  def text;
begin
  if to_regclass('public.fiskalo_basic_coupon_reservations') is null or
     to_regclass('public.fiskalo_basic_daily_number_reservations') is null then
    raise exception 'Offline reservation tables are missing';
  end if;
  if not exists(select 1 from pg_indexes where schemaname='public'
    and indexname='fiskalo_basic_coupon_reservations_coupon_id_key') then
    raise exception 'Coupon IDs must be globally unique in reservation ledger';
  end if;
  if not has_table_privilege('authenticated','public.fiskalo_basic_coupon_reservations','SELECT')
     or has_table_privilege('authenticated','public.fiskalo_basic_coupon_reservations','INSERT,UPDATE,DELETE') then
    raise exception 'Authenticated users may read but not mutate reservation ledger directly';
  end if;
  if has_table_privilege('anon','public.fiskalo_basic_coupon_reservations','SELECT') then
    raise exception 'Anon must not read coupon reservations';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_reserve_offline_coupon_ids(uuid,uuid,integer)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE')
     or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Coupon reservation RPC must be authenticated-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('fiskalo_private.fiskalo_basic_reserve_offline_coupon_ids' in def)=0 then
    raise exception 'Public coupon reservation RPC must delegate to private implementation';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE')
     or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Daily number reservation RPC must be authenticated-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('Europe/Belgrade' in def)=0 then
    raise exception 'Daily reservation must enforce Kosovo business date';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_consume_offline_coupon_id(uuid,uuid,bigint,uuid)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE')
     or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Coupon consume RPC must be authenticated-only';
  end if;
  select pg_get_functiondef(fn) into def;
  if position('already been consumed' in def)=0 or position('consumed_idempotency_key' in def)=0 then
    raise exception 'Coupon consumption must reject cross-checkout reuse';
  end if;

  if not exists(select 1 from pg_constraint
    where conrelid='public.fiskalo_basic_coupon_reservations'::regclass
      and contype='u') then
    raise exception 'Coupon reservation uniqueness constraint is missing';
  end if;
end $$;
rollback;
