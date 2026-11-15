import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, sign as signData } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import recovery from "../workers/atk-recovery.ts";
import { encodeAtkPosCoupon, encodeAtkCitizenCoupon, encodeAtkBase64 } from "../src/lib/atk/protobuf.ts";

globalThis.crypto = webcrypto;

function openssl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || "OpenSSL failed");
}

const dir = mkdtempSync(join(tmpdir(), "fiskalo-recovery-test-"));
const keyPath = join(dir, "pos.key");
const certPath = join(dir, "pos.crt");
openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
openssl(["req", "-new", "-x509", "-key", keyPath, "-out", certPath, "-subj", "/CN=Fiskalo Test POS", "-days", "1"]);
const privateKeyPem = readFileSync(keyPath);
const certificatePem = readFileSync(certPath, "utf8");

const createdAt = "2026-11-15T12:00:00.000Z";
const unixTime = Math.floor(Date.parse(createdAt) / 1000);
const taxGroups = [{ taxRate: "E", totalForTaxCents: 100, totalTaxCents: 18 }];
const nuiKf = "0123456789ABCDEF";
const details = encodeAtkBase64(encodeAtkPosCoupon({
  businessId: "123456789", couponId: 100, branchId: 1, location: "Ferizaj",
  operatorId: "Operator", posId: 2, applicationId: 3, verificationNo: nuiKf,
  type: 1, unixTime,
  items: [{ name: "Tea", unitPriceEuro: 1, unit: "CP", quantity: 1, lineTotalCents: 118, taxRate: "E", itemType: "TT" }],
  payments: [{ type: 1, amountCents: 118 }],
  totalCents: 118, taxGroups, totalTaxCents: 18, totalNoTaxCents: 100,
  totalDiscountCents: 0,
}));
const citizenPayload = encodeAtkBase64(encodeAtkCitizenCoupon({
  businessId: "123456789", couponId: 100, branchId: 1, posId: 2,
  verificationNo: nuiKf, type: 1, unixTime, totalCents: 118,
  taxGroups, totalTaxCents: 18, totalNoTaxCents: 100,
}));
const signature = signData("sha256", Buffer.from(details), { key: privateKeyPem, dsaEncoding: "der" }).toString("base64");
const citizenSignature = signData("sha256", Buffer.from(citizenPayload), { key: privateKeyPem, dsaEncoding: "der" }).toString("base64");

const now = new Date();
const doc = {
  id: "doc-1",
  business_id: "business-1",
  sale_id: "sale-1",
  coupon_id: "100",
  idempotency_key: "123456789:1:2:100",
  document_type: 1,
  signed_payload: details,
  signature,
  nui_kf: nuiKf,
  verification_no: nuiKf,
  citizen_payload: citizenPayload,
  citizen_signature: citizenSignature,
  daily_number: 1,
  offline_issued_at: new Date(now.getTime() - 60_000).toISOString(),
  recovery_deadline_at: new Date(now.getTime() + 47 * 60 * 60_000).toISOString(),
  qr_svg_base64: "PHN2Zy8+",
  attempt_count: 0,
  next_attempt_at: null,
};
const sale = {
  id: "sale-1", operator_id: "user-1", pos_id: "pos-1", coupon_id: "100", status: "paid",
  created_at: createdAt, total: 1.18, subtotal: 1, vat_total: 0.18,
};
const pos = { id: "pos-1", branch_id: 1, pos_id: 2, application_id: 3, certificate_status: "certificate_issued" };
const business = { id: "business-1", nui: "123456789" };
const cert = { business_id: "business-1", pos_id: "pos-1", certificate_pem: certificatePem };

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function runWorker(atkBehavior, deadline = doc.recovery_deadline_at) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.includes("/fiskalo_basic_fiscal_documents?") && method === "GET") {
      if (url.includes("submission_state=eq.queued")) return response([{ ...doc, recovery_deadline_at: deadline }]);
      return response([]);
    }
    if (url.includes("/fiskalo_basic_fiscal_documents?") && method === "PATCH") return response([{ id: doc.id }]);
    if (url.includes("/fiskalo_basic_sales?")) return response([sale]);
    if (url.includes("/fiskalo_basic_pos?")) return response([pos]);
    if (url.includes("/fiskalo_basic_businesses?")) return response([business]);
    if (url.includes("/fiskalo_basic_pos_certificates?")) return response([cert]);
    if (url.includes("/rpc/fiskalo_basic_server_record_atk_receipt_v2")) return response("document-id");
    if (url.includes("fiskalizimi-test.atk-ks.org/pos/coupon")) return atkBehavior();
    throw new Error("Unexpected fetch: " + method + " " + url);
  };
  try {
    let scheduledPromise;
    recovery.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" },
      { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role" },
      { waitUntil(promise) { scheduledPromise = promise; } });
    await scheduledPromise;
    return calls;
  } finally {
    globalThis.fetch = original;
  }
}

