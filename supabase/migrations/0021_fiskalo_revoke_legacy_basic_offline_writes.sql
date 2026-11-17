-- The local POS Agent + Edge Function attestation path is authoritative.
-- Some deployed installations may still contain the v2 browser RPC from an
-- earlier unreleased schema, while a clean replay of this repository does not.
-- Revoke every legacy entry point that exists without making clean installs
-- depend on objects outside the versioned migration history.
do $$
declare
  v2 regprocedure := to_regprocedure(
    'public.fiskalo_basic_store_offline_receipt_v2(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz,text)'
  );
  v1 regprocedure := to_regprocedure(
    'public.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz)'
  );
  private_v1 regprocedure := to_regprocedure(
    'fiskalo_private.fiskalo_basic_store_offline_receipt(uuid,uuid,bigint,text,text,text,text,text,text,bigint,timestamptz)'
  );
  consume_coupon regprocedure := to_regprocedure(
    'public.fiskalo_basic_consume_offline_coupon_id(uuid,uuid,bigint,uuid)'
  );
begin
  if v2 is not null then execute format('revoke all on function %s from public,anon,authenticated',v2); end if;
  if v1 is not null then execute format('revoke all on function %s from public,anon,authenticated',v1); end if;
  if private_v1 is not null then execute format('revoke all on function %s from public,anon,authenticated',private_v1); end if;
  if consume_coupon is not null then execute format('revoke all on function %s from public,anon,authenticated',consume_coupon); end if;

  if v2 is not null then
    execute format(
      'comment on function %s is %L',
      v2,
      'Deprecated browser write path. Use fiskalo-basic-atk-receipts Edge Function with local POS Agent attestation.'
    );
  end if;
  if v1 is not null then
    execute format(
      'comment on function %s is %L',
      v1,
      'Deprecated browser write path. Use fiskalo-basic-atk-receipts Edge Function with local POS Agent attestation.'
    );
  end if;
  if consume_coupon is not null then
    execute format(
      'comment on function %s is %L',
      consume_coupon,
      'Reserved for trusted server-side reconciliation; browser clients must not consume CouponIds.'
    );
  end if;
end
$$;
