-- Article 44 filing records must not accept client-asserted evidence hashes.
-- Verify actual private Storage bytes in the server route, then write through
-- service-role-only RPCs that repeat owner, incident, metadata and deadline checks.

revoke all on function fiskalo_private.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function fiskalo_private.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;

create or replace function fiskalo_private.fiskalo_basic_record_article44_notice_verified(
  p_actor_id uuid,
  p_incident_id uuid,
  p_notice_channel text,
  p_authority_reference text,
  p_evidence_manifest jsonb
) returns void
language plpgsql security definer set search_path='' as $article44$
declare
  caller_id uuid := p_actor_id;
  v_incident public.fiskalo_basic_article44_incidents%rowtype;
  manifest_count integer;
  unique_path_count integer;
  found_file_count integer;
  request_prefix text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Server-side Article 44 evidence verification is required' using errcode='42501';
  end if;
  if caller_id is null then
    raise exception 'Authenticated owner identity is required' using errcode='42501';
  end if;

  select i.* into v_incident
  from public.fiskalo_basic_article44_incidents i
  join public.fiskalo_basic_members m on m.business_id=i.business_id
  where i.id=p_incident_id and m.user_id=caller_id and m.role='owner'
  for update of i;
  if not found then
    raise exception 'Article 44 incident not found or owner access required' using errcode='42501';
  end if;
  if v_incident.notice_submitted_at is not null then
    raise exception 'Article 44 notice is already recorded';
  end if;
  if v_incident.cause not in ('isp_failure','equipment_change','force_majeure') then
    raise exception 'The recorded cause is not one of the Article 44 paragraph 5 notification grounds';
  end if;
  if coalesce(v_incident.restored_at,now()) < v_incident.outage_started_at + interval '48 hours' then
    raise exception 'Article 44 paragraph 5 notice is not required because the connection was restored within 48 hours';
  end if;
  if p_notice_channel is null or p_notice_channel not in ('electronic','in_person') or
     char_length(trim(coalesce(p_authority_reference,''))) > 200 then
    raise exception 'Notice channel or authority reference is invalid';
  end if;
  if p_evidence_manifest is null or jsonb_typeof(p_evidence_manifest) <> 'array' then
    raise exception 'Notice evidence manifest must be an array';
  end if;
  manifest_count := jsonb_array_length(p_evidence_manifest);
  if manifest_count < 1 or manifest_count > 20 or pg_column_size(p_evidence_manifest) > 65536 then
    raise exception 'One to twenty notice evidence files are required';
  end if;

  request_prefix := p_incident_id::text;
  select count(*), count(distinct e->>'storage_path')
    into manifest_count, unique_path_count
  from jsonb_array_elements(p_evidence_manifest) e
  where left(coalesce(e->>'storage_path',''), length(v_incident.business_id::text || '/' || request_prefix || '/'))
          = v_incident.business_id::text || '/' || request_prefix || '/'
    and array_length(string_to_array(coalesce(e->>'storage_path',''),'/'),1) = 3
    and split_part(e->>'storage_path','/',3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,100}$'
    and position('..' in split_part(e->>'storage_path','/',3)) = 0
    and char_length(coalesce(e->>'storage_path','')) <= 512
    and char_length(coalesce(e->>'file_name','')) between 1 and 255
    and coalesce(e->>'file_name','') !~ '[[:cntrl:]]'
    and coalesce(e->>'sha256','') ~ '^[a-f0-9]{64}$'
    and coalesce(e->>'mime_type','') in ('application/pdf','image/jpeg','image/png','text/plain')
    and case when coalesce(e->>'size_bytes','') ~ '^[0-9]+$'
      then (e->>'size_bytes')::bigint between 1 and 10485760 else false end;
  if manifest_count <> jsonb_array_length(p_evidence_manifest) or unique_path_count <> manifest_count then
    raise exception 'Every notice evidence file must have a unique private path, SHA-256 hash, allowed MIME type and valid size';
  end if;

  select count(*) into found_file_count
  from jsonb_array_elements(p_evidence_manifest) e
  join storage.objects o
    on o.bucket_id='fiskalo-article44-evidence'
   and o.name=e->>'storage_path'
  where o.owner_id=caller_id::text
    and lower(coalesce(o.metadata->>'mimetype',''))=lower(e->>'mime_type')
    and coalesce(o.metadata->>'size','') ~ '^[0-9]+$'
    and case when coalesce(o.metadata->>'size','') ~ '^[0-9]+$'
      then (o.metadata->>'size')::bigint=(e->>'size_bytes')::bigint else false end;
  if found_file_count <> manifest_count then
    raise exception 'One or more notice evidence files are missing or their storage metadata does not match';
  end if;

  update public.fiskalo_basic_article44_incidents
    set notice_submitted_at=now(), notice_channel=p_notice_channel,
        authority_reference=nullif(trim(p_authority_reference), ''),
        evidence_manifest=p_evidence_manifest, updated_at=now()
    where id=p_incident_id and business_id=v_incident.business_id;
