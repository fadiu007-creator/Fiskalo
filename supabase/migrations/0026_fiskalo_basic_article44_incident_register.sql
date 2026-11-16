-- Article 44 incident register and evidence pack.
-- This records the taxpayer's actual outage and manual ATK notification; it does not
-- claim that Fiskalo submits a notice to ATK (no supported public notice API is known).
create table if not exists public.fiskalo_basic_article44_incidents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.fiskalo_basic_businesses(id) on delete restrict,
  pos_id uuid not null references public.fiskalo_basic_pos(id) on delete restrict,
  outage_started_at timestamptz not null,
  detected_at timestamptz not null default now(),
  cause text not null check (cause in ('isp_failure','equipment_change','force_majeure','atk_service_unavailable','other')),
  description text not null check (length(trim(description)) between 10 and 2000),
  restored_at timestamptz,
  notice_submitted_at timestamptz,
  notice_channel text check (notice_channel in ('electronic','in_person')),
  authority_reference text,
  evidence_manifest jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_manifest)='array'),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (outage_started_at <= detected_at + interval '5 minutes'),
  check (restored_at is null or restored_at >= outage_started_at),
  check (
    (notice_submitted_at is null and notice_channel is null and authority_reference is null and evidence_manifest='[]'::jsonb)
    or
    (notice_submitted_at is not null and notice_channel is not null and jsonb_array_length(evidence_manifest)>0)
  )
);
create unique index if not exists fiskalo_basic_article44_one_open_incident_per_pos
  on public.fiskalo_basic_article44_incidents(pos_id) where restored_at is null;
create index if not exists fiskalo_basic_article44_business_history_idx
  on public.fiskalo_basic_article44_incidents(business_id,outage_started_at desc);
alter table public.fiskalo_basic_article44_incidents enable row level security;
drop policy if exists fiskalo_basic_article44_owner_read on public.fiskalo_basic_article44_incidents;
create policy fiskalo_basic_article44_owner_read
  on public.fiskalo_basic_article44_incidents for select to authenticated
  using (exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=fiskalo_basic_article44_incidents.business_id
      and m.user_id=auth.uid() and m.role='owner'));
revoke all on public.fiskalo_basic_article44_incidents from public,anon,authenticated;
grant select on public.fiskalo_basic_article44_incidents to authenticated;
grant all on public.fiskalo_basic_article44_incidents to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('fiskalo-article44-evidence','fiskalo-article44-evidence',false,10485760,
  array['application/pdf','image/jpeg','image/png','text/plain'])
on conflict(id) do update set public=false,file_size_limit=10485760,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists fiskalo_article44_evidence_owner_read on storage.objects;
create policy fiskalo_article44_evidence_owner_read on storage.objects
  for select to authenticated
  using (bucket_id='fiskalo-article44-evidence'
    and exists(select 1 from public.fiskalo_basic_members m
      where m.business_id=(storage.foldername(name))[1]::uuid
        and m.user_id=auth.uid() and m.role='owner'));
drop policy if exists fiskalo_article44_evidence_owner_insert on storage.objects;
create policy fiskalo_article44_evidence_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id='fiskalo-article44-evidence'
    and exists(select 1 from public.fiskalo_basic_members m
      where m.business_id=(storage.foldername(name))[1]::uuid
        and m.user_id=auth.uid() and m.role='owner'));

create or replace function fiskalo_private.fiskalo_basic_create_article44_incident(
  p_business_id uuid,p_pos_id uuid,p_outage_started_at timestamptz,p_cause text,p_description text
) returns uuid
language plpgsql security definer set search_path='' as $article44$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_business_id is null or p_pos_id is null or p_outage_started_at is null or
     p_outage_started_at>now()+interval '5 minutes' or p_outage_started_at<now()-interval '90 days' or
     p_cause not in ('isp_failure','equipment_change','force_majeure','atk_service_unavailable','other') or
     length(trim(coalesce(p_description,''))) not between 10 and 2000 then
    raise exception 'Article 44 incident details are invalid';
  end if;
  if not exists(select 1 from public.fiskalo_basic_members m
    where m.business_id=p_business_id and m.user_id=auth.uid() and m.role='owner') then
    raise exception 'Business owner access required';
  end if;
  if not exists(select 1 from public.fiskalo_basic_pos p
    where p.id=p_pos_id and p.business_id=p_business_id) then
    raise exception 'POS does not belong to this business';
  end if;
  insert into public.fiskalo_basic_article44_incidents(
    business_id,pos_id,outage_started_at,cause,description,created_by
  ) values(p_business_id,p_pos_id,p_outage_started_at,p_cause,trim(p_description),auth.uid())
  returning id into v_id;
  return v_id;
