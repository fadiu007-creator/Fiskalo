begin;

-- Server-only registry of the public certificate issued for each Full Web POS.
-- The private key remains non-exportable in the browser profile and is never uploaded.
create table if not exists public.fiskalo_atk_pos_certificates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.fiskalo_organizations(id) on delete cascade,
  pos_installation_id uuid not null references public.fiskalo_atk_pos_installations(id) on delete cascade,
  certificate_pem text not null,
  spki_sha256 text not null check (spki_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active','revoked')),
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (pos_installation_id, spki_sha256),
  check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null))
);

create unique index if not exists fiskalo_atk_pos_certificates_one_active_per_pos
  on public.fiskalo_atk_pos_certificates(pos_installation_id)
  where status = 'active' and revoked_at is null;

create index if not exists fiskalo_atk_pos_certificates_org_pos_idx
  on public.fiskalo_atk_pos_certificates(organization_id, pos_installation_id, issued_at desc);

alter table public.fiskalo_atk_pos_certificates enable row level security;
revoke all on table public.fiskalo_atk_pos_certificates from public, anon, authenticated;
grant all on table public.fiskalo_atk_pos_certificates to service_role;
comment on table public.fiskalo_atk_pos_certificates is
  'Server-only registry of ATK-issued public POS certificates. Browser clients cannot insert, read, update, or revoke certificates.';

-- Enforce official ATK product codes for new products and changes to fiscal fields.
-- Existing legacy products can still receive non-fiscal stock/metadata updates, but
-- cannot be newly created or have fiscal fields changed with invalid ATK codes.
create or replace function public.fiskalo_validate_full_product_atk_catalogue()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if new.atk_unit_code is null or new.atk_unit_code not in (
    'EA','CP','LTR','SEC','MIN','HUR','DAY','MON','ANN','KGB','KGN',
    'TN','GRM','M4','UDH','KMT','LM','MTS','MTV','MSK','KWH'
  ) then
    raise exception 'Invalid ATK measurement unit code: %', new.atk_unit_code using errcode = '23514';
  end if;
  if new.atk_item_category_code is null or new.atk_item_category_code not in (
    'TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB',
    'KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA',
    'KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM'
  ) then
    raise exception 'Invalid ATK item category code: %', new.atk_item_category_code using errcode = '23514';
  end if;
  if not (
    (new.atk_tax_code in ('A','C') and new.vat_rate = 0)
    or (new.atk_tax_code = 'D' and new.vat_rate = 8)
    or (new.atk_tax_code = 'E' and new.vat_rate = 18)
  ) then
    raise exception 'ATK VAT code and VAT rate do not match.' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.fiskalo_validate_full_product_atk_catalogue() from public, anon, authenticated;
drop trigger if exists fiskalo_products_atk_catalogue_insert on public.fiskalo_products;
drop trigger if exists fiskalo_products_atk_catalogue_update on public.fiskalo_products;
create trigger fiskalo_products_atk_catalogue_insert
  before insert on public.fiskalo_products
  for each row execute function public.fiskalo_validate_full_product_atk_catalogue();
create trigger fiskalo_products_atk_catalogue_update
  before update of atk_unit_code, atk_item_category_code, atk_tax_code, vat_rate on public.fiskalo_products
  for each row execute function public.fiskalo_validate_full_product_atk_catalogue();

-- Do not create a new invoice line from a legacy product whose ATK mapping is invalid.
create or replace function public.fiskalo_validate_invoice_item_atk_catalogue()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  product_row public.fiskalo_products%rowtype;
begin
  select * into product_row from public.fiskalo_products where id = new.product_id;
  if not found then
    raise exception 'Invoice line product was not found.' using errcode = '23503';
  end if;
  if product_row.atk_unit_code is null or product_row.atk_unit_code not in (
    'EA','CP','LTR','SEC','MIN','HUR','DAY','MON','ANN','KGB','KGN',
    'TN','GRM','M4','UDH','KMT','LM','MTS','MTV','MSK','KWH'
  ) then
    raise exception 'Product has an invalid ATK measurement unit code.' using errcode = '23514';
  end if;
  if product_row.atk_item_category_code is null or product_row.atk_item_category_code not in (
    'TT','UR','AU','VM','KO','AP','BM','PM','PP','PE','PS','PB','BB',
    'KB','EE','PSE','SM','SJ','ST','SK','SMK','STR','PI','PT','SEA',
    'KS','MN','SHN','SDG','HT','SHB','STI','SHT','PBS','MPM'
  ) then
    raise exception 'Product has an invalid ATK item category code.' using errcode = '23514';
  end if;
  if not (
    (product_row.atk_tax_code in ('A','C') and product_row.vat_rate = 0)
    or (product_row.atk_tax_code = 'D' and product_row.vat_rate = 8)
    or (product_row.atk_tax_code = 'E' and product_row.vat_rate = 18)
  ) or new.vat_rate is distinct from product_row.vat_rate then
    raise exception 'Product ATK VAT mapping does not match the invoice line.' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.fiskalo_validate_invoice_item_atk_catalogue() from public, anon, authenticated;
