-- Disposable CI fixture for a legacy public Article 44 export RPC that existed
-- in the connected project but is not part of the clean-install migration chain.
-- The following migration must revoke authenticated/anon API execution.
create or replace function fiskalo_private.fiskalo_basic_untransmitted_export(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_authority_request_reference text,
  p_limit integer default 5000
) returns jsonb
language sql
security definer
set search_path=''
as $fixture$
  select '{}'::jsonb
$fixture$;

revoke all on function fiskalo_private.fiskalo_basic_untransmitted_export(
  uuid,timestamptz,timestamptz,text,integer
) from public, anon;
grant execute on function fiskalo_private.fiskalo_basic_untransmitted_export(
  uuid,timestamptz,timestamptz,text,integer
) to authenticated;

create or replace function public.fiskalo_basic_untransmitted_export(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_authority_request_reference text,
  p_limit integer default 5000
) returns jsonb
language sql
security definer
set search_path=''
as $fixture$
  select fiskalo_private.fiskalo_basic_untransmitted_export(
    p_business_id,p_from,p_to,p_authority_request_reference,p_limit
  )
$fixture$;

revoke all on function public.fiskalo_basic_untransmitted_export(
  uuid,timestamptz,timestamptz,text,integer
) from public, anon;
grant execute on function public.fiskalo_basic_untransmitted_export(
  uuid,timestamptz,timestamptz,text,integer
) to authenticated;
