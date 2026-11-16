-- Run after migrations 0001-0019 in a disposable Supabase database.
begin;
do $$
declare
  fn regprocedure;
  def text;
begin
  if to_regclass('public.fiskalo_basic_daily_number_consumptions') is null then
    raise exception 'Offline daily number consumption ledger is missing';
  end if;
  if not exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_basic_sales'
      and column_name='stock_reconciliation_required') then
    raise exception 'Offline stock reconciliation marker is missing';
  end if;

  fn:=to_regprocedure('public.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamp with time zone)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE')
     or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Offline sale reconciliation RPC must be authenticated-only';
  end if;
  select pg_get_functiondef('fiskalo_private.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamp with time zone)'::regprocedure) into def;
  if position('fiskalo_basic_coupon_reservations' in def)=0 or
     position('fiskalo_basic_daily_number_reservations' in def)=0 or
     position('fiskalo_basic_daily_number_consumptions' in def)=0 then
    raise exception 'Offline sale must validate and consume both reserved identity ledgers';
  end if;
  if position('p_created_at at time zone ''Europe/Belgrade''' in def)=0 or
     position('p_expected_snapshot' in def)=0 then
    raise exception 'Offline sale must validate original Kosovo business date and immutable line snapshot';
  end if;
  if position('stock_reconciliation_required' in def)=0 then
    raise exception 'Offline stock mismatch must be explicitly flagged';
  end if;
  if has_function_privilege('anon','fiskalo_private.fiskalo_basic_sync_offline_sale(uuid,uuid,text,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamp with time zone)','EXECUTE') then
    raise exception 'Private offline sale function must not be executable by anon';
  end if;

  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_reserve_offline_daily_numbers(uuid,uuid,date,integer)');
  select pg_get_functiondef(fn) into def;
  if position('v_today+7' in def)=0 then
    raise exception 'Daily number provisioning must support the planned seven-day offline horizon';
  end if;
end $$;
rollback;