end;
$article44$;
revoke all on function fiskalo_private.fiskalo_basic_record_article44_notice_verified(uuid,uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.fiskalo_basic_record_article44_notice_verified(
  p_actor_id uuid,
  p_incident_id uuid,
  p_notice_channel text,
  p_authority_reference text,
  p_evidence_manifest jsonb
) returns void
language sql security definer set search_path='' as $article44$
  select fiskalo_private.fiskalo_basic_record_article44_notice_verified(
    p_actor_id,p_incident_id,p_notice_channel,p_authority_reference,p_evidence_manifest)
$article44$;
revoke all on function public.fiskalo_basic_record_article44_notice_verified(uuid,uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.fiskalo_basic_record_article44_notice_verified(uuid,uuid,text,text,jsonb)
  to service_role;

create or replace function fiskalo_private.fiskalo_basic_record_article44_monthly_submission_verified(
  p_actor_id uuid,
  p_incident_id uuid,
  p_submission_channel text,
  p_authority_reference text,
  p_evidence_manifest jsonb
) returns void
language plpgsql security definer set search_path='' as $article44$
declare
  caller_id uuid := p_actor_id;
  v_incident public.fiskalo_basic_article44_incidents%rowtype;
  v_deadline timestamptz;
  manifest_count integer;
  unique_path_count integer;
  found_file_count integer;
  csv_count integer;
  proof_count integer;
  request_prefix text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Server-side Article 44 evidence verification is required' using errcode='42501';
  end if;
  if caller_id is null then
    raise exception 'Authenticated owner identity is required' using errcode='42501';
  end if;

  select i.* into v_incident
  from public.fiskalo_basic_article44_incidents i
  join public.fiskalo_basic_members m on m.business_id=i.business_id
  where i.id=p_incident_id and m.user_id=caller_id and m.role='owner'
  for update of i;
  if not found then
    raise exception 'Article 44 incident not found or owner access required' using errcode='42501';
  end if;
  if v_incident.cause not in ('isp_failure','equipment_change','force_majeure') then
    raise exception 'Article 44 paragraph 6 applies only to the specified internet-interruption grounds';
  end if;
  if v_incident.monthly_export_submitted_at is not null then
    raise exception 'Article 44 monthly un-fiscalized coupon submission is already recorded';
  end if;

  v_deadline := (
    date_trunc('month',v_incident.outage_started_at at time zone 'Europe/Belgrade')
      + interval '1 month' + interval '10 days'
  ) at time zone 'Europe/Belgrade';
  if now() < v_deadline then
    raise exception 'The tenth day of the following month has not yet passed';
  end if;
  if v_incident.restored_at is not null and v_incident.restored_at <= v_deadline then
    raise exception 'The internet connection was restored by the Article 44 paragraph 6 deadline';
  end if;
  if p_submission_channel is null or p_submission_channel not in ('electronic','in_person') or
     char_length(trim(coalesce(p_authority_reference,''))) > 200 then
    raise exception 'Monthly submission channel or authority reference is invalid';
  end if;
  if p_evidence_manifest is null or jsonb_typeof(p_evidence_manifest) <> 'array' then
    raise exception 'Monthly submission evidence manifest must be an array';
  end if;
  manifest_count := jsonb_array_length(p_evidence_manifest);
  if manifest_count < 2 or manifest_count > 20 or pg_column_size(p_evidence_manifest) > 65536 then
    raise exception 'Monthly submission requires a CSV export and delivery evidence';
  end if;

  request_prefix := p_incident_id::text;
  select count(*), count(distinct e->>'storage_path')
    into manifest_count, unique_path_count
  from jsonb_array_elements(p_evidence_manifest) e
  where left(coalesce(e->>'storage_path',''), length(v_incident.business_id::text || '/' || request_prefix || '/'))
          = v_incident.business_id::text || '/' || request_prefix || '/'
    and array_length(string_to_array(coalesce(e->>'storage_path',''),'/'),1) = 3
    and split_part(e->>'storage_path','/',3) ~* '^monthly-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,100}$'
    and position('..' in split_part(e->>'storage_path','/',3)) = 0
    and char_length(coalesce(e->>'storage_path','')) <= 512
    and char_length(coalesce(e->>'file_name','')) between 1 and 255
    and coalesce(e->>'file_name','') !~ '[[:cntrl:]]'
    and coalesce(e->>'sha256','') ~ '^[a-f0-9]{64}$'
    and coalesce(e->>'mime_type','') in ('application/pdf','image/jpeg','image/png','text/plain','application/json','text/csv')
    and case when coalesce(e->>'size_bytes','') ~ '^[0-9]+$'
      then (e->>'size_bytes')::bigint between 1 and 10485760 else false end;
  if manifest_count <> jsonb_array_length(p_evidence_manifest) or unique_path_count <> manifest_count then
    raise exception 'Every monthly evidence file must have a unique private path, SHA-256 hash, allowed MIME type and valid size';
  end if;

  select count(*) filter (where e->>'mime_type'='text/csv'),
         count(*) filter (where e->>'mime_type' in ('application/pdf','image/jpeg','image/png','text/plain'))
    into csv_count, proof_count
  from jsonb_array_elements(p_evidence_manifest) e;
  if csv_count < 1 or proof_count < 1 then
    raise exception 'Monthly submission requires a CSV export and proof of delivery';
  end if;

  select count(*) into found_file_count
  from jsonb_array_elements(p_evidence_manifest) e
  join storage.objects o
    on o.bucket_id='fiskalo-article44-evidence'
   and o.name=e->>'storage_path'
  where o.owner_id=caller_id::text
    and lower(coalesce(o.metadata->>'mimetype',''))=lower(e->>'mime_type')
    and coalesce(o.metadata->>'size','') ~ '^[0-9]+$'
    and case when coalesce(o.metadata->>'size','') ~ '^[0-9]+$'
      then (o.metadata->>'size')::bigint=(e->>'size_bytes')::bigint else false end;
  if found_file_count <> manifest_count then
    raise exception 'One or more monthly evidence files are missing or their storage metadata does not match';
  end if;

  update public.fiskalo_basic_article44_incidents
    set monthly_export_submitted_at=now(), monthly_export_channel=p_submission_channel,
        monthly_export_reference=nullif(trim(p_authority_reference), ''),
        monthly_export_manifest=p_evidence_manifest, updated_at=now()
    where id=p_incident_id and business_id=v_incident.business_id;
end;
$article44$;
revoke all on function fiskalo_private.fiskalo_basic_record_article44_monthly_submission_verified(uuid,uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.fiskalo_basic_record_article44_monthly_submission_verified(
  p_actor_id uuid,
  p_incident_id uuid,
  p_submission_channel text,
  p_authority_reference text,
  p_evidence_manifest jsonb
) returns void
language sql security definer set search_path='' as $article44$
  select fiskalo_private.fiskalo_basic_record_article44_monthly_submission_verified(
    p_actor_id,p_incident_id,p_submission_channel,p_authority_reference,p_evidence_manifest)
$article44$;
revoke all on function public.fiskalo_basic_record_article44_monthly_submission_verified(uuid,uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.fiskalo_basic_record_article44_monthly_submission_verified(uuid,uuid,text,text,jsonb)
  to service_role;

comment on function public.fiskalo_basic_record_article44_notice_verified(uuid,uuid,text,text,jsonb)
  is 'Server-verified Article 44(5) filing evidence; service-role only.';
comment on function public.fiskalo_basic_record_article44_monthly_submission_verified(uuid,uuid,text,text,jsonb)
  is 'Server-verified Article 44(6) filing evidence; service-role only.';
