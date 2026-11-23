import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE44_EXPORT_COLUMNS,
  buildArticle44Csv,
  verifyArticle44AuthorityEvidenceManifest,
} from "../src/lib/pos/article44-export.ts";

test("Article 44 CSV uses the fixed column order and preserves signed payloads", () => {
  const csv = buildArticle44Csv([{
    source: "browser_local_outbox",
    business_name: "Dyqani, Qendra",
    coupon_id: "9001",
    signed_payload_base64: "cG9z",
    signature_base64: "c2ln",
    citizen_payload_base64: "Y2l0aXplbg==",
    citizen_signature_base64: "c2ln",
  }]);
  const lines = csv.trimEnd().split("\r\n");
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
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes("'=HYPERLINK"));
  assert.ok(row.includes('""https://evil.example""'));
  assert.ok(row.includes("line one\nline two"));
  assert.ok(row.includes("'+CMD"));
  assert.ok(row.includes("'@SUM"));
});

test("Article 44 CSV preserves numeric values and emits empty cells for missing fields", () => {
  const csv = buildArticle44Csv([{ branch_id: 1, total_eur: -2.5 }]);
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes(',"1",'));
  assert.ok(row.includes(',"-2.5",'));
});


async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
}

function evidenceEntry(businessId, incidentId, bytes, sha256) {
  return {
    storage_path: businessId + "/" + incidentId + "/authority-request-550e8400-e29b-41d4-a716-446655440000-request.pdf",
    file_name: "request.pdf",
    mime_type: "application/pdf",
    size_bytes: bytes.byteLength,
    sha256,
  };
}

test("Article 44 server verifier hashes the exact private-storage bytes", async () => {
  const businessId = "550e8400-e29b-41d4-a716-446655440001";
  const incidentId = "550e8400-e29b-41d4-a716-446655440002";
  const bytes = new TextEncoder().encode("signed ATK authority request").buffer;
  const manifest = [evidenceEntry(businessId, incidentId, bytes, await sha256Hex(bytes))];
  let downloadedPath = "";
  const verified = await verifyArticle44AuthorityEvidenceManifest(
    manifest,
    businessId,
    incidentId,
    async path => {
      downloadedPath = path;
      return { bytes, mimeType: "application/pdf" };
    },
  );
  assert.equal(downloadedPath, manifest[0].storage_path);
  assert.deepEqual(verified, manifest);
});

test("Article 44 server verifier rejects evidence bytes changed after browser hashing", async () => {
  const businessId = "550e8400-e29b-41d4-a716-446655440001";
  const incidentId = "550e8400-e29b-41d4-a716-446655440002";
  const original = new TextEncoder().encode("original authority request").buffer;
  const tampered = new TextEncoder().encode("tampered authority request").buffer;
  const manifest = [evidenceEntry(businessId, incidentId, original, await sha256Hex(original))];
  await assert.rejects(
    verifyArticle44AuthorityEvidenceManifest(manifest, businessId, incidentId, async () => ({
      bytes: tampered,
      mimeType: "application/pdf",
    })),
    /SHA-256/,
  );
});

test("Article 44 server verifier rejects evidence outside the incident storage scope before download", async () => {
  const businessId = "550e8400-e29b-41d4-a716-446655440001";
  const incidentId = "550e8400-e29b-41d4-a716-446655440002";
  const bytes = new TextEncoder().encode("request").buffer;
  const manifest = [evidenceEntry("550e8400-e29b-41d4-a716-446655440099", incidentId, bytes, await sha256Hex(bytes))];
  let downloaded = false;
  await assert.rejects(
    verifyArticle44AuthorityEvidenceManifest(manifest, businessId, incidentId, async () => {
      downloaded = true;
      return { bytes, mimeType: "application/pdf" };
    }),
    /private path/,
  );
  assert.equal(downloaded, false);
});

test("Article 44 server verifier rejects storage MIME and size mismatches", async () => {
  const businessId = "550e8400-e29b-41d4-a716-446655440001";
  const incidentId = "550e8400-e29b-41d4-a716-446655440002";
  const bytes = new TextEncoder().encode("request").buffer;
  const manifest = [evidenceEntry(businessId, incidentId, bytes, await sha256Hex(bytes))];
  await assert.rejects(
    verifyArticle44AuthorityEvidenceManifest(manifest, businessId, incidentId, async () => ({
      bytes,
      mimeType: "text/plain",
    })),
    /MIME type/,
  );
  await assert.rejects(
    verifyArticle44AuthorityEvidenceManifest(
      [{ ...manifest[0], size_bytes: bytes.byteLength + 1 }],
      businessId,
      incidentId,
      async () => ({ bytes, mimeType: "application/pdf" }),
    ),
    /size/,
  );
});
