-- Restrict Article 44(6) workflows to eligible internet interruptions and
-- re-check immutable offline totals during idempotent mixed-tender synchronization.
create or replace function fiskalo_private.fiskalo_basic_record_article44_monthly_submission(
  p_incident_id uuid,p_submission_channel text,p_authority_reference text,p_evidence_manifest jsonb
) returns void language plpgsql security definer set search_path='' as $article44$
declare
  v_incident public.fiskalo_basic_article44_incidents%rowtype;
  v_deadline timestamptz;
  v_count integer;
  v_found integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select i.* into v_incident from public.fiskalo_basic_article44_incidents i
    join public.fiskalo_basic_members m on m.business_id=i.business_id
    where i.id=p_incident_id and m.user_id=auth.uid() and m.role='owner'
    for update of i;
  if not found then raise exception 'Article 44 incident not found or owner access required'; end if;
  if v_incident.cause not in ('isp_failure','equipment_change','force_majeure') then
    raise exception 'Article 44 paragraph 6 monthly export applies to internet connection interruptions covered by the specified grounds';
  end if;
  if v_incident.monthly_export_submitted_at is not null then
    raise exception 'Article 44 monthly un-fiscalized coupon submission is already recorded';
  end if;
  v_deadline:=(
    date_trunc('month',v_incident.outage_started_at at time zone 'Europe/Belgrade')
      + interval '1 month' + interval '10 days'
  ) at time zone 'Europe/Belgrade';
  if now()<v_deadline then raise exception 'The tenth day of the following month has not yet passed'; end if;
  if v_incident.restored_at is not null and v_incident.restored_at<=v_deadline then
    raise exception 'The internet connection was restored by the Article 44 paragraph 6 deadline';
  end if;
  if p_submission_channel not in ('electronic','in_person') or
     length(trim(coalesce(p_authority_reference,'')))>200 or
     jsonb_typeof(p_evidence_manifest)<>'array' or
     jsonb_array_length(p_evidence_manifest)<1 or jsonb_array_length(p_evidence_manifest)>20 or
     pg_column_size(p_evidence_manifest)>65536 then
    raise exception 'Monthly submission channel, reference or evidence manifest is invalid';
  end if;
  select count(*) into v_count from jsonb_array_elements(p_evidence_manifest) e
    where coalesce(e->>'storage_path','') like v_incident.business_id::text||'/'||v_incident.id::text||'/%'
      and coalesce(e->>'sha256','') ~ '^[a-f0-9]{64}$'
      and coalesce(e->>'mime_type','') in ('application/pdf','image/jpeg','image/png','text/plain','application/json','text/csv')
      and coalesce((e->>'size_bytes')::bigint,0) between 1 and 10485760;
  if v_count<>jsonb_array_length(p_evidence_manifest) then
    raise exception 'Every monthly export evidence item must have a valid private storage path, SHA-256 hash, MIME type and size';
  end if;
  select count(*) into v_found from storage.objects o
    where o.bucket_id='fiskalo-article44-evidence'
      and o.name in (select e->>'storage_path' from jsonb_array_elements(p_evidence_manifest) e);
  if v_found<>v_count then raise exception 'One or more monthly export evidence files are missing from private storage'; end if;
  update public.fiskalo_basic_article44_incidents
    set monthly_export_submitted_at=now(),monthly_export_channel=p_submission_channel,
        monthly_export_reference=nullif(trim(p_authority_reference),''),
        monthly_export_manifest=p_evidence_manifest,updated_at=now()
    where id=p_incident_id;
end;
$article44$;

create or replace function fiskalo_private.fiskalo_basic_article44_unfiscalized_export(
  p_business_id uuid,p_pos_id uuid,p_from timestamptz,p_to timestamptz,
  p_authority_request_reference text,p_limit integer default 5000
) returns jsonb language plpgsql security definer set search_path='' as $article44$
declare
  caller_id uuid:=auth.uid();
  result jsonb;
  row_count integer;
