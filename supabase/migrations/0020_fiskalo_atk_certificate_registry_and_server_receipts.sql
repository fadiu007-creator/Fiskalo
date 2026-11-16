-- Trusted POS certificate registry and server-only fiscal receipt persistence.
-- The Edge Function verifies a local Agent signature with this registered key
-- before calling the v2 RPCs; browser sessions cannot write accepted responses.
create table if not exists public.fiskalo_basic_pos_certificates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete restrict,
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  application_id bigint not null check (application_id > 0),
  certificate_pem text not null check (char_length(certificate_pem) between 100 and 20000),
  certificate_thumbprint text not null check (certificate_thumbprint ~ '^[A-Fa-f0-9]{40}$'),
  spki_sha256 text not null check (spki_sha256 ~ '^[A-Fa-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active','revoked')),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status='active' and revoked_at is null) or (status='revoked' and revoked_at is not null))
);
create unique index if not exists fiskalo_basic_pos_certificates_active_idx
  on public.fiskalo_basic_pos_certificates(business_id,pos_id) where status='active';
create index if not exists fiskalo_basic_pos_certificates_thumbprint_idx
  on public.fiskalo_basic_pos_certificates(certificate_thumbprint);
alter table public.fiskalo_basic_pos_certificates enable row level security;
revoke all on public.fiskalo_basic_pos_certificates from public,anon,authenticated;
grant select,insert,update on public.fiskalo_basic_pos_certificates to service_role;

-- Edge Function-only writer for offline queue evidence.
create or replace function public.fiskalo_basic_store_offline_receipt_v2(
  p_actor_id uuid,p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_nui_kf text,p_citizen_payload text,
  p_citizen_signature text,p_daily_number bigint,p_offline_issued_at timestamptz,p_qr_svg_base64 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if p_actor_id is null or not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=p_actor_id) then
    raise exception 'Authenticated business member required';
  end if;
  if p_offline_issued_at is null or p_offline_issued_at>now()+interval '2 minutes' or
     p_coupon_id is null or p_coupon_id<=0 or p_daily_number is null or p_daily_number<=0 or
     char_length(coalesce(p_nui_kf,''))<>16 or p_nui_kf !~ '^[A-Z0-9]{16}$' or
     coalesce(p_signed_payload,'')='' or coalesce(p_signature,'')='' or
     coalesce(p_citizen_payload,'')='' or coalesce(p_citizen_signature,'')='' or
     coalesce(p_idempotency_key,'')='' or coalesce(p_qr_svg_base64,'')='' then
    raise exception 'Offline signed fiscal receipt fields are invalid';
  end if;
  if not exists(select 1 from public.fiskalo_basic_sales s
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.daily_number=p_daily_number and s.status in ('paid','fiscalized')) then
    raise exception 'Offline sale and fiscal identity do not match';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=(select s.pos_id from public.fiskalo_basic_sales s where s.id=p_sale_id)
      and p.business_id=p_business_id and p.certificate_status='certificate_issued') then
    raise exception 'POS does not have an issued ATK certificate';
  end if;
  if char_length(p_qr_svg_base64)>65536 then raise exception 'QR payload is too large'; end if;
  begin
    if left(convert_from(decode(p_qr_svg_base64,'base64'),'UTF8'),4)<>'<svg' then
      raise exception 'QR payload is not an SVG document';
    end if;
  exception when others then raise exception 'QR payload is not valid Base64 SVG'; end;

  select * into v_existing from public.fiskalo_basic_fiscal_documents d
    where d.idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.business_id<>p_business_id or v_existing.sale_id<>p_sale_id or
       v_existing.coupon_id<>p_coupon_id or v_existing.signed_payload<>p_signed_payload or
       v_existing.signature<>p_signature or v_existing.nui_kf<>p_nui_kf or
       v_existing.citizen_payload<>p_citizen_payload or v_existing.citizen_signature<>p_citizen_signature or
       v_existing.daily_number<>p_daily_number then
      raise exception 'Fiscal idempotency key already exists with different signed content';
    end if;
    if v_existing.submission_state='accepted' then return v_existing.id; end if;
    update public.fiskalo_basic_fiscal_documents set
      submission_state='queued',offline_issued_at=coalesce(offline_issued_at,p_offline_issued_at),
      recovery_deadline_at=coalesce(recovery_deadline_at,p_offline_issued_at+interval '48 hours'),
      qr_svg_base64=p_qr_svg_base64
    where id=v_existing.id returning id into v_id;
  else
    insert into public.fiskalo_basic_fiscal_documents(
      business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
      signed_payload,signature,submission_state,nui_kf,citizen_payload,citizen_signature,
      daily_number,offline_issued_at,recovery_deadline_at,qr_svg_base64
    ) values(
      p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
      p_signed_payload,p_signature,'queued',p_nui_kf,p_citizen_payload,p_citizen_signature,
      p_daily_number,p_offline_issued_at,p_offline_issued_at+interval '48 hours',p_qr_svg_base64
    ) returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.fiskalo_basic_store_offline_receipt_v2(uuid,uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz,text) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_store_offline_receipt_v2(uuid,uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz,text) to service_role;

