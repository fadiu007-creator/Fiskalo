-- Durable ATK correction journal. This does not expose UI actions or submit documents;
-- callers must first obtain an accepted ATK TEST response for the signed correction.
alter table public.fiskalo_basic_fiscal_documents
  add column if not exists parent_document_id uuid
    references public.fiskalo_basic_fiscal_documents(id);

create index if not exists fiskalo_basic_fiscal_correction_parent_idx
  on public.fiskalo_basic_fiscal_documents(parent_document_id)
  where parent_document_id is not null;

create or replace function fiskalo_private.fiskalo_basic_record_atk_correction(
  p_business_id uuid,
  p_sale_id uuid,
  p_original_coupon_id bigint,
  p_correction_coupon_id bigint,
  p_document_type smallint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
  p_atk_transaction_id numeric,
  p_atk_response jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_original public.fiskalo_basic_fiscal_documents%rowtype;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
  v_new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_document_type not in (2,3) then
    raise exception 'Correction document type must be ATK Cancel (2) or Return (3)';
  end if;
  if p_original_coupon_id is null or p_original_coupon_id<=0 or
     p_correction_coupon_id is null or p_correction_coupon_id<=0 or
     p_correction_coupon_id=p_original_coupon_id then
    raise exception 'Original and correction coupon identifiers are invalid';
  end if;
  if length(trim(coalesce(p_idempotency_key,'')))=0 or
     length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 then
    raise exception 'Idempotency key, signed payload and signature are required';
  end if;
  if p_atk_transaction_id is null or p_atk_transaction_id<=0 or
     p_atk_transaction_id>18446744073709551615 then
    raise exception 'A valid ATK uint64 transaction_id is required';
  end if;
  if p_atk_response is null or
     coalesce(p_atk_response->>'status','')<>'accepted' or
     coalesce(p_atk_response->>'transactionId','')<>p_atk_transaction_id::text or
     coalesce(p_atk_response->>'environment','')<>'ATK TEST' then
    raise exception 'ATK response must be an accepted TEST response matching the transaction_id';
  end if;
  if not exists (
    select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()
  ) then raise exception 'Not a member of this business'; end if;

  select d.* into v_original
  from public.fiskalo_basic_fiscal_documents d
  join public.fiskalo_basic_sales s
    on s.id=d.sale_id and s.business_id=d.business_id
  where d.business_id=p_business_id and d.sale_id=p_sale_id
    and d.coupon_id=p_original_coupon_id and d.document_type=1
    and d.submission_state='accepted' and d.atk_transaction_id>0
    and s.status='fiscalized'
  for update of d;
  if not found then
    raise exception 'Original sale must have a persisted accepted ATK fiscal document';
  end if;

  select * into v_existing
  from public.fiskalo_basic_fiscal_documents
  where idempotency_key=p_idempotency_key
  for update;
  if found then
    if v_existing.business_id<>p_business_id or v_existing.sale_id<>p_sale_id or
       v_existing.coupon_id<>p_correction_coupon_id or
       v_existing.document_type<>p_document_type or
       v_existing.reference_coupon_id<>p_original_coupon_id or
       v_existing.parent_document_id<>v_original.id or
       v_existing.signed_payload<>p_signed_payload or
       v_existing.signature<>p_signature then
      raise exception 'Idempotency key already exists with different correction data';
    end if;
    if v_existing.submission_state='accepted' and
       v_existing.atk_transaction_id<>p_atk_transaction_id then
      raise exception 'Accepted correction cannot be assigned a different ATK transaction';
    end if;
    update public.fiskalo_basic_fiscal_documents
      set atk_transaction_id=p_atk_transaction_id,
          submission_state='accepted',
          atk_response=p_atk_response
      where id=v_existing.id
      returning id into v_new_id;
    return v_new_id;
  end if;

  if p_document_type=2 and exists (
    select 1 from public.fiskalo_basic_fiscal_documents d
    where d.parent_document_id=v_original.id and d.document_type=2
      and d.submission_state in ('queued','submitted','accepted','needs_reconciliation')
  ) then
    raise exception 'An ATK cancellation already exists or is unresolved for this sale';
  end if;

  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,
    reference_coupon_id,parent_document_id,signed_payload,signature,
    atk_transaction_id,submission_state,atk_response
  ) values (
    p_business_id,p_sale_id,p_correction_coupon_id,p_idempotency_key,p_document_type,
    p_original_coupon_id,v_original.id,p_signed_payload,p_signature,
    p_atk_transaction_id,'accepted',p_atk_response
  ) returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) to authenticated;

create or replace function public.fiskalo_basic_record_atk_correction(
  p_business_id uuid,p_sale_id uuid,p_original_coupon_id bigint,
  p_correction_coupon_id bigint,p_document_type smallint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_atk_transaction_id numeric,p_atk_response jsonb
) returns uuid
language sql
security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_record_atk_correction(
    p_business_id,p_sale_id,p_original_coupon_id,p_correction_coupon_id,
    p_document_type,p_idempotency_key,p_signed_payload,p_signature,
    p_atk_transaction_id,p_atk_response
  )
$$;
revoke all on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public,anon;
grant execute on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) to authenticated;
