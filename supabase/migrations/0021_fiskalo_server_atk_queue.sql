-- Trusted service-role enqueue for signed offline coupons.
-- Only documents that have not been sent to ATK may enter the automatic recovery queue.
create or replace function public.fiskalo_basic_server_queue_atk_receipt_v2(
  p_actor_id uuid,
  p_business_id uuid,
  p_sale_id uuid,
  p_pos_record_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
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
declare
  v_sale public.fiskalo_basic_sales%rowtype;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
  v_id uuid;
begin
  if p_actor_id is null or p_business_id is null or p_sale_id is null or p_pos_record_id is null then
    raise exception 'Authenticated actor, business, sale and POS are required';
  end if;
  if not exists (
    select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=p_actor_id
  ) then raise exception 'Actor is not a member of this business'; end if;

  select s.* into v_sale
  from public.fiskalo_basic_sales s
  join public.fiskalo_basic_pos p
    on p.id=s.pos_id and p.business_id=s.business_id
  where s.id=p_sale_id and s.business_id=p_business_id
    and s.pos_id=p_pos_record_id and s.coupon_id=p_coupon_id
  for update of s;
  if not found or v_sale.status<>'paid' then
    raise exception 'Only a paid sale belonging to this POS can be queued';
  end if;
  if v_sale.daily_number is distinct from p_daily_number then
    raise exception 'Daily coupon number does not match the saved sale';
  end if;
  if coalesce(p_idempotency_key,'')='' or length(p_idempotency_key)>256 or
     coalesce(p_signed_payload,'')='' or coalesce(p_signature,'')='' or
     coalesce(p_citizen_payload,'')='' or coalesce(p_citizen_signature,'')='' then
    raise exception 'Signed POS and CitizenCoupon payloads are required';
  end if;
  if coalesce(p_nui_kf,'') !~ '^[A-Z0-9]{16}$' or p_verification_no is distinct from p_nui_kf then
    raise exception 'NUIKF and per-coupon VerificationNo must be the same 16-character value';
  end if;
  if p_daily_number is null or p_daily_number<=0 or p_offline_issued_at is null then
    raise exception 'A valid daily number and offline issue timestamp are required';
  end if;
  if p_offline_issued_at > now() + interval '2 minutes' or
     p_offline_issued_at + interval '48 hours' <= now() then
    raise exception 'Offline coupon is outside the permitted 48-hour recovery window';
  end if;
  if p_qr_svg_base64 is null or length(p_qr_svg_base64)>65536 then
    raise exception 'CitizenCoupon QR SVG is missing or too large';
  end if;

  select * into v_existing
  from public.fiskalo_basic_fiscal_documents d
  where d.idempotency_key=p_idempotency_key
  for update;
  if found then
    if v_existing.business_id<>p_business_id or v_existing.sale_id<>p_sale_id or
       v_existing.coupon_id<>p_coupon_id or v_existing.document_type<>1 or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.verification_no<>p_verification_no or
       v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or
       v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal document data';
    end if;
    if v_existing.submission_state='queued' then return v_existing.id; end if;
    raise exception 'Fiscal document has already been submitted or requires reconciliation';
  end if;

  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,
    signed_payload,signature,submission_state,nui_kf,verification_no,
    citizen_payload,citizen_signature,daily_number,qr_svg_base64,
    offline_issued_at,recovery_deadline_at,attempt_count,next_attempt_at
  ) values (
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,
    p_signed_payload,p_signature,'queued',p_nui_kf,p_verification_no,
    p_citizen_payload,p_citizen_signature,p_daily_number,p_qr_svg_base64,
    p_offline_issued_at,p_offline_issued_at+interval '48 hours',0,now()
  ) returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.fiskalo_basic_server_queue_atk_receipt_v2(
  uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,timestamptz,text
) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_queue_atk_receipt_v2(
  uuid,uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,timestamptz,text
) to service_role;
