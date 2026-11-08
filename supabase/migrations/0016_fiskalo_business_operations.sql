-- Business operations: inventory ledger, supplier purchases and operating expenses.
-- Every object is isolated to Fiskalo Basic and every write is owner-scoped.
create table if not exists public.fiskalo_basic_stock_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  product_id uuid not null references public.fiskalo_basic_products(id),
  movement_type text not null check (movement_type in ('adjustment','purchase','sale','return')),
  quantity_delta numeric(12,3) not null check (quantity_delta <> 0),
  reason text not null check (length(trim(reason)) between 2 and 240),
  reference_id uuid,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists fiskalo_basic_stock_movements_business_created_idx
  on public.fiskalo_basic_stock_movements(business_id,created_at desc);
create index if not exists fiskalo_basic_stock_movements_product_created_idx
  on public.fiskalo_basic_stock_movements(product_id,created_at desc);

create table if not exists public.fiskalo_basic_purchases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  supplier_name text not null check (length(trim(supplier_name)) between 2 and 160),
  invoice_number text,
  purchase_date date not null default current_date,
  payment_status text not null default 'unpaid' check (payment_status in ('paid','unpaid','partial')),
  payment_method text check (payment_method in ('cash','card','bank_transfer')),
  notes text,
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists fiskalo_basic_purchases_business_date_idx
  on public.fiskalo_basic_purchases(business_id,purchase_date desc);

create table if not exists public.fiskalo_basic_purchase_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  purchase_id uuid not null references public.fiskalo_basic_purchases(id) on delete cascade,
  product_id uuid not null references public.fiskalo_basic_products(id),
  quantity numeric(12,3) not null check (quantity > 0),
  unit_cost numeric(12,4) not null check (unit_cost >= 0),
  line_total numeric(12,2) generated always as (round(quantity * unit_cost,2)) stored,
  created_at timestamptz not null default now()
);
create index if not exists fiskalo_basic_purchase_items_purchase_idx
  on public.fiskalo_basic_purchase_items(purchase_id);

create table if not exists public.fiskalo_basic_expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete cascade,
  description text not null check (length(trim(description)) between 2 and 200),
  category text not null check (length(trim(category)) between 2 and 80),
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null default current_date,
  payment_method text not null check (payment_method in ('cash','card','bank_transfer')),
  supplier_name text,
  notes text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists fiskalo_basic_expenses_business_date_idx
  on public.fiskalo_basic_expenses(business_id,expense_date desc);

alter table public.fiskalo_basic_stock_movements enable row level security;
alter table public.fiskalo_basic_purchases enable row level security;
alter table public.fiskalo_basic_purchase_items enable row level security;
alter table public.fiskalo_basic_expenses enable row level security;

create policy fiskalo_basic_stock_read_owner on public.fiskalo_basic_stock_movements
  for select to authenticated using (exists (
    select 1 from public.fiskalo_basic_members m where m.business_id=fiskalo_basic_stock_movements.business_id and m.user_id=auth.uid() and m.role='owner'
  ));
create policy fiskalo_basic_stock_insert_owner on public.fiskalo_basic_stock_movements
  for insert to authenticated with check (
    created_by=auth.uid() and movement_type='adjustment' and exists (
      select 1 from public.fiskalo_basic_members m where m.business_id=fiskalo_basic_stock_movements.business_id and m.user_id=auth.uid() and m.role='owner'
    )
  );
create policy fiskalo_basic_purchases_read_owner on public.fiskalo_basic_purchases
  for select to authenticated using (exists (
    select 1 from public.fiskalo_basic_members m where m.business_id=fiskalo_basic_purchases.business_id and m.user_id=auth.uid() and m.role='owner'
  ));
create policy fiskalo_basic_purchases_insert_owner on public.fiskalo_basic_purchases
  for insert to authenticated with check (created_by=auth.uid() and exists (
    select 1 from public.fiskalo_basic_members m where m.business_id=fiskalo_basic_purchases.business_id and m.user_id=auth.uid() and m.role='owner'
  ));
create policy fiskalo_basic_purchase_items_read_owner on public.fiskalo_basic_purchase_items
  for select to authenticated using (exists (
    select 1 from public.fiskalo_basic_members m where m.business_id=fiskalo_basic_purchase_items.business_id and m.user_id=auth.uid() and m.role='owner'
  ));
