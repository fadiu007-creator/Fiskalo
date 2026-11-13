-- End-to-end full cancellation/return workflow for accepted ATK TEST sales.
-- This is additive: it does not change existing sales, products, or fiscal documents.
create table if not exists public.fiskalo_basic_correction_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  sale_id uuid not null references public.fiskalo_basic_sales(id) on delete restrict,
  original_document_id uuid not null references public.fiskalo_basic_fiscal_documents(id) on delete restrict,
  correction_coupon_id bigint not null unique,
  document_type smallint not null check (document_type in (2,3)),
  idempotency_key text not null unique,
  daily_number bigint not null check (daily_number > 0),
  submission_state text not null default 'prepared'
    check (submission_state in ('prepared','queued','accepted','rejected','needs_reconciliation')),
  signed_payload text,
  signature text,
  nui_kf text,
  citizen_payload text,
  citizen_signature text,
  qr_svg_base64 text,
  atk_transaction_id numeric(20,0),
  atk_response jsonb,
  offline_issued_at timestamptz,
  recovery_deadline_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sale_id)
);

alter table public.fiskalo_basic_correction_requests enable row level security;
create policy fiskalo_basic_correction_requests_read_owner
  on public.fiskalo_basic_correction_requests
  for select to authenticated
  using (
    exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=public.fiskalo_basic_correction_requests.business_id
        and m.user_id=auth.uid() and m.role='owner'
    )
  );
revoke all on public.fiskalo_basic_correction_requests from public,anon,authenticated;
grant select on public.fiskalo_basic_correction_requests to authenticated;

