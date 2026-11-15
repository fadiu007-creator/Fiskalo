// Server-side ATK TEST correction submission.
// The browser supplies the signed coupon, never an alleged ATK response.
// ATK's documented response is unsigned JSON; trust comes from this direct HTTPS
// request to the fixed ATK TEST origin, not from a browser-provided transaction ID.
import { createClient } from "npm:@supabase/supabase-js@2.114.0";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ATK = "https://fiskalizimi-test.atk-ks.org/pos/coupon";
const allowedOrigins = new Set([
  "https://fiskalo.shqiptare.workers.dev",
  "https://fiskalo.pages.dev",
  "http://localhost:3000",
]);
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};
const json = (status: number, body: Record<string, unknown>, origin?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, ...(origin && allowedOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}) },
  });
const uint64 = (v: unknown) => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) &&
  BigInt(v) > 0n && BigInt(v) <= 18446744073709551615n;
const uuid = (v: unknown) => typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const b64 = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 2_000_000 &&
  /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") {
    if (!allowedOrigins.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: {
      ...headers, "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    }});
  }
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, origin);
  if (origin && !allowedOrigins.has(origin)) return json(403, { error: "origin_not_allowed" });
  const authorization = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  if (!token) return json(401, { error: "authentication_required" }, origin);

  const userClient = createClient(URL, ANON, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return json(401, { error: "invalid_session" }, origin);

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 3_000_000) return json(413, { error: "request_too_large" }, origin);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad_body");
    body = parsed;
  } catch {
    return json(400, { error: "invalid_json" }, origin);
  }

  const businessId = body.businessId;
  const saleId = body.saleId;
  const originalCouponId = body.originalCouponId;
  const correctionCouponId = body.correctionCouponId;
  const documentType = body.documentType;
  const idempotencyKey = body.idempotencyKey;
  const details = body.detailsBase64;
  const signature = body.signatureBase64;
  if (!uuid(businessId) || !uuid(saleId) || typeof originalCouponId !== "string" || !uint64(originalCouponId) ||
      typeof correctionCouponId !== "string" || !uint64(correctionCouponId) || originalCouponId === correctionCouponId ||
      (documentType !== 2 && documentType !== 3) ||
      typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200 ||
      !b64(details) || !b64(signature)) {
    return json(400, { error: "invalid_correction_payload" }, origin);
  }

  const { data: member, error: memberError } = await admin.from("fiskalo_basic_members")
    .select("role").eq("business_id", businessId).eq("user_id", authData.user.id).maybeSingle();
  if (memberError) return json(500, { error: "membership_check_failed" }, origin);
  if (!member) return json(403, { error: "business_access_denied" }, origin);

  const { data: original, error: originalError } = await admin.from("fiskalo_basic_fiscal_documents")
    .select("id,business_id,sale_id,coupon_id,document_type,submission_state,atk_transaction_id")
    .eq("business_id", businessId).eq("sale_id", saleId)
    .eq("coupon_id", originalCouponId).eq("document_type", 1)
    .eq("submission_state", "accepted").maybeSingle();
  if (originalError) return json(500, { error: "original_coupon_lookup_failed" }, origin);
  if (!original || !original.atk_transaction_id || Number(original.atk_transaction_id) <= 0) {
    return json(409, { error: "original_sale_not_confirmed_by_atk" }, origin);
  }

  const { data: sale, error: saleError } = await admin.from("fiskalo_basic_sales")
    .select("id,status").eq("id", saleId).eq("business_id", businessId).maybeSingle();
  if (saleError) return json(500, { error: "sale_lookup_failed" }, origin);
  if (!sale || sale.status !== "fiscalized") return json(409, { error: "sale_not_fiscalized" }, origin);

  const { data: existing, error: existingError } = await admin.from("fiskalo_basic_fiscal_documents")
    .select("id,business_id,sale_id,coupon_id,document_type,reference_coupon_id,signed_payload,signature,submission_state,atk_transaction_id")
    .eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existingError) return json(500, { error: "idempotency_lookup_failed" }, origin);
  if (existing) {
    if (existing.business_id !== businessId || existing.sale_id !== saleId ||
        String(existing.coupon_id) !== String(correctionCouponId) ||
        existing.document_type !== documentType || String(existing.reference_coupon_id) !== String(originalCouponId) ||
        existing.signed_payload !== details || existing.signature !== signature) {
      return json(409, { error: "idempotency_key_conflict" }, origin);
    }
    if (existing.submission_state === "accepted") {
      return json(200, { accepted: true, transactionId: String(existing.atk_transaction_id), documentId: existing.id, replay: true, environment: "ATK TEST" }, origin);
    }
    return json(409, { error: "correction_already_exists_unresolved" }, origin);
  }

  if (documentType === 2) {
    const { data: cancel, error: cancelError } = await admin.from("fiskalo_basic_fiscal_documents")
      .select("id").eq("parent_document_id", original.id).eq("document_type", 2)
      .in("submission_state", ["queued", "submitted", "accepted", "needs_reconciliation"]).limit(1);
    if (cancelError) return json(500, { error: "cancellation_lookup_failed" }, origin);
    if (cancel?.length) return json(409, { error: "cancellation_already_exists" }, origin);
  }

  let atkResponse: Response;
  let responseText: string;
  try {
    atkResponse = await fetch(ATK, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ details, signature }),
      signal: AbortSignal.timeout(25_000),
    });
    responseText = await atkResponse.text();
  } catch {
    return json(502, { error: "atk_unreachable", accepted: false, reconciliationRequired: true }, origin);
  }
  let atkBody: Record<string, unknown>;
  let rawTransactionId: string | null = null;
  try {
    const parsed = JSON.parse(responseText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad_response");
    atkBody = parsed;
    // Preserve the exact uint64 JSON token; JavaScript Number would round large IDs.
    const match = /"transaction_id"\\s*:\\s*(?:"([0-9]+)"|([0-9]+))/.exec(responseText);
    rawTransactionId = match?.[1] ?? match?.[2] ?? null;
  } catch {
    return json(502, { error: "atk_invalid_response", accepted: false, reconciliationRequired: true }, origin);
  }
  if (!atkResponse.ok) {
    return json(422, { error: "atk_rejected_coupon", atkStatus: atkResponse.status, details: atkBody.error ?? "ATK rejected the correction" }, origin);
  }
  if (!rawTransactionId || !uint64(rawTransactionId)) {
    return json(502, { error: "atk_response_missing_valid_transaction_id", accepted: false, reconciliationRequired: true }, origin);
  }
  const transactionId = rawTransactionId;
  const verifiedResponse = {
    status: "accepted",
    transactionId,
    environment: "ATK TEST",
    message: typeof atkBody.message === "string" ? atkBody.message : "",
    receivedAt: new Date().toISOString(),
    verificationMethod: "direct-server-to-server-https",
  };

  const { data: inserted, error: insertError } = await admin.from("fiskalo_basic_fiscal_documents")
    .insert({
      business_id: businessId,
      sale_id: saleId,
      coupon_id: correctionCouponId,
      idempotency_key: idempotencyKey,
      document_type: documentType,
      reference_coupon_id: originalCouponId,
      parent_document_id: original.id,
      signed_payload: details,
      signature,
      atk_transaction_id: transactionId,
      submission_state: "accepted",
      atk_response: verifiedResponse,
    }).select("id").single();
  if (insertError) {
    // ATK has already accepted it; never retry submission blindly. Record as unresolved.
    return json(502, { error: "atk_accepted_but_persistence_failed", accepted: false, reconciliationRequired: true, transactionId }, origin);
  }
  return json(200, {
    accepted: true, transactionId, documentId: inserted.id,
    environment: "ATK TEST", verificationMethod: "direct-server-to-server-https",
  }, origin);
});
