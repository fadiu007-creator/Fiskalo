-- Persist an accepted ATK response exactly once and mark the internal sale fiscalized.
create policy fiskalo_basic_fiscal_insert on public.fiskalo_basic_fiscal_documents
  for insert to authenticated with check (
    exists(
      select 1 from public.fiskalo_basic_sales s
      join public.fiskalo_basic_members m on m.business_id=s.business_id
      where s.id=public.fiskalo_basic_fiscal_documents.sale_id
        and s.business_id=public.fiskalo_basic_fiscal_documents.business_id
        and m.user_id=auth.uid()
    )
  );
grant insert on public.fiskalo_basic_fiscal_documents to authenticated;

create policy fiskalo_basic_sales_update_status on public.fiskalo_basic_sales
  for update to authenticated
  using (exists(select 1 from public.fiskalo_basic_members m where m.business_id=public.fiskalo_basic_sales.business_id and m.user_id=auth.uid()))
  with check (exists(select 1 from public.fiskalo_basic_members m where m.business_id=public.fiskalo_basic_sales.business_id and m.user_id=auth.uid()));
grant update(status) on public.fiskalo_basic_sales to authenticated;

create or replace function public.fiskalo_basic_record_atk_sale(
  p_business_id uuid,
  p_sale_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
  p_atk_transaction_id numeric,
  p_atk_response jsonb
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  new_document_id uuid;
  existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_atk_transaction_id is null or p_atk_transaction_id<=0 or p_atk_transaction_id>18446744073709551615 then
    raise exception 'A valid ATK uint64 transaction_id is required';
  end if;
  if length(trim(coalesce(p_idempotency_key,'')))=0 or
     length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 then
    raise exception 'Idempotency key, signed payload and signature are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status in ('paid','fiscalized') and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
    signed_payload,signature,atk_transaction_id,submission_state,atk_response
  ) values(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
    p_signed_payload,p_signature,p_atk_transaction_id,'accepted',p_atk_response
  )
  on conflict (idempotency_key) do nothing
  returning id into new_document_id;

  if new_document_id is null then
    select * into existing from public.fiskalo_basic_fiscal_documents
      where idempotency_key=p_idempotency_key;
    if existing.sale_id<>p_sale_id or existing.coupon_id<>p_coupon_id or
       existing.signed_payload<>p_signed_payload or existing.signature<>p_signature or
       existing.atk_transaction_id<>p_atk_transaction_id then
      raise exception 'Idempotency key already exists with different fiscal document data';
    end if;
    new_document_id:=existing.id;
  end if;

  update public.fiskalo_basic_sales set status='fiscalized'
    where id=p_sale_id and business_id=p_business_id and coupon_id=p_coupon_id;
  return new_document_id;
end $$;
revoke all on function public.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_record_atk_sale(uuid,uuid,bigint,text,text,text,numeric,jsonb) to authenticated;