create or replace function fiskalo_private.fiskalo_basic_prepare_correction(
  p_business_id uuid,
  p_sale_id uuid,
  p_document_type smallint
) returns table (
  request_id uuid,
  correction_coupon_id bigint,
  idempotency_key text,
  document_type smallint,
  daily_number bigint,
  original_coupon_id bigint,
  original_signed_payload text,
  original_signature text,
  original_atk_transaction_id text,
  original_nui_kf text,
  submission_state text,
  request_created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.fiskalo_basic_sales%rowtype;
  v_business public.fiskalo_basic_businesses%rowtype;
  v_pos public.fiskalo_basic_pos%rowtype;
  v_original public.fiskalo_basic_fiscal_documents%rowtype;
  v_request public.fiskalo_basic_correction_requests%rowtype;
  v_coupon_id bigint;
  v_daily_number bigint;
  v_business_date date;
  v_key text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_document_type is null or p_document_type not in (2,3) then
    raise exception 'Correction document type must be ATK Cancel (2) or Return (3)';
  end if;
  if not exists (
    select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid() and m.role='owner'
  ) then raise exception 'Owner access required'; end if;

  select * into v_sale
  from public.fiskalo_basic_sales s
  where s.id=p_sale_id and s.business_id=p_business_id
  for update;
  if not found or v_sale.status<>'fiscalized' then
    raise exception 'Only an accepted and fiscalized original sale can be corrected';
  end if;

  select * into v_business from public.fiskalo_basic_businesses b
  where b.id=p_business_id;
  select * into v_pos from public.fiskalo_basic_pos p
  where p.id=v_sale.pos_id and p.business_id=p_business_id;
  if not found then raise exception 'Original POS does not belong to this business'; end if;

  select * into v_original
  from public.fiskalo_basic_fiscal_documents d
  where d.business_id=p_business_id and d.sale_id=p_sale_id
    and d.document_type=1 and d.submission_state='accepted'
    and d.atk_transaction_id>0
  for update;
  if not found or length(coalesce(v_original.signed_payload,''))=0 or
     length(coalesce(v_original.signature,''))=0 then
    raise exception 'Original sale must have a persisted accepted ATK fiscal document';
  end if;
  if char_length(coalesce(v_original.nui_kf,''))<>16 or
     translate(coalesce(v_original.nui_kf,''),'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789','')<>'' then
    raise exception 'Original sale does not contain a valid 16-character NUIKF';
  end if;

  select * into v_request
  from public.fiskalo_basic_correction_requests r
  where r.sale_id=p_sale_id
  for update;
  if found then
    if v_request.business_id is distinct from p_business_id or
       v_request.original_document_id is distinct from v_original.id or
       v_request.document_type is distinct from p_document_type then
      raise exception 'A different full correction is already reserved for this sale';
    end if;
  else
    if exists (
      select 1 from public.fiskalo_basic_fiscal_documents d
      where d.parent_document_id=v_original.id
        and d.submission_state in ('queued','submitted','accepted','needs_reconciliation')
    ) then
      raise exception 'An ATK correction already exists or is unresolved for this sale';
    end if;

    v_coupon_id := nextval('public.fiskalo_basic_coupon_seq');
    v_business_date := (clock_timestamp() at time zone 'Europe/Belgrade')::date;
    insert into fiskalo_private.fiskalo_basic_daily_counters as counter(pos_id,business_date,last_number)
    values (v_pos.id,v_business_date,1)
    on conflict (pos_id,business_date)
    do update set last_number=counter.last_number+1
    returning last_number into v_daily_number;

    v_key := v_business.nui || ':' || v_pos.branch_id::text || ':' ||
             v_pos.pos_id::text || ':' || v_coupon_id::text;

    insert into public.fiskalo_basic_correction_requests(
      business_id,sale_id,original_document_id,correction_coupon_id,
      document_type,idempotency_key,daily_number,submission_state,created_by
    ) values (
      p_business_id,p_sale_id,v_original.id,v_coupon_id,
      p_document_type,v_key,v_daily_number,'prepared',auth.uid()
    ) returning * into v_request;
  end if;

  return query
  select v_request.id,v_request.correction_coupon_id,v_request.idempotency_key,
         v_request.document_type,v_request.daily_number,v_original.coupon_id,
         v_original.signed_payload,v_original.signature,
         v_original.atk_transaction_id::text,v_original.nui_kf,
         v_request.submission_state,v_request.created_at;
end;
$$;

revoke all on function fiskalo_private.fiskalo_basic_prepare_correction(uuid,uuid,smallint) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_prepare_correction(uuid,uuid,smallint) to authenticated;

create or replace function public.fiskalo_basic_prepare_correction(
  p_business_id uuid,p_sale_id uuid,p_document_type smallint
) returns table (
  request_id uuid,correction_coupon_id bigint,idempotency_key text,
  document_type smallint,daily_number bigint,original_coupon_id bigint,
  original_signed_payload text,original_signature text,original_atk_transaction_id text,
  original_nui_kf text,submission_state text,request_created_at timestamptz
)
language sql
security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select * from fiskalo_private.fiskalo_basic_prepare_correction(
    p_business_id,p_sale_id,p_document_type
  )
$$;
revoke all on function public.fiskalo_basic_prepare_correction(uuid,uuid,smallint) from public,anon;
grant execute on function public.fiskalo_basic_prepare_correction(uuid,uuid,smallint) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_store_correction_receipt(
  p_business_id uuid,
  p_request_id uuid,
  p_submission_state text,
  p_signed_payload text,
  p_signature text,
  p_nui_kf text,
  p_citizen_payload text,
  p_citizen_signature text,
  p_qr_svg_base64 text,
  p_daily_number bigint,
  p_atk_transaction_id numeric,
  p_atk_response jsonb,
  p_offline_issued_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.fiskalo_basic_correction_requests%rowtype;
  v_original public.fiskalo_basic_fiscal_documents%rowtype;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
  v_document_id uuid;
  v_expected_response_status text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid() and m.role='owner'
  ) then raise exception 'Owner access required'; end if;
  if p_submission_state is null or p_submission_state not in ('queued','accepted','rejected','needs_reconciliation') then
    raise exception 'Invalid correction submission state';
  end if;

  select * into v_request
  from public.fiskalo_basic_correction_requests r
  where r.id=p_request_id and r.business_id=p_business_id
  for update;
  if not found then raise exception 'Correction request not found'; end if;

  select * into v_original
  from public.fiskalo_basic_fiscal_documents d
  where d.id=v_request.original_document_id and d.business_id=p_business_id
    and d.sale_id=v_request.sale_id and d.document_type=1
    and d.submission_state='accepted' and d.atk_transaction_id>0
  for update;
  if not found then raise exception 'Original sale must remain accepted by ATK'; end if;

  if p_daily_number is null or p_daily_number<=0 or p_daily_number<>v_request.daily_number then
    raise exception 'Correction daily number does not match the reserved number';
  end if;
  if length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_qr_svg_base64,''))=0 or length(p_qr_svg_base64)>350000 or
     p_qr_svg_base64 !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'Signed correction and QR data are required';
  end if;
  if char_length(coalesce(p_nui_kf,''))<>16 or
     translate(coalesce(p_nui_kf,''),'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789','')<>'' then
    raise exception 'Correction NUIKF must contain 16 uppercase alphanumeric characters';
  end if;
  if p_atk_response is null or coalesce(p_atk_response->>'environment','')<>'ATK TEST' then
    raise exception 'Correction response must identify the ATK TEST environment';
  end if;

  v_expected_response_status := case p_submission_state
    when 'accepted' then 'accepted'
    when 'queued' then 'queued_offline'
    when 'rejected' then 'rejected'
    else 'needs_reconciliation'
  end;
  if coalesce(p_atk_response->>'status','')<>v_expected_response_status then
    raise exception 'Correction response status does not match the persisted submission state';
  end if;

  if p_submission_state='accepted' then
    if p_atk_transaction_id is null or p_atk_transaction_id<=0 or
       p_atk_transaction_id>18446744073709551615 or
       coalesce(p_atk_response->>'transactionId','')<>p_atk_transaction_id::text then
      raise exception 'Accepted correction requires a matching positive ATK transaction_id';
    end if;
  elsif p_atk_transaction_id is not null or
        coalesce(p_atk_response->>'transactionId','')<>'' then
    raise exception 'Non-accepted correction cannot contain an ATK transaction_id';
  end if;
  if p_submission_state='queued' and
     (p_offline_issued_at is null or coalesce(p_atk_response->>'offline','false')<>'true') then
    raise exception 'Queued offline correction requires its offline issue time';
  end if;

  if v_request.submission_state='accepted' and
     (p_submission_state<>'accepted' or v_request.atk_transaction_id<>p_atk_transaction_id) then
    raise exception 'Accepted correction cannot be downgraded or assigned a different ATK transaction';
  end if;
  if v_request.signed_payload is not null and
     (v_request.signed_payload is distinct from p_signed_payload or
      v_request.signature is distinct from p_signature or
      v_request.nui_kf is distinct from p_nui_kf or
      v_request.citizen_payload is distinct from p_citizen_payload or
      v_request.citizen_signature is distinct from p_citizen_signature) then
    raise exception 'Correction idempotency key already exists with different signed content';
  end if;

  if p_submission_state='accepted' then
    v_document_id := fiskalo_private.fiskalo_basic_record_atk_correction(
      p_business_id,v_request.sale_id,v_original.coupon_id,
      v_request.correction_coupon_id,v_request.document_type,
      v_request.idempotency_key,p_signed_payload,p_signature,
      p_atk_transaction_id,p_atk_response
    );
    update public.fiskalo_basic_fiscal_documents
      set nui_kf=p_nui_kf,citizen_payload=p_citizen_payload,
          citizen_signature=p_citizen_signature,qr_svg_base64=p_qr_svg_base64,
          daily_number=p_daily_number,offline_issued_at=p_offline_issued_at,
          recovery_deadline_at=case when p_offline_issued_at is null then null
                                    else p_offline_issued_at+interval '48 hours' end
      where id=v_document_id;
  else
    select * into v_existing
    from public.fiskalo_basic_fiscal_documents d
    where d.idempotency_key=v_request.idempotency_key
    for update;
    if found then
      if v_existing.business_id is distinct from p_business_id or
         v_existing.sale_id is distinct from v_request.sale_id or
         v_existing.coupon_id is distinct from v_request.correction_coupon_id or
         v_existing.document_type is distinct from v_request.document_type or
         v_existing.reference_coupon_id is distinct from v_original.coupon_id or
         v_existing.parent_document_id is distinct from v_original.id or
         v_existing.signed_payload is distinct from p_signed_payload or
         v_existing.signature is distinct from p_signature then
        raise exception 'Correction idempotency key already exists with different document data';
      end if;
      if v_existing.submission_state='accepted' then
        raise exception 'Accepted correction cannot be downgraded';
      end if;
      update public.fiskalo_basic_fiscal_documents
        set submission_state=p_submission_state,atk_response=p_atk_response,
            nui_kf=p_nui_kf,citizen_payload=p_citizen_payload,
            citizen_signature=p_citizen_signature,qr_svg_base64=p_qr_svg_base64,
            daily_number=p_daily_number,offline_issued_at=p_offline_issued_at,
            recovery_deadline_at=case when p_offline_issued_at is null then null
                                      else p_offline_issued_at+interval '48 hours' end
        where id=v_existing.id returning id into v_document_id;
    else
      insert into public.fiskalo_basic_fiscal_documents(
        business_id,sale_id,coupon_id,idempotency_key,document_type,
        reference_coupon_id,parent_document_id,signed_payload,signature,
        submission_state,atk_response,nui_kf,citizen_payload,citizen_signature,
        qr_svg_base64,daily_number,offline_issued_at,recovery_deadline_at
      ) values (
        p_business_id,v_request.sale_id,v_request.correction_coupon_id,
        v_request.idempotency_key,v_request.document_type,v_original.coupon_id,
        v_original.id,p_signed_payload,p_signature,p_submission_state,p_atk_response,
        p_nui_kf,p_citizen_payload,p_citizen_signature,p_qr_svg_base64,
        p_daily_number,p_offline_issued_at,
        case when p_offline_issued_at is null then null
             else p_offline_issued_at+interval '48 hours' end
      ) returning id into v_document_id;
    end if;
  end if;

  update public.fiskalo_basic_correction_requests
    set submission_state=p_submission_state,signed_payload=p_signed_payload,
        signature=p_signature,nui_kf=p_nui_kf,citizen_payload=p_citizen_payload,
        citizen_signature=p_citizen_signature,qr_svg_base64=p_qr_svg_base64,
        atk_transaction_id=p_atk_transaction_id,atk_response=p_atk_response,
        offline_issued_at=p_offline_issued_at,
        recovery_deadline_at=case when p_offline_issued_at is null then null
                                  else p_offline_issued_at+interval '48 hours' end,
        updated_at=now()
    where id=v_request.id;
  return v_document_id;
