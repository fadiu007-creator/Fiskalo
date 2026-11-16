-- Treat restoration at exactly midnight after the tenth as after the deadline.
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
  if v_incident.monthly_export_submitted_at is not null then
    raise exception 'Article 44 monthly un-fiscalized coupon submission is already recorded';
  end if;
  v_deadline:=(
    date_trunc('month',v_incident.outage_started_at at time zone 'Europe/Belgrade')
      + interval '1 month' + interval '10 days'
  ) at time zone 'Europe/Belgrade';
  if now()<v_deadline then raise exception 'The tenth day of the following month has not yet passed'; end if;
  if v_incident.restored_at is not null and v_incident.restored_at<v_deadline then
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
