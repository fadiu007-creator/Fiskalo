#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL=(psql "${DATABASE_URL}" --no-psqlrc --set=ON_ERROR_STOP=1)

run_migration() {
  "${PSQL[@]}" --file "$ROOT_DIR/$1"
}

run_test() {
  echo "::group::SQL contract: $1"
  "${PSQL[@]}" --file "$ROOT_DIR/supabase/tests/$1"
  echo "::endgroup::"
}

echo "Bootstrapping disposable Supabase Auth compatibility objects"
run_migration "supabase/tests/bootstrap.sql"

migrations=(
  "0001_fiskalo_basic_core.sql"
  "0002_fiskalo_basic_checkout.sql"
  "0003_fiskalo_basic_atk_acceptance.sql"
  "0004_fiskalo_basic_security_hardening.sql"
  "0005_fiskalo_basic_offline_receipts.sql"
  "0006_fiskalo_basic_business_tax_profile.sql"
  "0007_fiskalo_basic_operator_identity.sql"
  "0008_fiskalo_basic_operator_snapshot.sql"
  "0009_fiskalo_basic_persist_receipt_qr.sql"
  "0010_fiskalo_atk_nuikf_format.sql"
  "0011_fiskalo_operator_identifier.sql"
  "0012_fiskalo_atk_nuikf_2026_format.sql"
  "0013_fiskalo_basic_pos_arbk_unit_number.sql"
  "0014_fiskalo_basic_checkout_idempotency.sql"
  "0015_fiskalo_basic_atk_corrections.sql"
  "0016_fiskalo_business_operations.sql"
  "0017_fiskalo_atomic_purchase_rpc.sql"
  "0018_fiskalo_basic_correction_workflow.sql"
  "0019_fiskalo_basic_correction_rpc_least_privilege.sql"
)

for migration in "${migrations[@]}"; do
  echo "Applying $migration"
  run_migration "supabase/migrations/$migration"

  case "$migration" in
    0005_fiskalo_basic_offline_receipts.sql) run_test "0005_fiskalo_basic_offline_receipts.sql" ;;
    0006_fiskalo_basic_business_tax_profile.sql) run_test "0006_fiskalo_basic_business_tax_profile.sql" ;;
    0007_fiskalo_basic_operator_identity.sql) run_test "0007_fiskalo_basic_operator_identity.sql" ;;
    0008_fiskalo_basic_operator_snapshot.sql) run_test "0008_fiskalo_basic_operator_snapshot.sql" ;;
    0014_fiskalo_basic_checkout_idempotency.sql)
      run_test "0004_fiskalo_basic_security_hardening.sql"
      run_test "0014_fiskalo_basic_checkout_idempotency.sql"
      ;;
    0015_fiskalo_basic_atk_corrections.sql) run_test "0015_fiskalo_basic_atk_corrections.sql" ;;
    0017_fiskalo_atomic_purchase_rpc.sql) run_test "0016_fiskalo_business_operations.sql" ;;
    0018_fiskalo_basic_correction_workflow.sql) run_test "0018_fiskalo_basic_correction_workflow.sql" ;;
    0019_fiskalo_basic_correction_rpc_least_privilege.sql) run_test "0019_fiskalo_basic_correction_rpc_least_privilege.sql" ;;
  esac
done

run_test "runtime_tenant_isolation.sql"
echo "All Supabase SQL migrations, catalog contracts, and runtime tenant-isolation/idempotency checks passed."