end;
$$;

revoke all on function fiskalo_private.fiskalo_basic_store_correction_receipt(
  uuid,uuid,text,text,text,text,text,text,text,bigint,numeric,jsonb,timestamptz
) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_store_correction_receipt(
  uuid,uuid,text,text,text,text,text,text,text,bigint,numeric,jsonb,timestamptz
) to authenticated;

create or replace function public.fiskalo_basic_store_correction_receipt(
  p_business_id uuid,p_request_id uuid,p_submission_state text,
  p_signed_payload text,p_signature text,p_nui_kf text,
  p_citizen_payload text,p_citizen_signature text,p_qr_svg_base64 text,
  p_daily_number bigint,p_atk_transaction_id numeric,p_atk_response jsonb,
  p_offline_issued_at timestamptz
) returns uuid
language sql
security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_store_correction_receipt(
    p_business_id,p_request_id,p_submission_state,p_signed_payload,p_signature,
    p_nui_kf,p_citizen_payload,p_citizen_signature,p_qr_svg_base64,
    p_daily_number,p_atk_transaction_id,p_atk_response,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_store_correction_receipt(
  uuid,uuid,text,text,text,text,text,text,text,bigint,numeric,jsonb,timestamptz
) from public,anon;
grant execute on function public.fiskalo_basic_store_correction_receipt(
  uuid,uuid,text,text,text,text,text,text,text,bigint,numeric,jsonb,timestamptz
) to authenticated;