begin
  if caller_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_business_id is null or p_pos_id is null or p_from is null or p_to is null or p_to<=p_from then
    raise exception 'Business, POS and valid offline date range are required';
  end if;
  if char_length(trim(coalesce(p_authority_request_reference,'')))<3 or
     char_length(trim(coalesce(p_authority_request_reference,'')))>100 then
    raise exception 'An ATK/authority request reference is required for this export';
  end if;
  if p_limit is null or p_limit<1 or p_limit>5000 then raise exception 'Export limit must be between 1 and 5000'; end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=caller_id and m.role='owner') then
    raise exception 'Only a business owner can export Article 44 offline fiscal documents' using errcode='42501';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_id and p.business_id=p_business_id) then
    raise exception 'POS does not belong to this business';
  end if;
  if not exists(select 1 from public.fiskalo_basic_article44_incidents i
    where i.business_id=p_business_id and i.pos_id=p_pos_id and i.outage_started_at=p_from
      and i.cause in ('isp_failure','equipment_change','force_majeure')) then
    raise exception 'Export range is not linked to an eligible Article 44 internet interruption';
  end if;
  with candidates as materialized (
    select d.id,d.business_id,d.sale_id,d.coupon_id,d.document_type,d.reference_coupon_id,
      d.signed_payload,d.signature,d.citizen_payload,d.citizen_signature,d.nui_kf,
      d.daily_number,d.offline_issued_at,d.recovery_deadline_at,d.submission_state,
      d.atk_response,d.atk_transaction_id,d.created_at,d.last_error,d.attempt_count,
      s.created_at as sale_created_at,s.total,b.name as business_name,b.nui,
      p.label as pos_label,p.branch_id,p.pos_id as atk_pos_id,p.fiscalization_number
    from public.fiskalo_basic_fiscal_documents d
    join public.fiskalo_basic_sales s on s.id=d.sale_id and s.business_id=d.business_id
    join public.fiskalo_basic_businesses b on b.id=d.business_id
    join public.fiskalo_basic_pos p on p.id=s.pos_id and p.business_id=s.business_id
    where d.business_id=p_business_id and s.pos_id=p_pos_id
      and d.offline_issued_at is not null
      and d.offline_issued_at>=p_from and d.offline_issued_at<p_to
      and d.submission_state<>'accepted'
    order by d.offline_issued_at,d.created_at,d.id limit p_limit
  ), total_count as (
    select count(*)::integer as value
    from public.fiskalo_basic_fiscal_documents d
    join public.fiskalo_basic_sales s on s.id=d.sale_id and s.business_id=d.business_id
    where d.business_id=p_business_id and s.pos_id=p_pos_id
      and d.offline_issued_at is not null
      and d.offline_issued_at>=p_from and d.offline_issued_at<p_to
      and d.submission_state<>'accepted'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'fiscal_document_id',c.id,'sale_id',c.sale_id,'coupon_id',c.coupon_id::text,
      'document_type',c.document_type,'reference_coupon_id',c.reference_coupon_id::text,
      'business_name',c.business_name,'nui',c.nui,'pos_label',c.pos_label,
      'branch_id',c.branch_id::text,'pos_id',c.atk_pos_id::text,
      'fiscalization_number',c.fiscalization_number,'sale_created_at',c.sale_created_at,
      'document_created_at',c.created_at,'total',c.total,'submission_state',c.submission_state,
      'nui_kf',c.nui_kf,'daily_number',c.daily_number,'offline_issued_at',c.offline_issued_at,
      'recovery_deadline_at',c.recovery_deadline_at,'atk_transaction_id',c.atk_transaction_id::text,
      'signed_payload',c.signed_payload,'signature',c.signature,
      'citizen_payload',c.citizen_payload,'citizen_signature',c.citizen_signature,
      'atk_response',c.atk_response,'last_error',c.last_error,'attempt_count',c.attempt_count
    ) order by c.offline_issued_at,c.created_at,c.id) filter(where c.id is not null),'[]'::jsonb),
    total_count.value
  into result,row_count from total_count left join candidates c on true group by total_count.value;

  insert into fiskalo_private.fiskalo_basic_authority_exports(
    business_id,requested_by,authority_request_reference,document_count
  ) values(p_business_id,caller_id,trim(p_authority_request_reference),jsonb_array_length(result));

  return jsonb_build_object('documents',result,'count',jsonb_array_length(result),
    'total_count',row_count,'truncated',row_count>p_limit,
    'authority_request_reference',trim(p_authority_request_reference),'exported_at',now());
end;
$article44$;

