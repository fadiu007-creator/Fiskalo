-- Persist the rendered signed CitizenCoupon QR with the fiscal document so
-- reprints work from another browser/device without the original local queue.
alter table public.fiskalo_basic_fiscal_documents
  add column if not exists qr_svg_base64 text
  check (qr_svg_base64 is null or char_length(qr_svg_base64) between 1 and 65536);

create or replace function fiskalo_private.fiskalo_basic_set_receipt_qr(
  p_business_id uuid,
  p_sale_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_qr_svg_base64 text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_svg text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_qr_svg_base64 is null or char_length(p_qr_svg_base64) not between 1 and 65536 then
    raise exception 'Receipt QR SVG is missing or exceeds the allowed size';
  end if;
  begin
    v_svg:=convert_from(decode(p_qr_svg_base64,'base64'),'UTF8');
  exception when others then
    raise exception 'Receipt QR must be valid Base64-encoded UTF-8 SVG';
  end;
  if left(v_svg,4)<>'<svg' then
    raise exception 'Receipt QR must contain an SVG document';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id
      and s.coupon_id=p_coupon_id and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible'; end if;
  update public.fiskalo_basic_fiscal_documents d
    set qr_svg_base64=p_qr_svg_base64
    where d.business_id=p_business_id and d.sale_id=p_sale_id
      and d.coupon_id=p_coupon_id and d.idempotency_key=p_idempotency_key
      and d.nui_kf is not null and d.citizen_payload is not null
      and d.citizen_signature is not null;
  if not found then raise exception 'Signed fiscal document was not found for this sale'; end if;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_set_receipt_qr(uuid,uuid,bigint,text,text) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_set_receipt_qr(uuid,uuid,bigint,text,text) to authenticated;

create or replace function public.fiskalo_basic_set_receipt_qr(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,p_qr_svg_base64 text
) returns void
language sql
security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_set_receipt_qr(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_qr_svg_base64
  )
$$;
revoke all on function public.fiskalo_basic_set_receipt_qr(uuid,uuid,bigint,text,text) from public,anon;
grant execute on function public.fiskalo_basic_set_receipt_qr(uuid,uuid,bigint,text,text) to authenticated;
