#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL=(psql "${DATABASE_URL}" --no-psqlrc --set=ON_ERROR_STOP=1)

run_test() {
  local contract="$1"
  echo "Running SQL contract supabase/tests/$contract"
  "${PSQL[@]}" --file "$ROOT_DIR/supabase/tests/$contract"
}

echo "Bootstrapping disposable Supabase Auth and Storage compatibility objects"
"${PSQL[@]}" --file "$ROOT_DIR/supabase/tests/bootstrap.sql"

while IFS= read -r migration; do
  migration_name="$(basename "$migration")"
  echo "Applying supabase/migrations/$migration_name"
  "${PSQL[@]}" --file "$migration"

  # Contracts are run at the schema version they were written for. Running
  # historical contracts against the final schema can reject intentional,
  # later SECURITY DEFINER server wrappers.
  case "$migration_name" in
    0005_fiskalo_basic_offline_receipts.sql)
      run_test "0005_fiskalo_basic_offline_receipts.sql"
      ;;
    0006_fiskalo_basic_business_tax_profile.sql)
      run_test "0006_fiskalo_basic_business_tax_profile.sql"
      ;;
    0007_fiskalo_basic_operator_identity.sql)
      run_test "0007_fiskalo_basic_operator_identity.sql"
      ;;
    0008_fiskalo_basic_operator_snapshot.sql)
      run_test "0008_fiskalo_basic_operator_snapshot.sql"
      ;;
    0014_fiskalo_basic_checkout_idempotency.sql)
      run_test "0004_fiskalo_basic_security_hardening.sql"
      run_test "0014_fiskalo_basic_checkout_idempotency.sql"
      ;;
    0015_fiskalo_basic_atk_corrections.sql)
      run_test "0015_fiskalo_basic_atk_corrections.sql"
      ;;
    0017_fiskalo_atomic_purchase_rpc.sql)
      run_test "0016_fiskalo_business_operations.sql"
      ;;
    0018_fiskalo_offline_number_reservations.sql)
      run_test "0018_fiskalo_offline_number_reservations.sql"
      ;;
    0019_fiskalo_offline_sale_reconciliation.sql)
      run_test "0019_fiskalo_offline_sale_reconciliation.sql"
      ;;
    0020_fiskalo_basic_offline_48h_recovery.sql)
      run_test "0020_fiskalo_atk_certificate_registry_and_server_receipts.sql"
      ;;
    0021_fiskalo_revoke_legacy_basic_offline_writes.sql)
      run_test "0021_fiskalo_revoke_legacy_basic_offline_writes.sql"
      ;;
    0022_fiskalo_atomic_offline_capacity_reservation.sql)
      run_test "0022_fiskalo_atomic_offline_capacity_reservation.sql"
      ;;
    0023_fiskalo_offline_capacity_invoker.sql)
      run_test "0023_fiskalo_offline_capacity_invoker.sql"
      ;;
    0024_fiskalo_allow_future_offline_daily_reservations.sql)
      run_test "0024_fiskalo_allow_future_offline_daily_reservations.sql"
      ;;
    0025_fiskalo_revoke_trigger_function_api_execute.sql)
      run_test "0025_fiskalo_revoke_trigger_function_api_execute.sql"
      ;;
    0026_fiskalo_basic_article44_incident_register.sql)
      run_test "0026_fiskalo_basic_article44_incident_register.sql"
      ;;
    0027_fiskalo_basic_article44_monthly_untransmitted_submission.sql)
      run_test "0027_fiskalo_basic_article44_monthly_untransmitted_submission.sql"
      ;;
    0028_fiskalo_basic_article44_unfiscalized_export.sql)
      run_test "0028_fiskalo_basic_article44_unfiscalized_export.sql"
      ;;
    0029_fiskalo_basic_split_payment_allocations.sql)
      run_test "0029_fiskalo_basic_split_payment_allocations.sql"
      ;;
    0030_fiskalo_article44_scope_and_offline_payment_integrity.sql)
      run_test "0030_fiskalo_article44_scope_and_offline_payment_integrity.sql"
      ;;
    0031_fiskalo_article44_deadline_boundary.sql)
      run_test "0031_fiskalo_article44_deadline_boundary.sql"
      ;;
    0032_fiskalo_article44_monthly_export_proof_guard.sql)
      run_test "0032_fiskalo_article44_monthly_export_proof_guard.sql"
      ;;
    0033_fiskalo_basic_complete_atk_item_categories.sql)
      run_test "0033_fiskalo_basic_complete_atk_item_categories.sql"
      ;;
    20261117113528_fiskalo_server_atk_corrections_20261117.sql)
      run_test "20261117113528_fiskalo_server_atk_corrections_20261117.sql"
      run_test "20261117110216_fiskalo_prevent_duplicate_full_atk_returns.sql"
      ;;
    20261117160000_fiskalo_atk_pos_heartbeat_evidence.sql)
      run_test "20261117160000_fiskalo_atk_pos_heartbeat_evidence.sql"
      ;;
    20261117160100_fiskalo_basic_offline_heartbeat_binding.sql)
      run_test "20261117160100_fiskalo_basic_offline_heartbeat_binding.sql"
      ;;
  esac
done < <(find "$ROOT_DIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print | sort)

echo "Bootstrapping disposable Full-schema ATK category fixture"
"${PSQL[@]}" --file "$ROOT_DIR/supabase/full-tests/bootstrap_atk_category_constraints.sql"

echo "Applying Full-schema ATK category expansion migration"
"${PSQL[@]}" --file "$ROOT_DIR/supabase/full-migrations/fiskalo_full_complete_atk_item_categories.sql"
"${PSQL[@]}" --file "$ROOT_DIR/supabase/full-tests/fiskalo_full_complete_atk_item_categories.sql"

echo "All Fiskalo migrations and version-matched SQL contracts passed."
