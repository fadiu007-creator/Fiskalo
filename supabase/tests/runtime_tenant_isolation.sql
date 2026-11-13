-- Runtime tenant-isolation and checkout-idempotency regression test.
-- Runs only in the disposable PostgreSQL CI database; all fixtures are rolled back.
BEGIN;

INSERT INTO auth.users (id,email) VALUES
  ('10000000-0000-4000-8000-000000000001','owner-a@example.invalid'),
  ('10000000-0000-4000-8000-000000000002','cashier-a@example.invalid'),
  ('20000000-0000-4000-8000-000000000001','owner-b@example.invalid');

INSERT INTO public.fiskalo_basic_businesses (id,name,nui,created_by) VALUES
  ('30000000-0000-4000-8000-000000000001','Tenant A','111111111','10000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000002','Tenant B','222222222','20000000-0000-4000-8000-000000000001');

INSERT INTO public.fiskalo_basic_members
  (business_id,user_id,role,operator_name,operator_identifier) VALUES
  ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner','Owner A','OA-1'),
  ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','cashier','Cashier A','CA-1'),
  ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','owner','Owner B','OB-1');

INSERT INTO public.fiskalo_basic_pos
  (id,business_id,label,location,branch_id,pos_id,fiscalization_number,application_id)
VALUES
  ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','A POS','Prishtine',1,1,'TEST-A','1'),
  ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','B POS','Prizren',1,1,'TEST-B','1');

INSERT INTO public.fiskalo_basic_products
  (id,business_id,name,price,stock,atk_unit_code,atk_item_category_code,atk_vat_code,vat_rate)
VALUES
  ('50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','A product',10,10,'TEST_UNIT','TEST_CATEGORY','E',18),
  ('50000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','B product',5,10,'TEST_UNIT','TEST_CATEGORY','E',18);

-- Owner A can see and manage Tenant A, but cannot see or write Tenant B.
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_count integer;
  v_rejected boolean := false;
BEGIN
  SELECT count(*) INTO v_count FROM public.fiskalo_basic_businesses;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Owner A must see exactly one business, got %',v_count; END IF;
  SELECT count(*) INTO v_count FROM public.fiskalo_basic_products
    WHERE business_id='30000000-0000-4000-8000-000000000002';
  IF v_count <> 0 THEN RAISE EXCEPTION 'Owner A can read Tenant B products'; END IF;

  INSERT INTO public.fiskalo_basic_products
    (business_id,name,price,stock,atk_unit_code,atk_item_category_code,atk_vat_code,vat_rate)
  VALUES
    ('30000000-0000-4000-8000-000000000001','Owner-created product',2,5,'TEST_UNIT','TEST_CATEGORY','E',18);

  BEGIN
    INSERT INTO public.fiskalo_basic_products
      (business_id,name,price,stock,atk_unit_code,atk_item_category_code,atk_vat_code,vat_rate)
    VALUES
      ('30000000-0000-4000-8000-000000000002','Cross-tenant product',2,5,'TEST_UNIT','TEST_CATEGORY','E',18);
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Owner A inserted a product into Tenant B'; END IF;
END
$$;
RESET ROLE;

-- Cashier A can use the POS and checkout RPC, but cannot manage catalogue/POS
-- records, write sales directly, or read another tenant.
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_count integer;
  v_rows integer;
  v_sale uuid;
  v_retry uuid;
  v_stock numeric;
  v_failed boolean := false;
BEGIN
  SELECT count(*) INTO v_count FROM public.fiskalo_basic_products;
  IF v_count <> 2 THEN RAISE EXCEPTION 'Cashier A must see only Tenant A products, got %',v_count; END IF;
  SELECT count(*) INTO v_count FROM public.fiskalo_basic_businesses;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Cashier A must see only Tenant A business, got %',v_count; END IF;

  UPDATE public.fiskalo_basic_products SET price=99
    WHERE id='50000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'Cashier A updated an owner-only product'; END IF;

  BEGIN
    INSERT INTO public.fiskalo_basic_products
      (business_id,name,price,stock,atk_unit_code,atk_item_category_code,atk_vat_code,vat_rate)
    VALUES
      ('30000000-0000-4000-8000-000000000001','Cashier-created product',1,1,'TEST_UNIT','TEST_CATEGORY','E',18);
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Cashier A inserted an owner-only product'; END IF;

  v_failed := false;
  BEGIN
    INSERT INTO public.fiskalo_basic_sales (id)
      VALUES (gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Cashier A inserted a sale outside the checkout RPC'; END IF;

  v_sale := public.fiskalo_basic_create_sale(
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'cash',
    jsonb_build_array(jsonb_build_object(
      'product_id','50000000-0000-4000-8000-000000000001',
      'quantity',1
    )),
    '60000000-0000-4000-8000-000000000001'
  );
  v_retry := public.fiskalo_basic_create_sale(
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'cash',
    jsonb_build_array(jsonb_build_object(
      'product_id','50000000-0000-4000-8000-000000000001',
      'quantity',1
    )),
    '60000000-0000-4000-8000-000000000001'
  );
  IF v_sale IS DISTINCT FROM v_retry THEN
    RAISE EXCEPTION 'Identical checkout retry created a different sale';
  END IF;

  SELECT stock INTO v_stock FROM public.fiskalo_basic_products
    WHERE id='50000000-0000-4000-8000-000000000001';
  IF v_stock <> 9 THEN
    RAISE EXCEPTION 'Idempotent checkout must decrement stock once; expected 9, got %',v_stock;
  END IF;

  SELECT count(*) INTO v_count FROM public.fiskalo_basic_sales
    WHERE business_id='30000000-0000-4000-8000-000000000001';
  IF v_count <> 1 THEN RAISE EXCEPTION 'Identical retry must persist exactly one sale, got %',v_count; END IF;

  v_failed := false;
  BEGIN
    PERFORM public.fiskalo_basic_create_sale(
      '30000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      'cash',
      jsonb_build_array(jsonb_build_object(
        'product_id','50000000-0000-4000-8000-000000000002',
        'quantity',1
      )),
      '60000000-0000-4000-8000-000000000001'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Checkout accepted an idempotency key with different request content'; END IF;

  v_failed := false;
  BEGIN
    PERFORM public.fiskalo_basic_create_sale(
      '30000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000002',
      'cash',
      jsonb_build_array(jsonb_build_object(
        'product_id','50000000-0000-4000-8000-000000000002',
        'quantity',1
      )),
      '60000000-0000-4000-8000-000000000002'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'Cashier A created a sale in Tenant B'; END IF;
END
$$;

ROLLBACK;
