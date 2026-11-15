-- The legacy correction RPC trusts a browser-supplied ATK response.
-- Disable it until the web runtime uses the server-verified correction submission path.
revoke all on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) to service_role;

revoke all on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public,anon,authenticated;
