-- Fiscal receipt identity, CitizenCoupon QR material and per-POS daily numbering.
-- The NUIKF format is 16 uppercase alphanumeric characters; the QR payload is
-- Base64(CitizenCoupon protobuf) + "|" + Base64(ECDSA signature), per ATK's
-- official fiskalizimi/pos-csharp implementation.

alter table public.fiskalo_basic_businesses
  add column if not exists vat_number text
  check (vat_number is null or vat_number ~ '^[0-9]{9}

create table if not exists fiskalo_private.fiskalo_basic_daily_counters (
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  business_date date not null,
  last_number bigint not null check (last_number > 0),
  primary key (pos_id,business_date)
);

create or replace function fiskalo_private.fiskalo_basic_assign_daily_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into fiskalo_private.fiskalo_basic_daily_counters(pos_id,business_date,last_number)
  values (new.pos_id,(now() at time zone 'Europe/Belgrade')::date,1)
  on conflict (pos_id,business_date)
  do update set last_number=fiskalo_private.fiskalo_basic_daily_counters.last_number+1
  returning last_number into new.daily_number;
  return new;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_assign_daily_number() from public,anon,authenticated;

drop trigger if exists fiskalo_basic_sales_assign_daily_number on public.fiskalo_basic_sales;
create trigger fiskalo_basic_sales_assign_daily_number
before insert on public.fiskalo_basic_sales
for each row execute function fiskalo_private.fiskalo_basic_assign_daily_number();

alter table public.fiskalo_basic_fiscal_documents
  add column if not exists nui_kf text,
  add column if not exists citizen_payload text,
  add column if not exists citizen_signature text,
  add column if not exists daily_number bigint,
  add column if not exists offline_issued_at timestamptz,
  add column if not exists recovery_deadline_at timestamptz;

alter table public.fiskalo_basic_fiscal_documents
  add constraint fiskalo_basic_fiscal_nui_kf_format
  check (nui_kf is null or nui_kf ~ '^[A-Z0-9]{16}$'),
  add constraint fiskalo_basic_fiscal_daily_number_positive
  check (daily_number is null or daily_number > 0);

create unique index if not exists fiskalo_basic_fiscal_nui_kf_unique
  on public.fiskalo_basic_fiscal_documents(nui_kf)
  where nui_kf is not null;

create or replace function fiskalo_private.fiskalo_basic_store_offline_receipt(
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
  p_offline_issued_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if coalesce(p_nui_kf,'') !~ '^[A-Z0-9]{16} or p_daily_number is null or p_daily_number<=0 then
    raise exception 'NUIKF or daily coupon number is invalid';
  end if;
  if length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_idempotency_key,''))=0 or p_offline_issued_at is null then
    raise exception 'Signed POS and CitizenCoupon data, NUIKF, idempotency key and offline time are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status='paid' and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
    signed_payload,signature,submission_state,nui_kf,citizen_payload,citizen_signature,
    daily_number,offline_issued_at,recovery_deadline_at
  ) values (
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
    p_signed_payload,p_signature,'queued',p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at,p_offline_issued_at+interval '48 hours'
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from public.fiskalo_basic_fiscal_documents
      where idempotency_key=p_idempotency_key for update;
    if v_existing.sale_id<>p_sale_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal receipt data';
    end if;
    v_id:=v_existing.id;
  end if;
  return v_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_store_offline_receipt(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_nui_kf text,p_citizen_payload text,
  p_citizen_signature text,p_daily_number bigint,p_offline_issued_at timestamptz
) returns uuid
language sql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_store_offline_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_record_atk_receipt(
  p_business_id uuid,
  p_sale_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
  p_atk_transaction_id numeric,
  p_atk_response jsonb,
  p_nui_kf text,
  p_citizen_payload text,
  p_citizen_signature text,
  p_daily_number bigint,
  p_offline_issued_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_atk_transaction_id is null or p_atk_transaction_id<=0 or p_atk_transaction_id>18446744073709551615 then
    raise exception 'A valid ATK uint64 transaction_id is required';
  end if;
  if p_atk_response is null or
     coalesce(p_atk_response->>'status','')<>'accepted' or
     coalesce(p_atk_response->>'transactionId','')<>p_atk_transaction_id::text or
     coalesce(p_atk_response->>'environment','')<>'ATK TEST' then
    raise exception 'ATK response must be an accepted TEST response matching the transaction_id';
  end if;
  if p_nui_kf !~ '^[A-Z0-9]{16}$' or p_daily_number is null or p_daily_number<=0 or
     length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_idempotency_key,''))=0 then
    raise exception 'Signed receipt identity and data are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status in ('paid','fiscalized') and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  select * into v_existing from public.fiskalo_basic_fiscal_documents
    where idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.sale_id<>p_sale_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal receipt data';
    end if;
    if v_existing.submission_state='accepted' and v_existing.atk_transaction_id<>p_atk_transaction_id then
      raise exception 'Accepted fiscal receipt cannot be assigned a different ATK transaction';
    end if;
    update public.fiskalo_basic_fiscal_documents
      set atk_transaction_id=p_atk_transaction_id,submission_state='accepted',atk_response=p_atk_response,
          offline_issued_at=coalesce(offline_issued_at,p_offline_issued_at),
          recovery_deadline_at=coalesce(recovery_deadline_at,p_offline_issued_at+interval '48 hours')
      where id=v_existing.id returning id into v_id;
  else
    insert into public.fiskalo_basic_fiscal_documents(
      business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
      signed_payload,signature,atk_transaction_id,submission_state,atk_response,
      nui_kf,citizen_payload,citizen_signature,daily_number,offline_issued_at,recovery_deadline_at
    ) values(
      p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
      p_signed_payload,p_signature,p_atk_transaction_id,'accepted',p_atk_response,
      p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at,
      case when p_offline_issued_at is null then null else p_offline_issued_at+interval '48 hours' end
    ) returning id into v_id;
  end if;
  update public.fiskalo_basic_sales set status='fiscalized'
    where id=p_sale_id and business_id=p_business_id and coupon_id=p_coupon_id and status='paid';
  return v_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_record_atk_receipt(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_atk_transaction_id numeric,p_atk_response jsonb,
  p_nui_kf text,p_citizen_payload text,p_citizen_signature text,p_daily_number bigint,
  p_offline_issued_at timestamptz
) returns uuid
language sql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_record_atk_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_atk_transaction_id,p_atk_response,p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) to authenticated;

