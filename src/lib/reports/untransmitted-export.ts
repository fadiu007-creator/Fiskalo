export type UntransmittedExportDocument = {
  fiscal_document_id: string;
  sale_id: string;
  coupon_id: string;
  document_type: number;
  reference_coupon_id: string | null;
  business_name: string;
  nui: string;
  pos_label: string;
  branch_id: string;
  pos_id: string;
  fiscalization_number: string;
  sale_created_at: string;
  document_created_at: string;
  total: number | string;
  submission_state: string;
  nui_kf: string | null;
  daily_number: number | string | null;
  offline_issued_at: string | null;
  recovery_deadline_at: string | null;
  atk_transaction_id: string | null;
  signed_payload: string;
  signature: string;
  citizen_payload: string | null;
  citizen_signature: string | null;
  atk_response: unknown;
};

function csvCell(value: unknown): string {
  let text = typeof value === "string" ? value : value == null ? "" :
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[\\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/** Structured authority-requested export. Call the owner-gated RPC before building this file. */
export function buildUntransmittedExportCsv(documents: UntransmittedExportDocument[]): string {
  const headers = [
    "Fiscal document ID", "Sale ID", "Coupon ID", "Document type", "Reference coupon ID",
    "Business", "NUI", "POS label", "Branch ID", "POS ID", "Fiscalization number",
    "Sale created at", "Document created at", "Total EUR", "ATK submission state",
    "NUIKF", "Daily number", "Offline outage start", "Recovery deadline", "ATK transaction ID",
    "POS coupon protobuf base64", "POS signature base64",
    "Citizen coupon protobuf base64", "Citizen signature base64", "ATK response JSON",
  ];
  const rows = documents.map(document => [
    document.fiscal_document_id, document.sale_id, document.coupon_id, document.document_type,
    document.reference_coupon_id, document.business_name, document.nui, document.pos_label,
    document.branch_id, document.pos_id, document.fiscalization_number, document.sale_created_at,
    document.document_created_at, Number(document.total).toFixed(2), document.submission_state,
    document.nui_kf, document.daily_number, document.offline_issued_at, document.recovery_deadline_at,
    document.atk_transaction_id, document.signed_payload, document.signature,
    document.citizen_payload, document.citizen_signature, document.atk_response,
  ]);
  return "\\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\\r\\n");
}
