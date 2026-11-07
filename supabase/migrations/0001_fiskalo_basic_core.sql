-- Fiskalo Basic core schema. All objects are isolated from other apps by prefix.
create extension if not exists pgcrypto;

create table public.fiskalo_basic_businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) >= 2),
  nui text not null unique check (nui ~ '^[0-9]{9}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.fiskalo_basic_members (
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','cashier')),
  created_at timestamptz not null default now(),
  primary key (business_id,user_id)
);

create table public.fiskalo_basic_pos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  label text not null,
  location text not null,
  branch_id bigint not null check (branch_id > 0),
  pos_id bigint not null check (pos_id > 0),
  fiscalization_number text not null,
  application_id text,
  verification_no text,
  verified_business_name text,
  certificate_pem text,
  certificate_status text not null default 'not_configured'
    check (certificate_status in ('not_configured','verified','certificate_issued','revoked')),
  created_at timestamptz not null default now(),
  unique (business_id,branch_id,pos_id)
);

create table public.fiskalo_basic_products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  price numeric(12,4) not null check (price >= 0),
  stock numeric(12,3) not null default 0 check (stock >= 0),
  atk_unit_code text not null check (length(trim(atk_unit_code)) > 0),
  atk_item_category_code text not null check (length(trim(atk_item_category_code)) > 0),
  atk_vat_code text not null check (atk_vat_code ~ '^[A-Z]$'),
  vat_rate numeric(5,2) not null default 18 check (vat_rate in (0,8,18)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (
    (vat_rate=18 and atk_vat_code='E') or
    (vat_rate=8 and atk_vat_code='D') or
    (vat_rate=0 and atk_vat_code in ('A','C'))
  )
);

create table public.fiskalo_basic_sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id),
  pos_id uuid not null references public.fiskalo_basic_pos(id),
  coupon_id bigint not null,
  operator_id uuid not null references auth.users(id),
  status text not null default 'paid'
    check (status in ('draft','paid','fiscalized','failed','needs_reconciliation')),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  vat_total numeric(12,2) not null check (vat_total >= 0),
  total numeric(12,2) not null check (total >= 0),
  payment_method text not null check (payment_method in ('cash','card','bank_transfer')),
  created_at timestamptz not null default now(),
  unique (business_id,coupon_id)
);

create table public.fiskalo_basic_fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id),
  sale_id uuid not null references public.fiskalo_basic_sales(id),
  coupon_id bigint not null unique,
  idempotency_key text not null unique,
  document_type smallint not null check (document_type in (1,2,3)),
  reference_coupon_id bigint,
  signed_payload text not null,
  signature text not null,
  atk_transaction_id numeric(20,0),
  submission_state text not null check (submission_state in ('queued','submitted','accepted','rejected','needs_reconciliation')),
  atk_response jsonb,
  created_at timestamptz not null default now()
);

alter table public.fiskalo_basic_businesses enable row level security;
alter table public.fiskalo_basic_members enable row level security;
alter table public.fiskalo_basic_pos enable row level security;
alter table public.fiskalo_basic_products enable row level security;
alter table public.fiskalo_basic_sales enable row level security;
alter table public.fiskalo_basic_fiscal_documents enable row level security;

create policy fiskalo_basic_business_read on public.fiskalo_basic_businesses
  for select to authenticated using (
    created_by=auth.uid() or exists (
      select 1 from public.fiskalo_basic_members m
      where m.business_id=id and m.user_id=auth.uid()
    )
  );
create policy fiskalo_basic_business_insert on public.fiskalo_basic_businesses
  for insert to authenticated with check (created_by=auth.uid());

create policy fiskalo_basic_member_read on public.fiskalo_basic_members
  for select to authenticated using (user_id=auth.uid());
create policy fiskalo_basic_member_insert on public.fiskalo_basic_members
  for insert to authenticated with check (
    user_id=auth.uid() and role='owner' and exists (
      select 1 from public.fiskalo_basic_businesses b
      where b.id=business_id and b.created_by=auth.uid()
    )
  );

create policy fiskalo_basic_pos_access on public.fiskalo_basic_pos
  for all to authenticated
  using (exists(select 1 from public.fiskalo_basic_members m where m.business_id=business_id and m.user_id=auth.uid()))
  with check (exists(select 1 from public.fiskalo_basic_members m where m.business_id=business_id and m.user_id=auth.uid()));

create policy fiskalo_basic_products_access on public.fiskalo_basic_products
  for all to authenticated
  using (exists(select 1 from public.fiskalo_basic_members m where m.business_id=business_id and m.user_id=auth.uid()))
  with check (exists(select 1 from public.fiskalo_basic_members m where m.business_id=business_id and m.user_id=auth.uid()));

create policy fiskalo_basic_sales_read on public.fiskalo_basic_sales
  for select to authenticated using (
    exists(select 1 from public.fiskalo_basic_members m where m.business_id=business_id and m.user_id=auth.uid())
  );
create policy fiskalo_basic_sales_insert on public.fiskalo_basic_sales
  for insert to authenticated with check (
    operator_id=auth.uid() and exists(select 1 from public.fiskalo_basic_members m where m.business_id=business_id and m.user_id=auth.uid())
  );

create policy fiskalo_basic_fiscal_access on public.fiskalo_basic_fiscal_documents
  for select to authenticated using (
    exists(select 1 from public.fiskalo_basic_members m where m.business_id=business_id and m.user_id=auth.uid())
  );

grant select,insert on public.fiskalo_basic_businesses to authenticated;
grant select,insert on public.fiskalo_basic_members to authenticated;
grant select,insert,update,delete on public.fiskalo_basic_pos to authenticated;
grant select,insert,update,delete on public.fiskalo_basic_products to authenticated;
grant select,insert on public.fiskalo_basic_sales to authenticated;
grant select on public.fiskalo_basic_fiscal_documents to authenticated;
revoke all on public.fiskalo_basic_businesses,public.fiskalo_basic_members,public.fiskalo_basic_pos,
  public.fiskalo_basic_products,public.fiskalo_basic_sales,public.fiskalo_basic_fiscal_documents from anon;
