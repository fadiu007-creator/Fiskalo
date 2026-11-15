-- Close the browser-trust vulnerability for correction acceptance.
-- The correction Edge Function uses the service role only after its own authenticated
-- server-to-server HTTPS submission to the fixed ATK TEST endpoint.
revoke all on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public, anon, authenticated;
revoke all on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public, anon, authenticated;

-- Do not allow clients to bypass the RPC boundary with direct fiscal-document inserts.
revoke insert on table public.fiskalo_basic_fiscal_documents from anon, authenticated;

-- Remove the legacy RLS insert path as well as the table privilege. A permissive
-- policy is not itself a grant, but retaining it makes future grants unsafe.
drop policy if exists fiskalo_basic_fiscal_insert on public.fiskalo_basic_fiscal_documents;

-- Enforce one unresolved/accepted full cancellation per original document at the
-- database boundary, including concurrent requests and multiple app instances.
create unique index if not exists fiskalo_basic_fiscal_one_active_correction_per_parent_uidx
  on public.fiskalo_basic_fiscal_documents(parent_document_id)
  where parent_document_id is not null
    and document_type = 2
    and submission_state in ('queued','submitted','accepted','needs_reconciliation');

-- This UI exposes full returns only. Keep one active full return per original sale;
-- partial returns need a separately modelled remaining-quantity/refund workflow.
create unique index if not exists fiskalo_basic_fiscal_one_active_full_return_per_parent_uidx
  on public.fiskalo_basic_fiscal_documents(parent_document_id)
  where parent_document_id is not null
    and document_type = 3
    and submission_state in ('queued','submitted','accepted','needs_reconciliation');
