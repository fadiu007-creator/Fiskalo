import { NextResponse } from "next/server";
import { createCitizenQrSvg } from "@/lib/atk/citizen-qr";
import { encodeAtkBase64 } from "@/lib/atk/protobuf";

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

function readDerNode(bytes: Uint8Array, offset: number) {
  if (offset + 2 > bytes.length) throw new Error("Invalid DER data.");
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 4 || cursor + count > bytes.length) throw new Error("Invalid DER length.");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++];
  }
  const end = cursor + length;
  if (end > bytes.length) throw new Error("Truncated DER data.");
  return { tag, start: offset, contentStart: cursor, end };
}

function getCertificateSpki(certificatePem: string): Uint8Array {
  const body = certificatePem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const cert = readDerNode(bytes, 0);
  if (cert.tag !== 0x30) throw new Error("POS certificate is not a DER sequence.");
  const tbs = readDerNode(bytes, cert.contentStart);
  if (tbs.tag !== 0x30) throw new Error("POS certificate has no TBSCertificate.");
  let cursor = tbs.contentStart;
  let node = readDerNode(bytes, cursor);
  if (node.tag === 0xa0) { cursor = node.end; node = readDerNode(bytes, cursor); }
  for (let i = 0; i < 5; i++) { cursor = node.end; node = readDerNode(bytes, cursor); }
  if (node.tag !== 0x30) throw new Error("POS certificate has no SubjectPublicKeyInfo.");
  return bytes.slice(node.start, node.end);
}

function getCsrSpki(csrPem: string): Uint8Array {
  const body = csrPem.replace(/-----BEGIN CERTIFICATE REQUEST-----|-----END CERTIFICATE REQUEST-----|\s/g, "");
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const request = readDerNode(bytes, 0);
  if (request.tag !== 0x30) throw new Error("PKCS#10 request is not a DER sequence.");
  const info = readDerNode(bytes, request.contentStart);
  if (info.tag !== 0x30) throw new Error("PKCS#10 request has no CertificationRequestInfo.");
  let cursor = info.contentStart;
  let node = readDerNode(bytes, cursor); // version
  cursor = node.end;
  node = readDerNode(bytes, cursor); // subject
  cursor = node.end;
  node = readDerNode(bytes, cursor); // SubjectPublicKeyInfo
  if (node.tag !== 0x30) throw new Error("PKCS#10 request has no SubjectPublicKeyInfo.");
  return bytes.slice(node.start, node.end);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
  return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
}

function derSignatureToP1363(signatureBase64: string): Uint8Array {
  const binary = atob(signatureBase64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  // WebCrypto and .NET ECDsa.SignHash both use fixed-width IEEE-P1363 (r || s).
  if (bytes.length === 64) return bytes;
  const sequence = readDerNode(bytes, 0);
  if (sequence.tag !== 0x30 || sequence.end !== bytes.length) throw new Error("ECDSA signature must be a DER sequence.");
  const r = readDerNode(bytes, sequence.contentStart);
  const s = readDerNode(bytes, r.end);
  if (r.tag !== 0x02 || s.tag !== 0x02 || s.end !== sequence.end) throw new Error("ECDSA DER signature is malformed.");
  const normalize = (node: {contentStart:number;end:number}) => {
    let value = bytes.slice(node.contentStart, node.end);
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error("ECDSA signature integer is too large.");
    const result = new Uint8Array(32);
    result.set(value, 32 - value.length);
    return result;
  };
  const raw = new Uint8Array(64);
  raw.set(normalize(r), 0);
  raw.set(normalize(s), 32);
  return raw;
}

async function verifySignedBase64Payload(certificatePem: string, payloadBase64: string, signatureBase64: string) {
  const spki = getCertificateSpki(certificatePem);
  const publicKey = await crypto.subtle.importKey(
    "spki", Uint8Array.from(spki).buffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Uint8Array.from(derSignatureToP1363(signatureBase64)).buffer,
    new TextEncoder().encode(payloadBase64),
  );
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

async function setTrustedSubmissionState(
  restOrigin: string,
  serviceRoleKey: string,
  idempotencyKey: string,
  state: "rejected" | "needs_reconciliation",
  reason: string,
): Promise<boolean> {
  const response = await fetch(restOrigin + "rpc/fiskalo_basic_server_set_atk_submission_state_v2", {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: "Bearer " + serviceRoleKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      p_idempotency_key: idempotencyKey,
      p_submission_state: state,
      p_last_error: reason.slice(0, 500),
    }),
    cache: "no-store",
  });
  return response.ok;
}

async function setTrustedCorrectionState(
  restOrigin: string,
  serviceRoleKey: string,
  idempotencyKey: string,
  state: "rejected" | "needs_reconciliation",
  reason: string,
): Promise<boolean> {
  const response = await fetch(restOrigin + "rpc/fiskalo_basic_server_set_atk_correction_state_v1", {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: "Bearer " + serviceRoleKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      p_idempotency_key: idempotencyKey,
      p_submission_state: state,
      p_last_error: reason.slice(0, 500),
    }),
    cache: "no-store",
  });
  return response.ok;
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

class AtkRejected extends Error {
  readonly statusCode: number;
  constructor(statusCode: number) {
    super("ATK TEST rejected the coupon (HTTP " + statusCode + ").");
    this.name = "AtkRejected";
    this.statusCode = statusCode;
  }
}

