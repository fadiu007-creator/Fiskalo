-- Durable server-side recovery metadata for ATK TEST offline coupons.
alter table public.fiskalo_basic_fiscal_documents
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error text;

create index if not exists fiskalo_basic_fiscal_documents_recovery_idx
  on public.fiskalo_basic_fiscal_documents (next_attempt_at, recovery_deadline_at)
  where submission_state='queued';

create or replace function public.fiskalo_basic_store_offline_receipt_v2(
  p_business_id uuid,
  p_sale_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
  p_nui_kf text,
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
  if coalesce(p_nui_kf,'') !~ '^[A-Z0-9]{16}$' then
    raise exception 'NUIKF / coupon verification number must be 16 uppercase alphanumeric characters';
  end if;
  v_id:=public.fiskalo_basic_store_offline_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at
  );
  update public.fiskalo_basic_fiscal_documents
    set verification_no=p_nui_kf,
        qr_svg_base64=p_qr_svg_base64,
        attempt_count=0,
        next_attempt_at=now(),
        last_attempt_at=null,
        last_error=null,
        submission_state='queued',
        recovery_deadline_at=coalesce(recovery_deadline_at,p_offline_issued_at+interval '48 hours')
    where id=v_id;
  return v_id;
end;
$$;

revoke all on function public.fiskalo_basic_store_offline_receipt_v2(
  uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz,text
) from public,anon;
grant execute on function public.fiskalo_basic_store_offline_receipt_v2(
  uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz,text
) to authenticated;
