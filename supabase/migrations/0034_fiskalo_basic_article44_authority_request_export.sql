-- This audit table existed in the connected project but was absent from the
-- clean-install migration chain. Define its complete baseline before extending it.
create schema if not exists fiskalo_private;
create table if not exists fiskalo_private.fiskalo_basic_authority_exports (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  authority_request_reference text not null
    check (char_length(trim(authority_request_reference)) between 3 and 100),
  document_count integer not null check (document_count >= 0),
  created_at timestamptz not null default now(),
  incident_id uuid references public.fiskalo_basic_article44_incidents(id) on delete restrict,
  authority_request_evidence_manifest jsonb not null default '[]'::jsonb
    check (jsonb_typeof(authority_request_evidence_manifest) = 'array'
      and jsonb_array_length(authority_request_evidence_manifest) <= 20)
);
revoke all on table fiskalo_private.fiskalo_basic_authority_exports from public, anon, authenticated;

-- Restrict untransmitted fiscal-data exports to documented ATK/state-authority requests.
-- The 22 June 2026 ATK technical-specification amendment requires CSV/PDF export
-- of untransmitted data only upon request by ATK or another state authority.
alter table fiskalo_private.fiskalo_basic_authority_exports
  add column if not exists incident_id uuid
    references public.fiskalo_basic_article44_incidents(id) on delete restrict,
  add column if not exists authority_request_evidence_manifest jsonb not null default '[]'::jsonb;

alter table fiskalo_private.fiskalo_basic_authority_exports
  drop constraint if exists fiskalo_basic_authority_exports_request_evidence_array;
alter table fiskalo_private.fiskalo_basic_authority_exports
  add constraint fiskalo_basic_authority_exports_request_evidence_array
  check (jsonb_typeof(authority_request_evidence_manifest) = 'array'
    and jsonb_array_length(authority_request_evidence_manifest) <= 20);

create index if not exists fiskalo_basic_authority_exports_incident_idx
  on fiskalo_private.fiskalo_basic_authority_exports(incident_id, created_at desc)
  where incident_id is not null;

-- Disable the former signature, which accepted a free-form reference without
-- evidence and could therefore be called with a fabricated reference.
revoke all on function fiskalo_private.fiskalo_basic_article44_unfiscalized_export(
  uuid,uuid,timestamptz,timestamptz,text,integer
) from public, anon, authenticated;
revoke all on function public.fiskalo_basic_article44_unfiscalized_export(
  uuid,uuid,timestamptz,timestamptz,text,integer
) from public, anon, authenticated;

-- A historical migration in the connected project exposed a second, older
-- untransmitted-data export RPC that accepted only a caller-supplied reference.
-- It is not part of the clean-install chain, so revoke it conditionally when present.
do $legacy_untransmitted$
declare
  private_export regprocedure := to_regprocedure(
    'fiskalo_private.fiskalo_basic_untransmitted_export(uuid,timestamptz,timestamptz,text,integer)'
  );
  public_export regprocedure := to_regprocedure(
    'public.fiskalo_basic_untransmitted_export(uuid,timestamptz,timestamptz,text,integer)'
  );
begin
  if private_export is not null then
    execute format('revoke all on function %s from public, anon, authenticated', private_export);
  end if;
  if public_export is not null then
    execute format('revoke all on function %s from public, anon, authenticated', public_export);
  end if;
end;
$legacy_untransmitted$;

-- Do not expose untransmitted fiscal payloads through direct PostgREST table reads.
-- The Article 44 RPC above is the only client path for those documents and is
-- owner-scoped, authority-request-bound, and evidence-gated.
alter table public.fiskalo_basic_fiscal_documents enable row level security;
drop policy if exists fiskalo_basic_fiscal_access on public.fiskalo_basic_fiscal_documents;
create policy fiskalo_basic_fiscal_access
  on public.fiskalo_basic_fiscal_documents
  for select
  to authenticated
  using (
    submission_state = 'accepted'
    and exists (
      select 1
      from public.fiskalo_basic_members m
      where m.business_id = fiskalo_basic_fiscal_documents.business_id
        and m.user_id = auth.uid()
    )
  );

-- The browser must never invoke the export RPC directly. The server route
-- downloads each private evidence object and verifies its SHA-256 bytes first.
drop function if exists public.fiskalo_basic_article44_unfiscalized_export(
  uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb,integer
);
drop function if exists fiskalo_private.fiskalo_basic_article44_unfiscalized_export(
  uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb,integer
);

