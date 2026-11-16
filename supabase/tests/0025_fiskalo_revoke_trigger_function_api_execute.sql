begin;
do $test$
declare
  fn regprocedure;
  trigger_count integer;
begin
  foreach fn in array array[
    'public.fiskalo_guard_invoice()'::regprocedure,
    'public.fiskalo_initialize_invoice()'::regprocedure,
    'public.fiskalo_refresh_invoice_totals()'::regprocedure,
    'public.fiskalo_touch_updated_at()'::regprocedure
  ] loop
    if has_function_privilege('anon',fn,'EXECUTE')
       or has_function_privilege('authenticated',fn,'EXECUTE') then
      raise exception 'Trigger helper % is still directly executable through the API',fn;
    end if;
    select count(*) into trigger_count
    from pg_trigger t
    where t.tgfoid=fn and not t.tgisinternal;
    if trigger_count=0 then
      raise exception 'Expected trigger binding for % was removed',fn;
    end if;
  end loop;
end
$test$;
rollback;