-- Authenticated catalog and receipt readers may read the new metadata via existing RLS.
);

alter table public.fiskalo_basic_sales
  add column if not exists daily_number bigint;

create table if not exists fiskalo_private.fiskalo_basic_daily_counters (
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  business_date date not null,
  last_number bigint not null check (last_number > 0),
  primary key (pos_id,business_date)
);

create or replace function fiskalo_private.fiskalo_basic_assign_daily_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into fiskalo_private.fiskalo_basic_daily_counters(pos_id,business_date,last_number)
  values (new.pos_id,(now() at time zone 'Europe/Belgrade')::date,1)
  on conflict (pos_id,business_date)
  do update set last_number=fiskalo_private.fiskalo_basic_daily_counters.last_number+1
  returning last_number into new.daily_number;
  return new;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_assign_daily_number() from public,anon,authenticated;

drop trigger if exists fiskalo_basic_sales_assign_daily_number on public.fiskalo_basic_sales;
create trigger fiskalo_basic_sales_assign_daily_number
before insert on public.fiskalo_basic_sales
for each row execute function fiskalo_private.fiskalo_basic_assign_daily_number();

alter table public.fiskalo_basic_fiscal_documents
  add column if not exists nui_kf text,
  add column if not exists citizen_payload text,
  add column if not exists citizen_signature text,
  add column if not exists daily_number bigint,
  add column if not exists offline_issued_at timestamptz,
  add column if not exists recovery_deadline_at timestamptz;

alter table public.fiskalo_basic_fiscal_documents
  add constraint fiskalo_basic_fiscal_nui_kf_format
  check (nui_kf is null or nui_kf ~ '^[A-Z0-9]{16}$'),
  add constraint fiskalo_basic_fiscal_daily_number_positive
  check (daily_number is null or daily_number > 0);