-- Edge Function-only writer for an ATK-accepted response. It requires the exact
-- registered POS, a current active certificate, and a real uint64 transaction id.
create or replace function public.fiskalo_basic_server_record_atk_receipt_v2(
  p_actor_id uuid,p_business_id uuid,p_sale_id uuid,p_pos_record_id uuid,p_coupon_id bigint,
  p_idempotency_key text,p_signed_payload text,p_signature text,p_atk_transaction_id numeric,
  p_atk_response jsonb,p_nui_kf text,p_verification_no text,p_citizen_payload text,
  p_citizen_signature text,p_daily_number bigint,p_offline_issued_at timestamptz,p_qr_svg_base64 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if p_actor_id is null or not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=p_actor_id) then
    raise exception 'Authenticated business member required';
  end if;
  if p_atk_transaction_id is null or p_atk_transaction_id<=0 or p_atk_transaction_id>18446744073709551615 or
     coalesce(p_atk_response->>'status','')<>'accepted' or
     coalesce(p_atk_response->>'transactionId','')<>p_atk_transaction_id::text or
     coalesce(p_atk_response->>'environment','')<>'ATK TEST' then
    raise exception 'ATK acceptance response is invalid';
  end if;
  if char_length(coalesce(p_nui_kf,''))<>16 or p_nui_kf !~ '^[A-Z0-9]{16}$' or
     p_verification_no is distinct from p_nui_kf or p_daily_number is null or p_daily_number<=0 or
     coalesce(p_signed_payload,'')='' or coalesce(p_signature,'')='' or
     coalesce(p_citizen_payload,'')='' or coalesce(p_citizen_signature,'')='' or
     coalesce(p_qr_svg_base64,'')='' or char_length(p_qr_svg_base64)>65536 or
     coalesce(p_idempotency_key,'')='' then
    raise exception 'Accepted signed fiscal receipt fields are invalid';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    join public.fiskalo_basic_pos_certificates c on c.business_id=p.business_id and c.pos_id=p.id
    where p.id=p_pos_record_id and p.business_id=p_business_id and p.certificate_status='certificate_issued'
      and c.application_id::text=p.application_id and c.status='active' and c.revoked_at is null) then
    raise exception 'No active registered ATK certificate exists for this POS';
  end if;
  if not exists(select 1 from public.fiskalo_basic_sales s
    where s.id=p_sale_id and s.business_id=p_business_id and s.pos_id=p_pos_record_id
      and s.coupon_id=p_coupon_id and s.daily_number=p_daily_number and s.status in ('paid','fiscalized')) then
    raise exception 'Sale, POS, CouponId or daily number does not match';
  end if;
  if char_length(p_qr_svg_base64)>65536 then raise exception 'QR payload is too large'; end if;
  begin
    if left(convert_from(decode(p_qr_svg_base64,'base64'),'UTF8'),4)<>'<svg' then
      raise exception 'QR payload is not an SVG document';
    end if;
  exception when others then raise exception 'QR payload is not valid Base64 SVG'; end;

  select * into v_existing from public.fiskalo_basic_fiscal_documents d
    where d.idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.business_id<>p_business_id or v_existing.sale_id<>p_sale_id or
       v_existing.coupon_id<>p_coupon_id or v_existing.signed_payload<>p_signed_payload or
       v_existing.signature<>p_signature or v_existing.nui_kf<>p_nui_kf or
       v_existing.citizen_payload<>p_citizen_payload or v_existing.citizen_signature<>p_citizen_signature or
       v_existing.daily_number<>p_daily_number then
      raise exception 'Fiscal idempotency key already exists with different signed content';
    end if;
    if v_existing.submission_state='accepted' and v_existing.atk_transaction_id<>p_atk_transaction_id then
      raise exception 'Accepted fiscal document cannot be assigned another ATK transaction';
    end if;
    update public.fiskalo_basic_fiscal_documents set
      submission_state='accepted',atk_transaction_id=p_atk_transaction_id,atk_response=p_atk_response,
      offline_issued_at=coalesce(offline_issued_at,p_offline_issued_at),
      recovery_deadline_at=case when p_offline_issued_at is null then recovery_deadline_at
        else coalesce(recovery_deadline_at,p_offline_issued_at+interval '48 hours') end,
      qr_svg_base64=p_qr_svg_base64
    where id=v_existing.id returning id into v_id;
  else
    insert into public.fiskalo_basic_fiscal_documents(
      business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
      signed_payload,signature,atk_transaction_id,submission_state,atk_response,
      nui_kf,citizen_payload,citizen_signature,daily_number,offline_issued_at,recovery_deadline_at,qr_svg_base64
    ) values(
      p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
      p_signed_payload,p_signature,p_atk_transaction_id,'accepted',p_atk_response,
      p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at,
      case when p_offline_issued_at is null then null else p_offline_issued_at+interval '48 hours' end,
      p_qr_svg_base64
    ) returning id into v_id;
  end if;
  update public.fiskalo_basic_sales set status='fiscalized'
    where id=p_sale_id and business_id=p_business_id and coupon_id=p_coupon_id and status='paid';
  return v_id;
