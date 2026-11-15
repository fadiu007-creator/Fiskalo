// Server-side ATK TEST correction submission.
// The browser supplies only a signed POS coupon. It never supplies an ATK response,
// transaction ID, environment or acceptance status.
import { createClient } from "npm:@supabase/supabase-js@2.114.0";
import {
  assertAtkCorrectionIdentity,
  assertFullCorrectionMatchesOriginal,
  decodeAtkCorrectionIdentity,
  extractAtkTransactionId,
  isBase64,
  isUint64String,
  isUuid,
  type AtkCorrectionIdentity,
} from "./core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ATK_TEST_COUPON_URL = "https://fiskalizimi-test.atk-ks.org/pos/coupon";
const allowedOrigins = new Set([
  "https://fiskalo.shqiptare.workers.dev",
  "https://fiskalo.pages.dev",
  "http://localhost:3000",
]);
const baseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Pragma": "no-cache",
  "Vary": "Origin",
};

type JsonObject = Record<string, unknown>;
type SupabaseAdminClient = ReturnType<typeof createClient<any>>;
type SubmissionState = "accepted" | "rejected" | "needs_reconciliation";

function json(status: number, body: JsonObject, origin = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...baseHeaders,
      ...(origin && allowedOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    },
  });
}

async function readLimitedBody(request: Request, maximumBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("request_too_large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readLimitedResponse(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("atk_response_too_large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function sameCorrection(existing: JsonObject, expected: {
  businessId: string;
  saleId: string;
  originalCouponId: string;
  originalDocumentId: string;
  correctionCouponId: string;
  nuiKf: string;
  documentType: number;
  details: string;
  signature: string;
}): boolean {
  return existing.business_id === expected.businessId &&
    existing.sale_id === expected.saleId &&
    String(existing.coupon_id) === expected.correctionCouponId &&
    Number(existing.document_type) === expected.documentType &&
    String(existing.reference_coupon_id) === expected.originalCouponId &&
    existing.parent_document_id === expected.originalDocumentId &&
    existing.nui_kf === expected.nuiKf &&
    existing.signed_payload === expected.details &&
    existing.signature === expected.signature;
}

async function existingIdempotencyResult(
  admin: SupabaseAdminClient,
  idempotencyKey: string,
  expected: {
    businessId: string;
    saleId: string;
    originalCouponId: string;
    originalDocumentId: string;
    correctionCouponId: string;
    nuiKf: string;
    documentType: number;
    details: string;
    signature: string;
  },
  origin: string,
): Promise<Response | null> {
  const { data, error } = await admin.from("fiskalo_basic_fiscal_documents")
    .select("id,business_id,sale_id,coupon_id,document_type,reference_coupon_id,parent_document_id,nui_kf,signed_payload,signature,submission_state,atk_response")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) return json(500, { error: "idempotency_lookup_failed" }, origin);
  if (!data) return null;
  if (!sameCorrection(data, expected)) {
    return json(409, { error: "idempotency_key_conflict" }, origin);
  }
  if (data.submission_state === "accepted") {
    const response = data.atk_response as JsonObject | null;
    const transactionId = response?.transactionId;
    if (response?.status === "accepted" &&
        response.environment === "ATK TEST" &&
        response.verificationMethod === "direct-server-to-server-https" &&
        isUint64String(transactionId)) {
      return json(200, {
        accepted: true,
        transactionId,
        documentId: data.id,
        replay: true,
        environment: "ATK TEST",
        verificationMethod: "direct-server-to-server-https",
      }, origin);
    }
    return json(409, { error: "accepted_record_requires_reconciliation" }, origin);
  }
  if (data.submission_state === "rejected") {
    return json(409, { error: "correction_previously_rejected", retryWithNewCorrection: true }, origin);
  }
  return json(409, {
    error: "correction_already_submitted_or_unresolved",
    reconciliationRequired: true,
  }, origin);
}

async function setReservationState(
  admin: ReturnType<typeof createClient>,
  reservationId: string,
  state: SubmissionState,
  response: JsonObject,
  transactionId?: string,
): Promise<boolean> {
  const update: JsonObject = {
    submission_state: state,
    atk_response: response,
  };
  if (transactionId) update.atk_transaction_id = transactionId;
  const { data, error } = await admin.from("fiskalo_basic_fiscal_documents")
    .update(update)
    .eq("id", reservationId)
    .eq("submission_state", "submitted")
    .select("id")
    .maybeSingle();
  return !error && !!data;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  if (request.method === "OPTIONS") {
    if (!allowedOrigins.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        ...baseHeaders,
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, origin);
  if (origin && !allowedOrigins.has(origin)) return json(403, { error: "origin_not_allowed" });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(503, { error: "server_configuration_missing" }, origin);
  }

  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return json(401, { error: "authentication_required" }, origin);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return json(401, { error: "invalid_session" }, origin);

  let body: JsonObject;
  try {
    const raw = await readLimitedBody(request, 3_000_000);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
    body = parsed as JsonObject;
  } catch (error) {
    return json(error instanceof Error && error.message === "request_too_large" ? 413 : 400, {
      error: error instanceof Error && error.message === "request_too_large" ? "request_too_large" : "invalid_json",
    }, origin);
  }

  const businessId = body.businessId;
  const saleId = body.saleId;
  const originalCouponId = body.originalCouponId;
  const correctionCouponId = body.correctionCouponId;
  const documentType = body.documentType;
  const idempotencyKey = body.idempotencyKey;
  const details = body.detailsBase64;
  const signature = body.signatureBase64;

  if (!isUuid(businessId) || !isUuid(saleId) ||
      !isUint64String(originalCouponId) || !isUint64String(correctionCouponId) ||
      originalCouponId === correctionCouponId ||
      (documentType !== 2 && documentType !== 3) ||
      typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 ||
      idempotencyKey.length > 200 ||
      !isBase64(details) || !isBase64(signature, 4096)) {
    return json(400, { error: "invalid_correction_payload" }, origin);
  }

  const { data: member, error: memberError } = await admin.from("fiskalo_basic_members")
    .select("role")
    .eq("business_id", businessId)
    .eq("user_id", authData.user.id)
    .maybeSingle();
  if (memberError) return json(500, { error: "membership_check_failed" }, origin);
  if (member?.role !== "owner") return json(403, { error: "owner_access_required" }, origin);

  const { data: original, error: originalError } = await admin.from("fiskalo_basic_fiscal_documents")
    .select("id,business_id,sale_id,coupon_id,document_type,submission_state,nui_kf,signed_payload")
    .eq("business_id", businessId)
    .eq("sale_id", saleId)
    .eq("coupon_id", originalCouponId)
    .eq("document_type", 1)
    .eq("submission_state", "accepted")
    .gt("atk_transaction_id", "0")
    .maybeSingle();
  if (originalError) return json(500, { error: "original_coupon_lookup_failed" }, origin);
  if (!original) return json(409, { error: "original_sale_not_confirmed_by_atk" }, origin);

  const { data: sale, error: saleError } = await admin.from("fiskalo_basic_sales")
    .select("id,status,pos_id")
    .eq("id", saleId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (saleError) return json(500, { error: "sale_lookup_failed" }, origin);
  if (!sale || sale.status !== "fiscalized") return json(409, { error: "sale_not_fiscalized" }, origin);

  const { data: business, error: businessError } = await admin.from("fiskalo_basic_businesses")
    .select("nui")
    .eq("id", businessId)
    .maybeSingle();
  if (businessError) return json(500, { error: "business_lookup_failed" }, origin);
  if (!business?.nui) return json(409, { error: "business_nui_missing" }, origin);

  const { data: pos, error: posError } = await admin.from("fiskalo_basic_pos")
    .select("branch_id,pos_id,application_id,verification_no,certificate_status")
    .eq("id", sale.pos_id)
    .eq("business_id", businessId)
    .maybeSingle();
  if (posError) return json(500, { error: "pos_lookup_failed" }, origin);
  if (!pos || pos.certificate_status !== "certificate_issued" ||
      !pos.application_id || !pos.verification_no ||
      !isUint64String(String(pos.branch_id)) || !isUint64String(String(pos.pos_id)) ||
      !isUint64String(String(pos.application_id))) {
    return json(409, { error: "pos_test_certificate_or_identity_missing" }, origin);
  }

  let couponIdentity: AtkCorrectionIdentity;
  try {
    couponIdentity = decodeAtkCorrectionIdentity(details);
    assertAtkCorrectionIdentity(couponIdentity, {
      businessId: business.nui,
      couponId: correctionCouponId,
      branchId: String(pos.branch_id),
      posId: String(pos.pos_id),
      applicationId: String(pos.application_id),
      type: documentType,
      referenceNo: originalCouponId,
    });
    if (!original.nui_kf || couponIdentity.verificationNo === original.nui_kf) {
      throw new Error("Correction must use a new NUIKF, not the original coupon NUIKF.");
    }
    assertFullCorrectionMatchesOriginal(original.signed_payload, details);
  } catch (error) {
    return json(400, {
      error: "signed_correction_identity_mismatch",
      details: error instanceof Error ? error.message : "Invalid signed correction payload.",
    }, origin);
  }

  const expectedCorrection = {
    businessId,
    saleId,
    originalCouponId,
    originalDocumentId: original.id,
    correctionCouponId,
    nuiKf: couponIdentity.verificationNo,
    documentType,
    details,
    signature,
  };

  const replay = await existingIdempotencyResult(admin, idempotencyKey, expectedCorrection, origin);
  if (replay) return replay;

  const submittedAt = new Date().toISOString();
  const { data: reservation, error: reservationError } = await admin
    .from("fiskalo_basic_fiscal_documents")
    .insert({
      business_id: businessId,
      sale_id: saleId,
      coupon_id: correctionCouponId,
      idempotency_key: idempotencyKey,
      document_type: documentType,
      reference_coupon_id: originalCouponId,
      parent_document_id: original.id,
      nui_kf: couponIdentity.verificationNo,
      signed_payload: details,
      signature,
      submission_state: "submitted",
      atk_response: {
        status: "submitted",
        environment: "ATK TEST",
        submittedAt,
        verificationMethod: "direct-server-to-server-https",
      },
    })
    .select("id")
    .single();

  if (reservationError || !reservation) {
    if (reservationError?.code === "23505") {
      const raced = await existingIdempotencyResult(admin, idempotencyKey, expectedCorrection, origin);
      return raced ?? json(409, { error: "correction_coupon_or_cancellation_already_reserved" }, origin);
    }
    return json(500, { error: "correction_reservation_failed" }, origin);
  }

  let atkResponse: Response;
  let responseText: string;
  try {
    atkResponse = await fetch(ATK_TEST_COUPON_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ details, signature }),
      signal: AbortSignal.timeout(25_000),
    });
    responseText = await readLimitedResponse(atkResponse, 64_000);
  } catch {
    const recorded = await setReservationState(admin, reservation.id, "needs_reconciliation", {
      status: "needs_reconciliation",
      environment: "ATK TEST",
      reason: "ATK request outcome is unknown; automatic resubmission is disabled.",
      submittedAt,
      checkedAt: new Date().toISOString(),
    });
    return json(502, {
      error: "atk_outcome_unknown",
      accepted: false,
      reconciliationRequired: true,
      reservationRecorded: recorded,
    }, origin);
  }

  let atkBody: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_response");
    atkBody = parsed as JsonObject;
  } catch {
    const recorded = await setReservationState(admin, reservation.id, "needs_reconciliation", {
      status: "needs_reconciliation",
      environment: "ATK TEST",
      httpStatus: atkResponse.status,
      reason: "ATK returned an unreadable response; automatic resubmission is disabled.",
      submittedAt,
      checkedAt: new Date().toISOString(),
    });
    return json(502, {
      error: "atk_response_unreadable",
      accepted: false,
      reconciliationRequired: true,
      reservationRecorded: recorded,
    }, origin);
  }

  if (!atkResponse.ok) {
    const reason = typeof atkBody.error === "string" ? atkBody.error.slice(0, 500) : "ATK rejected the correction.";
    if (atkResponse.status >= 500) {
      const recorded = await setReservationState(admin, reservation.id, "needs_reconciliation", {
        status: "needs_reconciliation",
        environment: "ATK TEST",
        httpStatus: atkResponse.status,
        reason,
        submittedAt,
        checkedAt: new Date().toISOString(),
      });
      return json(502, {
        error: "atk_server_outcome_unknown",
        accepted: false,
        reconciliationRequired: true,
        reservationRecorded: recorded,
      }, origin);
    }
    const recorded = await setReservationState(admin, reservation.id, "rejected", {
      status: "rejected",
      environment: "ATK TEST",
      httpStatus: atkResponse.status,
      message: reason,
      submittedAt,
      receivedAt: new Date().toISOString(),
    });
    return json(422, {
      error: "atk_rejected_coupon",
      atkStatus: atkResponse.status,
      details: reason,
      rejectionRecorded: recorded,
    }, origin);
  }

  let transactionId: string | null;
  try {
    transactionId = extractAtkTransactionId(responseText);
  } catch {
    transactionId = null;
  }
  if (!transactionId) {
    const recorded = await setReservationState(admin, reservation.id, "needs_reconciliation", {
      status: "needs_reconciliation",
      environment: "ATK TEST",
      httpStatus: atkResponse.status,
      reason: "ATK success response did not contain an unambiguous valid uint64 transaction_id.",
      submittedAt,
      checkedAt: new Date().toISOString(),
    });
    return json(502, {
      error: "atk_response_missing_valid_transaction_id",
      accepted: false,
      reconciliationRequired: true,
      reservationRecorded: recorded,
    }, origin);
  }

  const acceptedAt = new Date().toISOString();
  const verifiedResponse = {
    status: "accepted",
    transactionId,
    environment: "ATK TEST",
    message: typeof atkBody.message === "string" ? atkBody.message.slice(0, 500) : "",
    httpStatus: atkResponse.status,
    submittedAt,
    receivedAt: acceptedAt,
    verificationMethod: "direct-server-to-server-https",
  };
  const recorded = await setReservationState(admin, reservation.id, "accepted", verifiedResponse, transactionId);
  if (!recorded) {
    return json(502, {
      error: "atk_accepted_but_persistence_unconfirmed",
      accepted: false,
      reconciliationRequired: true,
      transactionId,
    }, origin);
  }

  return json(200, {
    accepted: true,
    transactionId,
    documentId: reservation.id,
    environment: "ATK TEST",
    verificationMethod: "direct-server-to-server-https",
  }, origin);
});