create unique index if not exists fiskalo_basic_fiscal_nui_kf_unique
  on public.fiskalo_basic_fiscal_documents(nui_kf)
  where nui_kf is not null;

create or replace function fiskalo_private.fiskalo_basic_store_offline_receipt(
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
  p_offline_issued_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_nui_kf !~ '^[A-Z0-9]{16}$' or p_daily_number is null or p_daily_number<=0 then
    raise exception 'NUIKF or daily coupon number is invalid';
  end if;
  if length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_idempotency_key,''))=0 or p_offline_issued_at is null then
    raise exception 'Signed POS and CitizenCoupon data, NUIKF, idempotency key and offline time are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status='paid' and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
    signed_payload,signature,submission_state,nui_kf,citizen_payload,citizen_signature,
    daily_number,offline_issued_at,recovery_deadline_at
  ) values (
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
    p_signed_payload,p_signature,'queued',p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at,p_offline_issued_at+interval '48 hours'
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from public.fiskalo_basic_fiscal_documents
      where idempotency_key=p_idempotency_key for update;
    if v_existing.sale_id<>p_sale_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal receipt data';
    end if;
    v_id:=v_existing.id;
  end if;
  return v_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_store_offline_receipt(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_nui_kf text,p_citizen_payload text,
  p_citizen_signature text,p_daily_number bigint,p_offline_issued_at timestamptz
) returns uuid
language sql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_store_offline_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_record_atk_receipt(
  p_business_id uuid,
  p_sale_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
  p_atk_transaction_id numeric,
  p_atk_response jsonb,
  p_nui_kf text,
  p_citizen_payload text,
  p_citizen_signature text,
  p_daily_number bigint,
  p_offline_issued_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_atk_transaction_id is null or p_atk_transaction_id<=0 or p_atk_transaction_id>18446744073709551615 then
    raise exception 'A valid ATK uint64 transaction_id is required';
  end if;
  if p_atk_response is null or
     coalesce(p_atk_response->>'status','')<>'accepted' or
     coalesce(p_atk_response->>'transactionId','')<>p_atk_transaction_id::text or
     coalesce(p_atk_response->>'environment','')<>'ATK TEST' then
    raise exception 'ATK response must be an accepted TEST response matching the transaction_id';
  end if;
  if p_nui_kf !~ '^[A-Z0-9]{16}$' or p_daily_number is null or p_daily_number<=0 or
     length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_idempotency_key,''))=0 then
    raise exception 'Signed receipt identity and data are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status in ('paid','fiscalized') and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  select * into v_existing from public.fiskalo_basic_fiscal_documents
    where idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.sale_id<>p_sale_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal receipt data';
    end if;
    if v_existing.submission_state='accepted' and v_existing.atk_transaction_id<>p_atk_transaction_id then
      raise exception 'Accepted fiscal receipt cannot be assigned a different ATK transaction';
    end if;
    update public.fiskalo_basic_fiscal_documents
      set atk_transaction_id=p_atk_transaction_id,submission_state='accepted',atk_response=p_atk_response,
          offline_issued_at=coalesce(offline_issued_at,p_offline_issued_at),
          recovery_deadline_at=coalesce(recovery_deadline_at,p_offline_issued_at+interval '48 hours')
      where id=v_existing.id returning id into v_id;
  else
    insert into public.fiskalo_basic_fiscal_documents(
      business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
      signed_payload,signature,atk_transaction_id,submission_state,atk_response,
      nui_kf,citizen_payload,citizen_signature,daily_number,offline_issued_at,recovery_deadline_at
    ) values(
      p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
      p_signed_payload,p_signature,p_atk_transaction_id,'accepted',p_atk_response,
      p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at,
      case when p_offline_issued_at is null then null else p_offline_issued_at+interval '48 hours' end
    ) returning id into v_id;
  end if;
  update public.fiskalo_basic_sales set status='fiscalized'
    where id=p_sale_id and business_id=p_business_id and coupon_id=p_coupon_id and status='paid';
  return v_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_record_atk_receipt(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_atk_transaction_id numeric,p_atk_response jsonb,
  p_nui_kf text,p_citizen_payload text,p_citizen_signature text,p_daily_number bigint,
  p_offline_issued_at timestamptz
) returns uuid
language sql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_record_atk_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_atk_transaction_id,p_atk_response,p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) to authenticated;

