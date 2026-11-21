export const ARTICLE44_EXPORT_COLUMNS = [
  "generated_at_utc",
  "authority_request_reference",
  "business_name",
  "business_nui",
  "pos_label",
  "branch_id",
  "pos_number",
  "period_from_utc",
  "period_to_utc",
  "source",
  "fiscal_document_id",
  "sale_id",
  "idempotency_key",
  "coupon_id",
  "document_type",
  "reference_coupon_id",
  "original_transaction_id",
  "sale_created_at",
  "document_created_at",
  "issued_at_utc",
  "offline_issued_at_utc",
  "recovery_deadline_utc",
  "status",
  "atk_transaction_id",
  "daily_number",
  "nui_kf",
  "verification_no",
  "fiscalization_number",
  "total_eur",
  "signed_payload_base64",
  "signature_base64",
  "citizen_payload_base64",
  "citizen_signature_base64",
  "citizen_qr_payload",
  "qr_svg_base64",
  "atk_response",
  "last_error",
  "attempt_count"
] as const;

export type Article44ExportColumn = typeof ARTICLE44_EXPORT_COLUMNS[number];
export type Article44ExportRow = Partial<Record<Article44ExportColumn, string | number | null | undefined>>;

function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = typeof value === "string" && /^[=+@\t\r-]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function buildArticle44Csv(rows: readonly Article44ExportRow[]): string {
  const header = ARTICLE44_EXPORT_COLUMNS.map(csvCell).join(",");
  const records = rows.map(row => ARTICLE44_EXPORT_COLUMNS.map(column => csvCell(row[column])).join(","));
  return [header, ...records].join("\r\n") + "\r\n";
}
