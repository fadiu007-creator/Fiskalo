-- Article 44 follow-up: only require paragraph 5 notice when the outage actually
-- lasted beyond 48 hours, and support the paragraph 6 tenth-of-next-month export.
update storage.buckets set allowed_mime_types=array[
  'application/pdf','image/jpeg','image/png','text/plain','application/json','text/csv'
] where id='fiskalo-article44-evidence';

alter table public.fiskalo_basic_article44_incidents
  add column if not exists monthly_export_submitted_at timestamptz,
  add column if not exists monthly_export_channel text,
  add column if not exists monthly_export_reference text,
  add column if not exists monthly_export_manifest jsonb not null default '[]'::jsonb;

alter table public.fiskalo_basic_article44_incidents
  drop constraint if exists fiskalo_basic_article44_monthly_export_consistency;
alter table public.fiskalo_basic_article44_incidents
  add constraint fiskalo_basic_article44_monthly_export_consistency check (
    (monthly_export_submitted_at is null and monthly_export_channel is null
      and monthly_export_reference is null and monthly_export_manifest='[]'::jsonb)
    or
    (monthly_export_submitted_at is not null and monthly_export_channel in ('electronic','in_person')
      and jsonb_typeof(monthly_export_manifest)='array'
      and jsonb_array_length(monthly_export_manifest)>0)
  );

create or replace function fiskalo_private.fiskalo_basic_record_article44_notice(
  p_incident_id uuid,p_notice_channel text,p_authority_reference text,p_evidence_manifest jsonb
) returns void language plpgsql security definer set search_path='' as $article44$
declare v_incident public.fiskalo_basic_article44_incidents%rowtype; v_count integer; v_found integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select i.* into v_incident from public.fiskalo_basic_article44_incidents i
    join public.fiskalo_basic_members m on m.business_id=i.business_id
    where i.id=p_incident_id and m.user_id=auth.uid() and m.role='owner'
    for update of i;
  if not found then raise exception 'Article 44 incident not found or owner access required'; end if;
  if v_incident.notice_submitted_at is not null then raise exception 'Article 44 notice is already recorded'; end if;
  if v_incident.cause not in ('isp_failure','equipment_change','force_majeure') then
    raise exception 'The recorded cause is not one of the Article 44 paragraph 5 notification grounds';
  end if;
  if coalesce(v_incident.restored_at,now())<v_incident.outage_started_at+interval '48 hours' then
    raise exception 'Article 44 paragraph 5 notice is not required because the internet connection was restored within 48 hours';
  end if;
  if p_notice_channel not in ('electronic','in_person') or
     length(trim(coalesce(p_authority_reference,'')))>200 or
     jsonb_typeof(p_evidence_manifest)<>'array' or
     jsonb_array_length(p_evidence_manifest)<1 or jsonb_array_length(p_evidence_manifest)>20 or
     pg_column_size(p_evidence_manifest)>65536 then
    raise exception 'Notice channel, reference or evidence manifest is invalid';
  end if;
  select count(*) into v_count from jsonb_array_elements(p_evidence_manifest) e
    where coalesce(e->>'storage_path','') like v_incident.business_id::text||'/'||v_incident.id::text||'/%'
      and coalesce(e->>'sha256','') ~ '^[a-f0-9]{64}$'
      and coalesce(e->>'mime_type','') in ('application/pdf','image/jpeg','image/png','text/plain')
      and coalesce((e->>'size_bytes')::bigint,0) between 1 and 10485760;
  if v_count<>jsonb_array_length(p_evidence_manifest) then
    raise exception 'Every evidence item must have a valid private storage path, SHA-256 hash, MIME type and size';
  end if;
  select count(*) into v_found from storage.objects o
    where o.bucket_id='fiskalo-article44-evidence'
      and o.name in (select e->>'storage_path' from jsonb_array_elements(p_evidence_manifest) e);
  if v_found<>v_count then raise exception 'One or more Article 44 evidence files are missing from private storage'; end if;
  update public.fiskalo_basic_article44_incidents
    set notice_submitted_at=now(),notice_channel=p_notice_channel,
        authority_reference=nullif(trim(p_authority_reference),''),evidence_manifest=p_evidence_manifest,updated_at=now()
    where id=p_incident_id;
end;
$article44$;

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
revoke all on function fiskalo_private.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb)
  to authenticated;
create or replace function public.fiskalo_basic_record_article44_monthly_submission(
  p_incident_id uuid,p_submission_channel text,p_authority_reference text,p_evidence_manifest jsonb
) returns void language sql security invoker set search_path=pg_catalog,public,pg_temp as $article44$
  select fiskalo_private.fiskalo_basic_record_article44_monthly_submission(
    p_incident_id,p_submission_channel,p_authority_reference,p_evidence_manifest)
$article44$;
revoke all on function public.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_record_article44_monthly_submission(uuid,text,text,jsonb) to authenticated;
