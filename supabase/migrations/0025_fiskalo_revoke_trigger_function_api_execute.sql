-- Trigger functions are invoked by PostgreSQL's trigger machinery, not as RPC endpoints.
-- The Full-app invoice schema is provisioned separately from the Basic migration
-- chain. Harden those helpers when present, while allowing a clean Basic-only
-- database replay where those optional Full-app functions do not exist.
do $$
declare
  fn regprocedure;
  signature text;
begin
  foreach signature in array array[
    'public.fiskalo_guard_invoice()',
    'public.fiskalo_initialize_invoice()',
    'public.fiskalo_refresh_invoice_totals()',
    'public.fiskalo_touch_updated_at()'
  ] loop
    fn:=to_regprocedure(signature);
    if fn is not null then
      execute format('revoke all on function %s from public,anon,authenticated',fn);
    end if;
  end loop;
end
$$;
