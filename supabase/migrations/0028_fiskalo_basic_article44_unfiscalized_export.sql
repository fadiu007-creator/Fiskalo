-- Article 44 paragraph 6 export must include rejected as well as queued/uncertain
-- offline documents: every offline coupon not accepted by ATK remains un-fiscalized.
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
revoke all on function fiskalo_private.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)
  from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)
  to authenticated;
create or replace function public.fiskalo_basic_article44_unfiscalized_export(
  p_business_id uuid,p_pos_id uuid,p_from timestamptz,p_to timestamptz,
  p_authority_request_reference text,p_limit integer default 5000
) returns jsonb language sql security invoker set search_path=pg_catalog,public,pg_temp as $article44$
  select fiskalo_private.fiskalo_basic_article44_unfiscalized_export(
    p_business_id,p_pos_id,p_from,p_to,p_authority_request_reference,p_limit)
$article44$;
revoke all on function public.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)
  from public,anon;
grant execute on function public.fiskalo_basic_article44_unfiscalized_export(uuid,uuid,timestamptz,timestamptz,text,integer)
  to authenticated;
