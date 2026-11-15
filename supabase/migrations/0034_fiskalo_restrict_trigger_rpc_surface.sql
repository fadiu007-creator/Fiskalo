-- Restrict trigger-only functions from the PostgREST RPC surface.
-- These functions are invoked by table triggers; application roles must not
-- be able to call them directly as SECURITY DEFINER RPCs.
revoke all on function public.fiskalo_basic_apply_purchase_item() from public, anon, authenticated;
revoke all on function public.fiskalo_basic_apply_stock_movement() from public, anon, authenticated;
revoke all on function public.fiskalo_basic_block_audit_mutation() from public, anon, authenticated;

alter function public.fiskalo_basic_block_audit_mutation() set search_path = '';
