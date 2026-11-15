import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const ATK_TEST_ORIGIN = "https://fiskalizimi-test.atk-ks.org";
const MAX_BODY_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message, environment: "ATK TEST" }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function readProtoVarint(bytes: Uint8Array, state: { offset: number }): bigint {
  let value = BigInt(0);
  let shift = BigInt(0);
  for (let count = 0; count < 10; count++) {
    if (state.offset >= bytes.length) throw new Error("Signed ATK coupon protobuf is truncated.");
    const byte = bytes[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += BigInt(7);
  }
  throw new Error("Signed ATK coupon protobuf contains an invalid varint.");
}

function readCouponIdentity(detailsBase64: string) {
  let binary: string;
  try { binary = atob(detailsBase64); } catch { throw new Error("Signed coupon details are not valid base64."); }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const state = { offset: 0 };
  const values = new Map<number, bigint | string>();
  while (state.offset < bytes.length) {
    const tag = Number(readProtoVarint(bytes, state));
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field) throw new Error("Signed coupon protobuf contains an invalid field.");
    if (wire === 0) {
      if (values.has(field)) throw new Error("Signed coupon protobuf contains duplicate identity fields.");
      values.set(field, readProtoVarint(bytes, state));
    } else if (wire === 2) {
      const length = Number(readProtoVarint(bytes, state));
      if (!Number.isSafeInteger(length) || length < 0 || state.offset + length > bytes.length) throw new Error("Signed coupon protobuf has an invalid length.");
      const value = bytes.slice(state.offset, state.offset + length);
      state.offset += length;
      if ([4, 5, 8].includes(field)) {
        if (values.has(field)) throw new Error("Signed coupon protobuf contains duplicate identity fields.");
        values.set(field, new TextDecoder().decode(value));
      }
    } else if (wire === 5) {
      state.offset += 4;
    } else if (wire === 1) {
      state.offset += 8;
    } else {
      throw new Error("Signed coupon protobuf uses an unsupported wire type.");
    }
    if (state.offset > bytes.length) throw new Error("Signed coupon protobuf is truncated.");
  }
  return values;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, max = 8192): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(label + " is required and must be within the allowed length.");
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(label + " must be a positive integer.");
  return parsed;
}

