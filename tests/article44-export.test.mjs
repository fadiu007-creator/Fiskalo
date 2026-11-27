import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE44_EXPORT_COLUMNS,
  buildArticle44Csv,
  verifyArticle44AuthorityEvidenceManifest,
  verifyArticle44FilingEvidenceManifest,
} from "../src/lib/pos/article44-export.ts";
import {
  InvalidRequestBodyError,
  readJsonBodyLimited,
  RequestBodyTooLargeError,
} from "../src/lib/http/read-json-limited.ts";

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

test("bounded JSON reader accepts valid JSON without Content-Length", async () => {
  const request = new Request("https://example.test/article-44", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentId: "incident-1" }),
  });
  assert.deepEqual(await readJsonBodyLimited(request, 128), { incidentId: "incident-1" });
});

test("bounded JSON reader rejects an oversized declared Content-Length before reading", async () => {
  const request = new Request("https://example.test/article-44", {
    method: "POST",
    headers: { "Content-Length": "129" },
    body: "{}",
  });
  await assert.rejects(readJsonBodyLimited(request, 128), RequestBodyTooLargeError);
});

test("bounded JSON reader rejects oversized streamed bytes when Content-Length is absent", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(129));
      controller.close();
    },
  });
  const request = new Request("https://example.test/article-44", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
  await assert.rejects(readJsonBodyLimited(request, 128), RequestBodyTooLargeError);
});

test("bounded JSON reader rejects a Content-Length that understates the received body", async () => {
  const request = new Request("https://example.test/article-44", {
    method: "POST",
    headers: { "Content-Length": "1" },
    body: "{}",
  });
  await assert.rejects(readJsonBodyLimited(request, 128), InvalidRequestBodyError);
});

test("bounded JSON reader rejects malformed JSON and invalid UTF-8", async () => {
  const malformed = new Request("https://example.test/article-44", {
    method: "POST",
    body: "{not-json}",
  });
  await assert.rejects(readJsonBodyLimited(malformed, 128), InvalidRequestBodyError);

  const invalidUtf8 = new Request("https://example.test/article-44", {
    method: "POST",
    body: new Uint8Array([0xff, 0xfe, 0xfd]),
  });
  await assert.rejects(readJsonBodyLimited(invalidUtf8, 128), InvalidRequestBodyError);
});

test("bounded JSON reader cancels an unbounded stream at the first oversized chunk", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(129));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://example.test/atk", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
  await assert.rejects(readJsonBodyLimited(request, 128), RequestBodyTooLargeError);
  assert.equal(cancelled, true);
});

test("bounded JSON reader rejects empty bodies and invalid limits", async () => {
  const empty = new Request("https://example.test/article-44", { method: "POST" });
  await assert.rejects(readJsonBodyLimited(empty, 128), InvalidRequestBodyError);
  await assert.rejects(readJsonBodyLimited(empty, 0), RangeError);
});


const FILING_BUSINESS_ID = "550e8400-e29b-41d4-a716-446655440011";
const FILING_INCIDENT_ID = "550e8400-e29b-41d4-a716-446655440012";

async function filingDigest(bytes) {
  return sha256Hex(bytes);
}

function filingEntry(kind, mimeType, fileName, bytes, sha256) {
  const nonce = "550e8400-e29b-41d4-a716-446655440013";
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "evidence";
  const prefix = kind === "monthly_submission" ? "monthly-" : "";
  return {
    storage_path: FILING_BUSINESS_ID + "/" + FILING_INCIDENT_ID + "/" + prefix + nonce + "-" + safeName,
    file_name: fileName,
    mime_type: mimeType,
    size_bytes: bytes.byteLength,
    sha256
  };
}

test("Article 44(5) notice evidence is verified against exact private-storage bytes", async () => {
  const bytes = new TextEncoder().encode("actual notice filing evidence").buffer;
  const manifest = [filingEntry("notice","application/pdf","notice.pdf",bytes,await filingDigest(bytes))];
  let downloaded = 0;
  const verified = await verifyArticle44FilingEvidenceManifest(
    manifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"notice",
    async path => {
      downloaded += 1;
      assert.equal(path,manifest[0].storage_path);
      return {bytes,mimeType:"application/pdf"};
    }
  );
  assert.equal(downloaded,1);
  assert.equal(verified[0].sha256,manifest[0].sha256);
});

test("Article 44(6) monthly evidence requires a CSV and independently verified delivery proof", async () => {
  const csvBytes = new TextEncoder().encode("coupon_id,total\r\n123,10.00").buffer;
  const proofBytes = new TextEncoder().encode("ATK submission acknowledgement").buffer;
  const manifest = [
    filingEntry("monthly_submission","text/csv","untransmitted.csv",csvBytes,await filingDigest(csvBytes)),
    filingEntry("monthly_submission","application/pdf","delivery.pdf",proofBytes,await filingDigest(proofBytes))
  ];
  const verified = await verifyArticle44FilingEvidenceManifest(
    manifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"monthly_submission",
    async path => path === manifest[0].storage_path
      ? {bytes:csvBytes,mimeType:"text/csv"}
      : {bytes:proofBytes,mimeType:"application/pdf"}
  );
  assert.equal(verified.length,2);
});

test("Article 44 filing evidence rejects client hashes that do not match stored bytes", async () => {
  const uploadedBytes = new TextEncoder().encode("uploaded evidence").buffer;
  const storedBytes = new TextEncoder().encode("tampered evidence").buffer;
  const manifest = [filingEntry("notice","application/pdf","notice.pdf",uploadedBytes,await filingDigest(uploadedBytes))];
  await assert.rejects(
    verifyArticle44FilingEvidenceManifest(
      manifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"notice",
      async () => ({bytes:storedBytes,mimeType:"application/pdf"})
    ),
    /SHA-256 does not match/
  );
});

test("Article 44 filing evidence rejects cross-incident paths before downloading", async () => {
  const bytes = new TextEncoder().encode("notice").buffer;
  const manifest = [filingEntry("notice","application/pdf","notice.pdf",bytes,await filingDigest(bytes))];
  manifest[0].storage_path = FILING_BUSINESS_ID + "/550e8400-e29b-41d4-a716-446655440099/" + manifest[0].storage_path.split("/")[2];
  let downloaded = false;
  await assert.rejects(
    verifyArticle44FilingEvidenceManifest(
      manifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"notice",
      async () => { downloaded = true; return {bytes,mimeType:"application/pdf"}; }
    ),
    /unique private path/
  );
  assert.equal(downloaded,false);
});

test("Article 44 monthly evidence rejects a manifest without delivery proof", async () => {
  const csvBytes = new TextEncoder().encode("coupon_id,total\r\n123,10.00").buffer;
  const manifest = [filingEntry("monthly_submission","text/csv","untransmitted.csv",csvBytes,await filingDigest(csvBytes))];
  await assert.rejects(
    verifyArticle44FilingEvidenceManifest(
      manifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"monthly_submission",
      async () => ({bytes:csvBytes,mimeType:"text/csv"})
    ),
    /CSV export and proof of delivery/
  );
});
