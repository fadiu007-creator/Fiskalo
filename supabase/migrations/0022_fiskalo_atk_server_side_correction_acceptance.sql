-- Close the browser-trust vulnerability for correction acceptance.
-- The correction Edge Function uses the service role only after its own authenticated
-- server-to-server HTTPS submission to the fixed ATK TEST endpoint.
revoke all on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public, anon, authenticated;
revoke all on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public, anon, authenticated;

-- Do not allow clients to bypass the RPC boundary with direct fiscal-document inserts.
revoke insert on table public.fiskalo_basic_fiscal_documents from anon, authenticated;
