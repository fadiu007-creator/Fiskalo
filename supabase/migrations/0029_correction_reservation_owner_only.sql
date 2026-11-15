create or replace function public.fiskalo_basic_reserve_atk_correction(
  p_business_id uuid,
  p_sale_id uuid,
  p_document_type smallint,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'Europe/Belgrade'
as $$
declare
  v_sale public.fiskalo_basic_sales%rowtype;
  v_original public.fiskalo_basic_fiscal_documents%rowtype;
  v_existing public.fiskalo_basic_correction_reservations%rowtype;
  v_pos public.fiskalo_basic_pos%rowtype;
  v_coupon bigint;
  v_daily bigint;
  v_date date := current_date;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_document_type not in (2,3) then raise exception 'Correction must be Cancel (2) or Return (3)'; end if;
  if coalesce(trim(p_idempotency_key),'')='' then raise exception 'Correction idempotency key is required'; end if;
  if not exists(select 1 from public.fiskalo_basic_members m where m.business_id=p_business_id and m.user_id=auth.uid() and m.role='owner') then
    raise exception 'Not a member of this business';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text||':'||p_sale_id::text,0));
  select * into v_sale from public.fiskalo_basic_sales s
    where s.id=p_sale_id and s.business_id=p_business_id for update;
  if not found or v_sale.status<>'fiscalized' then
    raise exception 'Only an ATK-accepted fiscalized sale can be cancelled or returned';
  end if;
  select d.* into v_original from public.fiskalo_basic_fiscal_documents d
    where d.business_id=p_business_id and d.sale_id=p_sale_id and d.coupon_id=v_sale.coupon_id
      and d.document_type=1 and d.submission_state='accepted' and d.atk_transaction_id>0
    for update;
  if not found then raise exception 'Original accepted ATK sale document was not found'; end if;
  select * into v_existing from public.fiskalo_basic_correction_reservations r
    where r.idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.business_id<>p_business_id or v_existing.sale_id<>p_sale_id or v_existing.document_type<>p_document_type then
      raise exception 'Correction idempotency key already exists with different request data';
    end if;
    return jsonb_build_object(
      'correctionCouponId',v_existing.correction_coupon_id,
      'dailyNumber',v_existing.daily_number,
      'originalCouponId',v_existing.original_coupon_id,
      'originalTransactionId',v_existing.original_transaction_id::text,
      'documentType',v_existing.document_type,
      'idempotencyKey',v_existing.idempotency_key,
      'status',v_existing.status
    );
  end if;
  if exists(select 1 from public.fiskalo_basic_correction_reservations r
      where r.business_id=p_business_id and r.sale_id=p_sale_id
        and r.status in ('reserved','submitting','queued','accepted','needs_reconciliation')) then
    raise exception 'A cancellation or return already exists or is unresolved for this sale';
  end if;
  select * into v_pos from public.fiskalo_basic_pos p where p.id=v_sale.pos_id and p.business_id=p_business_id;
  if not found then raise exception 'Original POS was not found'; end if;

  v_coupon:=pg_catalog.nextval('public.fiskalo_basic_coupon_seq'::regclass);
  insert into fiskalo_private.fiskalo_basic_daily_counters(pos_id,business_date,last_number)
    values(v_pos.id,v_date,1)
    on conflict(pos_id,business_date)
    do update set last_number=fiskalo_private.fiskalo_basic_daily_counters.last_number+1
    returning last_number into v_daily;

  insert into public.fiskalo_basic_correction_reservations(
    business_id,sale_id,pos_id,document_type,original_coupon_id,original_transaction_id,
    correction_coupon_id,daily_number,idempotency_key,created_by
  ) values(
    p_business_id,p_sale_id,v_pos.id,p_document_type,v_sale.coupon_id,v_original.atk_transaction_id,
    v_coupon,v_daily,p_idempotency_key,auth.uid()
  ) returning * into v_existing;
  return jsonb_build_object(
    'correctionCouponId',v_existing.correction_coupon_id,
    'dailyNumber',v_existing.daily_number,
    'originalCouponId',v_existing.original_coupon_id,
    'originalTransactionId',v_existing.original_transaction_id::text,
    'documentType',v_existing.document_type,
    'idempotencyKey',v_existing.idempotency_key,
    'status',v_existing.status
  );
end;
$$;
revoke all on function public.fiskalo_basic_reserve_atk_correction(uuid,uuid,smallint,text) from public,anon;
grant execute on function public.fiskalo_basic_reserve_atk_correction(uuid,uuid,smallint,text) to authenticated;
