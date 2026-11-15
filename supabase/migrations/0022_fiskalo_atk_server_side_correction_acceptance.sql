-- ATK correction acceptance must originate from a server-to-server ATK submission.
-- The legacy browser-callable RPC trusted caller-supplied JSON and is disabled.
revoke all on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public, anon, authenticated;
revoke all on function public.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) from public, anon, authenticated;

-- Authenticated clients may not insert correction documents directly.
drop policy if exists fiskalo_basic_fiscal_insert on public.fiskalo_basic_fiscal_documents;
create policy fiskalo_basic_fiscal_insert on public.fiskalo_basic_fiscal_documents
  for insert to authenticated with check (
    document_type = 1
    and exists(
      select 1 from public.fiskalo_basic_sales s
      join public.fiskalo_basic_members m on m.business_id=s.business_id
      where s.id=public.fiskalo_basic_fiscal_documents.sale_id
        and s.business_id=public.fiskalo_basic_fiscal_documents.business_id
        and m.user_id=auth.uid()
    )
  );

comment on function fiskalo_private.fiskalo_basic_record_atk_correction(
  uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb
) is 'Disabled for client roles. Corrections must be submitted through the authenticated server-side ATK TEST edge function.';
