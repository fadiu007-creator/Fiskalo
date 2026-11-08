-- Atomic purchase entry: purchase header, lines, stock ledger and product balances
-- commit together or roll back together.
create or replace function public.fiskalo_basic_create_purchase(
  p_business_id uuid,p_supplier_name text,p_invoice_number text,p_purchase_date date,
  p_payment_status text,p_payment_method text,p_notes text,p_items jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare purchase_uuid uuid; line jsonb; product_uuid uuid; qty numeric; cost numeric;
begin
  if auth.uid() is null or not exists (
    select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid() and m.role='owner'
  ) then raise exception 'Owner access required'; end if;
  if length(trim(coalesce(p_supplier_name,'')))<2 then raise exception 'Supplier name is required'; end if;
  if p_payment_status not in ('paid','unpaid','partial') then raise exception 'Invalid payment status'; end if;
  if p_payment_method is not null and p_payment_method not in ('cash','card','bank_transfer') then raise exception 'Invalid payment method'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'At least one purchase item is required'; end if;
  insert into public.fiskalo_basic_purchases(business_id,supplier_name,invoice_number,purchase_date,payment_status,payment_method,notes,created_by)
  values(p_business_id,trim(p_supplier_name),nullif(trim(coalesce(p_invoice_number,'')),''),coalesce(p_purchase_date,current_date),p_payment_status,p_payment_method,nullif(trim(coalesce(p_notes,'')),''),auth.uid())
  returning id into purchase_uuid;
  for line in select value from jsonb_array_elements(p_items) loop
    product_uuid:=(line->>'product_id')::uuid;
    qty:=(line->>'quantity')::numeric;
    cost:=(line->>'unit_cost')::numeric;
    if qty<=0 or cost<0 then raise exception 'Invalid purchase quantity or cost'; end if;
    insert into public.fiskalo_basic_purchase_items(business_id,purchase_id,product_id,quantity,unit_cost)
    values(p_business_id,purchase_uuid,product_uuid,qty,cost);
  end loop;
  return purchase_uuid;
end $$;
revoke all on function public.fiskalo_basic_create_purchase(uuid,text,text,date,text,text,text,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_create_purchase(uuid,text,text,date,text,text,text,jsonb) to authenticated;
