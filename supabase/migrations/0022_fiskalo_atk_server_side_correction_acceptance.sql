-- Correction acceptance must originate from the authenticated server-to-server ATK TEST path.
-- Browser roles cannot write fiscal documents or invoke the legacy JSON-trusting RPC.
revoke all on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public, anon, authenticated;
revoke all on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public, anon, authenticated;

-- Keep fiscal documents read-only to authenticated clients. The Edge Function uses
-- the server-only service role after it has submitted the signed coupon to ATK.
drop policy if exists fiskalo_basic_fiscal_insert on public.fiskalo_basic_fiscal_documents;
revoke insert, update, delete on public.fiskalo_basic_fiscal_documents from public, anon, authenticated;

-- A cancellation is a single full-cancel document for an original sale. Reserve it
-- before the external request so concurrent requests cannot submit two cancellations.
do $$
begin
  if exists (
    select parent_document_id
    from public.fiskalo_basic_fiscal_documents
    where parent_document_id is not null
      and document_type = 2
      and submission_state in ('queued','submitted','accepted','needs_reconciliation')
    group by parent_document_id
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce one active ATK cancellation: duplicate unresolved cancellations already exist';
  end if;
end
$$;

create unique index if not exists fiskalo_basic_fiscal_one_active_cancel_per_parent_uidx
  on public.fiskalo_basic_fiscal_documents(parent_document_id)
  where parent_document_id is not null
    and document_type = 2
    and submission_state in ('queued','submitted','accepted','needs_reconciliation');

comment on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) is 'Disabled for browser roles. ATK correction submissions and acceptance persistence must use the server-side Edge Function.';
comment on table public.fiskalo_basic_fiscal_documents is
  'Fiscal documents are immutable to browser roles. ATK TEST correction submissions are reserved and finalized by the server-side Edge Function.';