async function supabaseRequest(path: string, token: string, anonKey: string) {
  const response = await fetch(path, {
    headers: {
      apikey: anonKey,
      Authorization: "Bearer " + token,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Supabase authorization or business lookup failed.");
  return payload;
}

async function atkPost<T extends JsonRecord>(path: string, body: JsonRecord): Promise<T> {
  const response = await fetch(ATK_TEST_ORIGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // Do not reflect ATK response bodies: they may contain identifiers or certificate data.
    throw new Error("ATK TEST rejected the request (HTTP " + response.status + ").");
  }
  if (!isRecord(payload)) throw new Error("ATK TEST returned an invalid JSON response.");
  return payload as T;
}

export async function POST(request: Request) {
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!configuredUrl || !anonKey) return jsonError("Supabase authentication is not configured.", 503);

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return jsonError("Request body is too large.", 413);

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || token.length > 8192) return jsonError("Sign in before using ATK TEST.", 401);

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return jsonError("Request body is too large.", 413);
    body = JSON.parse(raw);
  } catch {
    return jsonError("Request body must be valid JSON.", 400);
  }
  if (!isRecord(body)) return jsonError("Invalid request.", 400);

  try {
    const userResponse = await fetch(configuredUrl.replace(/\/$/, "") + "/auth/v1/user", {
      headers: { apikey: anonKey, Authorization: "Bearer " + token },
      cache: "no-store",
    });
    if (!userResponse.ok) return jsonError("Your session is invalid or expired.", 401);
    const user: unknown = await userResponse.json();
    if (!isRecord(user) || typeof user.id !== "string") return jsonError("Your session is invalid.", 401);

    const businessId = requiredString(body.businessId, "Business ID", 64);
    const restOrigin = configuredUrl.replace(/\/$/, "") + "/rest/v1/";
    const memberQuery = new URLSearchParams({
      select: "business_id,role",
      user_id: "eq." + user.id,
      business_id: "eq." + businessId,
      limit: "1",
    });
    const members = await supabaseRequest(restOrigin + "fiskalo_basic_members?" + memberQuery.toString(), token, anonKey);
    if (!Array.isArray(members) || members.length !== 1 || !isRecord(members[0])) return jsonError("You do not have access to this business.", 403);
    const memberRole = members[0].role;
    const action = requiredString(body.action, "Action", 24);
    if ((action === "verify" || action === "sign-csr") && memberRole !== "owner") {
      return jsonError("Only the business owner can verify a POS or request its ATK certificate.", 403);
    }

    const businessQuery = new URLSearchParams({
      select: "id,name,nui",
      id: "eq." + businessId,
      limit: "1",
    });
    const businesses = await supabaseRequest(restOrigin + "fiskalo_basic_businesses?" + businessQuery.toString(), token, anonKey);
    if (!Array.isArray(businesses) || businesses.length !== 1 || !isRecord(businesses[0])) {
      return jsonError("Business record was not found.", 404);
    }
    const business = businesses[0];
    if (action === "verify") {
      const nui = requiredPositiveInteger(business.nui, "Business NUI");
      const posRecordId = requiredString(body.posRecordId, "POS record ID", 64);
      const posQuery = new URLSearchParams({
        select: "id,branch_id,pos_id,application_id,verification_no,fiscalization_number",
        id: "eq." + posRecordId,
        business_id: "eq." + businessId,
        limit: "1",
      });
      const poses = await supabaseRequest(restOrigin + "fiskalo_basic_pos?" + posQuery.toString(), token, anonKey);
      if (!Array.isArray(poses) || poses.length !== 1 || !isRecord(poses[0])) return jsonError("POS does not belong to this business.", 403);
      const pos = poses[0];
      const fiscalizationNo = requiredString(pos.fiscalization_number, "ATK fiscalization number", 128);
      const applicationId = requiredPositiveInteger(pos.application_id, "Application ID");
      if (String(body.applicationId) !== String(pos.application_id)) return jsonError("Application ID does not match the saved POS configuration.", 409);
      const result = await atkPost<JsonRecord>("/ca/verify/" + nui, {
        fiscalization_no: fiscalizationNo,
        pos_id: requiredPositiveInteger(pos.pos_id, "POS ID"),
        branch_id: requiredPositiveInteger(pos.branch_id, "Branch ID"),
        application_id: applicationId,
      });
      const verificationCode = result.verification_code;
      if (!(typeof verificationCode === "string" || (typeof verificationCode === "number" && Number.isSafeInteger(verificationCode)))) {
        return jsonError("ATK TEST returned no valid verification code.", 502);
      }
      return NextResponse.json({
        businessName: typeof result.business_name === "string" ? result.business_name : String(business.name ?? ""),
        verificationCode: String(verificationCode),
        environment: "ATK TEST",
        productionEnabled: false,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "sign-csr") {
      const posRecordId = requiredString(body.posRecordId, "POS record ID", 64);
      const posQuery = new URLSearchParams({
        select: "id,branch_id,pos_id,application_id,verification_no,fiscalization_number",
        id: "eq." + posRecordId,
        business_id: "eq." + businessId,
        limit: "1",
      });
      const poses = await supabaseRequest(restOrigin + "fiskalo_basic_pos?" + posQuery.toString(), token, anonKey);
      if (!Array.isArray(poses) || poses.length !== 1 || !isRecord(poses[0])) return jsonError("POS does not belong to this business.", 403);
      const pos = poses[0];
      const result = await atkPost<JsonRecord>("/ca/signcsr", {
        business_name: requiredString(business.name, "Business name", 256),
        business_id: requiredPositiveInteger(business.nui, "Business NUI"),
        branch_id: requiredPositiveInteger(pos.branch_id, "Branch ID"),
        verification_no: requiredPositiveInteger(pos.verification_no, "ATK verification code"),
        pos_id: requiredPositiveInteger(pos.pos_id, "POS ID"),
        application_id: requiredPositiveInteger(body.applicationId, "Application ID"),
        csr: requiredString(body.csrPem, "Browser-generated CSR", 32_000),
      });
      if (typeof result.signed_certificate !== "string" || !result.signed_certificate.includes("BEGIN CERTIFICATE")) {
        return jsonError("ATK TEST returned no valid signed certificate.", 502);
      }
      return NextResponse.json({
        signedCertificate: result.signed_certificate,
        environment: "ATK TEST",
        productionEnabled: false,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "coupon") {
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!serviceRoleKey) return jsonError("Server-side fiscal ledger is not configured. Coupon submission is disabled until SUPABASE_SERVICE_ROLE_KEY is set as a Cloudflare secret.", 503);

      const details = requiredString(body.details, "Signed coupon details", 200_000);
      const signature = requiredString(body.signature, "Coupon signature", 256);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return jsonError("Coupon signature is not valid base64.", 400);
      const posRecordId = requiredString(body.posRecordId, "POS record ID", 64);
      const posQuery = new URLSearchParams({
        select: "id,branch_id,pos_id,application_id,verification_no",
        id: "eq." + posRecordId,
        business_id: "eq." + businessId,
        limit: "1",
      });
      const poses = await supabaseRequest(restOrigin + "fiskalo_basic_pos?" + posQuery.toString(), token, anonKey);
      if (!Array.isArray(poses) || poses.length !== 1 || !isRecord(poses[0])) return jsonError("POS does not belong to this business.", 403);
      const pos = poses[0];

      const saleId = requiredString(body.saleId, "Sale ID", 64);
      const couponId = requiredPositiveInteger(body.couponId, "Coupon ID");
      const saleQuery = new URLSearchParams({
        select: "id,coupon_id,pos_id,status",
        id: "eq." + saleId,
        business_id: "eq." + businessId,
        pos_id: "eq." + posRecordId,
        limit: "1",
      });
      const sales = await supabaseRequest(restOrigin + "fiskalo_basic_sales?" + saleQuery.toString(), token, anonKey);
      if (!Array.isArray(sales) || sales.length !== 1 || !isRecord(sales[0]) ||
          Number(sales[0].coupon_id) !== couponId || !["paid", "fiscalized"].includes(String(sales[0].status))) {
        return jsonError("Sale does not belong to the selected business and POS, or is not payable.", 409);
      }

      const couponIdentity = readCouponIdentity(details);
      const expected: Array<[number, bigint]> = [
        [1, BigInt(business.nui as string)],
        [3, BigInt(requiredPositiveInteger(pos.branch_id, "Branch ID"))],
        [6, BigInt(requiredPositiveInteger(pos.pos_id, "POS ID"))],
        [7, BigInt(requiredPositiveInteger(pos.application_id, "Application ID"))],
      ];
      for (const [field, value] of expected) {
        if (couponIdentity.get(field) !== value) return jsonError("Signed coupon identifiers do not match the selected business and POS.", 409);
      }
      if (couponIdentity.get(2) !== BigInt(couponId)) return jsonError("Signed coupon number does not match the paid sale.", 409);
      if (couponIdentity.get(8) !== String(pos.verification_no)) return jsonError("Signed coupon verification number does not match the saved POS.", 409);

      const idempotencyKey = requiredString(body.idempotencyKey, "Fiscal idempotency key", 256);
      const nuiKf = requiredString(body.nuiKf, "NUIKF", 16);
      const citizenPayload = requiredString(body.citizenPayload, "Signed CitizenCoupon payload", 200_000);
      const citizenSignature = requiredString(body.citizenSignature, "CitizenCoupon signature", 256);
      const dailyNumber = requiredPositiveInteger(body.dailyNumber, "Daily coupon number");
      const qrSvgBase64 = requiredString(body.qrSvgBase64, "CitizenCoupon QR SVG", 1_500_000);
      const offlineIssuedAt = body.offlineIssuedAt == null ? null : requiredString(body.offlineIssuedAt, "Offline issue timestamp", 64);
      if (!/^[A-Z0-9]{16}$/.test(nuiKf)) return jsonError("NUIKF must be 16 uppercase alphanumeric characters.", 400);

      const existingQuery = new URLSearchParams({
        select: "submission_state,atk_transaction_id",
        idempotency_key: "eq." + idempotencyKey,
        limit: "1",
      });
      const existingDocs = await supabaseRequest(restOrigin + "fiskalo_basic_fiscal_documents?" + existingQuery.toString(), token, anonKey);
      if (Array.isArray(existingDocs) && existingDocs.length === 1 && isRecord(existingDocs[0])) {
        const existing = existingDocs[0];
        if (existing.submission_state === "accepted" && existing.atk_transaction_id != null) {
          return jsonError("This fiscal document is already accepted by ATK. Do not submit it again.", 409);
        }
        return jsonError("This fiscal document already exists in the journal and requires reconciliation before another submission.", 409);
      }

      // ATK is the authority for acceptance. No client-supplied status or transaction ID is trusted.
      const result = await atkPost<JsonRecord>("/pos/coupon", { details, signature });
      const transactionId = result.transaction_id;
      const transactionIdText = typeof transactionId === "string"
        ? transactionId
        : typeof transactionId === "number" && Number.isSafeInteger(transactionId)
          ? String(transactionId) : "";
      if (!/^[1-9][0-9]{0,19}$/.test(transactionIdText) ||
          BigInt(transactionIdText) > BigInt("18446744073709551615")) {
        return jsonError("ATK TEST returned no valid uint64 transaction_id; the document is not marked accepted.", 502);
      }

      const trustedResponse = {
        status: "accepted",
        transactionId: transactionIdText,
        message: typeof result.message === "string" ? result.message : "",
        environment: "ATK TEST",
      };
      const persistResponse = await fetch(restOrigin + "rpc/fiskalo_basic_server_record_atk_receipt", {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: "Bearer " + serviceRoleKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          p_actor_id: user.id,
          p_business_id: businessId,
          p_sale_id: saleId,
          p_pos_record_id: posRecordId,
          p_coupon_id: couponId,
          p_idempotency_key: idempotencyKey,
          p_signed_payload: details,
          p_signature: signature,
          p_atk_transaction_id: transactionIdText,
          p_atk_response: trustedResponse,
          p_nui_kf: nuiKf,
          p_citizen_payload: citizenPayload,
          p_citizen_signature: citizenSignature,
          p_daily_number: dailyNumber,
          p_offline_issued_at: offlineIssuedAt,
          p_qr_svg_base64: qrSvgBase64,
        }),
        cache: "no-store",
      });
      if (!persistResponse.ok) {
        // ATK has already accepted this coupon. Never let the UI retry it blindly.
        return NextResponse.json({
          error: "ATK accepted the coupon (transaction " + transactionIdText + "), but the trusted fiscal ledger could not persist it. Do not resubmit; reconcile this transaction.",
          status: "accepted_not_persisted",
          transactionId: transactionIdText,
          environment: "ATK TEST",
        }, { status: 502, headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json({
        ...trustedResponse,
        persisted: true,
        productionEnabled: false,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    return jsonError("Unsupported ATK TEST action.", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ATK TEST request failed.";
    const status = message.includes("required") || message.includes("must be") ? 400 : 502;
    return jsonError(message, status);
  }
}