-- Authenticated catalog and receipt readers may read the new metadata via existing RLS.
 or p_daily_number is null or p_daily_number<=0 then
    raise exception 'NUIKF or daily coupon number is invalid';
  end if;
  if length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_idempotency_key,''))=0 or p_offline_issued_at is null then
    raise exception 'Signed POS and CitizenCoupon data, NUIKF, idempotency key and offline time are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status='paid' and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
    signed_payload,signature,submission_state,nui_kf,citizen_payload,citizen_signature,
    daily_number,offline_issued_at,recovery_deadline_at
  ) values (
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
    p_signed_payload,p_signature,'queued',p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at,p_offline_issued_at+interval '48 hours'
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from public.fiskalo_basic_fiscal_documents
      where idempotency_key=p_idempotency_key for update;
    if v_existing.sale_id<>p_sale_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal receipt data';
    end if;
    v_id:=v_existing.id;
  end if;
  return v_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_store_offline_receipt(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_nui_kf text,p_citizen_payload text,
  p_citizen_signature text,p_daily_number bigint,p_offline_issued_at timestamptz
) returns uuid
language sql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_store_offline_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_record_atk_receipt(
  p_business_id uuid,
  p_sale_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
  p_atk_transaction_id numeric,
  p_atk_response jsonb,
  p_nui_kf text,
  p_citizen_payload text,
  p_citizen_signature text,
  p_daily_number bigint,
  p_offline_issued_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_atk_transaction_id is null or p_atk_transaction_id<=0 or p_atk_transaction_id>18446744073709551615 then
    raise exception 'A valid ATK uint64 transaction_id is required';
  end if;
  if p_atk_response is null or
     coalesce(p_atk_response->>'status','')<>'accepted' or
     coalesce(p_atk_response->>'transactionId','')<>p_atk_transaction_id::text or
     coalesce(p_atk_response->>'environment','')<>'ATK TEST' then
    raise exception 'ATK response must be an accepted TEST response matching the transaction_id';
  end if;
  if p_nui_kf !~ '^[A-Z0-9]{16}$' or p_daily_number is null or p_daily_number<=0 or
     length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_idempotency_key,''))=0 then
    raise exception 'Signed receipt identity and data are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status in ('paid','fiscalized') and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  select * into v_existing from public.fiskalo_basic_fiscal_documents
    where idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.sale_id<>p_sale_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal receipt data';
    end if;
    if v_existing.submission_state='accepted' and v_existing.atk_transaction_id<>p_atk_transaction_id then
      raise exception 'Accepted fiscal receipt cannot be assigned a different ATK transaction';
    end if;
    update public.fiskalo_basic_fiscal_documents
      set atk_transaction_id=p_atk_transaction_id,submission_state='accepted',atk_response=p_atk_response,
          offline_issued_at=coalesce(offline_issued_at,p_offline_issued_at),
          recovery_deadline_at=coalesce(recovery_deadline_at,p_offline_issued_at+interval '48 hours')
      where id=v_existing.id returning id into v_id;
  else
    insert into public.fiskalo_basic_fiscal_documents(
      business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
      signed_payload,signature,atk_transaction_id,submission_state,atk_response,
      nui_kf,citizen_payload,citizen_signature,daily_number,offline_issued_at,recovery_deadline_at
    ) values(
      p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
      p_signed_payload,p_signature,p_atk_transaction_id,'accepted',p_atk_response,
      p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at,
      case when p_offline_issued_at is null then null else p_offline_issued_at+interval '48 hours' end
    ) returning id into v_id;
  end if;
  update public.fiskalo_basic_sales set status='fiscalized'
    where id=p_sale_id and business_id=p_business_id and coupon_id=p_coupon_id and status='paid';
  return v_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_record_atk_receipt(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_atk_transaction_id numeric,p_atk_response jsonb,
  p_nui_kf text,p_citizen_payload text,p_citizen_signature text,p_daily_number bigint,
  p_offline_issued_at timestamptz
) returns uuid
language sql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_record_atk_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_atk_transaction_id,p_atk_response,p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) to authenticated;

