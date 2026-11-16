-- Trigger functions are invoked by PostgreSQL's trigger machinery, not as RPC endpoints.
-- Remove inherited/default API EXECUTE grants so PostgREST cannot expose these helpers.
revoke all on function public.fiskalo_guard_invoice() from public, anon, authenticated;
revoke all on function public.fiskalo_initialize_invoice() from public, anon, authenticated;
revoke all on function public.fiskalo_refresh_invoice_totals() from public, anon, authenticated;
revoke all on function public.fiskalo_touch_updated_at() from public, anon, authenticated;
