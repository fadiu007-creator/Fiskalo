-- Fiskalo Basic core schema. Uses isolated fiskalo_basic_* names so it cannot
-- overwrite tables belonging to other applications in the shared Supabase project.
create extension if not exists pgcrypto;

create table if not exists public.fiskalo_basic_businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nui text not null check (nui ~ '^[0-9]{9}$'),
  created_at timestamptz not null default now()
);
create table if not exists public.fiskalo_basic_members (
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','cashier')),
  created_at timestamptz not null default now(),
  primary key (business_id,user_id)
);
create table if not exists public.fiskalo_basic_pos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  label text not null,
  branch_id bigint not null check (branch_id > 0),
  pos_id bigint not null check (pos_id > 0),
  fiscalization_number text not null,
  application_id text,
  verification_no text,
  certificate_pem text,
  certificate_status text not null default 'not_configured' check (certificate_status in ('not_configured','verified','certificate_issued','revoked')),
  created_at timestamptz not null default now(),
  unique (business_id,branch_id,pos_id)
);
create table if not exists public.fiskalo_basic_products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  name text not null,
  price numeric(12,4) not null check (price >= 0),
  stock numeric(12,3) not null default 0 check (stock >= 0),
  atk_unit_code text not null,
  atk_item_category_code text not null,
  atk_vat_code text not null check (atk_vat_code ~ '^[A-Z]$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.fiskalo_basic_sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id),
  pos_id uuid not null references public.fiskalo_basic_pos(id),
  coupon_id bigint not null,
  operator_id uuid not null references auth.users(id),
  status text not null default 'paid' check (status in ('draft','paid','fiscalized','failed','needs_reconciliation')),
  subtotal numeric(12,2) not null,
  vat_total numeric(12,2) not null,
  total numeric(12,2) not null,
  payment_method text not null check (payment_method in ('cash','card','bank_transfer')),
  created_at timestamptz not null default now(),
  unique (business_id,coupon_id)
);
create table if not exists public.fiskalo_basic_fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id),
  sale_id uuid not null references public.fiskalo_basic_sales(id),
  document_type smallint not null check (document_type in (1,2,3)),
  reference_coupon_id bigint,
  signed_payload text not null,
  signature text not null,
  atk_transaction_id numeric(20,0),
  submission_state text not null check (submission_state in ('queued','submitted','accepted','rejected','needs_reconciliation')),
  atk_response jsonb,
  created_at timestamptz not null default now(),
  unique (business_id,sale_id,document_type)
);

create or replace function public.fiskalo_basic_is_member(target_business uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.fiskalo_basic_members m where m.business_id=target_business and m.user_id=auth.uid());
$$;
revoke all on function public.fiskalo_basic_is_member(uuid) from public, anon;
grant execute on function public.fiskalo_basic_is_member(uuid) to authenticated;

alter table public.fiskalo_basic_businesses enable row level security;
alter table public.fiskalo_basic_members enable row level security;
alter table public.fiskalo_basic_pos enable row level security;
alter table public.fiskalo_basic_products enable row level security;
alter table public.fiskalo_basic_sales enable row level security;
alter table public.fiskalo_basic_fiscal_documents enable row level security;

create policy fiskalo_basic_business_read on public.fiskalo_basic_businesses for select to authenticated using (public.fiskalo_basic_is_member(id));
create policy fiskalo_basic_member_read on public.fiskalo_basic_members for select to authenticated using (user_id=auth.uid() or public.fiskalo_basic_is_member(business_id));
create policy fiskalo_basic_pos_access on public.fiskalo_basic_pos for all to authenticated using (public.fiskalo_basic_is_member(business_id)) with check (public.fiskalo_basic_is_member(business_id));
create policy fiskalo_basic_products_access on public.fiskalo_basic_products for all to authenticated using (public.fiskalo_basic_is_member(business_id)) with check (public.fiskalo_basic_is_member(business_id));
create policy fiskalo_basic_sales_access on public.fiskalo_basic_sales for all to authenticated using (public.fiskalo_basic_is_member(business_id)) with check (public.fiskalo_basic_is_member(business_id));
create policy fiskalo_basic_fiscal_access on public.fiskalo_basic_fiscal_documents for select to authenticated using (public.fiskalo_basic_is_member(business_id));
