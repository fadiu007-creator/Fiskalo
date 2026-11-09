-- Restrict the low-level correction writer to the owner-checked correction workflow.
-- The public API must go through fiskalo_basic_store_correction_receipt, which
-- checks owner membership, request identity and required ATK TEST response fields.
-- It cannot independently authenticate a browser-supplied ATK response; a signed
-- local-agent attestation or server-side ATK verification remains a production gate.
-- The SECURITY DEFINER store function remains able to call the private helper as its owner.
revoke all on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public,anon,authenticated;

revoke all on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public,anon,authenticated;
