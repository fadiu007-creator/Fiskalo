-- Full fiscal receipts must carry the separately signed CitizenCoupon used by
-- the official QR code. Historical rows remain readable with both fields null.
alter table public.fiskalo_atk_fiscal_documents
  add column if not exists citizen_coupon_base64 text,
  add column if not exists citizen_signature_base64 text;

alter table public.fiskalo_atk_fiscal_documents
  drop constraint if exists fiskalo_atk_fiscal_documents_citizen_payload_pair_check;
alter table public.fiskalo_atk_fiscal_documents
  add constraint fiskalo_atk_fiscal_documents_citizen_payload_pair_check
  check (
    (citizen_coupon_base64 is null and citizen_signature_base64 is null)
    or
    (citizen_coupon_base64 is not null and citizen_signature_base64 is not null)
  ) not valid;
alter table public.fiskalo_atk_fiscal_documents
  validate constraint fiskalo_atk_fiscal_documents_citizen_payload_pair_check;

comment on column public.fiskalo_atk_fiscal_documents.citizen_coupon_base64 is
  'Base64-encoded signed ATK CitizenCoupon Protobuf; this is the receipt QR payload, not the POS coupon.';
comment on column public.fiskalo_atk_fiscal_documents.citizen_signature_base64 is
  'ECDSA signature over the Base64-encoded CitizenCoupon Protobuf.';

notify pgrst, 'reload schema';