create or replace function fiskalo_private.fiskalo_basic_article44_unfiscalized_export(
  p_actor_id uuid,
  p_incident_id uuid,
  p_business_id uuid,
  p_pos_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_authority_request_reference text,
  p_authority_request_evidence_manifest jsonb,
  p_limit integer default 5000
) returns jsonb language plpgsql security definer set search_path='' as $article44$
declare
  caller_id uuid := p_actor_id;
  v_incident public.fiskalo_basic_article44_incidents%rowtype;
  result jsonb;
  row_count integer;
  manifest_count integer;
  unique_path_count integer;
  found_file_count integer;
  request_prefix text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Server-side evidence verification is required' using errcode='42501';
  end if;
  if caller_id is null then
    raise exception 'Authenticated owner identity is required' using errcode='42501';
  end if;
  if p_business_id is null or p_pos_id is null or p_incident_id is null or
     p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Business, POS, incident and valid offline date range are required';
  end if;
  select i.* into v_incident
  from public.fiskalo_basic_article44_incidents i
  join public.fiskalo_basic_members m on m.business_id=i.business_id
  where i.id=p_incident_id and i.business_id=p_business_id and i.pos_id=p_pos_id
    and i.outage_started_at=p_from
    and i.cause in ('isp_failure','equipment_change','force_majeure')
    and m.user_id=caller_id and m.role='owner'
  for update of i;
  if not found then
    raise exception 'Eligible Article 44 incident not found or owner access required' using errcode='42501';
  end if;
  if p_to > coalesce(v_incident.restored_at, now()) then
    raise exception 'Export end time exceeds the incident restoration/current time';
  end if;
  if char_length(trim(coalesce(p_authority_request_reference,''))) < 3 or
     char_length(trim(coalesce(p_authority_request_reference,''))) > 100 then
    raise exception 'A real ATK/state-authority request reference is required';
  end if;
  if coalesce(jsonb_typeof(p_authority_request_evidence_manifest),'null') <> 'array' then
    raise exception 'Authority request evidence manifest must be an array';
  end if;
  manifest_count := jsonb_array_length(p_authority_request_evidence_manifest);
  if manifest_count < 1 or manifest_count > 20 or
     pg_column_size(p_authority_request_evidence_manifest) > 65536 then
    raise exception 'One to twenty authority request evidence files are required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'Export limit must be between 1 and 5000';
  end if;

  request_prefix := p_business_id::text || '/' || p_incident_id::text || '/authority-request-';
  select count(*), count(distinct e->>'storage_path')
    into manifest_count, unique_path_count
  from jsonb_array_elements(p_authority_request_evidence_manifest) e
  where left(coalesce(e->>'storage_path',''), length(request_prefix)) = request_prefix
    and coalesce(e->>'sha256','') ~ '^[a-f0-9]{64}$'
    and coalesce(e->>'mime_type','') in ('application/pdf','image/jpeg','image/png','text/plain')
    and case when coalesce(e->>'size_bytes','') ~ '^[0-9]+$'
      then (e->>'size_bytes')::bigint between 1 and 10485760 else false end;
  if manifest_count <> jsonb_array_length(p_authority_request_evidence_manifest) or
     unique_path_count <> manifest_count then
    raise exception 'Every authority request file must have a unique private path, SHA-256 hash, allowed MIME type and valid size';
  end if;
  select count(*) into found_file_count
  from jsonb_array_elements(p_authority_request_evidence_manifest) e
  join storage.objects o
    on o.bucket_id='fiskalo-article44-evidence'
   and o.name=e->>'storage_path'
  where o.owner_id=caller_id::text
    and lower(coalesce(o.metadata->>'mimetype',''))=lower(e->>'mime_type')
    and coalesce(o.metadata->>'size','') ~ '^[0-9]+$'
    and (o.metadata->>'size')::bigint=(e->>'size_bytes')::bigint;
  if found_file_count <> manifest_count then
    raise exception 'One or more authority request evidence files are missing from private storage';
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
      and d.offline_issued_at >= p_from and d.offline_issued_at < p_to
      and d.submission_state <> 'accepted'
    order by d.offline_issued_at,d.created_at,d.id
    limit p_limit
  ), total_count as (
    select count(*)::integer as value
    from public.fiskalo_basic_fiscal_documents d
    join public.fiskalo_basic_sales s on s.id=d.sale_id and s.business_id=d.business_id
    where d.business_id=p_business_id and s.pos_id=p_pos_id
      and d.offline_issued_at is not null
      and d.offline_issued_at >= p_from and d.offline_issued_at < p_to
      and d.submission_state <> 'accepted'
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
  into result,row_count
  from total_count left join candidates c on true
  group by total_count.value;

  if row_count > p_limit then
    raise exception 'Export exceeds the 5,000 document limit; narrow the incident period before retrying';
  end if;

  insert into fiskalo_private.fiskalo_basic_authority_exports(
    business_id,requested_by,authority_request_reference,document_count,
    incident_id,authority_request_evidence_manifest
  ) values(
    p_business_id,caller_id,trim(p_authority_request_reference),jsonb_array_length(result),
    p_incident_id,p_authority_request_evidence_manifest
  );

  return jsonb_build_object('documents',result,'count',jsonb_array_length(result),
    'total_count',row_count,'truncated',false,
    'authority_request_reference',trim(p_authority_request_reference),'exported_at',now());
end;
$article44$;
revoke all on function fiskalo_private.fiskalo_basic_article44_unfiscalized_export(
  uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb,integer
) from public, anon, authenticated, service_role;

create or replace function public.fiskalo_basic_article44_unfiscalized_export(
  p_actor_id uuid,
  p_incident_id uuid,
  p_business_id uuid,
  p_pos_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_authority_request_reference text,
  p_authority_request_evidence_manifest jsonb,
  p_limit integer default 5000
) returns jsonb language sql security definer set search_path=pg_catalog,public,pg_temp as $article44$
  select fiskalo_private.fiskalo_basic_article44_unfiscalized_export(
    p_actor_id,p_incident_id,p_business_id,p_pos_id,p_from,p_to,
    p_authority_request_reference,p_authority_request_evidence_manifest,p_limit)
$article44$;
revoke all on function public.fiskalo_basic_article44_unfiscalized_export(
  uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb,integer
) from public, anon, authenticated;
grant execute on function public.fiskalo_basic_article44_unfiscalized_export(
  uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb,integer
) to service_role;