class AtkTransportFailure extends Error {
  readonly delivery: "not_delivered" | "unknown";
  constructor(delivery: "not_delivered" | "unknown", message: string) {
    super(message);
    this.name = "AtkTransportFailure";
    this.delivery = delivery;
  }
}

function transportFailureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { code?: unknown; cause?: unknown; message?: unknown };
  if (typeof value.code === "string") return value.code.toUpperCase();
  const cause = value.cause && typeof value.cause === "object" ? value.cause as { code?: unknown; message?: unknown } : null;
  if (cause && typeof cause.code === "string") return cause.code.toUpperCase();
  const message = [cause?.message, value.message].filter(v => typeof v === "string").join(" ");
  const match = message.match(/\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/i);
  return match ? match[1].toUpperCase() : "";
}

async function atkPost<T extends JsonRecord>(path: string, body: JsonRecord): Promise<T> {
  let response: Response;
  try {
    response = await fetch(ATK_TEST_ORIGIN + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const code = transportFailureCode(error);
    const safeBeforeDelivery = ["ENOTFOUND","EAI_AGAIN","ECONNREFUSED","EHOSTUNREACH","ENETUNREACH",
      "ERR_TLS_CERT_ALTNAME_INVALID","CERT_HAS_EXPIRED","UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code);
    if (safeBeforeDelivery) {
      throw new AtkTransportFailure("not_delivered", "ATK TEST could not be reached before request delivery (" + code + "). The signed coupon may be safely queued for recovery.");
    }
    throw new AtkTransportFailure("unknown", "ATK TEST delivery outcome is unknown. Do not resubmit until reconciled.");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // A 4xx is a definite rejection; a 5xx does not prove the coupon was not processed.
    if (response.status >= 400 && response.status < 500) throw new AtkRejected(response.status);
    throw new AtkTransportFailure("unknown", "ATK TEST returned HTTP " + response.status + "; delivery outcome requires reconciliation.");
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
    if (["reserve-correction","correction","queue-correction"].includes(action) && memberRole !== "owner") {
      return jsonError("Only the business owner can cancel or return a fiscalized sale.", 403);
    }
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
    if (action === "reserve-correction") {
      const saleId = requiredString(body.saleId, "Original sale ID", 64);
      const documentType = requiredPositiveInteger(body.documentType, "Correction document type");
      if (documentType !== 2 && documentType !== 3) return jsonError("Correction type must be Cancel (2) or Return (3).", 400);
      const idempotencyKey = requiredString(body.idempotencyKey, "Correction idempotency key", 256);
      const reserveResponse = await fetch(restOrigin + "rpc/fiskalo_basic_reserve_atk_correction", {
        method: "POST",
        headers: { apikey: anonKey, Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          p_business_id: businessId,
          p_sale_id: saleId,
          p_document_type: documentType,
          p_idempotency_key: idempotencyKey,
        }),
        cache: "no-store",
      });
      const reservation: unknown = await reserveResponse.json().catch(() => null);
      if (!reserveResponse.ok || !isRecord(reservation)) return jsonError("ATK correction could not reserve a unique coupon and daily number.", 409);
      return NextResponse.json({ ...reservation, environment: "ATK TEST", productionEnabled: false }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (action === "verify") {
      const nui = requiredPositiveInteger(business.nui, "Business NUI");
      const posRecordId = requiredString(body.posRecordId, "POS record ID", 64);
      const posQuery = new URLSearchParams({
        select: "id,branch_id,pos_id,application_id,verification_no,fiscalization_number,verified_business_name",
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
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!serviceRoleKey) return jsonError("Server-side POS certificate registry is not configured. Set SUPABASE_SERVICE_ROLE_KEY as a Cloudflare secret.", 503);
      const posRecordId = requiredString(body.posRecordId, "POS record ID", 64);
      const posQuery = new URLSearchParams({
        select: "id,branch_id,pos_id,application_id,verification_no,fiscalization_number,verified_business_name",
        id: "eq." + posRecordId,
        business_id: "eq." + businessId,
        limit: "1",
      });
      const poses = await supabaseRequest(restOrigin + "fiskalo_basic_pos?" + posQuery.toString(), token, anonKey);
      if (!Array.isArray(poses) || poses.length !== 1 || !isRecord(poses[0])) return jsonError("POS does not belong to this business.", 403);
      const pos = poses[0];
      const applicationId = requiredPositiveInteger(pos.application_id, "Application ID");
      if (String(body.applicationId) !== String(applicationId)) return jsonError("Application ID does not match the saved POS configuration.", 409);
      if (String(body.verificationCode) !== String(pos.verification_no)) return jsonError("ATK verification code does not match the saved POS verification.", 409);
      const csrPem = requiredString(body.csrPem, "Browser-generated CSR", 32_000);
      const result = await atkPost<JsonRecord>("/ca/signcsr", {
        business_name: requiredString(pos.verified_business_name || business.name, "Verified business name", 256),
        business_id: requiredPositiveInteger(business.nui, "Business NUI"),
        branch_id: requiredPositiveInteger(pos.branch_id, "Branch ID"),
        verification_code: requiredString(pos.verification_no, "ATK verification code", 128),
        pos_id: requiredPositiveInteger(pos.pos_id, "POS ID"),
        application_id: applicationId,
        csr: csrPem,
      });
      if (typeof result.signed_certificate !== "string" || !result.signed_certificate.includes("BEGIN CERTIFICATE")) {
        return jsonError("ATK TEST returned no valid signed certificate.", 502);
      }
      if (!equalBytes(getCsrSpki(csrPem), getCertificateSpki(result.signed_certificate))) {
        return jsonError("ATK TEST certificate public key does not match the submitted browser CSR. Certificate was not registered.", 502);
      }
      const certificatePersist = await fetch(restOrigin + "rpc/fiskalo_basic_server_register_pos_certificate_v1", {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: "Bearer " + serviceRoleKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          p_business_id: businessId,
          p_pos_record_id: posRecordId,
          p_application_id: applicationId,
          p_certificate_pem: result.signed_certificate,
          p_spki_sha256: await sha256Hex(getCertificateSpki(result.signed_certificate)),
          p_verified_business_name: String(pos.verified_business_name || business.name || ""),
        }),
        cache: "no-store",
      });
      if (!certificatePersist.ok) {
        return jsonError("ATK issued the certificate, but atomic POS certificate registration failed. Reconcile this certificate before requesting another.", 502);
      }
      return NextResponse.json({
        signedCertificate: result.signed_certificate,
        environment: "ATK TEST",
        productionEnabled: false,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "correction" || action === "queue-correction") {
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!serviceRoleKey) return jsonError("Server-side correction ledger is not configured.", 503);
      const posRecordId = requiredString(body.posRecordId, "POS record ID", 64);
      const saleId = requiredString(body.saleId, "Original sale ID", 64);
      const documentType = requiredPositiveInteger(body.documentType, "Correction type");
      if (documentType !== 2 && documentType !== 3) return jsonError("Correction type must be Cancel (2) or Return (3).", 400);
      const correctionCouponId = requiredPositiveInteger(body.correctionCouponId, "Correction coupon ID");
      const originalCouponId = requiredPositiveInteger(body.originalCouponId, "Original coupon ID");
      const originalTransactionId = requiredString(body.originalTransactionId, "Original ATK transaction ID", 20);
      if (!/^[1-9][0-9]{0,19}$/.test(originalTransactionId) || BigInt(originalTransactionId) > BigInt("18446744073709551615")) {
        return jsonError("Original ATK transaction ID is invalid.", 400);
      }
      const idempotencyKey = requiredString(body.idempotencyKey, "Correction idempotency key", 256);
      const nuiKf = requiredString(body.nuiKf, "Correction NUIKF", 16);
      if (!/^[A-Z0-9]{16}$/.test(nuiKf)) return jsonError("Correction NUIKF must contain 16 uppercase alphanumeric characters.", 400);
      const dailyNumber = requiredPositiveInteger(body.dailyNumber, "Correction daily number");
      const unixTime = requiredPositiveInteger(body.unixTime, "Correction timestamp");
      if (Math.abs(Math.floor(Date.now() / 1000) - unixTime) > 300) return jsonError("Correction timestamp is outside the allowed five-minute window.", 400);
      const details = requiredString(body.details, "Signed correction details", 200_000);
      const signature = requiredString(body.signature, "Correction signature", 256);
      const citizenPayload = requiredString(body.citizenPayload, "CitizenCoupon payload", 200_000);
      const citizenSignature = requiredString(body.citizenSignature, "CitizenCoupon signature", 256);
      const certificatePemFromBrowser = requiredString(body.certificatePem, "POS public certificate", 16_384);
      const offlineIssuedAt = body.offlineIssuedAt == null ? null : requiredString(body.offlineIssuedAt, "Offline issue timestamp", 64);

      const posQuery = new URLSearchParams({
        select: "id,branch_id,pos_id,application_id,verification_no,certificate_status",
        id: "eq." + posRecordId,
        business_id: "eq." + businessId,
        limit: "1",
      });
      const poses = await supabaseRequest(restOrigin + "fiskalo_basic_pos?" + posQuery.toString(), token, anonKey);
      if (!Array.isArray(poses) || poses.length !== 1 || !isRecord(poses[0])) return jsonError("POS does not belong to this business.", 403);
      const pos = poses[0];
      if (pos.certificate_status !== "certificate_issued") return jsonError("This POS has no issued ATK TEST certificate.", 409);

      const saleQuery = new URLSearchParams({
        select: "id,coupon_id,pos_id,status,total,subtotal,vat_total,daily_number",
        id: "eq." + saleId,
        business_id: "eq." + businessId,
        pos_id: "eq." + posRecordId,
        limit: "1",
      });
      const sales = await supabaseRequest(restOrigin + "fiskalo_basic_sales?" + saleQuery.toString(), token, anonKey);
      if (!Array.isArray(sales) || sales.length !== 1 || !isRecord(sales[0]) ||
          String(sales[0].coupon_id) !== String(originalCouponId) || sales[0].status !== "fiscalized") {
        return jsonError("Only the accepted original sale can be cancelled or returned.", 409);
      }

      const adminHeaders = { apikey: serviceRoleKey, Authorization: "Bearer " + serviceRoleKey, Accept: "application/json" };
      const originalQuery = new URLSearchParams({
        select: "id,coupon_id,atk_transaction_id,submission_state,document_type",
        business_id: "eq." + businessId,
        sale_id: "eq." + saleId,
        coupon_id: "eq." + originalCouponId,
        document_type: "eq.1",
        submission_state: "eq.accepted",
        limit: "1",
      });
      const originalResponse = await fetch(restOrigin + "fiskalo_basic_fiscal_documents?" + originalQuery.toString(), {
        headers: adminHeaders, cache: "no-store",
      });
      if (!originalResponse.ok) return jsonError("Could not verify the original accepted ATK document.", 502);
      const originals: unknown = await originalResponse.json();
      if (!Array.isArray(originals) || originals.length !== 1 || !isRecord(originals[0]) ||
          String(originals[0].atk_transaction_id) !== originalTransactionId) {
        return jsonError("Original ATK transaction does not match the accepted sale.", 409);
      }
      const reservationQuery = new URLSearchParams({
        select: "business_id,sale_id,pos_id,document_type,original_coupon_id,original_transaction_id,correction_coupon_id,daily_number,idempotency_key,created_by,status",
        business_id: "eq." + businessId,
        sale_id: "eq." + saleId,
        idempotency_key: "eq." + idempotencyKey,
        limit: "1",
      });
      const reservationResponse = await fetch(restOrigin + "fiskalo_basic_correction_reservations?" + reservationQuery.toString(), {
        headers: adminHeaders, cache: "no-store",
      });
      if (!reservationResponse.ok) return jsonError("Could not verify the correction reservation.", 502);
      const reservations: unknown = await reservationResponse.json();
      if (!Array.isArray(reservations) || reservations.length !== 1 || !isRecord(reservations[0])) return jsonError("Correction reservation was not found.", 409);
      const reservation = reservations[0];
      if (reservation.created_by !== user.id || String(reservation.pos_id) !== posRecordId ||
          Number(reservation.document_type) !== documentType ||
          String(reservation.original_coupon_id) !== String(originalCouponId) ||
          String(reservation.original_transaction_id) !== originalTransactionId ||
          String(reservation.correction_coupon_id) !== String(correctionCouponId) ||
          Number(reservation.daily_number) !== dailyNumber ||
          !["reserved","submitting","queued"].includes(String(reservation.status))) {
        return jsonError("Correction reservation does not match the authenticated user or signed coupon.", 409);
      }

      const certResponse = await fetch(restOrigin + "fiskalo_basic_pos_certificates?" + new URLSearchParams({
        select: "certificate_pem",
        business_id: "eq." + businessId,
        pos_id: "eq." + posRecordId,
        limit: "1",
      }).toString(), { headers: adminHeaders, cache: "no-store" });
      if (!certResponse.ok) return jsonError("Could not load the server-registered ATK certificate.", 502);
      const certRows: unknown = await certResponse.json();
      if (!Array.isArray(certRows) || certRows.length !== 1 || !isRecord(certRows[0])) return jsonError("No ATK certificate is registered for this POS.", 409);
      const certificatePem = requiredString(certRows[0].certificate_pem, "ATK-issued POS certificate", 16_384);
      if (certificatePemFromBrowser.trim() !== certificatePem.trim()) return jsonError("Browser certificate does not match the server-registered ATK certificate.", 409);

      const couponIdentity = readCouponIdentity(details);
      const expectedUnixTime = BigInt(unixTime);
      const expectedPos: Array<[number,bigint]> = [
        [1,BigInt(business.nui as string)],[2,BigInt(correctionCouponId)],
        [3,BigInt(requiredPositiveInteger(pos.branch_id,"Branch ID"))],
        [6,BigInt(requiredPositiveInteger(pos.pos_id,"POS ID"))],
        [7,BigInt(requiredPositiveInteger(pos.application_id,"Application ID"))],
        [9,BigInt(documentType)],[10,expectedUnixTime],
        [13,BigInt(Math.round(Number(sales[0].total)*100))],
        [15,BigInt(Math.round(Number(sales[0].vat_total)*100))],
        [16,BigInt(Math.round(Number(sales[0].subtotal)*100))],
        [17,BigInt(originalCouponId)],
      ];
      for (const [field,value] of expectedPos) if (couponIdentity.get(field)!==value) return jsonError("Signed correction coupon identifiers, reference or totals do not match the original sale.", 409);
      if (couponIdentity.get(18)!==undefined && couponIdentity.get(18)!==BigInt(0)) return jsonError("Correction payload must reference the original coupon using ReferenceNo only.", 409);
      if (couponIdentity.get(8)!==nuiKf) return jsonError("Correction NUIKF / VerificationNo mismatch.", 409);
      const citizenIdentity = readCouponIdentity(citizenPayload);
      const expectedCitizen: Array<[number,bigint]> = [
        [1,BigInt(business.nui as string)],[2,BigInt(correctionCouponId)],
        [3,BigInt(requiredPositiveInteger(pos.branch_id,"Branch ID"))],
        [4,BigInt(requiredPositiveInteger(pos.pos_id,"POS ID"))],
        [6,BigInt(documentType)],[7,expectedUnixTime],
        [8,BigInt(Math.round(Number(sales[0].total)*100))],
        [10,BigInt(Math.round(Number(sales[0].vat_total)*100))],
        [11,BigInt(Math.round(Number(sales[0].subtotal)*100))],
      ];
      for (const [field,value] of expectedCitizen) if (citizenIdentity.get(field)!==value) return jsonError("CitizenCoupon correction identifiers or totals do not match.", 409);
      if (citizenIdentity.get(5)!==nuiKf) return jsonError("CitizenCoupon NUIKF / VerificationNo mismatch.", 409);
      const [posSignatureValid,citizenSignatureValid]=await Promise.all([
        verifySignedBase64Payload(certificatePem,details,signature),
        verifySignedBase64Payload(certificatePem,citizenPayload,citizenSignature),
      ]);
      if (!posSignatureValid || !citizenSignatureValid) return jsonError("Correction POS or CitizenCoupon signature is invalid.", 400);
      const qrSvg = await createCitizenQrSvg(citizenPayload + "|" + citizenSignature);
      const qrSvgBase64 = encodeAtkBase64(new TextEncoder().encode(qrSvg));
      const existingCorrectionQuery = new URLSearchParams({
        select: "submission_state,recovery_deadline_at",
        business_id: "eq." + businessId,
        idempotency_key: "eq." + idempotencyKey,
        limit: "1",
      });
      const existingCorrectionResponse = await fetch(restOrigin + "fiskalo_basic_fiscal_documents?" + existingCorrectionQuery.toString(), {
        headers: adminHeaders, cache: "no-store",
      });
      if (!existingCorrectionResponse.ok) return jsonError("Could not verify the existing correction journal state.", 502);
      const existingCorrections: unknown = await existingCorrectionResponse.json();
      if (Array.isArray(existingCorrections) && existingCorrections.length === 1 && isRecord(existingCorrections[0])) {
        if (existingCorrections[0].submission_state === "queued" && action === "queue-correction") {
          return NextResponse.json({ status: "queued", recoveryDeadlineAt: existingCorrections[0].recovery_deadline_at, environment: "ATK TEST", productionEnabled: false }, {
            headers: { "Cache-Control": "no-store" },
          });
        }
        if (action !== "queue-correction" || existingCorrections[0].submission_state !== "submitting") {
          return jsonError("Correction already exists with status " + String(existingCorrections[0].submission_state) + ". Reconciliation is required.", 409);
        }
      }

      const beginResponse = await fetch(restOrigin + "rpc/fiskalo_basic_server_begin_atk_correction_v2", {
        method: "POST",
        headers: { apikey: serviceRoleKey, Authorization: "Bearer " + serviceRoleKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          p_actor_id: user.id,p_business_id: businessId,p_sale_id: saleId,p_pos_record_id: posRecordId,
          p_original_coupon_id: originalCouponId,p_correction_coupon_id: correctionCouponId,p_document_type: documentType,
          p_idempotency_key: idempotencyKey,p_signed_payload: details,p_signature: signature,p_nui_kf: nuiKf,
          p_verification_no: nuiKf,p_citizen_payload: citizenPayload,p_citizen_signature: citizenSignature,
          p_daily_number: dailyNumber,p_qr_svg_base64: qrSvgBase64,
        }),
        cache: "no-store",
      });
      if (!beginResponse.ok) return jsonError("Correction could not be reserved in the trusted fiscal journal.", 409);

      if (action === "queue-correction") {
        if (!offlineIssuedAt) return jsonError("Offline correction timestamp is required.", 400);
        const queueResponse = await fetch(restOrigin + "rpc/fiskalo_basic_server_queue_atk_correction_v1", {
          method: "POST",
          headers: { apikey: serviceRoleKey, Authorization: "Bearer " + serviceRoleKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            p_actor_id: user.id,p_business_id: businessId,p_sale_id: saleId,p_pos_record_id: posRecordId,
            p_original_coupon_id: originalCouponId,p_correction_coupon_id: correctionCouponId,p_document_type: documentType,
            p_idempotency_key: idempotencyKey,p_signed_payload: details,p_signature: signature,p_nui_kf: nuiKf,
            p_verification_no: nuiKf,p_citizen_payload: citizenPayload,p_citizen_signature: citizenSignature,
            p_daily_number: dailyNumber,p_offline_issued_at: offlineIssuedAt,p_qr_svg_base64: qrSvgBase64,
          }),
          cache: "no-store",
        });
        if (!queueResponse.ok) return jsonError("Signed correction could not be stored in the ATK recovery queue.", 502);
        return NextResponse.json({ status: "queued", recoveryDeadlineAt: new Date(Date.parse(offlineIssuedAt)+48*60*60*1000).toISOString(), environment: "ATK TEST", productionEnabled: false }, {
          headers: { "Cache-Control": "no-store" },
        });
      }

      let result: JsonRecord;
      try {
        result = await atkPost<JsonRecord>("/pos/coupon", { details, signature });
      } catch (error) {
        if (error instanceof AtkRejected) {
          await setTrustedCorrectionState(restOrigin, serviceRoleKey, idempotencyKey, "rejected", error.message);
          return NextResponse.json({ error: error.message, status: "rejected", environment: "ATK TEST" }, { status: 422, headers: { "Cache-Control": "no-store" } });
        }
        if (error instanceof AtkTransportFailure && error.delivery === "not_delivered") {
          const recoveryIssuedAt = new Date().toISOString();
          const queueResponse = await fetch(restOrigin + "rpc/fiskalo_basic_server_queue_atk_correction_v1", {
            method: "POST",
            headers: { apikey: serviceRoleKey, Authorization: "Bearer " + serviceRoleKey, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              p_actor_id: user.id,p_business_id: businessId,p_sale_id: saleId,p_pos_record_id: posRecordId,
              p_original_coupon_id: originalCouponId,p_correction_coupon_id: correctionCouponId,p_document_type: documentType,
              p_idempotency_key: idempotencyKey,p_signed_payload: details,p_signature: signature,p_nui_kf: nuiKf,
              p_verification_no: nuiKf,p_citizen_payload: citizenPayload,p_citizen_signature: citizenSignature,
              p_daily_number: dailyNumber,p_offline_issued_at: recoveryIssuedAt,p_qr_svg_base64: qrSvgBase64,
            }),
            cache: "no-store",
          });
          if (!queueResponse.ok) {
            return NextResponse.json({ error: "ATK was not reached, but the signed correction could not be placed in the trusted recovery queue.", status: "needs_reconciliation" }, {
              status: 502, headers: { "Cache-Control": "no-store" },
            });
          }
          return NextResponse.json({
            error: error.message, notDelivered: true, status: "queued",
            recoveryDeadlineAt: new Date(Date.parse(recoveryIssuedAt) + 48 * 60 * 60 * 1000).toISOString(),
            environment: "ATK TEST",
          }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        if (error instanceof AtkTransportFailure) {
          await setTrustedCorrectionState(restOrigin, serviceRoleKey, idempotencyKey, "needs_reconciliation", error.message);
          return NextResponse.json({ error: error.message, status: "needs_reconciliation", environment: "ATK TEST" }, { status: 502, headers: { "Cache-Control": "no-store" } });
        }
        throw error;
      }
      const rawTransactionId = result.transaction_id;
      const transactionId = typeof rawTransactionId === "string" ? rawTransactionId :
        typeof rawTransactionId === "number" && Number.isSafeInteger(rawTransactionId) ? String(rawTransactionId) : "";
      if (!/^[1-9][0-9]{0,19}$/.test(transactionId) || BigInt(transactionId)>BigInt("18446744073709551615")) {
        await setTrustedCorrectionState(restOrigin, serviceRoleKey, idempotencyKey, "needs_reconciliation", "ATK returned no valid correction transaction_id.");
        return jsonError("ATK returned no valid correction transaction_id; do not resubmit.", 502);
      }
      const trustedResponse={status:"accepted",transactionId,message:typeof result.message==="string"?result.message:"",environment:"ATK TEST"};
      const recordResponse=await fetch(restOrigin+"rpc/fiskalo_basic_server_record_atk_correction_v2",{
        method:"POST",
        headers:{apikey:serviceRoleKey,Authorization:"Bearer "+serviceRoleKey,"Content-Type":"application/json",Accept:"application/json"},
        body:JSON.stringify({
          p_actor_id:user.id,p_business_id:businessId,p_sale_id:saleId,p_original_coupon_id:originalCouponId,
          p_correction_coupon_id:correctionCouponId,p_document_type:documentType,p_idempotency_key:idempotencyKey,
          p_signed_payload:details,p_signature:signature,p_atk_transaction_id:transactionId,p_atk_response:trustedResponse,
          p_nui_kf:nuiKf,p_verification_no:nuiKf,p_citizen_payload:citizenPayload,p_citizen_signature:citizenSignature,
          p_daily_number:dailyNumber,p_qr_svg_base64:qrSvgBase64,
        }),
        cache:"no-store",
      });
      if (!recordResponse.ok) {
        await setTrustedCorrectionState(restOrigin, serviceRoleKey, idempotencyKey, "needs_reconciliation", "ATK accepted correction transaction "+transactionId+" but trusted persistence failed.");
        return NextResponse.json({ error:"ATK accepted the correction (transaction "+transactionId+") but the trusted ledger update failed. Do not resubmit.",status:"accepted_not_persisted",transactionId,environment:"ATK TEST" },{status:502,headers:{"Cache-Control":"no-store"}});
      }
      return NextResponse.json({ status:"accepted",transactionId,message:trustedResponse.message,persisted:true,qrSvgBase64,environment:"ATK TEST",productionEnabled:false },{headers:{"Cache-Control":"no-store"}});
    }

    if (action === "coupon" || action === "queue-coupon") {
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!serviceRoleKey) return jsonError("Server-side fiscal ledger is not configured. Coupon submission is disabled until SUPABASE_SERVICE_ROLE_KEY is set as a Cloudflare secret.", 503);

      const details = requiredString(body.details, "Signed coupon details", 200_000);
      const signature = requiredString(body.signature, "Coupon signature", 256);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return jsonError("Coupon signature is not valid base64.", 400);
      const posRecordId = requiredString(body.posRecordId, "POS record ID", 64);
      const posQuery = new URLSearchParams({
        select: "id,branch_id,pos_id,application_id,verification_no,certificate_status",
        id: "eq." + posRecordId,
        business_id: "eq." + businessId,
        limit: "1",
      });
      const poses = await supabaseRequest(restOrigin + "fiskalo_basic_pos?" + posQuery.toString(), token, anonKey);
      if (!Array.isArray(poses) || poses.length !== 1 || !isRecord(poses[0])) return jsonError("POS does not belong to this business.", 403);
      const pos = poses[0];
      if (pos.certificate_status !== "certificate_issued") return jsonError("This POS does not have an issued ATK TEST certificate.", 409);

      const saleId = requiredString(body.saleId, "Sale ID", 64);
      const couponId = requiredPositiveInteger(body.couponId, "Coupon ID");
      const saleQuery = new URLSearchParams({
        select: "id,coupon_id,pos_id,status,created_at,total,subtotal,vat_total,daily_number",
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

      const nuiKf = requiredString(body.nuiKf, "NUIKF", 16);
      if (!/^[A-Z0-9]{16}$/.test(nuiKf)) return jsonError("NUIKF must be 16 uppercase alphanumeric characters.", 400);
      const couponIdentity = readCouponIdentity(details);
      const verificationNo = nuiKf;
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
      if (couponIdentity.get(8) !== nuiKf) return jsonError("Signed coupon VerificationNo must match the per-coupon NUIKF.", 409);
      const expectedUnixTime = BigInt(Math.floor(new Date(String(sales[0].created_at)).getTime() / 1000));
      if (couponIdentity.get(9) !== BigInt(1) || couponIdentity.get(10) !== expectedUnixTime ||
          couponIdentity.get(13) !== BigInt(Math.round(Number(sales[0].total) * 100)) ||
          couponIdentity.get(15) !== BigInt(Math.round(Number(sales[0].vat_total) * 100)) ||
          couponIdentity.get(16) !== BigInt(Math.round(Number(sales[0].subtotal) * 100))) {
        return jsonError("Signed POS coupon type, timestamp or totals do not match the paid sale.", 409);
      }

      const idempotencyKey = requiredString(body.idempotencyKey, "Fiscal idempotency key", 256);
      const citizenPayload = requiredString(body.citizenPayload, "Signed CitizenCoupon payload", 200_000);
      const citizenSignature = requiredString(body.citizenSignature, "CitizenCoupon signature", 256);
      const dailyNumber = requiredPositiveInteger(body.dailyNumber, "Daily coupon number");
      if (dailyNumber !== requiredPositiveInteger(sales[0].daily_number, "Saved daily coupon number")) return jsonError("Daily coupon number does not match the saved sale.", 409);
      const certResponse = await fetch(restOrigin + "fiskalo_basic_pos_certificates?" + new URLSearchParams({
        select: "certificate_pem,business_id,pos_id",
        business_id: "eq." + businessId,
        pos_id: "eq." + posRecordId,
        limit: "1",
      }).toString(), { headers: { apikey: serviceRoleKey, Authorization: "Bearer " + serviceRoleKey }, cache: "no-store" });
      if (!certResponse.ok) return jsonError("Could not load the server-registered ATK certificate for this POS.", 502);
      const certRows: unknown = await certResponse.json();
      if (!Array.isArray(certRows) || certRows.length !== 1 || !isRecord(certRows[0])) return jsonError("No ATK-issued public certificate is registered for this POS.", 409);
      const certificatePem = requiredString(certRows[0].certificate_pem, "ATK-issued POS public certificate", 16_384);
      if (String(body.certificatePem).trim() !== certificatePem.trim()) return jsonError("Browser certificate does not match the server-registered ATK certificate for this POS.", 409);
      const offlineIssuedAt = body.offlineIssuedAt == null ? null : requiredString(body.offlineIssuedAt, "Offline issue timestamp", 64);
      const citizenIdentity = readCouponIdentity(citizenPayload);
      const citizenExpected: Array<[number, bigint]> = [
        [1, BigInt(business.nui as string)],
        [2, BigInt(couponId)],
        [3, BigInt(requiredPositiveInteger(pos.branch_id, "Branch ID"))],
        [4, BigInt(requiredPositiveInteger(pos.pos_id, "POS ID"))],
        [6, BigInt(1)],
        [7, expectedUnixTime],
        [8, BigInt(Math.round(Number(sales[0].total) * 100))],
        [10, BigInt(Math.round(Number(sales[0].vat_total) * 100))],
        [11, BigInt(Math.round(Number(sales[0].subtotal) * 100))],
      ];
      for (const [field, value] of citizenExpected) {
        if (citizenIdentity.get(field) !== value) return jsonError("CitizenCoupon QR identifiers or totals do not match the paid POS sale.", 409);
      }
      if (citizenIdentity.get(5) !== nuiKf) return jsonError("CitizenCoupon VerificationNo must match the per-coupon NUIKF.", 409);
      const [posSignatureValid, citizenSignatureValid] = await Promise.all([
        verifySignedBase64Payload(certificatePem, details, signature),
        verifySignedBase64Payload(certificatePem, citizenPayload, citizenSignature),
      ]);
      if (!posSignatureValid || !citizenSignatureValid) return jsonError("POS or CitizenCoupon signature does not verify against the installed POS certificate.", 400);
      const qrSvg = await createCitizenQrSvg(citizenPayload + "|" + citizenSignature);
      const qrSvgBase64 = encodeAtkBase64(new TextEncoder().encode(qrSvg));

      if (action === "queue-coupon") {
        if (!offlineIssuedAt) return jsonError("Offline issue timestamp is required for the recovery queue.", 400);
        const queuedQuery = new URLSearchParams({
          select: "submission_state,atk_transaction_id,recovery_deadline_at",
          idempotency_key: "eq." + idempotencyKey,
          limit: "1",
        });
        const existingQueue = await supabaseRequest(restOrigin + "fiskalo_basic_fiscal_documents?" + queuedQuery.toString(), token, anonKey);
        if (Array.isArray(existingQueue) && existingQueue.length === 1 && isRecord(existingQueue[0])) {
          if (existingQueue[0].submission_state === "queued") {
            return NextResponse.json({
              status: "queued",
              recoveryDeadlineAt: existingQueue[0].recovery_deadline_at,
              environment: "ATK TEST",
              productionEnabled: false,
            }, { headers: { "Cache-Control": "no-store" } });
          }
          if (existingQueue[0].submission_state !== "submitting") {
            return jsonError("This fiscal document already exists with status " + String(existingQueue[0].submission_state) + ". Reconciliation is required before further action.", 409);
          }
        }
        const queueResponse = await fetch(restOrigin + "rpc/fiskalo_basic_server_queue_atk_receipt_v2", {
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
            p_nui_kf: nuiKf,
            p_verification_no: verificationNo,
            p_citizen_payload: citizenPayload,
            p_citizen_signature: citizenSignature,
            p_daily_number: dailyNumber,
            p_offline_issued_at: offlineIssuedAt,
            p_qr_svg_base64: qrSvgBase64,
          }),
          cache: "no-store",
        });
        if (!queueResponse.ok) return jsonError("Signed offline coupon could not be saved to the trusted ATK recovery queue.", 502);
        return NextResponse.json({
          status: "queued",
          recoveryDeadlineAt: new Date(Date.parse(offlineIssuedAt) + 48 * 60 * 60 * 1000).toISOString(),
          environment: "ATK TEST",
          productionEnabled: false,
        }, { headers: { "Cache-Control": "no-store" } });
      }

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

      const beginResponse = await fetch(restOrigin + "rpc/fiskalo_basic_server_begin_atk_submission_v2", {
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
          p_nui_kf: nuiKf,
          p_verification_no: verificationNo,
          p_citizen_payload: citizenPayload,
          p_citizen_signature: citizenSignature,
          p_daily_number: dailyNumber,
          p_qr_svg_base64: qrSvgBase64,
        }),
        cache: "no-store",
      });
      if (!beginResponse.ok) return jsonError("Signed coupon could not be reserved in the trusted fiscal journal; no ATK request was sent.", 409);

      // ATK is the authority for acceptance. No client-supplied status or transaction ID is trusted.
      let result: JsonRecord;
      try {
        result = await atkPost<JsonRecord>("/pos/coupon", { details, signature });
      } catch (error) {
        if (error instanceof AtkRejected) {
          const recorded = await setTrustedSubmissionState(restOrigin, serviceRoleKey, idempotencyKey, "rejected", error.message);
          if (!recorded) return jsonError("ATK rejected the coupon, but the trusted journal could not be updated. Reconcile before any further action.", 502);
          return NextResponse.json({ error: error.message, status: "rejected", environment: "ATK TEST" }, {
            status: 422, headers: { "Cache-Control": "no-store" },
          });
        }
        if (error instanceof AtkTransportFailure && error.delivery === "not_delivered") {
          const recoveryIssuedAt = new Date().toISOString();
          const queueResponse = await fetch(restOrigin + "rpc/fiskalo_basic_server_queue_atk_receipt_v2", {
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
              p_nui_kf: nuiKf,
              p_verification_no: verificationNo,
              p_citizen_payload: citizenPayload,
              p_citizen_signature: citizenSignature,
              p_daily_number: dailyNumber,
              p_offline_issued_at: recoveryIssuedAt,
              p_qr_svg_base64: qrSvgBase64,
            }),
            cache: "no-store",
          });
          if (!queueResponse.ok) {
            return NextResponse.json({ error: "ATK was not reached, but the signed coupon could not be placed in the trusted recovery queue.", status: "needs_reconciliation" }, {
              status: 502, headers: { "Cache-Control": "no-store" },
            });
          }
          return NextResponse.json({
            error: error.message,
            notDelivered: true,
            status: "queued",
            recoveryDeadlineAt: new Date(Date.parse(recoveryIssuedAt) + 48 * 60 * 60 * 1000).toISOString(),
            environment: "ATK TEST",
          }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        if (error instanceof AtkTransportFailure) {
          const recorded = await setTrustedSubmissionState(restOrigin, serviceRoleKey, idempotencyKey, "needs_reconciliation", error.message);
          if (!recorded) return jsonError("ATK delivery is ambiguous and the trusted journal could not be updated. Do not retry.", 502);
          return NextResponse.json({ error: error.message, status: "needs_reconciliation", environment: "ATK TEST" }, {
            status: 502, headers: { "Cache-Control": "no-store" },
          });
        }
        throw error;
      }
      const transactionId = result.transaction_id;
      const transactionIdText = typeof transactionId === "string"
        ? transactionId
        : typeof transactionId === "number" && Number.isSafeInteger(transactionId)
          ? String(transactionId) : "";
      if (!/^[1-9][0-9]{0,19}$/.test(transactionIdText) ||
          BigInt(transactionIdText) > BigInt("18446744073709551615")) {
        await setTrustedSubmissionState(restOrigin, serviceRoleKey, idempotencyKey, "needs_reconciliation", "ATK returned no valid uint64 transaction_id.");
        return jsonError("ATK TEST returned no valid uint64 transaction_id; the document is not marked accepted.", 502);
      }

      const trustedResponse = {
        status: "accepted",
        transactionId: transactionIdText,
        message: typeof result.message === "string" ? result.message : "",
        environment: "ATK TEST",
      };
      const persistResponse = await fetch(restOrigin + "rpc/fiskalo_basic_server_record_atk_receipt_v2", {
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
          p_verification_no: verificationNo,
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
        await setTrustedSubmissionState(restOrigin, serviceRoleKey, idempotencyKey, "needs_reconciliation", "ATK accepted transaction " + transactionIdText + " but the trusted ledger update failed.");
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
        qrSvgBase64,
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