drop trigger if exists fiskalo_invoice_items_atk_catalogue_insert on public.fiskalo_invoice_items;
drop trigger if exists fiskalo_invoice_items_atk_catalogue_update on public.fiskalo_invoice_items;
create trigger fiskalo_invoice_items_atk_catalogue_insert
  before insert on public.fiskalo_invoice_items
  for each row execute function public.fiskalo_validate_invoice_item_atk_catalogue();
create trigger fiskalo_invoice_items_atk_catalogue_update
  before update of product_id, vat_rate on public.fiskalo_invoice_items
  for each row execute function public.fiskalo_validate_invoice_item_atk_catalogue();

-- Fiscal acceptance and audit events are server-trusted facts, never browser-editable.
drop policy if exists fiskalo_atk_docs_insert_test on public.fiskalo_atk_fiscal_documents;
drop policy if exists fiskalo_atk_docs_update_test on public.fiskalo_atk_fiscal_documents;
drop policy if exists fiskalo_atk_events_insert_test on public.fiskalo_atk_fiscal_events;
drop policy if exists fiskalo_atk_verifications_insert_test on public.fiskalo_atk_pos_verifications;
drop policy if exists fiskalo_atk_verifications_update_test on public.fiskalo_atk_pos_verifications;
drop policy if exists fiskalo_atk_verifications_delete_test on public.fiskalo_atk_pos_verifications;
drop policy if exists fiskalo_atk_pos_update_test on public.fiskalo_atk_pos_installations;

revoke insert, update, delete on table public.fiskalo_atk_fiscal_documents from public, anon, authenticated;
revoke insert, update, delete on table public.fiskalo_atk_fiscal_events from public, anon, authenticated;
revoke insert, update, delete on table public.fiskalo_atk_pos_verifications from public, anon, authenticated;
revoke update, delete on table public.fiskalo_atk_pos_installations from public, anon, authenticated;

grant select on table public.fiskalo_atk_fiscal_documents to authenticated;
grant select on table public.fiskalo_atk_fiscal_events to authenticated;
grant select on table public.fiskalo_atk_pos_verifications to authenticated;
grant select, insert on table public.fiskalo_atk_pos_installations to authenticated;
grant all on table public.fiskalo_atk_pos_certificates to service_role;
grant all on table public.fiskalo_atk_fiscal_documents to service_role;
grant all on table public.fiskalo_atk_fiscal_events to service_role;
grant all on table public.fiskalo_atk_pos_verifications to service_role;
grant all on table public.fiskalo_atk_pos_installations to service_role;



-- Support the complete ATK PaymentType enum in Full invoices and POS.
alter table public.fiskalo_invoice_payments
  drop constraint if exists fiskalo_invoice_payments_payment_method_check;
alter table public.fiskalo_invoice_payments
  add constraint fiskalo_invoice_payments_payment_method_check
  check (payment_method in ('cash','card','voucher','cheque','crypto','bank_transfer'));

alter table public.fiskalo_invoices
  drop constraint if exists fiskalo_invoices_payment_method_check;
alter table public.fiskalo_invoices
  add constraint fiskalo_invoices_payment_method_check
  check (payment_method in ('cash','card','voucher','cheque','crypto','bank_transfer','credit','mixed'));

