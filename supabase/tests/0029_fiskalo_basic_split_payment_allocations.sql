begin;
do $test$
declare fn regprocedure; def text;
begin
  if not exists(select 1 from pg_constraint where conrelid='public.fiskalo_basic_sales'::regclass
    and conname='fiskalo_basic_sales_payment_method_check'
    and pg_get_constraintdef(oid) like '%mixed%') then
    raise exception 'Sales must support mixed and all ATK tender methods';
  end if;
  fn:=to_regprocedure('public.fiskalo_basic_create_sale_with_allocations(uuid,uuid,jsonb,uuid,jsonb)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Online split-payment RPC privileges are incorrect';
  end if;
  fn:=to_regprocedure('public.fiskalo_basic_sync_offline_sale_with_allocations(uuid,uuid,jsonb,uuid,bigint,bigint,date,uuid,text,text,jsonb,timestamptz,jsonb)');
  if fn is null or not has_function_privilege('authenticated',fn,'EXECUTE') or has_function_privilege('anon',fn,'EXECUTE') then
    raise exception 'Offline split-payment sync RPC privileges are incorrect';
  end if;
  fn:=to_regprocedure('fiskalo_private.fiskalo_basic_normalize_payment_allocations(bigint,jsonb)');
  select pg_get_functiondef(fn) into def;
  if position('voucher' in def)=0 or position('cheque' in def)=0 or position('crypto' in def)=0 or
     position('amount_cents' in def)=0 or position('each payment method' in lower(def))=0 then
    raise exception 'Payment allocation validator is missing supported tender and duplicate/amount checks';
  end if;
end
$test$;
rollback;