create policy fiskalo_basic_purchase_items_insert_owner on public.fiskalo_basic_purchase_items
  for insert to authenticated with check (exists (
    select 1 from public.fiskalo_basic_members m where m.business_id=fiskalo_basic_purchase_items.business_id and m.user_id=auth.uid() and m.role='owner'
  ));
create policy fiskalo_basic_expenses_owner on public.fiskalo_basic_expenses
  for all to authenticated using (exists (
    select 1 from public.fiskalo_basic_members m where m.business_id=fiskalo_basic_expenses.business_id and m.user_id=auth.uid() and m.role='owner'
  )) with check (created_by=auth.uid() and exists (
    select 1 from public.fiskalo_basic_members m where m.business_id=fiskalo_basic_expenses.business_id and m.user_id=auth.uid() and m.role='owner'
  ));

grant select,insert on public.fiskalo_basic_stock_movements to authenticated;
grant select,insert on public.fiskalo_basic_purchases to authenticated;
grant select,insert on public.fiskalo_basic_purchase_items to authenticated;
grant select,insert,update,delete on public.fiskalo_basic_expenses to authenticated;
revoke update,delete on public.fiskalo_basic_stock_movements,public.fiskalo_basic_purchases,public.fiskalo_basic_purchase_items from authenticated;

create or replace function public.fiskalo_basic_apply_stock_movement()
returns trigger language plpgsql security definer set search_path='' as $$
declare current_stock numeric(12,3);
begin
  if not exists (
    select 1 from public.fiskalo_basic_products p
    where p.id=new.product_id and p.business_id=new.business_id
  ) then raise exception 'Product does not belong to this business'; end if;
  select p.stock into current_stock from public.fiskalo_basic_products p
    where p.id=new.product_id and p.business_id=new.business_id for update;
  if current_stock + new.quantity_delta < 0 then raise exception 'Insufficient stock'; end if;
  update public.fiskalo_basic_products set stock=current_stock+new.quantity_delta
    where id=new.product_id and business_id=new.business_id;
  return new;
end $$;
drop trigger if exists fiskalo_basic_stock_movement_apply on public.fiskalo_basic_stock_movements;
create trigger fiskalo_basic_stock_movement_apply before insert on public.fiskalo_basic_stock_movements
for each row execute function public.fiskalo_basic_apply_stock_movement();

create or replace function public.fiskalo_basic_apply_purchase_item()
returns trigger language plpgsql security definer set search_path='' as $$
declare purchase_business uuid; product_business uuid;
begin
  select p.business_id into purchase_business from public.fiskalo_basic_purchases p where p.id=new.purchase_id;
  select p.business_id into product_business from public.fiskalo_basic_products p where p.id=new.product_id;
  if purchase_business is null or purchase_business<>new.business_id or product_business<>new.business_id then
    raise exception 'Purchase and product must belong to the same business';
  end if;
  insert into public.fiskalo_basic_stock_movements(business_id,product_id,movement_type,quantity_delta,reason,reference_id,created_by)
  values(new.business_id,new.product_id,'purchase',new.quantity,'Blerje furnizuesi',new.purchase_id,auth.uid());
  update public.fiskalo_basic_purchases set subtotal=subtotal+new.line_total where id=new.purchase_id;
  return new;
end $$;
drop trigger if exists fiskalo_basic_purchase_item_apply on public.fiskalo_basic_purchase_items;
create trigger fiskalo_basic_purchase_item_apply after insert on public.fiskalo_basic_purchase_items
for each row execute function public.fiskalo_basic_apply_purchase_item();

-- Purchase lines and stock movements are immutable audit records.
create or replace function public.fiskalo_basic_block_audit_mutation()
returns trigger language plpgsql as $$ begin raise exception 'Audit records are immutable'; end $$;
drop trigger if exists fiskalo_basic_stock_movement_immutable on public.fiskalo_basic_stock_movements;
create trigger fiskalo_basic_stock_movement_immutable before update or delete on public.fiskalo_basic_stock_movements
for each row execute function public.fiskalo_basic_block_audit_mutation();
drop trigger if exists fiskalo_basic_purchase_item_immutable on public.fiskalo_basic_purchase_items;
create trigger fiskalo_basic_purchase_item_immutable before update or delete on public.fiskalo_basic_purchase_items
for each row execute function public.fiskalo_basic_block_audit_mutation();
