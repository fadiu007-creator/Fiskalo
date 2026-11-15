import test from "node:test";
import assert from "node:assert/strict";
import recovery from "../workers/atk-recovery.ts";

const originalFetch = globalThis.fetch;
const now = new Date();
const doc = {
  id: "doc-1",
  business_id: "business-1",
  sale_id: "sale-1",
  coupon_id: "123",
  idempotency_key: "123:1:2:123",
  document_type: 1,
  signed_payload: "cG9z",
  signature: "c2ln",
  nui_kf: "0123456789ABCDEF",
  verification_no: "0123456789ABCDEF",
  citizen_payload: "Y2l0aXplbg==",
  citizen_signature: "c2ln",
  daily_number: 1,
  offline_issued_at: new Date(now.getTime() - 60_000).toISOString(),
  recovery_deadline_at: new Date(now.getTime() + 47 * 60 * 60_000).toISOString(),
  qr_svg_base64: "PHN2Zy8+",
  attempt_count: 0,
  next_attempt_at: null,
};
const sale = { id: "sale-1", operator_id: "user-1", pos_id: "pos-1", coupon_id: "123" };
const pos = { id: "pos-1", branch_id: 1, pos_id: 2, application_id: 3, certificate_status: "certificate_issued" };

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function runWorker(atkBehavior, deadline = doc.recovery_deadline_at) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/fiskalo_basic_fiscal_documents?") && method === "GET") {
      if (url.includes("submission_state=eq.queued")) return response([{ ...doc, recovery_deadline_at: deadline }]);
      return response([]);
    }
    if (url.includes("/fiskalo_basic_fiscal_documents?") && method === "PATCH") {
      if (url.includes("submission_state=eq.queued")) return response([{ id: doc.id }]);
      return response([{ id: doc.id }]);
    }
    if (url.includes("/fiskalo_basic_sales?")) return response([sale]);
    if (url.includes("/fiskalo_basic_pos?")) return response([pos]);
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
