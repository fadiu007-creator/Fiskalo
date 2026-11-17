-- Migration-ledger alignment.
-- The identical duplicate full-return guard was applied in migration
-- 20261117110216_fiskalo_prevent_duplicate_full_atk_returns.sql. This no-op
-- migration records the follow-up deployment entry that was applied directly
-- to the live Supabase project; keeping the version in source prevents schema
-- history drift. The guard and grants are defined by the preceding migration.
select 1;
