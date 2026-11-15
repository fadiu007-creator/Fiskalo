create or replace function public.fiskalo_basic_server_begin_atk_correction_v2(
  p_actor_id uuid,p_business_id uuid,p_sale_id uuid,p_pos_record_id uuid,
  p_original_coupon_id bigint,p_correction_coupon_id bigint,p_document_type smallint,
  p_idempotency_key text,p_signed_payload text,p_signature text,p_nui_kf text,p_verification_no text,
  p_citizen_payload text,p_citizen_signature text,p_daily_number bigint,p_qr_svg_base64 text
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_id uuid;
begin
  v_id:=public.fiskalo_basic_server_begin_atk_correction_v1(
    p_actor_id,p_business_id,p_sale_id,p_pos_record_id,p_original_coupon_id,p_correction_coupon_id,
    p_document_type,p_idempotency_key,p_signed_payload,p_signature,p_nui_kf,p_verification_no,
    p_citizen_payload,p_citizen_signature,p_daily_number,p_qr_svg_base64
  );
  update public.fiskalo_basic_fiscal_documents
    set last_attempt_at=coalesce(last_attempt_at,now()),
        attempt_count=greatest(coalesce(attempt_count,0),1)
    where id=v_id and submission_state='submitting';
  return v_id;
end;
$$;
revoke all on function public.fiskalo_basic_server_begin_atk_correction_v2(
  uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,text
) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_begin_atk_correction_v2(
  uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,text
) to service_role;