-- Authenticated catalog and receipt readers may read the new metadata via existing RLS.
);

alter table public.fiskalo_basic_sales
  add column if not exists daily_number bigint;

create table if not exists fiskalo_private.fiskalo_basic_daily_counters (
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  business_date date not null,
  last_number bigint not null check (last_number > 0),
  primary key (pos_id,business_date)
);

create or replace function fiskalo_private.fiskalo_basic_assign_daily_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into fiskalo_private.fiskalo_basic_daily_counters(pos_id,business_date,last_number)
  values (new.pos_id,(now() at time zone 'Europe/Belgrade')::date,1)
  on conflict (pos_id,business_date)
  do update set last_number=fiskalo_private.fiskalo_basic_daily_counters.last_number+1
  returning last_number into new.daily_number;
  return new;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_assign_daily_number() from public,anon,authenticated;

drop trigger if exists fiskalo_basic_sales_assign_daily_number on public.fiskalo_basic_sales;
create trigger fiskalo_basic_sales_assign_daily_number
before insert on public.fiskalo_basic_sales
for each row execute function fiskalo_private.fiskalo_basic_assign_daily_number();

alter table public.fiskalo_basic_fiscal_documents
  add column if not exists nui_kf text,
  add column if not exists citizen_payload text,
  add column if not exists citizen_signature text,
  add column if not exists daily_number bigint,
  add column if not exists offline_issued_at timestamptz,
  add column if not exists recovery_deadline_at timestamptz;

alter table public.fiskalo_basic_fiscal_documents
  add constraint fiskalo_basic_fiscal_nui_kf_format
  check (nui_kf is null or nui_kf ~ '^[A-Z0-9]{16}$'),
  add constraint fiskalo_basic_fiscal_daily_number_positive
  check (daily_number is null or daily_number > 0);

create unique index if not exists fiskalo_basic_fiscal_nui_kf_unique
  on public.fiskalo_basic_fiscal_documents(nui_kf)
  where nui_kf is not null;

