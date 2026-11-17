begin;
do $test$
declare
  fn regprocedure;
  signature text;
  trigger_count integer;
  found_helpers integer:=0;
begin
  foreach signature in array array[
    'public.fiskalo_guard_invoice()',
    'public.fiskalo_initialize_invoice()',
    'public.fiskalo_refresh_invoice_totals()',
    'public.fiskalo_touch_updated_at()'
  ] loop
    fn:=to_regprocedure(signature);
    if fn is not null then
      found_helpers:=found_helpers+1;
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
    end if;
  end loop;
  -- These helpers belong to the separately provisioned Full-app schema and
  -- are optional in a clean Basic-only migration replay.
  if found_helpers not in (0,4) then
    raise exception 'Partial Full-app trigger helper installation detected';
  end if;
end
$test$;
rollback;