create or replace function public.fiskalo_record_payment(
  target_invoice uuid,
  payment_amount numeric,
  method text,
  payment_reference text default null
)
returns numeric
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  inv public.fiskalo_invoices%rowtype;
  already_paid numeric(14,2);
  new_paid numeric(14,2);
  active_shift uuid;
  distinct_method_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if payment_amount is null or payment_amount <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  if method not in ('cash','card','voucher','cheque','crypto','bank_transfer') then raise exception 'Unsupported payment method'; end if;
  select * into inv from public.fiskalo_invoices where id = target_invoice for update;
  if not found or not public.fiskalo_is_member(inv.organization_id) then raise exception 'Invoice not found or access denied'; end if;
  if not public.fiskalo_has_role(inv.organization_id, array['owner','administrator','manager','cashier']::public.fiskalo_organization_role[]) then
    raise exception 'Accountants cannot record customer payments';
  end if;
  if inv.status <> 'issued' then raise exception 'Only issued invoices can receive payments'; end if;
  select coalesce(sum(p.amount),0) into already_paid from public.fiskalo_invoice_payments p where p.invoice_id = target_invoice;
  new_paid := already_paid + payment_amount;
  if new_paid > inv.total then raise exception 'Payment exceeds the outstanding invoice balance'; end if;
  if method = 'cash' then
    select id into active_shift from public.fiskalo_cashier_shifts
    where organization_id = inv.organization_id and opened_by = auth.uid() and status = 'open' for update;
    if active_shift is null then raise exception 'Open a cashier shift before recording a cash payment'; end if;
  end if;
  insert into public.fiskalo_invoice_payments(organization_id, invoice_id, created_by, amount, payment_method, reference, cashier_shift_id)
  values (inv.organization_id, target_invoice, auth.uid(), payment_amount, method, nullif(trim(payment_reference), ''), active_shift);
  select count(distinct p.payment_method) into distinct_method_count
    from public.fiskalo_invoice_payments p where p.invoice_id = target_invoice;
  update public.fiskalo_invoices
    set payment_status = case when new_paid >= inv.total then 'paid' else 'partial' end,
        payment_method = case when distinct_method_count > 1 then 'mixed' else method end,
        paid_at = case when new_paid >= inv.total then now() else null end
    where id = target_invoice;
  insert into public.fiskalo_audit_logs(organization_id, actor_id, action, entity_type, entity_id, details)
  values (inv.organization_id, auth.uid(), 'invoice.payment_recorded', 'invoice', target_invoice,
    jsonb_build_object('amount', payment_amount, 'total_paid', new_paid, 'method', method, 'payment_method_summary', case when distinct_method_count > 1 then 'mixed' else method end, 'cashier_shift_id',active_shift));
  return new_paid;
end;
$function$;

create or replace function public.fiskalo_create_pos_sale(
  target_org uuid,
  request_id uuid,
  target_customer uuid,
  target_payment_method text,
  sale_items jsonb,
  target_discount_percent numeric
)
returns table(invoice_id uuid, invoice_number text, invoice_total numeric, replayed boolean)
language plpgsql
set search_path to ''
as $function$
declare
  actor_id uuid := auth.uid();
  normalized_items jsonb;
  request_fingerprint text;
  existing public.fiskalo_invoices%rowtype;
  created_invoice uuid;
  created_number text;
  created_total numeric(14,2);
  input_count integer;
  valid_count integer;
