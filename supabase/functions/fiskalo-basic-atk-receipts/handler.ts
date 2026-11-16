export type AtkReceiptActor = { id: string };
export type AtkReceiptBusiness = { nui: string | number; name?: string };
export type AtkReceiptPos = {
  id: string;
  businessId: string;
  branchId: number;
  posNumber: number;
  applicationId: string | number;
  certificateStatus: string;
  location: string;
  verifiedBusinessName?: string | null;
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
  operatorName: string;
  paymentMethod: string;
  paymentAllocations: Array<{ method: string; amount_cents: number | string }> | null;
  subtotal: number | string;
  vatTotal: number | string;
  total: number | string;
};
export type AtkReceiptSaleItem = {
  description: string;
  unitPrice: number | string;
  quantity: number | string;
  lineTotal: number | string;
  lineNet: number | string;
  lineVat: number | string;
  unitCode: string;
  categoryCode: string;
  vatCode: string;
};
export type AtkReceiptDependencies = {
  authenticate(token: string): Promise<AtkReceiptActor | null>;
  isMember(businessId: string, userId: string): Promise<boolean>;
  isOwner(businessId: string, userId: string): Promise<boolean>;
  registerCertificate(args: Record<string, unknown>): Promise<string>;
  getBusiness(businessId: string): Promise<AtkReceiptBusiness | null>;
  getPos(businessId: string, posUuid: string): Promise<AtkReceiptPos | null>;
  getCertificate(businessId: string, posUuid: string): Promise<AtkReceiptCertificate | null>;
  getSale(businessId: string, saleId: string): Promise<AtkReceiptSale | null>;
  getSaleItems(saleId: string): Promise<AtkReceiptSaleItem[]>;
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
  couponSnapshotSha256: string;
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
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes))));
}
async function sha1(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", toArrayBuffer(bytes))));
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
function cents(value: string | number): number {
  const result = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(result)) throw new AtkReceiptRequestError(400, "Sale amount is outside the supported range.");
  return result;
}
function fixed(value: string | number, decimals: number): string {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new AtkReceiptRequestError(400, "Sale item numeric value is invalid.");
  return result.toFixed(decimals);
}
function canonicalField(value: string | number): string {
  const text = String(value);
  return `${new TextEncoder().encode(text).byteLength}:${text}`;
}
export async function computeSaleSnapshotSha256(
  businessNui: number, pos: AtkReceiptPos, sale: AtkReceiptSale,
  saleItems: AtkReceiptSaleItem[], verificationNo: string, dailyNumber: number,
): Promise<string> {
  const totalCents = cents(sale.total);
  const totalTaxCents = cents(sale.vatTotal);
  const totalNoTaxCents = cents(sale.subtotal);
  const itemRows = saleItems.map(item => [
    item.description.trim(), fixed(item.unitPrice, 4), item.unitCode.trim(),
    fixed(item.quantity, 3), String(cents(item.lineTotal)), item.vatCode, item.categoryCode.trim(),
  ].join("\u001f")).sort();
  const rawPayments = sale.paymentAllocations?.length
    ? sale.paymentAllocations
    : [{ method: sale.paymentMethod, amount_cents: totalCents }];
  const paymentTypes: Record<string, number> = { cash: 1, card: 2, bank_transfer: 6 };
  const payments = rawPayments.map(payment => {
    const type = paymentTypes[payment.method];
    const amount = Number(payment.amount_cents);
    if (type === undefined || !Number.isSafeInteger(amount) || amount < 0)
      throw new AtkReceiptRequestError(409, "Sale payment allocation cannot be represented in the signed ATK coupon.");
    return { type, amount };
  }).sort((a,b)=>a.type-b.type||a.amount-b.amount);
  const groups = new Map<string,{base:number;tax:number}>();
  for (const item of saleItems) {
    const current = groups.get(item.vatCode) ?? { base: 0, tax: 0 };
    current.base += cents(item.lineNet);
    current.tax += cents(item.lineVat);
    groups.set(item.vatCode,current);
  }
  const taxGroups = [...groups.entries()].map(([taxRate,values])=>({taxRate,...values}))
    .sort((a,b)=>(a.taxRate<b.taxRate?-1:a.taxRate>b.taxRate?1:0)||a.base-b.base);
  const fields: string[] = [
    "FISKALO-ATK-SNAPSHOT-V1", String(businessNui), String(numeric(sale.couponId)),
    String(pos.branchId), String(pos.posNumber), String(numeric(pos.applicationId)),
    String(Math.floor(new Date(sale.createdAt).getTime()/1000)), String(dailyNumber),
    verificationNo.trim(), "1", pos.location.trim(), sale.operatorName.trim(),
    String(totalCents), String(totalTaxCents), String(totalNoTaxCents), "0", "0",
    String(itemRows.length), ...itemRows, String(payments.length),
    ...payments.map(payment=>[String(payment.type),String(payment.amount)].join("\u001f")),
    String(taxGroups.length),
    ...taxGroups.map(group=>[group.taxRate,String(group.base),String(group.tax)].join("\u001f")),
  ];
  const canonical = fields.map(canonicalField).join("|");
  return sha256(new TextEncoder().encode(canonical));
}
type CertificateAttestation = {
  version: number; businessId: string; posUuid: string; businessNui: number;
  branchId: number; posNumber: number; applicationId: number;
  certificatePem: string; certificateThumbprint: string; spkiBase64: string; issuedAtUtc: string;
};
type DerNode = { tag: number; start: number; contentStart: number; end: number };
function derNode(bytes: Uint8Array, offset: number): DerNode {
  if (offset + 2 > bytes.length) throw new AtkReceiptRequestError(400, "ATK certificate DER is truncated.");
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let contentStart = offset + 2;
  if ((length & 0x80) !== 0) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || contentStart + count > bytes.length)
      throw new AtkReceiptRequestError(400, "ATK certificate DER length is invalid.");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[contentStart + i];
    contentStart += count;
  }
  const end = contentStart + length;
  if (end > bytes.length) throw new AtkReceiptRequestError(400, "ATK certificate DER is truncated.");
  return { tag, start: offset, contentStart, end };
}
function derChildren(bytes: Uint8Array, parent: DerNode): DerNode[] {
  const result: DerNode[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = derNode(bytes, offset);
    result.push(child);
    offset = child.end;
  }
  if (offset !== parent.end) throw new AtkReceiptRequestError(400, "ATK certificate DER structure is invalid.");
  return result;
}
function certificateSpki(der: Uint8Array): Uint8Array {
  const root = derNode(der, 0);
  if (root.tag !== 0x30 || root.end !== der.length) throw new AtkReceiptRequestError(400, "ATK certificate is not a DER X.509 certificate.");
  const rootChildren = derChildren(der, root);
  const tbs = rootChildren[0];
  if (!tbs || tbs.tag !== 0x30) throw new AtkReceiptRequestError(400, "ATK certificate TBSCertificate is missing.");
  const fields = derChildren(der, tbs);
  const offset = fields[0]?.tag === 0xa0 ? 6 : 5;
  const spki = fields[offset];
  if (!spki || spki.tag !== 0x30) throw new AtkReceiptRequestError(400, "ATK certificate SubjectPublicKeyInfo is missing.");
  return der.slice(spki.start, spki.end);
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
      if (action === "register") {
        if (!UUID.test(businessId) || !UUID.test(posUuid))
          return json(400, { error: "Business and POS identity is invalid." }, headers);
        if (!(await deps.isOwner(businessId, actor.id)))
          return json(403, { error: "Only a business owner can register the ATK POS certificate." }, headers);
        const [business, pos] = await Promise.all([deps.getBusiness(businessId), deps.getPos(businessId, posUuid)]);
        if (!business || !pos || pos.id !== posUuid || pos.businessId !== businessId)
          return json(404, { error: "Business or POS was not found." }, headers);
        if (pos.certificateStatus !== "verified")
          return json(409, { error: "Verify this POS with ATK TEST before registering its certificate." }, headers);
        const verifiedBusinessName = (pos.verifiedBusinessName || business.name || "").trim();
        if (verifiedBusinessName.length < 2)
          return json(409, { error: "The ATK-verified business name is missing from this POS." }, headers);
        const attestationPayloadBase64 = typeof body.certificateAttestationPayloadBase64 === "string" ? body.certificateAttestationPayloadBase64 : "";
        const attestationSignatureBase64 = typeof body.certificateAttestationSignatureBase64 === "string" ? body.certificateAttestationSignatureBase64 : "";
        const attestationBytes = decodeBase64(attestationPayloadBase64, "ATK certificate attestation");
        const attestationSignature = decodeBase64(attestationSignatureBase64, "ATK certificate attestation signature");
        let certificateAttestation: CertificateAttestation;
        try { certificateAttestation = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(attestationBytes)) as CertificateAttestation; }
        catch { throw new AtkReceiptRequestError(400, "ATK certificate attestation JSON is invalid."); }
        if (!certificateAttestation || certificateAttestation.version !== 1 ||
            certificateAttestation.businessId !== businessId || certificateAttestation.posUuid !== posUuid ||
            numeric(certificateAttestation.businessNui) !== numeric(business.nui) ||
            numeric(certificateAttestation.branchId) !== pos.branchId ||
            numeric(certificateAttestation.posNumber) !== pos.posNumber ||
            numeric(certificateAttestation.applicationId) !== numeric(pos.applicationId) ||
            typeof certificateAttestation.certificatePem !== "string" ||
            typeof certificateAttestation.certificateThumbprint !== "string" ||
            typeof certificateAttestation.spkiBase64 !== "string" ||
            typeof certificateAttestation.issuedAtUtc !== "string") {
          return json(409, { error: "ATK certificate attestation does not match the selected business POS." }, headers);
        }
        const issuedAt = new Date(certificateAttestation.issuedAtUtc);
        if (!Number.isFinite(issuedAt.getTime()) || Math.abs(Date.now() - issuedAt.getTime()) > 5 * 60_000)
          return json(409, { error: "ATK certificate attestation is stale; refresh it from the local POS Agent." }, headers);
        const certDer = certificateDer(certificateAttestation.certificatePem);
        const thumbprint = (await sha1(certDer)).toUpperCase();
        if (thumbprint !== certificateAttestation.certificateThumbprint.replace(/:/g, "").toUpperCase())
          return json(403, { error: "ATK certificate thumbprint does not match its DER certificate." }, headers);
        const extractedSpki = certificateSpki(certDer);
        const suppliedSpki = decodeBase64(certificateAttestation.spkiBase64, "ATK certificate public key");
        if (toHex(extractedSpki) !== toHex(suppliedSpki))
          return json(403, { error: "POS Agent public key does not match the public key embedded in the ATK certificate." }, headers);
        const spkiHash = await sha256(extractedSpki);
        let publicKey: CryptoKey;
        try {
          publicKey = await crypto.subtle.importKey("spki", toArrayBuffer(extractedSpki),
            { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        } catch { return json(400, { error: "ATK certificate does not contain a supported ECDSA P-256 public key." }, headers); }
        const signatureValid = await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" }, publicKey,
          toArrayBuffer(attestationSignature), toArrayBuffer(attestationBytes),
        );
        if (!signatureValid) return json(403, { error: "POS Agent certificate proof-of-possession signature is invalid." }, headers);
        const registeredId = await deps.registerCertificate({
          p_business_id: businessId, p_pos_record_id: posUuid,
          p_application_id: numeric(pos.applicationId),
          p_certificate_pem: certificateAttestation.certificatePem,
          p_spki_sha256: spkiHash,
          p_verified_business_name: verifiedBusinessName,
        });
        return json(200, { ok: true, certificateId: registeredId, certificateThumbprint: thumbprint, status: "active" }, headers);
      }
      if (action !== "queue" && action !== "accepted")
        return json(400, { error: "Fiscal receipt action is invalid." }, headers);
      const saleId = typeof body.saleId === "string" ? body.saleId : "";
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      const couponId = numeric(body.couponId as string | number | undefined);
      if (!UUID.test(businessId) || !UUID.test(posUuid) || !UUID.test(saleId) || !idempotencyKey || idempotencyKey.length > 256 ||
          !Number.isSafeInteger(couponId) || couponId <= 0) {
        return json(400, { error: "Fiscal document identity or action is invalid." }, headers);
      }
      if (!(await deps.isMember(businessId, actor.id))) {
        return json(403, { error: "The user is not a member of this business." }, headers);
      }

      const [business, pos, certificate, sale, saleItems] = await Promise.all([
        deps.getBusiness(businessId), deps.getPos(businessId, posUuid),
        deps.getCertificate(businessId, posUuid), deps.getSale(businessId, saleId),
        deps.getSaleItems(saleId),
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
        publicKey = await crypto.subtle.importKey("spki", toArrayBuffer(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      } catch {
        return json(400, { error: "The ATK certificate public key is not a supported P-256 key." }, headers);
      }
      const signatureValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, publicKey, toArrayBuffer(attestationSignature), toArrayBuffer(attestationBytes),
      );
      if (!signatureValid) return json(403, { error: "Local POS attestation signature is invalid." }, headers);

      if (typeof attestation.signedPayloadBase64 !== "string" ||
          typeof attestation.signatureBase64 !== "string" ||
          typeof attestation.payloadSha256 !== "string" ||
          typeof attestation.signatureSha256 !== "string" ||
          typeof attestation.couponSnapshotSha256 !== "string" ||
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
          attestation.businessDate !== businessDateOf(sale.createdAt) ||
          saleItems.length === 0) {
        return json(409, { error: "Signed attestation metadata does not match the registered sale and POS." }, headers);
      }
      const snapshotHash = await computeSaleSnapshotSha256(
        numeric(business.nui), pos, sale, saleItems, attestation.nuiKf, numeric(sale.dailyNumber),
      );
      if (snapshotHash !== attestation.couponSnapshotSha256.toLowerCase()) {
        return json(409, { error: "Cloud sale line, payment or tax snapshot does not match the locally signed ATK coupon." }, headers);
      }
      const citizenPayload = decodeBase64(attestation.citizenPayloadBase64, "CitizenCoupon payload");
      const citizenSignature = decodeBase64(attestation.citizenSignatureBase64, "CitizenCoupon signature");
      const qrBytes = decodeBase64(attestation.qrSvgBase64, "CitizenCoupon QR");
      if (citizenPayload.length === 0 || citizenSignature.length !== 64 || signatureBytes.length !== 64 ||
          qrBytes.length === 0 || attestation.qrSvgBase64.length > 1_500_000) {
        return json(400, { error: "CitizenCoupon or POSCoupon signature data is invalid." }, headers);
      }
      const posSignatureValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, publicKey, toArrayBuffer(signatureBytes), toArrayBuffer(payloadBytes),
      );
      const citizenSignatureValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, publicKey, toArrayBuffer(citizenSignature), toArrayBuffer(citizenPayload),
      );
      if (!posSignatureValid || !citizenSignatureValid) {
        return json(403, { error: "POSCoupon or CitizenCoupon signature does not match the active ATK certificate." }, headers);
      }
      if (action === "queue") {
        if (attestation.status !== "queued" || !attestation.offlineIssuedAtUtc || attestation.transactionId) {
          return json(409, { error: "Only a definitely-not-sent offline coupon can be queued." }, headers);
        }
        const offlineIssuedAt = new Date(attestation.offlineIssuedAtUtc);
        if (!Number.isFinite(offlineIssuedAt.getTime()) || offlineIssuedAt.getTime() > Date.now() + 120_000) {
          return json(409, { error: "Offline issue timestamp is invalid or in the future." }, headers);
        }
        // The 48-hour point is a compliance escalation deadline, not a reason
        // to discard the signed document or block later synchronization.
        const overdue = offlineIssuedAt.getTime() + 48 * 60 * 60 * 1000 <= Date.now();
        const documentId = await deps.queueReceipt({
          p_actor_id: actor.id, p_business_id: businessId, p_sale_id: saleId, p_pos_record_id: posUuid,
          p_coupon_id: couponId, p_idempotency_key: idempotencyKey, p_signed_payload: attestation.signedPayloadBase64,
          p_signature: attestation.signatureBase64, p_nui_kf: attestation.nuiKf,
          p_verification_no: attestation.verificationNo, p_citizen_payload: attestation.citizenPayloadBase64,
          p_citizen_signature: attestation.citizenSignatureBase64,
          p_daily_number: attestation.dailyNumber, p_offline_issued_at: offlineIssuedAt.toISOString(),
          p_qr_svg_base64: attestation.qrSvgBase64,
        });
        return json(200, { ok: true, state: "queued", documentId, overdue, recoveryDeadlineAt: new Date(offlineIssuedAt.getTime() + 48 * 60 * 60 * 1000).toISOString() }, headers);
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