create or replace function fiskalo_private.fiskalo_basic_store_offline_receipt(
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
  p_offline_issued_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_nui_kf !~ '^[A-Z0-9]{16}$' or p_daily_number is null or p_daily_number<=0 then
    raise exception 'NUIKF or daily coupon number is invalid';
  end if;
  if length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_idempotency_key,''))=0 or p_offline_issued_at is null then
    raise exception 'Signed POS and CitizenCoupon data, NUIKF, idempotency key and offline time are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status='paid' and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
    signed_payload,signature,submission_state,nui_kf,citizen_payload,citizen_signature,
    daily_number,offline_issued_at,recovery_deadline_at
  ) values (
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
    p_signed_payload,p_signature,'queued',p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at,p_offline_issued_at+interval '48 hours'
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from public.fiskalo_basic_fiscal_documents
      where idempotency_key=p_idempotency_key for update;
    if v_existing.sale_id<>p_sale_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal receipt data';
    end if;
    v_id:=v_existing.id;
  end if;
  return v_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_store_offline_receipt(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_nui_kf text,p_citizen_payload text,
  p_citizen_signature text,p_daily_number bigint,p_offline_issued_at timestamptz
) returns uuid
language sql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_store_offline_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_record_atk_receipt(
  p_business_id uuid,
  p_sale_id uuid,
  p_coupon_id bigint,
  p_idempotency_key text,
  p_signed_payload text,
  p_signature text,
  p_atk_transaction_id numeric,
  p_atk_response jsonb,
  p_nui_kf text,
  p_citizen_payload text,
  p_citizen_signature text,
  p_daily_number bigint,
  p_offline_issued_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing public.fiskalo_basic_fiscal_documents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_atk_transaction_id is null or p_atk_transaction_id<=0 or p_atk_transaction_id>18446744073709551615 then
    raise exception 'A valid ATK uint64 transaction_id is required';
  end if;
  if p_atk_response is null or
     coalesce(p_atk_response->>'status','')<>'accepted' or
     coalesce(p_atk_response->>'transactionId','')<>p_atk_transaction_id::text or
     coalesce(p_atk_response->>'environment','')<>'ATK TEST' then
    raise exception 'ATK response must be an accepted TEST response matching the transaction_id';
  end if;
  if p_nui_kf !~ '^[A-Z0-9]{16}$' or p_daily_number is null or p_daily_number<=0 or
     length(coalesce(p_signed_payload,''))=0 or length(coalesce(p_signature,''))=0 or
     length(coalesce(p_citizen_payload,''))=0 or length(coalesce(p_citizen_signature,''))=0 or
     length(coalesce(p_idempotency_key,''))=0 then
    raise exception 'Signed receipt identity and data are required';
  end if;
  if not exists(
    select 1 from public.fiskalo_basic_sales s
    join public.fiskalo_basic_members m on m.business_id=s.business_id
    where s.id=p_sale_id and s.business_id=p_business_id and s.coupon_id=p_coupon_id
      and s.status in ('paid','fiscalized') and m.user_id=auth.uid()
  ) then raise exception 'Sale is not accessible or coupon identity does not match'; end if;

  select * into v_existing from public.fiskalo_basic_fiscal_documents
    where idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.sale_id<>p_sale_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.signed_payload<>p_signed_payload or v_existing.signature<>p_signature or
       v_existing.nui_kf<>p_nui_kf or v_existing.citizen_payload<>p_citizen_payload or
       v_existing.citizen_signature<>p_citizen_signature or v_existing.daily_number<>p_daily_number then
      raise exception 'Idempotency key already exists with different fiscal receipt data';
    end if;
    if v_existing.submission_state='accepted' and v_existing.atk_transaction_id<>p_atk_transaction_id then
      raise exception 'Accepted fiscal receipt cannot be assigned a different ATK transaction';
    end if;
    update public.fiskalo_basic_fiscal_documents
      set atk_transaction_id=p_atk_transaction_id,submission_state='accepted',atk_response=p_atk_response,
          offline_issued_at=coalesce(offline_issued_at,p_offline_issued_at),
          recovery_deadline_at=coalesce(recovery_deadline_at,p_offline_issued_at+interval '48 hours')
      where id=v_existing.id returning id into v_id;
  else
    insert into public.fiskalo_basic_fiscal_documents(
      business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
      signed_payload,signature,atk_transaction_id,submission_state,atk_response,
      nui_kf,citizen_payload,citizen_signature,daily_number,offline_issued_at,recovery_deadline_at
    ) values(
      p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,1,null,
      p_signed_payload,p_signature,p_atk_transaction_id,'accepted',p_atk_response,
      p_nui_kf,p_citizen_payload,p_citizen_signature,p_daily_number,p_offline_issued_at,
      case when p_offline_issued_at is null then null else p_offline_issued_at+interval '48 hours' end
    ) returning id into v_id;
  end if;
  update public.fiskalo_basic_sales set status='fiscalized'
    where id=p_sale_id and business_id=p_business_id and coupon_id=p_coupon_id and status='paid';
  return v_id;
end;
$$;
revoke all on function fiskalo_private.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) to authenticated;

create or replace function public.fiskalo_basic_record_atk_receipt(
  p_business_id uuid,p_sale_id uuid,p_coupon_id bigint,p_idempotency_key text,
  p_signed_payload text,p_signature text,p_atk_transaction_id numeric,p_atk_response jsonb,
  p_nui_kf text,p_citizen_payload text,p_citizen_signature text,p_daily_number bigint,
  p_offline_issued_at timestamptz
) returns uuid
language sql security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_record_atk_receipt(
    p_business_id,p_sale_id,p_coupon_id,p_idempotency_key,p_signed_payload,p_signature,
    p_atk_transaction_id,p_atk_response,p_nui_kf,p_citizen_payload,p_citizen_signature,
    p_daily_number,p_offline_issued_at
  )
$$;
revoke all on function public.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_record_atk_receipt(uuid,uuid,bigint,text,text,text,numeric,jsonb,text,text,text,bigint,timestamptz) to authenticated;

-- Authenticated catalog and receipt readers may read the new metadata via existing RLS.