begin
  if actor_id is null then raise exception 'Authentication required'; end if;
  if request_id is null then raise exception 'A stable request ID is required'; end if;
  if target_payment_method not in ('cash','card','voucher','cheque','crypto','bank_transfer','credit') then raise exception 'Unsupported payment method'; end if;
  if target_discount_percent is null or target_discount_percent < 0 or target_discount_percent > 99.99 then
    raise exception 'Discount percentage must be between 0 and 99.99';
  end if;
  if jsonb_typeof(sale_items) <> 'array' or jsonb_array_length(sale_items) < 1 or jsonb_array_length(sale_items) > 100 then
    raise exception 'A sale must contain between 1 and 100 item rows';
  end if;
  if not public.fiskalo_is_member(target_org)
     or not public.fiskalo_has_role(target_org, array['owner','administrator','manager','cashier']::public.fiskalo_organization_role[]) then
    raise exception 'Access denied';
  end if;

  select count(*) into input_count from jsonb_to_recordset(sale_items) as x(product_id uuid, quantity numeric);
  if input_count < 1 then raise exception 'Sale items are required'; end if;
  if exists (
    select 1 from jsonb_to_recordset(sale_items) as x(product_id uuid, quantity numeric)
    where x.product_id is null or x.quantity is null or x.quantity <= 0 or x.quantity > 100000
  ) then raise exception 'Each sale item needs a product and a positive quantity'; end if;

  select jsonb_agg(jsonb_build_object('product_id', grouped.product_id, 'quantity', grouped.quantity) order by grouped.product_id)
  into normalized_items
  from (
    select x.product_id, sum(x.quantity) as quantity
    from jsonb_to_recordset(sale_items) as x(product_id uuid, quantity numeric)
    group by x.product_id
  ) grouped;

  select count(*) into valid_count
  from jsonb_to_recordset(normalized_items) as x(product_id uuid, quantity numeric)
  join public.fiskalo_products p on p.id = x.product_id and p.organization_id = target_org and p.is_active = true;
  if valid_count <> jsonb_array_length(normalized_items) then
    raise exception 'One or more products are unavailable or belong to another business';
  end if;

  if target_customer is not null and not exists (
    select 1 from public.fiskalo_customers c where c.id = target_customer and c.organization_id = target_org
  ) then raise exception 'Customer does not belong to this business'; end if;

  if target_payment_method = 'cash' and not exists (
    select 1 from public.fiskalo_cashier_shifts s
    where s.organization_id = target_org and s.opened_by = actor_id and s.status = 'open'
  ) then raise exception 'Open a cashier shift before accepting cash'; end if;

  request_fingerprint := md5(jsonb_build_object(
    'customer_id', target_customer,
    'payment_method', target_payment_method,
    'discount_percent', target_discount_percent,
    'items', normalized_items
  )::text);

  select * into existing from public.fiskalo_invoices i
  where i.organization_id = target_org and i.created_by = actor_id and i.pos_request_id = request_id
  for update;
  if found then
    if existing.pos_request_fingerprint is distinct from request_fingerprint then raise exception 'Request ID was already used for a different sale'; end if;
    if existing.status <> 'issued' then raise exception 'A previous sale request is incomplete; review its draft before retrying'; end if;
    return query select existing.id, existing.invoice_number, existing.total, true;
    return;
  end if;

  insert into public.fiskalo_invoices(
    organization_id, created_by, customer_id, payment_method, payment_status,
    issue_date, pos_request_id, pos_request_fingerprint
  ) values (
    target_org, actor_id, target_customer, target_payment_method, 'unpaid',
    current_date, request_id, request_fingerprint
  )
  on conflict (organization_id, created_by, pos_request_id) do nothing
  returning id into created_invoice;

  if created_invoice is null then
    select * into existing from public.fiskalo_invoices i
    where i.organization_id = target_org and i.created_by = actor_id and i.pos_request_id = request_id
    for update;
    if not found or existing.pos_request_fingerprint is distinct from request_fingerprint then raise exception 'Request ID was already used for a different sale'; end if;
    if existing.status <> 'issued' then raise exception 'A previous sale request is incomplete; review its draft before retrying'; end if;
    return query select existing.id, existing.invoice_number, existing.total, true;
    return;
  end if;

  insert into public.fiskalo_invoice_items(
    invoice_id, product_id, description, quantity, unit_price, vat_rate, discount_percent
  )
  select created_invoice, p.id, p.name, x.quantity, p.unit_price, p.vat_rate, target_discount_percent
  from jsonb_to_recordset(normalized_items) as x(product_id uuid, quantity numeric)
  join public.fiskalo_products p on p.id = x.product_id and p.organization_id = target_org and p.is_active = true
  order by p.id;

  created_number := public.fiskalo_issue_invoice(created_invoice);
  select i.total into created_total from public.fiskalo_invoices i
  where i.id = created_invoice and i.organization_id = target_org;

  if target_payment_method <> 'credit' then
    perform public.fiskalo_record_payment(created_invoice, created_total, target_payment_method, null);
  end if;

  return query select created_invoice, created_number, created_total, false;
end;
$function$;

revoke all on function public.fiskalo_record_payment(uuid, numeric, text, text) from public, anon;
grant execute on function public.fiskalo_record_payment(uuid, numeric, text, text) to authenticated;
revoke all on function public.fiskalo_create_pos_sale(uuid, uuid, uuid, text, jsonb, numeric) from public, anon;
grant execute on function public.fiskalo_create_pos_sale(uuid, uuid, uuid, text, jsonb, numeric) to authenticated;
revoke all on function public.fiskalo_create_pos_sale(uuid, uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.fiskalo_create_pos_sale(uuid, uuid, uuid, text, jsonb) to authenticated;

commit;
