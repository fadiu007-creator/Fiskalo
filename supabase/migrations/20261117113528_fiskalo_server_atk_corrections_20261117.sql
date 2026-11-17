begin;

-- The online/offline delivery journal uses an explicit pre-submission state.
-- Without this state the server's begin-correction RPC cannot persist the
-- journal entry before making the external ATK request.
alter table public.fiskalo_basic_fiscal_documents
  drop constraint if exists fiskalo_basic_fiscal_documents_submission_state_check;
alter table public.fiskalo_basic_fiscal_documents
  add constraint fiskalo_basic_fiscal_documents_submission_state_check
  check (submission_state in (
    'queued','submitting','submitted','accepted','rejected','needs_reconciliation'
  ));

-- Reserve correction coupon numbers and add trusted server-side correction journaling.
create table if not exists public.fiskalo_basic_correction_reservations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  sale_id uuid not null references public.fiskalo_basic_sales(id) on delete cascade,
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  document_type smallint not null check (document_type in (2,3)),
  original_coupon_id bigint not null,
  original_transaction_id numeric(20,0) not null,
  correction_coupon_id bigint not null unique,
  daily_number bigint not null,
  idempotency_key text not null unique,
  created_by uuid not null,
  status text not null default 'reserved'
    check (status in ('reserved','submitting','queued','accepted','rejected','needs_reconciliation')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.fiskalo_basic_correction_reservations enable row level security;
revoke all on table public.fiskalo_basic_correction_reservations from public,anon,authenticated;
grant select,insert,update,delete on table public.fiskalo_basic_correction_reservations to service_role;
create unique index if not exists fiskalo_basic_correction_one_active_per_sale
  on public.fiskalo_basic_correction_reservations(business_id,sale_id)
  where status in ('reserved','submitting','queued','accepted','needs_reconciliation');

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
  if not exists(select 1 from public.fiskalo_basic_members m where m.business_id=p_business_id and m.user_id=auth.uid()) then
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

create or replace function public.fiskalo_basic_server_begin_atk_correction_v1(
  p_actor_id uuid,p_business_id uuid,p_sale_id uuid,p_pos_record_id uuid,
  p_original_coupon_id bigint,p_correction_coupon_id bigint,p_document_type smallint,
  p_idempotency_key text,p_signed_payload text,p_signature text,p_nui_kf text,p_verification_no text,
  p_citizen_payload text,p_citizen_signature text,p_daily_number bigint,p_qr_svg_base64 text
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_res public.fiskalo_basic_correction_reservations%rowtype; v_original public.fiskalo_basic_fiscal_documents%rowtype; v_id uuid;
begin
  if not exists(select 1 from public.fiskalo_basic_members m where m.business_id=p_business_id and m.user_id=p_actor_id) then raise exception 'Actor is not a business member'; end if;
  if p_document_type not in (2,3) or coalesce(p_nui_kf,'') !~ '^[A-Z0-9]{16}$' or p_verification_no<>p_nui_kf then raise exception 'Correction type or NUIKF is invalid'; end if;
  if coalesce(p_signed_payload,'')='' or coalesce(p_signature,'')='' or coalesce(p_citizen_payload,'')='' or coalesce(p_citizen_signature,'')='' then raise exception 'Signed correction payload and CitizenCoupon are required'; end if;
  select * into v_res from public.fiskalo_basic_correction_reservations r
    where r.idempotency_key=p_idempotency_key and r.business_id=p_business_id and r.sale_id=p_sale_id
      and r.pos_id=p_pos_record_id and r.document_type=p_document_type
      and r.original_coupon_id=p_original_coupon_id and r.correction_coupon_id=p_correction_coupon_id
      and r.daily_number=p_daily_number and r.created_by=p_actor_id for update;
  if not found then raise exception 'Correction reservation does not match the request'; end if;
  select d.* into v_original from public.fiskalo_basic_fiscal_documents d
    where d.business_id=p_business_id and d.sale_id=p_sale_id and d.coupon_id=p_original_coupon_id
      and d.document_type=1 and d.submission_state='accepted' and d.atk_transaction_id>0 for update;
  if not found then raise exception 'Original accepted ATK sale is not available'; end if;
  select id into v_id from public.fiskalo_basic_fiscal_documents d where d.idempotency_key=p_idempotency_key;
  if found then
    if exists(select 1 from public.fiskalo_basic_fiscal_documents d where d.id=v_id and d.submission_state='submitting' and d.signed_payload=p_signed_payload and d.signature=p_signature) then return v_id; end if;
    raise exception 'Correction journal entry already exists with a different payload or state';
  end if;
  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,parent_document_id,
    signed_payload,signature,nui_kf,verification_no,citizen_payload,citizen_signature,daily_number,
    qr_svg_base64,submission_state
  ) values(
    p_business_id,p_sale_id,p_correction_coupon_id,p_idempotency_key,p_document_type,p_original_coupon_id,
    v_original.id,p_signed_payload,p_signature,p_nui_kf,p_verification_no,p_citizen_payload,
    p_citizen_signature,p_daily_number,p_qr_svg_base64,'submitting'
  ) returning id into v_id;
  update public.fiskalo_basic_correction_reservations set status='submitting',updated_at=now()
    where idempotency_key=p_idempotency_key;
  return v_id;
end;
$$;

create or replace function public.fiskalo_basic_server_queue_atk_correction_v1(
  p_actor_id uuid,p_business_id uuid,p_sale_id uuid,p_pos_record_id uuid,
  p_original_coupon_id bigint,p_correction_coupon_id bigint,p_document_type smallint,
  p_idempotency_key text,p_signed_payload text,p_signature text,p_nui_kf text,p_verification_no text,
  p_citizen_payload text,p_citizen_signature text,p_daily_number bigint,p_offline_issued_at timestamptz,p_qr_svg_base64 text
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_id uuid; v_deadline timestamptz;
begin
  if not exists(select 1 from public.fiskalo_basic_members m where m.business_id=p_business_id and m.user_id=p_actor_id) then raise exception 'Actor is not a business member'; end if;
  if p_offline_issued_at is null or p_offline_issued_at>now()+interval '5 minutes' or p_offline_issued_at<now()-interval '48 hours' then raise exception 'Offline issue time is outside the 48-hour recovery window'; end if;
  v_deadline:=p_offline_issued_at+interval '48 hours';
  update public.fiskalo_basic_fiscal_documents d
    set submission_state='queued',offline_issued_at=p_offline_issued_at,recovery_deadline_at=v_deadline,
        next_attempt_at=now(),attempt_count=0,last_attempt_at=null,last_error=null,qr_svg_base64=p_qr_svg_base64
    where d.idempotency_key=p_idempotency_key and d.business_id=p_business_id and d.sale_id=p_sale_id
      and d.coupon_id=p_correction_coupon_id and d.reference_coupon_id=p_original_coupon_id
      and d.document_type=p_document_type and d.submission_state='submitting'
      and d.signed_payload=p_signed_payload and d.signature=p_signature and d.nui_kf=p_nui_kf;
  if not found then raise exception 'Reserved correction is not available for safe offline queueing'; end if;
  update public.fiskalo_basic_correction_reservations set status='queued',updated_at=now()
    where idempotency_key=p_idempotency_key;
  select id into v_id from public.fiskalo_basic_fiscal_documents where idempotency_key=p_idempotency_key;
  return v_id;
end;
$$;

create or replace function public.fiskalo_basic_server_record_atk_correction_v2(
  p_actor_id uuid,p_business_id uuid,p_sale_id uuid,p_original_coupon_id bigint,p_correction_coupon_id bigint,
  p_document_type smallint,p_idempotency_key text,p_signed_payload text,p_signature text,
  p_atk_transaction_id numeric,p_atk_response jsonb,p_nui_kf text,p_verification_no text,
  p_citizen_payload text,p_citizen_signature text,p_daily_number bigint,p_qr_svg_base64 text
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_id uuid;
begin
  if coalesce(p_nui_kf,'') !~ '^[A-Z0-9]{16}$' or p_verification_no<>p_nui_kf then raise exception 'NUIKF / VerificationNo is invalid'; end if;
  if p_atk_response is null or p_atk_response->>'status'<>'accepted'
    or p_atk_response->>'transactionId'<>p_atk_transaction_id::text
    or p_atk_response->>'environment'<>'ATK TEST' then raise exception 'Trusted ATK TEST response is invalid'; end if;
  perform pg_catalog.set_config('request.jwt.claim.sub',p_actor_id::text,true);
  v_id:=public.fiskalo_basic_record_atk_correction(
    p_business_id,p_sale_id,p_original_coupon_id,p_correction_coupon_id,p_document_type,
    p_idempotency_key,p_signed_payload,p_signature,p_atk_transaction_id,p_atk_response
  );
  update public.fiskalo_basic_fiscal_documents set
    nui_kf=p_nui_kf,verification_no=p_verification_no,citizen_payload=p_citizen_payload,
    citizen_signature=p_citizen_signature,daily_number=p_daily_number,qr_svg_base64=p_qr_svg_base64
  where id=v_id;
  update public.fiskalo_basic_correction_reservations set status='accepted',updated_at=now()
    where idempotency_key=p_idempotency_key;
  return v_id;
end;
$$;

create or replace function public.fiskalo_basic_server_set_atk_correction_state_v1(
  p_idempotency_key text,p_submission_state text,p_last_error text
) returns boolean
language plpgsql security definer set search_path=''
as $$
begin
  if p_submission_state not in ('rejected','needs_reconciliation') then raise exception 'Unsupported correction state'; end if;
  update public.fiskalo_basic_fiscal_documents set submission_state=p_submission_state,
    last_error=left(coalesce(p_last_error,''),500),next_attempt_at=null
    where idempotency_key=p_idempotency_key and document_type in (2,3)
      and submission_state in ('submitting','queued');
  update public.fiskalo_basic_correction_reservations set status=p_submission_state,updated_at=now()
    where idempotency_key=p_idempotency_key;
  return found;
end;
$$;

revoke all on function public.fiskalo_basic_server_begin_atk_correction_v1(uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.fiskalo_basic_server_queue_atk_correction_v1(uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,timestamptz,text) from public,anon,authenticated;
revoke all on function public.fiskalo_basic_server_record_atk_correction_v2(uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb,text,text,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.fiskalo_basic_server_set_atk_correction_state_v1(text,text,text) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_server_begin_atk_correction_v1(uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,text) to service_role;
grant execute on function public.fiskalo_basic_server_queue_atk_correction_v1(uuid,uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,text,text,text,text,bigint,timestamptz,text) to service_role;
grant execute on function public.fiskalo_basic_server_record_atk_correction_v2(uuid,uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb,text,text,text,text,bigint,text) to service_role;
grant execute on function public.fiskalo_basic_server_set_atk_correction_state_v1(text,text,text) to service_role;

revoke all on function public.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb) from public,anon,authenticated;
revoke all on function fiskalo_private.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb) to service_role;


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


commit;
