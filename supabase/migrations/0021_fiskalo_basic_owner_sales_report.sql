-- Read-only Basic sales report. The private function returns only the selected
-- business/date-range rows and is callable only through the owner-checked wrapper.
create or replace function fiskalo_private.fiskalo_basic_sales_report(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 20000
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  result jsonb;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_business_id is null or p_from is null or p_to is null or p_to <= p_from then
    raise exception 'A business and valid inclusive date range are required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20000 then
    raise exception 'Report limit must be between 1 and 20000';
  end if;
  if not exists (
    select 1
    from public.fiskalo_basic_members m
    where m.business_id = p_business_id
      and m.user_id = caller_id
      and m.role = 'owner'
  ) then
    raise exception 'Only a business owner can access financial reports' using errcode = '42501';
  end if;

  with selected_sales as materialized (
    select
      s.id, s.coupon_id, s.created_at, s.status,
      s.subtotal, s.vat_total, s.total, s.payment_method
    from public.fiskalo_basic_sales s
    where s.business_id = p_business_id
      and s.created_at >= p_from
      and s.created_at < p_to
    order by s.created_at, s.id
    limit p_limit
  ),
  sales_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'coupon_id', s.coupon_id,
          'created_at', s.created_at,
          'status', s.status,
          'subtotal', s.subtotal,
          'vat_total', s.vat_total,
          'total', s.total,
          'payment_method', s.payment_method
        ) order by s.created_at, s.id
      ),
      '[]'::jsonb
    ) as value
    from selected_sales s
  ),
  items_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'sale_id', i.sale_id,
          'quantity', i.quantity,
          'vat_rate', i.vat_rate,
          'atk_vat_code', i.atk_vat_code,
          'line_net', i.line_net,
          'line_vat', i.line_vat,
          'line_total', i.line_total
        ) order by i.sale_id, i.id
      ),
      '[]'::jsonb
    ) as value
    from public.fiskalo_basic_sale_items i
    join selected_sales s on s.id = i.sale_id
  ),
  documents_payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'sale_id', d.sale_id,
          'document_type', d.document_type,
          'submission_state', d.submission_state,
          'atk_transaction_id', d.atk_transaction_id
        ) order by d.sale_id, d.id
      ),
      '[]'::jsonb
    ) as value
    from public.fiskalo_basic_fiscal_documents d
    join selected_sales s on s.id = d.sale_id
  ),
  count_payload as (
    select count(*) as total
    from public.fiskalo_basic_sales s
    where s.business_id = p_business_id
      and s.created_at >= p_from
      and s.created_at < p_to
  )
  select jsonb_build_object(
    'sales', sales_payload.value,
    'items', items_payload.value,
    'documents', documents_payload.value,
    'truncated', count_payload.total > p_limit
  )
  into result
  from sales_payload, items_payload, documents_payload, count_payload;

  return result;
end;
$$;

revoke all on function fiskalo_private.fiskalo_basic_sales_report(uuid,timestamptz,timestamptz,integer)
  from public, anon, authenticated;

create or replace function public.fiskalo_basic_sales_report(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 20000
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select fiskalo_private.fiskalo_basic_sales_report(
    p_business_id, p_from, p_to, p_limit
  )
$$;

revoke all on function public.fiskalo_basic_sales_report(uuid,timestamptz,timestamptz,integer)
  from public, anon;
grant execute on function public.fiskalo_basic_sales_report(uuid,timestamptz,timestamptz,integer)
  to authenticated;
