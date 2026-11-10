-- Store the actual payment split for each Basic sale and pass every
-- allocation through the signed ATK POS coupon's repeated Payments field.
alter table public.fiskalo_basic_sales
  add column if not exists payment_allocations jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_basic_sales'::regclass
      and conname='fiskalo_basic_sales_payment_allocations_array'
  ) then
    alter table public.fiskalo_basic_sales
      add constraint fiskalo_basic_sales_payment_allocations_array
      check (
        payment_allocations is null or
        case
          when pg_catalog.jsonb_typeof(payment_allocations)='array'
          then pg_catalog.jsonb_array_length(payment_allocations) between 1 and 6
          else false
        end
      );
  end if;
end $$;

comment on column public.fiskalo_basic_sales.payment_allocations is
  'Immutable canonical JSON array of {method,amount_cents} tender allocations used for the fiscal coupon.';

create or replace function fiskalo_private.fiskalo_basic_create_sale_with_payments(
  p_business_id uuid,
  p_pos_id uuid,
  p_payments jsonb,
  p_lines jsonb,
  p_idempotency_key uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_payments jsonb;
  legacy_method text;
  sale_uuid uuid;
  sale_total numeric(12,2);
  allocated_cents numeric;
  existing_sale public.fiskalo_basic_sales%rowtype;
  had_existing_sale boolean:=false;
  saved_payments jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_idempotency_key is null then raise exception 'Checkout idempotency key is required'; end if;
  if not exists (
    select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()
  ) then raise exception 'Not a member of this business'; end if;
  if p_payments is null or pg_catalog.jsonb_typeof(p_payments) is distinct from 'array' then
    raise exception 'Payment allocations must be a JSON array';
  end if;
  if pg_catalog.jsonb_array_length(p_payments)<1 or pg_catalog.jsonb_array_length(p_payments)>6 then
    raise exception 'A sale must contain between one and six payment allocations';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_payments) as x(method text,amount_cents numeric)
    where x.method is null
      or x.method not in ('cash','card','bank_transfer','voucher','cheque','crypto')
      or x.amount_cents is null
      or x.amount_cents<0
      or x.amount_cents<>pg_catalog.trunc(x.amount_cents)
      or x.amount_cents>9223372036854775807
  ) then
    raise exception 'Unsupported payment method or invalid payment amount';
  end if;
  if exists (
    select x.method
    from pg_catalog.jsonb_to_recordset(p_payments) as x(method text,amount_cents numeric)
    group by x.method
    having count(*)>1
  ) then
    raise exception 'Each payment method may appear only once';
  end if;

  select
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('method',x.method,'amount_cents',x.amount_cents::bigint)
      order by x.method
    ),
    sum(x.amount_cents),
    case
      when pg_catalog.bool_or(x.method='card') then 'card'
      when pg_catalog.bool_or(x.method='bank_transfer') then 'bank_transfer'
      else 'cash'
    end
  into normalized_payments,allocated_cents,legacy_method
  from pg_catalog.jsonb_to_recordset(p_payments) as x(method text,amount_cents numeric);

  if allocated_cents is null then raise exception 'Payment allocation total is required'; end if;

  -- Acquire the same business/key lock as the underlying checkout function
  -- before inspecting or updating payment allocations. This keeps the sale,
  -- stock deduction, coupon number and tender split in one transaction.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text||':'||p_idempotency_key::text,0)
  );

  select * into existing_sale
  from public.fiskalo_basic_sales s
  where s.business_id=p_business_id
    and s.checkout_idempotency_key=p_idempotency_key
  for update;
  had_existing_sale:=found;

  sale_uuid:=fiskalo_private.fiskalo_basic_create_sale(
    p_business_id,p_pos_id,legacy_method,p_lines,p_idempotency_key
  );

  select s.total,s.payment_allocations
  into sale_total,saved_payments
  from public.fiskalo_basic_sales s
  where s.id=sale_uuid and s.business_id=p_business_id
  for update;
  if not found then raise exception 'Paid sale could not be read after checkout'; end if;
  if allocated_cents<>round(sale_total*100)::numeric then
    raise exception 'Payment allocations must equal the exact paid sale total';
  end if;

  if saved_payments is not null then
    if saved_payments is distinct from normalized_payments then
      raise exception 'Checkout idempotency key already exists with different payment allocations';
    end if;
    return sale_uuid;
  end if;

  -- The legacy payment_method column remains a deterministic compatibility key;
-- payment_allocations is the source of truth for receipts and ATK submissions.
-- Legacy sales did not store a split. Only an exact single-method replay may
  -- backfill their tender; never rewrite an old accepted receipt as a new split.
  if had_existing_sale and (
    pg_catalog.jsonb_array_length(normalized_payments)<>1
    or normalized_payments->0->>'method' not in ('cash','card','bank_transfer')
    or legacy_method<>existing_sale.payment_method
    or (normalized_payments->0->>'amount_cents')::bigint<>round(sale_total*100)::bigint
  ) then
    raise exception 'This existing sale has no stored payment split; a different tender cannot be applied to it';
  end if;

  update public.fiskalo_basic_sales
  set payment_allocations=normalized_payments
  where id=sale_uuid
    and business_id=p_business_id
    and payment_allocations is null;

  return sale_uuid;
end;
$$;

revoke all on function fiskalo_private.fiskalo_basic_create_sale_with_payments(uuid,uuid,jsonb,jsonb,uuid)
  from public,anon;
grant execute on function fiskalo_private.fiskalo_basic_create_sale_with_payments(uuid,uuid,jsonb,jsonb,uuid)
  to authenticated;

-- All new client checkouts must persist the complete tender split.
revoke all on function public.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)
  from public,anon,authenticated;
revoke all on function fiskalo_private.fiskalo_basic_create_sale(uuid,uuid,text,jsonb,uuid)
  from public,anon,authenticated;

create or replace function public.fiskalo_basic_create_sale_with_payments(
  p_business_id uuid,
  p_pos_id uuid,
  p_payments jsonb,
  p_lines jsonb,
  p_idempotency_key uuid
) returns uuid
language sql
security invoker
set search_path=pg_catalog,public,pg_temp
as $$
  select fiskalo_private.fiskalo_basic_create_sale_with_payments(
    p_business_id,p_pos_id,p_payments,p_lines,p_idempotency_key
  )
$$;
revoke all on function public.fiskalo_basic_create_sale_with_payments(uuid,uuid,jsonb,jsonb,uuid)
  from public,anon;
grant execute on function public.fiskalo_basic_create_sale_with_payments(uuid,uuid,jsonb,jsonb,uuid)
  to authenticated;