end;
$article44$;
revoke all on function fiskalo_private.fiskalo_basic_create_article44_incident(uuid,uuid,timestamptz,text,text)
  from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_create_article44_incident(uuid,uuid,timestamptz,text,text)
  to authenticated;
create or replace function public.fiskalo_basic_create_article44_incident(
  p_business_id uuid,p_pos_id uuid,p_outage_started_at timestamptz,p_cause text,p_description text
) returns uuid language sql security invoker set search_path=pg_catalog,public,pg_temp as $article44$
  select fiskalo_private.fiskalo_basic_create_article44_incident(
    p_business_id,p_pos_id,p_outage_started_at,p_cause,p_description)
$article44$;
revoke all on function public.fiskalo_basic_create_article44_incident(uuid,uuid,timestamptz,text,text) from public,anon;
grant execute on function public.fiskalo_basic_create_article44_incident(uuid,uuid,timestamptz,text,text) to authenticated;

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
  if now()<v_incident.outage_started_at+interval '48 hours' then
    raise exception 'Article 44 paragraph 5 notice is recorded only after the 48-hour reconnection deadline';
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
revoke all on function fiskalo_private.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb)
  to authenticated;
create or replace function public.fiskalo_basic_record_article44_notice(
  p_incident_id uuid,p_notice_channel text,p_authority_reference text,p_evidence_manifest jsonb
) returns void language sql security invoker set search_path=pg_catalog,public,pg_temp as $article44$
  select fiskalo_private.fiskalo_basic_record_article44_notice(
    p_incident_id,p_notice_channel,p_authority_reference,p_evidence_manifest)
$article44$;
revoke all on function public.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb) from public,anon;
grant execute on function public.fiskalo_basic_record_article44_notice(uuid,text,text,jsonb) to authenticated;

create or replace function fiskalo_private.fiskalo_basic_restore_article44_incident(
  p_incident_id uuid,p_restored_at timestamptz default now()
) returns void language plpgsql security definer set search_path='' as $article44$
declare v_incident public.fiskalo_basic_article44_incidents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select i.* into v_incident from public.fiskalo_basic_article44_incidents i
    join public.fiskalo_basic_members m on m.business_id=i.business_id
    where i.id=p_incident_id and m.user_id=auth.uid() and m.role='owner'
    for update of i;
  if not found then raise exception 'Article 44 incident not found or owner access required'; end if;
  if v_incident.restored_at is not null then raise exception 'Incident is already marked restored'; end if;
  if p_restored_at is null or p_restored_at<v_incident.outage_started_at or p_restored_at>now()+interval '5 minutes' then
    raise exception 'Restoration timestamp is invalid';
  end if;
  update public.fiskalo_basic_article44_incidents
    set restored_at=p_restored_at,updated_at=now() where id=p_incident_id;
end;
$article44$;
revoke all on function fiskalo_private.fiskalo_basic_restore_article44_incident(uuid,timestamptz)
  from public,anon,authenticated;
grant execute on function fiskalo_private.fiskalo_basic_restore_article44_incident(uuid,timestamptz)
  to authenticated;
create or replace function public.fiskalo_basic_restore_article44_incident(
  p_incident_id uuid,p_restored_at timestamptz default now()
) returns void language sql security invoker set search_path=pg_catalog,public,pg_temp as $article44$
  select fiskalo_private.fiskalo_basic_restore_article44_incident(p_incident_id,p_restored_at)
$article44$;
revoke all on function public.fiskalo_basic_restore_article44_incident(uuid,timestamptz) from public,anon;
grant execute on function public.fiskalo_basic_restore_article44_incident(uuid,timestamptz) to authenticated;