create or replace function fiskalo_private.fiskalo_basic_sync_offline_sale_with_allocations(
  p_business_id uuid,p_pos_id uuid,p_lines jsonb,p_checkout_idempotency_key uuid,
  p_coupon_id bigint,p_daily_number bigint,p_business_date date,p_operator_id uuid,
  p_operator_name text,p_operator_identifier text,p_expected_snapshot jsonb,
  p_created_at timestamptz,p_payment_allocations jsonb
) returns uuid language plpgsql security definer set search_path='' as $payments$
declare
  v_existing public.fiskalo_basic_sales%rowtype;
  v_sale_id uuid;
  v_total_cents bigint;
  v_allocations jsonb;
  v_payment_method text;
  v_normalized_lines jsonb;
  v_snapshot_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_checkout_idempotency_key is null or p_coupon_id is null or p_daily_number is null or
     p_business_date is null or p_created_at is null or p_expected_snapshot is null or
     jsonb_typeof(p_expected_snapshot)<>'array' then
    raise exception 'Offline checkout identity and immutable snapshot are required';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid()) then raise exception 'Not a member of this business'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',x.product_id,'quantity',x.quantity) order by x.product_id),'[]'::jsonb)
    into v_normalized_lines
  from (select q.product_id,sum(q.quantity)::numeric(12,3) quantity
    from jsonb_to_recordset(p_lines) as q(product_id uuid,quantity numeric)
    group by q.product_id) x;
  select count(*) into v_snapshot_count from jsonb_to_recordset(p_expected_snapshot) as x(
    product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
    atk_unit_code text,atk_item_category_code text,atk_vat_code text,
    line_net numeric,line_vat numeric,line_total numeric
  );
  if v_snapshot_count<>jsonb_array_length(v_normalized_lines) or exists(
    select 1 from jsonb_to_recordset(v_normalized_lines) as q(product_id uuid,quantity numeric)
    full join jsonb_to_recordset(p_expected_snapshot) as x(
      product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
      atk_unit_code text,atk_item_category_code text,atk_vat_code text,
      line_net numeric,line_vat numeric,line_total numeric
    ) using(product_id)
    where q.product_id is null or x.product_id is null or q.quantity is distinct from x.quantity
  ) then raise exception 'Offline snapshot and checkout request line identities differ'; end if;
  select coalesce(sum(x.line_total*100),0)::bigint into v_total_cents
    from jsonb_to_recordset(p_expected_snapshot) as x(line_total numeric);
  v_allocations:=fiskalo_private.fiskalo_basic_normalize_payment_allocations(v_total_cents,p_payment_allocations);
  v_payment_method:=case when jsonb_array_length(v_allocations)=1 then v_allocations->0->>'method' else 'mixed' end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text||':'||p_checkout_idempotency_key::text,0)
  );
  select * into v_existing from public.fiskalo_basic_sales s
    where s.business_id=p_business_id and s.checkout_idempotency_key=p_checkout_idempotency_key for update;
  if found then
    if v_existing.pos_id<>p_pos_id or v_existing.coupon_id<>p_coupon_id or
       v_existing.daily_number<>p_daily_number or v_existing.operator_id<>p_operator_id or
       v_existing.operator_name<>trim(p_operator_name) or
       v_existing.operator_identifier<>trim(p_operator_identifier) or
       v_existing.created_at<>p_created_at or
       round(v_existing.total*100)::bigint<>v_total_cents or
       v_existing.checkout_request_lines is distinct from v_normalized_lines or
       (v_existing.payment_allocations is not null and
         (v_existing.payment_allocations is distinct from v_allocations or v_existing.payment_method<>v_payment_method)) or
       (v_existing.payment_allocations is null and v_existing.payment_method<>v_payment_method) then
      raise exception 'Offline checkout key already exists with different fiscal identity or payment allocation';
    end if;
    if exists(
      select 1 from jsonb_to_recordset(p_expected_snapshot) as x(
        product_id uuid,quantity numeric,description text,unit_price numeric,vat_rate numeric,
        atk_unit_code text,atk_item_category_code text,atk_vat_code text,
        line_net numeric,line_vat numeric,line_total numeric
      )
      left join public.fiskalo_basic_sale_items i on i.sale_id=v_existing.id and i.product_id=x.product_id
      where i.id is null or i.quantity is distinct from x.quantity or i.description is distinct from x.description or
        i.unit_price is distinct from x.unit_price or i.vat_rate is distinct from x.vat_rate or
        i.atk_unit_code is distinct from x.atk_unit_code or i.atk_item_category_code is distinct from x.atk_item_category_code or
        i.atk_vat_code is distinct from x.atk_vat_code or i.line_net is distinct from x.line_net or
        i.line_vat is distinct from x.line_vat or i.line_total is distinct from x.line_total
    ) then raise exception 'Offline checkout key was retried with different immutable line data'; end if;
    update public.fiskalo_basic_sales set payment_method=v_payment_method,payment_allocations=v_allocations
      where id=v_existing.id;
    return v_existing.id;
  end if;

  v_sale_id:=fiskalo_private.fiskalo_basic_sync_offline_sale(
    p_business_id,p_pos_id,'cash',p_lines,p_checkout_idempotency_key,p_coupon_id,
    p_daily_number,p_business_date,p_operator_id,p_operator_name,p_operator_identifier,
    p_expected_snapshot,p_created_at
  );
  update public.fiskalo_basic_sales set payment_method=v_payment_method,payment_allocations=v_allocations
    where id=v_sale_id;
  return v_sale_id;
end;
$payments$;
