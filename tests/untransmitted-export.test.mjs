import assert from "node:assert/strict";
import test from "node:test";
import { buildUntransmittedExportCsv } from "../src/lib/reports/untransmitted-export.ts";

test("authority export includes signed POS and CitizenCoupon evidence", () => {
  const csv = buildUntransmittedExportCsv([{
    fiscal_document_id: "doc-1",
    sale_id: "sale-1",
    coupon_id: "123",
    document_type: 1,
    reference_coupon_id: null,
    business_name: "Biznesi",
    nui: "123456789",
    pos_label: "Arka 1",
    branch_id: "1",
    pos_id: "2",
    fiscalization_number: "TEST-1",
    sale_created_at: "2026-11-15T10:00:00.000Z",
    document_created_at: "2026-11-15T10:00:01.000Z",
    total: "12.34",
    submission_state: "queued",
    nui_kf: "ABCDEFGHIJKLMNOP",
    daily_number: 4,
    offline_issued_at: "2026-11-15T10:00:00.000Z",
    recovery_deadline_at: "2026-11-17T10:00:00.000Z",
    atk_transaction_id: null,
    signed_payload: "POS-PROTOBUF-BASE64",
    signature: "POS-SIGNATURE-BASE64",
    citizen_payload: "CITIZEN-PROTOBUF-BASE64",
    citizen_signature: "CITIZEN-SIGNATURE-BASE64",
    atk_response: null,
  }], "ATK-REQ-2026-001");
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /ATK-REQ-2026-001/);
  assert.match(csv, /POS-PROTOBUF-BASE64/);
  assert.match(csv, /POS-SIGNATURE-BASE64/);
  assert.match(csv, /CITIZEN-PROTOBUF-BASE64/);
  assert.match(csv, /CITIZEN-SIGNATURE-BASE64/);
  assert.match(csv, /2026-11-17T10:00:00.000Z/);
});

test("authority export neutralizes spreadsheet formulas in stored metadata", () => {
  const csv = buildUntransmittedExportCsv([{
    fiscal_document_id: "doc-2", sale_id: "sale-2", coupon_id: "2", document_type: 1,
    reference_coupon_id: null, business_name: "=HYPERLINK(\"https://example.invalid\")",
    nui: "123456789", pos_label: "POS", branch_id: "1", pos_id: "1", fiscalization_number: "1",
    sale_created_at: "", document_created_at: "", total: 0, submission_state: "queued",
    nui_kf: null, daily_number: null, offline_issued_at: null, recovery_deadline_at: null,
    atk_transaction_id: null, signed_payload: "A", signature: "B", citizen_payload: null,
    citizen_signature: null, atk_response: null,
  }]);
  assert.match(csv, /'=HYPERLINK/);
});