end;
$$;
revoke all on function public.fiskalo_basic_server_record_atk_receipt_v2(uuid,uuid,uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,text,bigint,timestamptz,text) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_record_atk_receipt_v2(uuid,uuid,uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,text,bigint,timestamptz,text) to service_role;

-- Certificate registration is performed only after the Edge Function validates a
-- signature produced by the local POS Agent using the certificate private key.
create or replace function public.fiskalo_basic_register_pos_certificate_v1(
  p_actor_id uuid,p_business_id uuid,p_pos_id uuid,p_application_id bigint,
  p_certificate_pem text,p_certificate_thumbprint text,p_spki_sha256 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if p_actor_id is null or not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=p_actor_id and m.role='owner') then
    raise exception 'Business owner access required to register an ATK certificate';
  end if;
  if p_application_id is null or p_application_id<=0 or
     char_length(coalesce(p_certificate_pem,'')) not between 100 and 20000 or
     coalesce(p_certificate_thumbprint,'') !~ '^[A-Fa-f0-9]{40}$' or
     coalesce(p_spki_sha256,'') !~ '^[A-Fa-f0-9]{64}$' then
    raise exception 'ATK certificate registration fields are invalid';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_id and p.business_id=p_business_id
      and p.application_id::bigint=p_application_id and p.certificate_status in ('verified','certificate_issued')) then
    raise exception 'POS identity or ATK application does not match the registered business POS';
  end if;
  update public.fiskalo_basic_pos_certificates
    set status='revoked',revoked_at=now()
    where business_id=p_business_id and pos_id=p_pos_id and status='active';
  insert into public.fiskalo_basic_pos_certificates(
    business_id,pos_id,application_id,certificate_pem,certificate_thumbprint,spki_sha256,status
  ) values(
    p_business_id,p_pos_id,p_application_id,p_certificate_pem,upper(p_certificate_thumbprint),lower(p_spki_sha256),'active'
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.fiskalo_basic_register_pos_certificate_v1(uuid,uuid,uuid,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_register_pos_certificate_v1(uuid,uuid,uuid,bigint,text,text,text) to service_role;
