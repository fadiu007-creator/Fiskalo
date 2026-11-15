-- Persist the per-coupon verification number separately from the POS onboarding code.
alter table public.fiskalo_basic_fiscal_documents
  add column if not exists verification_no text;

create or replace function public.fiskalo_basic_server_record_atk_receipt_v2(
  p_actor_id uuid,
  p_business_id uuid,
  p_sale_id uuid,
  p_pos_record_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
  p_atk_transaction_id numeric,
  p_atk_response jsonb,
  p_nui_kf text,
  p_verification_no text,
  p_citizen_payload text,
  p_citizen_signature text,
  p_daily_number bigint,
  p_offline_issued_at timestamptz,
  p_qr_svg_base64 text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if coalesce(p_verification_no,'') !~ '^[A-Z0-9]{16}$' then
    raise exception 'Per-coupon ATK verification number must be 16 uppercase alphanumeric characters';
  end if;
  v_id:=public.fiskalo_basic_server_record_atk_receipt(
    p_actor_id,p_business_id,p_sale_id,p_pos_record_id,p_coupon_id,
    p_idempotency_key,p_signed_payload,p_signature,p_atk_transaction_id,
    p_atk_response,p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at,p_qr_svg_base64
  );
  update public.fiskalo_basic_fiscal_documents
    set verification_no=p_verification_no
    where id=v_id;
  return v_id;
end;
$$;

revoke all on function public.fiskalo_basic_server_record_atk_receipt_v2(
  uuid,uuid,uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,text,bigint,timestamptz,text
) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_record_atk_receipt_v2(
  uuid,uuid,uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,text,bigint,timestamptz,text
) to service_role;
