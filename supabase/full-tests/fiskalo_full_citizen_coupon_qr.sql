begin;
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_atk_fiscal_documents'
      and column_name='citizen_coupon_base64'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='fiskalo_atk_fiscal_documents'
      and column_name='citizen_signature_base64'
  ) then
    raise exception 'Full fiscal journal must store the signed CitizenCoupon';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.fiskalo_atk_fiscal_documents'::regclass
      and conname='fiskalo_atk_fiscal_documents_citizen_payload_pair_check'
      and convalidated
  ) then
    raise exception 'CitizenCoupon payload and signature must be stored as a pair';
  end if;
end $$;
rollback;
