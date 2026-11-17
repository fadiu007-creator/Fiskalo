-- Bind new offline fiscal documents to a server-measured heartbeat outage interval.
alter table public.fiskalo_basic_fiscal_documents
  add column if not exists outage_heartbeat_evidence_id uuid
    references public.fiskalo_atk_pos_heartbeat_evidence(id) on delete restrict,
  add column if not exists offline_time_evidence text not null default 'legacy_unverified'
    check (offline_time_evidence in ('legacy_unverified','server_bounded_outage_window','server_signed_near_issue'));

create index if not exists fiskalo_basic_fiscal_documents_heartbeat_evidence_idx
  on public.fiskalo_basic_fiscal_documents (outage_heartbeat_evidence_id)
  where outage_heartbeat_evidence_id is not null;

create or replace function fiskalo_private.fiskalo_basic_bind_offline_heartbeat_evidence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pos_id uuid;
  v_evidence_id uuid;
  v_outage_started_at timestamptz;
  v_gap_seconds integer;
  v_should_validate boolean := false;
begin
  if tg_op = 'INSERT' then
    v_should_validate := new.submission_state = 'queued' and new.offline_issued_at is not null;
  else
    v_should_validate := new.submission_state = 'queued'
      and new.offline_issued_at is not null
      and (
        old.submission_state is distinct from 'queued'
        or old.offline_issued_at is distinct from new.offline_issued_at
        or old.outage_heartbeat_evidence_id is distinct from new.outage_heartbeat_evidence_id
        or old.offline_time_evidence is distinct from new.offline_time_evidence
        or old.recovery_deadline_at is distinct from new.recovery_deadline_at
      );
  end if;

  if not v_should_validate then
    return new;
  end if;

  select s.pos_id
    into v_pos_id
  from public.fiskalo_basic_sales s
  where s.id = new.sale_id
    and s.business_id = new.business_id;

  if v_pos_id is null then
    raise exception 'Offline fiscal document sale/POS identity could not be verified';
  end if;

  select h.id,
         coalesce(h.previous_heartbeat_at, h.server_time_utc),
         h.gap_seconds
    into v_evidence_id, v_outage_started_at, v_gap_seconds
  from public.fiskalo_atk_pos_heartbeat_evidence h
  where h.business_id = new.business_id
    and h.pos_id = v_pos_id
    and h.server_time_utc <= now() + interval '2 minutes'
    and (
      (
        h.previous_heartbeat_at is not null
        and new.offline_issued_at >= h.previous_heartbeat_at - interval '2 minutes'
        and new.offline_issued_at <= h.server_time_utc + interval '2 minutes'
      )
      or (
        h.previous_heartbeat_at is null
        and new.offline_issued_at between h.server_time_utc - interval '2 minutes'
                                      and h.server_time_utc + interval '2 minutes'
      )
    )
  order by h.server_time_utc asc
  limit 1;

  if v_evidence_id is null then
    raise exception 'Offline issue time is not bounded by a verified server heartbeat interval for this POS';
  end if;

  new.outage_heartbeat_evidence_id := v_evidence_id;
  new.offline_time_evidence := case when coalesce(v_gap_seconds, 0) > 90
    then 'server_bounded_outage_window' else 'server_signed_near_issue' end;
  new.recovery_deadline_at := v_outage_started_at + interval '48 hours';
  return new;
end;
$$;

revoke all on function fiskalo_private.fiskalo_basic_bind_offline_heartbeat_evidence()
  from public, anon, authenticated;

drop trigger if exists fiskalo_basic_bind_offline_heartbeat_evidence
  on public.fiskalo_basic_fiscal_documents;

create trigger fiskalo_basic_bind_offline_heartbeat_evidence
before insert or update of submission_state, offline_issued_at, recovery_deadline_at, outage_heartbeat_evidence_id, offline_time_evidence
on public.fiskalo_basic_fiscal_documents
for each row
execute function fiskalo_private.fiskalo_basic_bind_offline_heartbeat_evidence();
