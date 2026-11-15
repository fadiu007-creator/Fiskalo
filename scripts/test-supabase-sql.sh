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
  "0018_fiskalo_atk_server_acceptance.sql"
  "0019_fiskalo_coupon_verification_no.sql"
  "0020_fiskalo_atk_recovery_queue.sql"
  "0021_fiskalo_server_atk_queue.sql"
  "0022_fiskalo_private_pos_certificates.sql"
  "0023_fiskalo_register_pos_certificate.sql"
  "0024_fiskalo_atk_pre_submission_journal.sql"
  "0025_revoke_legacy_browser_correction_rpc.sql"
  "0026_fiskalo_server_atk_corrections.sql"
  "0027_fiskalo_queue_pre_submission_transition.sql"
  "0028_fiskalo_correction_submission_attempt.sql"
  "0029_correction_reservation_owner_only.sql"
  "0030_fiskalo_basic_atk_catalogue_constraints.sql"
  "0031_fiskalo_basic_split_tender.sql"
  "0032_fiskalo_basic_owner_sales_report.sql"
  "0033_fiskalo_basic_authority_export.sql"
  "0034_fiskalo_restrict_trigger_rpc_surface.sql"
  "0035_fiskalo_basic_certificate_application_binding.sql"
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
    0031_fiskalo_basic_split_tender.sql) run_test "0031_fiskalo_basic_split_tender.sql" ;;
    0032_fiskalo_basic_owner_sales_report.sql) run_test "0032_fiskalo_basic_owner_sales_report.sql" ;;
    0033_fiskalo_basic_authority_export.sql) run_test "0033_fiskalo_basic_authority_export.sql" ;;
    0034_fiskalo_restrict_trigger_rpc_surface.sql) run_test "0034_fiskalo_restrict_trigger_rpc_surface.sql" ;;
    0035_fiskalo_basic_certificate_application_binding.sql) run_test "0035_fiskalo_basic_certificate_application_binding.sql" ;;
  esac
done

echo "All Fiskalo migrations and SQL security contracts passed."
