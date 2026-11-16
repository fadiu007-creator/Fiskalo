-- The local POS Agent + Edge Function attestation path is now authoritative.
-- Revoke browser access to legacy RPCs that could persist unsigned/unverified
-- offline receipt payloads or consume reserved CouponIds from a browser session.
revoke all on function public.fiskalo_basic_store_offline_receipt_v2(
  uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz,text
) from public,anon,authenticated;
revoke all on function public.fiskalo_basic_store_offline_receipt(
  uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz
) from public,anon,authenticated;
revoke all on function fiskalo_private.fiskalo_basic_store_offline_receipt(
  uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz
) from public,anon,authenticated;
revoke all on function public.fiskalo_basic_consume_offline_coupon_id(
  uuid,uuid,bigint,uuid
) from public,anon,authenticated;

comment on function public.fiskalo_basic_store_offline_receipt_v2(
  uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz,text
) is 'Deprecated browser write path. Use fiskalo-basic-atk-receipts Edge Function with local POS Agent attestation.';
comment on function public.fiskalo_basic_store_offline_receipt(
  uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz
) is 'Deprecated browser write path. Use fiskalo-basic-atk-receipts Edge Function with local POS Agent attestation.';
comment on function public.fiskalo_basic_consume_offline_coupon_id(
  uuid,uuid,bigint,uuid
) is 'Reserved for trusted server-side reconciliation; browser clients must not consume CouponIds.';