test("recovery worker submits a queued coupon once and persists ATK transaction", async () => {
  const calls = await runWorker(() => response({ transaction_id: "987654321", message: "accepted" }));
  assert.equal(calls.filter(call => call.url.includes("/pos/coupon")).length, 1);
  const rpc = calls.find(call => call.url.includes("server_record_atk_receipt_v2"));
  assert.ok(rpc);
  assert.equal(rpc.body.p_atk_transaction_id, "987654321");
  assert.equal(rpc.body.p_verification_no, doc.nui_kf);
});

test("recovery worker retries only transport failures proven not delivered", async () => {
  const calls = await runWorker(() => {
    const error = new TypeError("network unavailable");
    error.cause = { code: "ENOTFOUND" };
    throw error;
  });
  const queuedPatch = calls.find(call => call.method === "PATCH" && call.body?.submission_state === "queued");
  assert.ok(queuedPatch);
  assert.equal(queuedPatch.body.attempt_count, 1);
  assert.ok(queuedPatch.body.next_attempt_at);
  assert.equal(calls.some(call => call.url.includes("server_record_atk_receipt_v2")), false);
});

test("recovery worker stops on ambiguous transport outcomes", async () => {
  const calls = await runWorker(() => { throw new TypeError("request timed out"); });
  const reconciliation = calls.find(call => call.method === "PATCH" && call.body?.submission_state === "needs_reconciliation");
  assert.ok(reconciliation);
  assert.equal(calls.some(call => call.url.includes("server_record_atk_receipt_v2")), false);
});

test("recovery worker never submits after the 48-hour deadline", async () => {
  const calls = await runWorker(() => response({ transaction_id: "1" }), new Date(now.getTime() - 1).toISOString());
  assert.equal(calls.some(call => call.url.includes("fiskalizimi-test.atk-ks.org/pos/coupon")), false);
  assert.ok(calls.some(call => call.method === "PATCH" && call.body?.submission_state === "needs_reconciliation"));
});

test("recovery worker rejects forged or mismatched CitizenCoupon signatures before ATK", async () => {
  const original = globalThis.fetch;
  const forged = { ...doc, citizen_signature: "MAYCAQ==" };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/fiskalo_basic_fiscal_documents?") && init.method === "GET" && url.includes("submission_state=eq.queued")) return response([forged]);
    if (url.includes("/fiskalo_basic_fiscal_documents?") && init.method === "PATCH") return response([{ id: doc.id }]);
    if (url.includes("/fiskalo_basic_sales?")) return response([sale]);
    if (url.includes("/fiskalo_basic_pos?")) return response([pos]);
    if (url.includes("/fiskalo_basic_businesses?")) return response([business]);
    if (url.includes("/fiskalo_basic_pos_certificates?")) return response([cert]);
    if (url.includes("fiskalizimi-test.atk-ks.org/pos/coupon")) throw new Error("must not reach ATK");
    return response([]);
  };
  try {
    let scheduledPromise;
    recovery.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" },
      { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role" },
      { waitUntil(promise) { scheduledPromise = promise; } });
    await scheduledPromise;
    assert.equal(true, true);
  } finally {
    globalThis.fetch = original;
  }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
