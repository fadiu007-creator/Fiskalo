export type AtkReceiptActor = { id: string };
export type AtkReceiptBusiness = { nui: string | number };
export type AtkReceiptPos = {
  id: string;
  businessId: string;
  branchId: number;
  posNumber: number;
  applicationId: string | number;
  certificateStatus: string;
};
export type AtkReceiptCertificate = {
  applicationId: number;
  spkiSha256: string;
  certificatePem: string;
  status: string;
  revokedAt: string | null;
};
export type AtkReceiptSale = {
  id: string;
  businessId: string;
  posId: string;
  couponId: number | string;
  status: string;
  dailyNumber: number | string | null;
  createdAt: string;
  checkoutIdempotencyKey?: string | null;
};
export type AtkReceiptDependencies = {
  authenticate(token: string): Promise<AtkReceiptActor | null>;
  isMember(businessId: string, userId: string): Promise<boolean>;
  getBusiness(businessId: string): Promise<AtkReceiptBusiness | null>;
  getPos(businessId: string, posUuid: string): Promise<AtkReceiptPos | null>;
  getCertificate(businessId: string, posUuid: string): Promise<AtkReceiptCertificate | null>;
  getSale(businessId: string, saleId: string): Promise<AtkReceiptSale | null>;
  queueReceipt(args: Record<string, unknown>): Promise<string>;
  recordReceipt(args: Record<string, unknown>): Promise<string>;
};
export class AtkReceiptRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AtkReceiptRequestError";
  }
}
type Attestation = {
  version: number;
  businessId: string;
  posUuid: string;
  businessNui: number;
  branchId: number;
  posNumber: number;
  applicationId: number;
  couponId: number;
  idempotencyKey: string;
  checkoutIdempotencyKey: string | null;
  businessDate: string;
  documentType: string;
  signedPayloadBase64: string;
  signatureBase64: string;
  payloadSha256: string;
  signatureSha256: string;
  status: "queued" | "accepted";
  transactionId: string | null;
  atkResponseMessage: string | null;
  nuiKf: string;
  verificationNo: string;
  citizenPayloadBase64: string;
  citizenSignatureBase64: string;
  dailyNumber: number;
  offlineIssuedAtUtc: string | null;
  qrSvgBase64: string;
  certificateThumbprint: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const NUIKF = /^[A-Z0-9]{16}$/;
const MAX_BODY_BYTES = 1_500_000;
const ALLOWED_ORIGINS = new Set([
  "https://fiskalo.shqiptare.workers.dev",
  "https://fiskalo.pages.dev",
  "http://localhost:3000",
]);
function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
function json(status: number, value: Record<string, unknown>, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(value), { status, headers });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeBase64(value: string, label: string): Uint8Array {
  if (!value || value.length > MAX_BODY_BYTES * 2 || !BASE64.test(value)) {
    throw new AtkReceiptRequestError(400, label + " is not valid base64.");
  }
  try {
    const raw = atob(value);
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch {
    throw new AtkReceiptRequestError(400, label + " is not valid base64.");
  }
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
async function sha1(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)));
}
function certificateDer(pem: string): Uint8Array {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
  if (!match) throw new AtkReceiptRequestError(409, "Registered ATK certificate PEM is invalid.");
  return decodeBase64(match[1].replace(/\s/g, ""), "Registered ATK certificate");
}
function numeric(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}
function businessDateOf(timestamp: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function parseAttestation(bytes: Uint8Array): Attestation {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AtkReceiptRequestError(400, "Fiscal attestation payload is not valid JSON.");
  }
  if (!isRecord(value)) throw new AtkReceiptRequestError(400, "Fiscal attestation payload is invalid.");
  return value as unknown as Attestation;
}
export function createAtkReceiptHandler(deps: AtkReceiptDependencies) {
  return async (request: Request): Promise<Response> => {
    const headers = corsHeaders(request.headers.get("origin"));
    if (request.method === "OPTIONS") {
      if (request.headers.get("origin") && !ALLOWED_ORIGINS.has(request.headers.get("origin")!)) {
        return json(403, { error: "Origin is not allowed." }, headers);
      }
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") return json(405, { error: "POST is required." }, headers);
    if (request.headers.get("origin") && !ALLOWED_ORIGINS.has(request.headers.get("origin")!)) {
      return json(403, { error: "Origin is not allowed." }, headers);
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!bearer) return json(401, { error: "An authenticated session is required." }, headers);

    try {
      const actor = await deps.authenticate(bearer[1]);
      if (!actor) return json(401, { error: "The authenticated session is invalid." }, headers);
      const contentLength = request.headers.get("content-length");
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
        return json(413, { error: "Request body is too large." }, headers);
      }
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
        return json(413, { error: "Request body is too large." }, headers);
      }
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return json(400, { error: "Request JSON is invalid." }, headers); }
      if (!isRecord(body)) return json(400, { error: "Request body must be an object." }, headers);

      const action = body.action;
      const businessId = typeof body.businessId === "string" ? body.businessId : "";
      const posUuid = typeof body.posUuid === "string" ? body.posUuid : "";
      const saleId = typeof body.saleId === "string" ? body.saleId : "";
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      const couponId = numeric(body.couponId as string | number | undefined);
      if ((action !== "queue" && action !== "accepted") || !UUID.test(businessId) ||
          !UUID.test(posUuid) || !UUID.test(saleId) || !idempotencyKey || idempotencyKey.length > 256 ||
          !Number.isSafeInteger(couponId) || couponId <= 0) {
        return json(400, { error: "Fiscal document identity or action is invalid." }, headers);
      }
      if (!(await deps.isMember(businessId, actor.id))) {
        return json(403, { error: "The user is not a member of this business." }, headers);
      }

      const [business, pos, certificate, sale] = await Promise.all([
        deps.getBusiness(businessId), deps.getPos(businessId, posUuid),
        deps.getCertificate(businessId, posUuid), deps.getSale(businessId, saleId),
      ]);
      if (!business || !pos || !certificate || !sale) {
        return json(404, { error: "Business, POS, certificate or sale was not found." }, headers);
      }
      if (pos.businessId !== businessId || pos.id !== posUuid || pos.certificateStatus !== "certificate_issued" ||
          certificate.status !== "active" || certificate.revokedAt !== null || !certificate.certificatePem ||
          numeric(certificate.applicationId) !== numeric(pos.applicationId)) {
        return json(409, { error: "The POS certificate is not active for this business installation." }, headers);
      }
      if (sale.businessId !== businessId || sale.posId !== posUuid ||
          numeric(sale.couponId) !== couponId || !["paid", "fiscalized"].includes(sale.status) ||
          !Number.isFinite(numeric(sale.dailyNumber))) {
        return json(409, { error: "Sale, POS, CouponId and daily number do not match." }, headers);
      }

      const attestationPayloadBase64 = typeof body.attestationPayloadBase64 === "string" ? body.attestationPayloadBase64 : "";
      const attestationSignatureBase64 = typeof body.attestationSignatureBase64 === "string" ? body.attestationSignatureBase64 : "";
      const publicKeySpkiBase64 = typeof body.publicKeySpkiBase64 === "string" ? body.publicKeySpkiBase64 : "";
      const attestationBytes = decodeBase64(attestationPayloadBase64, "Attestation payload");
      const attestationSignature = decodeBase64(attestationSignatureBase64, "Attestation signature");
      const spki = decodeBase64(publicKeySpkiBase64, "Certificate public key");
      const attestation = parseAttestation(attestationBytes);
      const registeredCertificateDer = certificateDer(certificate.certificatePem);
      const registeredThumbprint = (await sha1(registeredCertificateDer)).toUpperCase();
      if (registeredThumbprint !== attestation.certificateThumbprint.replace(/:/g, "").toUpperCase()) {
        return json(403, { error: "Attested certificate thumbprint does not match the registered ATK certificate." }, headers);
      }
      if ((await sha256(spki)) !== certificate.spkiSha256.toLowerCase()) {
        return json(403, { error: "Attestation public key does not match the active ATK certificate." }, headers);
      }
      let publicKey: CryptoKey;
      try {
        publicKey = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      } catch {
        return json(400, { error: "The ATK certificate public key is not a supported P-256 key." }, headers);
      }
      const signatureValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, publicKey, attestationSignature, attestationBytes,
      );
      if (!signatureValid) return json(403, { error: "Local POS attestation signature is invalid." }, headers);

      if (typeof attestation.signedPayloadBase64 !== "string" ||
          typeof attestation.signatureBase64 !== "string" ||
          typeof attestation.payloadSha256 !== "string" ||
          typeof attestation.signatureSha256 !== "string" ||
          typeof attestation.certificateThumbprint !== "string" ||
          typeof attestation.businessDate !== "string" ||
          typeof attestation.nuiKf !== "string" ||
          typeof attestation.verificationNo !== "string" ||
          typeof attestation.citizenPayloadBase64 !== "string" ||
          typeof attestation.citizenSignatureBase64 !== "string" ||
          typeof attestation.qrSvgBase64 !== "string") {
        return json(400, { error: "Fiscal attestation fields are incomplete." }, headers);
      }
      const payloadBytes = decodeBase64(attestation.signedPayloadBase64, "Signed POSCoupon");
      const signatureBytes = decodeBase64(attestation.signatureBase64, "POSCoupon signature");
      if ((await sha256(payloadBytes)) !== attestation.payloadSha256.toLowerCase() ||
          (await sha256(signatureBytes)) !== attestation.signatureSha256.toLowerCase()) {
        return json(400, { error: "Signed POSCoupon fingerprint does not match the attested document." }, headers);
      }
      if (attestation.version !== 1 || attestation.businessId !== businessId || attestation.posUuid !== posUuid ||
          attestation.idempotencyKey !== idempotencyKey || numeric(attestation.couponId) !== couponId ||
          numeric(attestation.dailyNumber) !== numeric(sale.dailyNumber) ||
          numeric(attestation.businessNui) !== numeric(business.nui) ||
          numeric(attestation.branchId) !== pos.branchId || numeric(attestation.posNumber) !== pos.posNumber ||
          numeric(attestation.applicationId) !== numeric(pos.applicationId) ||
          idempotencyKey !== `${attestation.businessNui}:${attestation.branchId}:${attestation.posNumber}:${attestation.couponId}` ||
          (attestation.checkoutIdempotencyKey !== null && attestation.checkoutIdempotencyKey !== sale.checkoutIdempotencyKey) ||
          attestation.nuiKf !== attestation.verificationNo || !NUIKF.test(attestation.nuiKf) ||
          !attestation.citizenPayloadBase64 || !attestation.citizenSignatureBase64 ||
          attestation.qrSvgBase64.length === 0 || attestation.certificateThumbprint.length < 8 ||
          attestation.businessDate !== businessDateOf(sale.createdAt)) {
        return json(409, { error: "Signed attestation metadata does not match the registered sale and POS." }, headers);
      }
      const citizenPayload = decodeBase64(attestation.citizenPayloadBase64, "CitizenCoupon payload");
      const citizenSignature = decodeBase64(attestation.citizenSignatureBase64, "CitizenCoupon signature");
      const qrBytes = decodeBase64(attestation.qrSvgBase64, "CitizenCoupon QR");
      if (citizenPayload.length === 0 || citizenSignature.length !== 64 || signatureBytes.length !== 64 ||
          qrBytes.length === 0 || attestation.qrSvgBase64.length > 1_500_000) {
        return json(400, { error: "CitizenCoupon or POSCoupon signature data is invalid." }, headers);
      }
      const posSignatureValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, publicKey, signatureBytes, payloadBytes,
      );
      const citizenSignatureValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, publicKey, citizenSignature, citizenPayload,
      );
      if (!posSignatureValid || !citizenSignatureValid) {
        return json(403, { error: "POSCoupon or CitizenCoupon signature does not match the active ATK certificate." }, headers);
      }
      if (action === "queue") {
        if (attestation.status !== "queued" || !attestation.offlineIssuedAtUtc || attestation.transactionId) {
          return json(409, { error: "Only a definitely-not-sent offline coupon can be queued." }, headers);
        }
        const offlineIssuedAt = new Date(attestation.offlineIssuedAtUtc);
        if (!Number.isFinite(offlineIssuedAt.getTime()) || offlineIssuedAt.getTime() > Date.now() + 120_000 ||
            offlineIssuedAt.getTime() + 48 * 60 * 60 * 1000 <= Date.now()) {
          return json(409, { error: "Offline coupon is outside the 48-hour recovery window." }, headers);
        }
        const documentId = await deps.queueReceipt({
          p_business_id: businessId, p_sale_id: saleId, p_coupon_id: couponId,
          p_idempotency_key: idempotencyKey, p_signed_payload: attestation.signedPayloadBase64,
          p_signature: attestation.signatureBase64, p_nui_kf: attestation.nuiKf,
          p_citizen_payload: attestation.citizenPayloadBase64,
          p_citizen_signature: attestation.citizenSignatureBase64,
          p_daily_number: attestation.dailyNumber, p_offline_issued_at: offlineIssuedAt.toISOString(),
          p_qr_svg_base64: attestation.qrSvgBase64,
        });
        return json(200, { ok: true, state: "queued", documentId }, headers);
      }

      if (attestation.status !== "accepted" || !attestation.transactionId ||
          !/^\d{1,20}$/.test(attestation.transactionId) || BigInt(attestation.transactionId) <= 0n ||
          !attestation.atkResponseMessage) {
        return json(409, { error: "ATK acceptance attestation is incomplete." }, headers);
      }
      const atkResponse = {
        status: "accepted",
        transactionId: attestation.transactionId,
        environment: "ATK TEST",
        message: attestation.atkResponseMessage,
      };
      const documentId = await deps.recordReceipt({
        p_actor_id: actor.id, p_business_id: businessId, p_sale_id: saleId, p_pos_record_id: posUuid,
        p_coupon_id: couponId, p_idempotency_key: idempotencyKey,
        p_signed_payload: attestation.signedPayloadBase64, p_signature: attestation.signatureBase64,
        p_atk_transaction_id: attestation.transactionId, p_atk_response: atkResponse,
        p_nui_kf: attestation.nuiKf, p_verification_no: attestation.verificationNo,
        p_citizen_payload: attestation.citizenPayloadBase64,
        p_citizen_signature: attestation.citizenSignatureBase64,
        p_daily_number: attestation.dailyNumber,
        p_offline_issued_at: attestation.offlineIssuedAtUtc,
        p_qr_svg_base64: attestation.qrSvgBase64,
      });
      return json(200, { ok: true, state: "accepted", documentId, transactionId: attestation.transactionId }, headers);
    } catch (error) {
      if (error instanceof AtkReceiptRequestError) return json(error.status, { error: error.message }, headers);
      return json(500, { error: "Fiscal receipt attestation could not be verified or persisted." }, headers);
    }
  };
}
