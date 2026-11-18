-- Version-matched contract for the owner-only, read-only sales report.
begin;

do $$
declare
  private_oid oid;
  public_oid oid;
  private_definition text;
  public_is_definer boolean;
  owner_id uuid := '11111111-1111-4111-8111-111111111111';
  other_id uuid := '22222222-2222-4222-8222-222222222222';
  owner_business uuid := '33333333-3333-4333-8333-333333333333';
  other_business uuid := '44444444-4444-4444-8444-444444444444';
  report_pos uuid := '55555555-5555-4555-8555-555555555555';
  report_product uuid := '66666666-6666-4666-8666-666666666666';
  report_sale uuid := '77777777-7777-4777-8777-777777777777';
  report_result jsonb;
begin
  private_oid := to_regprocedure(
    'fiskalo_private.fiskalo_basic_sales_report(uuid,timestamptz,timestamptz,integer)'
  );
  public_oid := to_regprocedure(
    'public.fiskalo_basic_sales_report(uuid,timestamptz,timestamptz,integer)'
  );
  if private_oid is null or public_oid is null then
    raise exception 'Owner-scoped sales report functions are missing';
  end if;

  if not has_function_privilege('authenticated', public_oid, 'EXECUTE') or
     has_function_privilege('anon', public_oid, 'EXECUTE') then
    raise exception 'Public sales report wrapper permissions are incorrect';
  end if;
  if has_function_privilege('authenticated', private_oid, 'EXECUTE') or
     has_function_privilege('anon', private_oid, 'EXECUTE') then
    raise exception 'Private report helper must not be directly executable by API roles';
  end if;

  select p.prosecdef into public_is_definer
  from pg_catalog.pg_proc p where p.oid = public_oid;
  if not coalesce(public_is_definer, false) then
    raise exception 'Public report wrapper must use SECURITY DEFINER';
  end if;

  select pg_catalog.pg_get_functiondef(private_oid) into private_definition;
  if position('m.role = ''owner''' in private_definition) = 0 or
     position('p_limit > 5000' in private_definition) = 0 or
     position('p_from' in private_definition) = 0 or
     position('p_to' in private_definition) = 0 or
     position('payment_allocations' in lower(private_definition)) = 0 or
     position('d.atk_transaction_id::text' in lower(private_definition)) = 0 or
     position('accepted_corrections' in lower(private_definition)) = 0 or
     position('reference_coupon_id' in lower(private_definition)) = 0 or
     position('line_vat' in lower(private_definition)) = 0 then
    raise exception 'Private report helper must enforce owner membership, date range, limit and fiscal transaction identity';
  end if;
  if position('update public.fiskalo_basic_sales' in lower(private_definition)) > 0 or
     position('delete from public.fiskalo_basic_sales' in lower(private_definition)) > 0 then
    raise exception 'Sales report helper must remain read-only';
  end if;

  insert into auth.users(id,email) values
    (owner_id,'report-owner@example.invalid'),
    (other_id,'report-other@example.invalid');
  insert into public.fiskalo_basic_businesses(id,name,nui,created_by) values
    (owner_business,'Report Owner Business','111111111',owner_id),
    (other_business,'Report Other Business','222222222',other_id);
  insert into public.fiskalo_basic_members(business_id,user_id,role) values
    (owner_business,owner_id,'owner'),
    (other_business,other_id,'owner');

  insert into public.fiskalo_basic_pos(id,business_id,label,location,branch_id,pos_id,fiscalization_number)
  values(report_pos,owner_business,'Report POS','Prishtinë',1,1,'REPORT-TEST');
  insert into public.fiskalo_basic_products(
    id,business_id,name,price,stock,atk_unit_code,atk_item_category_code,atk_vat_code,vat_rate
  ) values(report_product,owner_business,'Report item',10,1,'CP','TT','E',18);
  insert into public.fiskalo_basic_sales(
    id,business_id,pos_id,coupon_id,operator_id,operator_name,operator_identifier,
    status,subtotal,vat_total,total,payment_method,created_at
  ) values(
    report_sale,owner_business,report_pos,900001,owner_id,'Report Operator','REPORT-OP-1',
    'fiscalized',10,1.80,11.80,'cash','2026-11-18T08:00:00Z'::timestamptz
  );
  insert into public.fiskalo_basic_sale_items(
    sale_id,product_id,description,quantity,unit_price,vat_rate,atk_unit_code,
    atk_item_category_code,atk_vat_code,line_net,line_vat,line_total
  ) values(
    report_sale,report_product,'Report item',1,10,18,'CP','TT','E',10,1.80,11.80
  );
  insert into public.fiskalo_basic_fiscal_documents(
    business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,
    signed_payload,signature,atk_transaction_id,submission_state
  ) values
    (owner_business,report_sale,900001,'report-test-original',1,null,'original-payload','original-signature',1000,'accepted'),
    (owner_business,report_sale,900002,'report-test-return',3,900001,'return-payload','return-signature',1001,'accepted');

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  report_result := public.fiskalo_basic_sales_report(
    owner_business, '2026-11-01T00:00:00Z'::timestamptz,
    '2026-12-01T00:00:00Z'::timestamptz, 5000
  );
  if pg_catalog.jsonb_array_length(report_result->'sales') <> 1 or
     pg_catalog.jsonb_array_length(report_result->'items') <> 1 or
     pg_catalog.jsonb_array_length(report_result->'documents') <> 2 or
     report_result->>'truncated' <> 'false' then
    raise exception 'Owner report must return the selected sale, VAT group, fiscal documents and truncation state';
  end if;
  if (report_result->'items'->0->>'line_net')::numeric <> -10.00 or
     (report_result->'items'->0->>'line_vat')::numeric <> -1.80 or
     (report_result->'items'->0->>'line_total')::numeric <> -11.80 then
    raise exception 'Accepted full ATK returns must reverse the original VAT-code group amounts';
  end if;
  if (report_result->'sales'->0->>'total')::numeric <> 11.80 or
     (report_result->'sales'->0->>'item_count')::integer <> 1 then
    raise exception 'Original sale record and line count must remain intact for audit';
  end if;

  perform set_config('request.jwt.claim.sub', other_id::text, true);
  begin
    perform public.fiskalo_basic_sales_report(
      owner_business, '2026-11-01T00:00:00Z'::timestamptz,
      '2026-12-01T00:00:00Z'::timestamptz, 5000
    );
    raise exception 'A different business owner must not read this business report';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  begin
    perform public.fiskalo_basic_sales_report(
      owner_business, '2026-12-01T00:00:00Z'::timestamptz,
      '2026-11-01T00:00:00Z'::timestamptz, 5000
    );
    raise exception 'A reversed report date range must be rejected';
  exception when sqlstate '22023' then
    null;
  end;
end
$$;

rollback;
