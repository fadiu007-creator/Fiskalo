-- Run after migrations 0001-0017 in a Supabase SQL session.
-- Static schema, RLS, trigger and RPC contract checks. Runtime tenant tests
-- still require authenticated JWT fixtures in a disposable database.
begin;
do $$
declare
  rpc_oid oid;
  movement_trigger oid;
  purchase_trigger oid;
  stock_trigger oid;
  definition text;
  table_name text;
begin
  foreach table_name in array array[
    'fiskalo_basic_stock_movements',
    'fiskalo_basic_purchases',
    'fiskalo_basic_purchase_items',
    'fiskalo_basic_expenses'
  ] loop
    if to_regclass('public.' || table_name) is null then
      raise exception 'Required business operations table is missing: %', table_name;
    end if;
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=table_name and c.relrowsecurity
    ) then
      raise exception 'RLS must be enabled on %', table_name;
    end if;
  end loop;

  if not has_table_privilege('authenticated','public.fiskalo_basic_stock_movements','SELECT,INSERT')
     or has_table_privilege('authenticated','public.fiskalo_basic_stock_movements','UPDATE,DELETE') then
    raise exception 'Stock ledger must be readable/insertable but immutable to authenticated users';
  end if;
  if not has_table_privilege('authenticated','public.fiskalo_basic_purchase_items','SELECT,INSERT')
     or has_table_privilege('authenticated','public.fiskalo_basic_purchase_items','UPDATE,DELETE') then
    raise exception 'Purchase lines must be readable/insertable but immutable to authenticated users';
  end if;

  rpc_oid:=to_regprocedure('public.fiskalo_basic_create_purchase(uuid,text,text,date,text,text,text,jsonb)');
  if rpc_oid is null then raise exception 'Atomic purchase RPC is missing'; end if;
  if not has_function_privilege('authenticated',rpc_oid,'EXECUTE')
     or has_function_privilege('anon',rpc_oid,'EXECUTE')
     or has_function_privilege('public',rpc_oid,'EXECUTE') then
    raise exception 'Atomic purchase RPC must be authenticated-only';
  end if;
  select pg_get_functiondef(rpc_oid) into definition;
  if position('auth.uid()' in definition)=0
     or position('fiskalo_basic_members' in definition)=0
     or position('role=''owner''' in definition)=0
     or position('jsonb_array_elements' in definition)=0 then
    raise exception 'Purchase RPC must validate owner membership and process purchase lines';
  end if;

  select t.oid into stock_trigger from pg_trigger t
    where t.tgrelid='public.fiskalo_basic_stock_movements'::regclass
      and t.tgname='fiskalo_basic_stock_movement_apply' and not t.tgisinternal;
  if stock_trigger is null then raise exception 'Stock movement balance trigger is missing'; end if;
  select t.oid into purchase_trigger from pg_trigger t
    where t.tgrelid='public.fiskalo_basic_purchase_items'::regclass
      and t.tgname='fiskalo_basic_purchase_item_apply' and not t.tgisinternal;
  if purchase_trigger is null then raise exception 'Purchase item stock/subtotal trigger is missing'; end if;

  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid='public.fiskalo_basic_stock_movements'::regclass
      and t.tgname='fiskalo_basic_stock_movement_immutable' and not t.tgisinternal
  ) or not exists (
    select 1 from pg_trigger t
    where t.tgrelid='public.fiskalo_basic_purchase_items'::regclass
      and t.tgname='fiskalo_basic_purchase_item_immutable' and not t.tgisinternal
  ) then
    raise exception 'Immutable audit triggers are missing';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public'
      and tablename='fiskalo_basic_stock_movements'
      and policyname='fiskalo_basic_stock_read_owner'
  ) or not exists (
    select 1 from pg_policies where schemaname='public'
      and tablename='fiskalo_basic_purchases'
      and policyname='fiskalo_basic_purchases_read_owner'
  ) or not exists (
    select 1 from pg_policies where schemaname='public'
      and tablename='fiskalo_basic_expenses'
      and policyname='fiskalo_basic_expenses_owner'
  ) then
    raise exception 'Owner-scoped read/write policies are incomplete';
  end if;
end $$;
rollback;
