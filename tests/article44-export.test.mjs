import assert from "node:assert/strict";
import test from "node:test";
import { ARTICLE44_EXPORT_COLUMNS, buildArticle44Csv } from "../src/lib/pos/article44-export.ts";

test("Article 44 CSV uses the published fixed column order and preserves signed payloads", () => {
  const csv = buildArticle44Csv([{
    source: "browser_local_outbox",
    business_name: "Dyqani, Qendra",
    coupon_id: "9001",
    signed_payload_base64: "cG9z",
    signature_base64: "c2ln",
    citizen_payload_base64: "Y2l0aXplbg==",
    citizen_signature_base64: "c2ln",
  }]);
  const lines = csv.trimEnd().split("\\r\\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].split(",").length, ARTICLE44_EXPORT_COLUMNS.length);
  assert.ok(lines[0].includes('"signed_payload_base64"'));
  assert.ok(lines[1].includes('"Dyqani, Qendra"'));
  assert.ok(lines[1].includes('"cG9z"'));
  assert.ok(lines[1].includes('"Y2l0aXplbg=="'));
});

test("Article 44 CSV quotes cells, doubles quotes and prevents spreadsheet formula injection", () => {
  const csv = buildArticle44Csv([{
    business_name: '=HYPERLINK("https://evil.example","open")',
    last_error: "line one\nline two",
    authority_request_reference: "+CMD|' /C calc'!A0",
    idempotency_key: "@SUM(1,1)",
  }]);
  const row = csv.split("\\r\\n")[1];
  assert.ok(row.includes('"'=HYPERLINK(""https://evil.example"",""open"")"'));
  assert.ok(row.includes('"line one\nline two"'));
  assert.ok(row.includes('"'+CMD|\' /C calc\'!A0"'));
  assert.ok(row.includes('"'@SUM(1,1)"'));
});

test("Article 44 CSV preserves numeric values and emits empty cells for missing fields", () => {
  const csv = buildArticle44Csv([{ branch_id: 1, total_eur: -2.5 }]);
  const row = csv.split("\\r\\n")[1];
  assert.ok(row.includes(',"1",'));
  assert.ok(row.includes(',"-2.5",'));
});
