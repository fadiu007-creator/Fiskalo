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

function pdfBytes(body) {
  return new TextEncoder().encode("%PDF-1.7\n" + body + "\n%%EOF\n").buffer;
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
  const bytes = pdfBytes("signed ATK authority request");
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
  const original = pdfBytes("original authority request");
  const tampered = pdfBytes("tampered authority request");
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
  const bytes = pdfBytes("request");
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
  const bytes = pdfBytes("request");
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


test("Article 44 authority evidence rejects a text file spoofed as a PDF in Storage metadata", async () => {
  const businessId = "550e8400-e29b-41d4-a716-446655440001";
  const incidentId = "550e8400-e29b-41d4-a716-446655440002";
  const bytes = new TextEncoder().encode("this is not a PDF").buffer;
  const manifest = [evidenceEntry(businessId, incidentId, bytes, await sha256Hex(bytes))];
  await assert.rejects(
    verifyArticle44AuthorityEvidenceManifest(manifest, businessId, incidentId, async () => ({
      bytes,
      mimeType: "application/pdf",
    })),
    /declared MIME type/,
  );
});

test("Article 44 filing verifier checks PDF, PNG, JPEG and UTF-8 text signatures", async () => {
  const pngBytes = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).buffer;
  const jpegBytes = new Uint8Array([0xff,0xd8,0xff,0xd9]).buffer;
  const cases = [
    ["application/pdf","request.pdf",pdfBytes("valid request")],
    ["image/png","photo.png",pngBytes],
    ["image/jpeg","photo.jpg",jpegBytes],
    ["text/plain","notes.txt",new TextEncoder().encode("valid UTF-8 evidence").buffer],
  ];
  const manifest = await Promise.all(cases.map(async ([mimeType,fileName,bytes]) =>
    filingEntry("notice",mimeType,fileName,bytes,await sha256Hex(bytes))));
  const stored = new Map(cases.map((entry,index)=>[manifest[index].storage_path,{bytes:entry[2],mimeType:entry[0]}]));
  const verified = await verifyArticle44FilingEvidenceManifest(
    manifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"notice",
    async path => stored.get(path),
  );
  assert.equal(verified.length,cases.length);
});

test("Article 44 monthly evidence validates JSON and rejects invalid JSON bytes", async () => {
  const csvBytes = new TextEncoder().encode("coupon_id,total\r\n123,10.00").buffer;
  const pdf = pdfBytes("delivery acknowledgement");
  const json = new TextEncoder().encode('{"delivery":"recorded"}').buffer;
  const manifest = [
    filingEntry("monthly_submission","text/csv","untransmitted.csv",csvBytes,await sha256Hex(csvBytes)),
    filingEntry("monthly_submission","application/pdf","delivery.pdf",pdf,await sha256Hex(pdf)),
    filingEntry("monthly_submission","application/json","delivery.json",json,await sha256Hex(json)),
  ];
  const stored = new Map([
    [manifest[0].storage_path,{bytes:csvBytes,mimeType:"text/csv"}],
    [manifest[1].storage_path,{bytes:pdf,mimeType:"application/pdf"}],
    [manifest[2].storage_path,{bytes:json,mimeType:"application/json"}],
  ]);
  const verified = await verifyArticle44FilingEvidenceManifest(
    manifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"monthly_submission",
    async path => stored.get(path),
  );
  assert.equal(verified.length,3);

  const invalidJson = new TextEncoder().encode("{not-json}").buffer;
  const invalidManifest = [
    manifest[0],
    manifest[1],
    filingEntry("monthly_submission","application/json","invalid.json",invalidJson,await sha256Hex(invalidJson)),
  ];
  const invalidStored = new Map([
    [invalidManifest[0].storage_path,{bytes:csvBytes,mimeType:"text/csv"}],
    [invalidManifest[1].storage_path,{bytes:pdf,mimeType:"application/pdf"}],
    [invalidManifest[2].storage_path,{bytes:invalidJson,mimeType:"application/json"}],
  ]);
  await assert.rejects(
    verifyArticle44FilingEvidenceManifest(
      invalidManifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"monthly_submission",
      async path => invalidStored.get(path),
    ),
    /declared MIME type/,
  );
});

test("Article 44 text evidence rejects invalid UTF-8 and binary control bytes", async () => {
  const invalidUtf8 = new Uint8Array([0xff,0xfe,0xfd]).buffer;
  const manifest = [filingEntry("notice","text/plain","notes.txt",invalidUtf8,await sha256Hex(invalidUtf8))];
  await assert.rejects(
    verifyArticle44FilingEvidenceManifest(
      manifest,FILING_BUSINESS_ID,FILING_INCIDENT_ID,"notice",
      async () => ({bytes:invalidUtf8,mimeType:"text/plain"}),
    ),
    /declared MIME type/,
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
  const bytes = pdfBytes("actual notice filing evidence");
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
  const proofBytes = pdfBytes("ATK submission acknowledgement");
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
  const uploadedBytes = pdfBytes("uploaded evidence");
  const storedBytes = pdfBytes("tampered evidence");
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
  const bytes = pdfBytes("notice");
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
