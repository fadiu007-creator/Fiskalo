-- Run after migrations 0001-0019 in a disposable or approved staging database.
-- The low-level correction writer must not be callable directly by API roles.
begin;
do $$
declare
  record_public oid;
  record_private oid;
  prepare_public oid;
  store_public oid;
  store_private oid;
  is_definer boolean;
begin
  record_public := to_regprocedure(
    'public.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  record_private := to_regprocedure(
    'fiskalo_private.fiskalo_basic_record_atk_correction(uuid,uuid,bigint,bigint,smallint,text,text,text,numeric,jsonb)'
  );
  prepare_public := to_regprocedure(
    'public.fiskalo_basic_prepare_correction(uuid,uuid,smallint)'
  );
  store_public := to_regprocedure(
    'public.fiskalo_basic_store_correction_receipt(uuid,uuid,text,text,text,text,text,text,text,bigint,numeric,jsonb,timestamptz)'
  );
  store_private := to_regprocedure(
    'fiskalo_private.fiskalo_basic_store_correction_receipt(uuid,uuid,text,text,text,text,text,text,text,bigint,numeric,jsonb,timestamptz)'
  );

  if record_public is null or record_private is null or
     prepare_public is null or store_public is null or store_private is null then
    raise exception 'Correction workflow RPCs are incomplete';
  end if;

  if has_function_privilege('anon',record_public,'EXECUTE') or
     has_function_privilege('authenticated',record_public,'EXECUTE') or
     has_function_privilege('anon',record_private,'EXECUTE') or
     has_function_privilege('authenticated',record_private,'EXECUTE') then
    raise exception 'Low-level correction writer must not be directly executable by API roles';
  end if;

  if not has_function_privilege('authenticated',prepare_public,'EXECUTE') or
     not has_function_privilege('authenticated',store_public,'EXECUTE') or
     has_function_privilege('anon',prepare_public,'EXECUTE') or
     has_function_privilege('anon',store_public,'EXECUTE') then
    raise exception 'Owner-checked correction workflow RPC grants are incorrect';
  end if;

  select p.prosecdef into is_definer from pg_proc p where p.oid=store_private;
  if is_definer is distinct from true then
    raise exception 'Correction store helper must remain SECURITY DEFINER to call the private writer';
  end if;
end $$;
rollback;
