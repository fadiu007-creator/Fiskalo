import QRCode from "qrcode";
type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

type Json = Record<string, unknown>;
type FiscalDoc = {
  id: string;
  business_id: string;
  sale_id: string;
  coupon_id: number | string;
  idempotency_key: string;
  document_type: number;
  reference_coupon_id: number | string | null;
  parent_document_id: string | null;
  created_at: string;
  signed_payload: string;
  signature: string;
  nui_kf: string;
  verification_no: string | null;
  citizen_payload: string;
  citizen_signature: string;
  daily_number: number | string;
  offline_issued_at: string;
  recovery_deadline_at: string;
  qr_svg_base64: string;
  attempt_count: number;
  next_attempt_at: string | null;
};
type Sale = { id: string; operator_id: string; pos_id: string; coupon_id: number | string; status: string; created_at: string; total: number | string; subtotal: number | string; vat_total: number | string };
type OriginalDoc = { id: string; coupon_id: number | string; atk_transaction_id: number | string; submission_state: string; document_type: number };
type Pos = { id: string; branch_id: number | string; pos_id: number | string; application_id: number | string; certificate_status: string };
type PosCertificate = { business_id: string; pos_id: string; certificate_pem: string };
type Business = { id: string; nui: string };

const ATK_TEST_ORIGIN = "https://fiskalizimi-test.atk-ks.org";
const MAX_BATCH = 25;
const MAX_BACKOFF_MINUTES = 30;

function readVarint(bytes: Uint8Array, state: { offset: number }): bigint {
  let value = BigInt(0);
  let shift = BigInt(0);
  for (let i = 0; i < 10; i++) {
    if (state.offset >= bytes.length) throw new Error("Truncated coupon protobuf.");
    const byte = bytes[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value;
    shift += BigInt(7);
  }
  throw new Error("Invalid coupon protobuf varint.");
}
function parseCouponFields(base64Value: string) {
  const binary = atob(base64Value);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const state = { offset: 0 };
  const values = new Map<number, bigint | string>();
  while (state.offset < bytes.length) {
    const tag = Number(readVarint(bytes, state));
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field) throw new Error("Invalid coupon protobuf field.");
    if (wire === 0) {
      if (values.has(field)) throw new Error("Duplicate coupon protobuf field.");
      values.set(field, readVarint(bytes, state));
    } else if (wire === 2) {
      const length = Number(readVarint(bytes, state));
      if (!Number.isSafeInteger(length) || length < 0 || state.offset + length > bytes.length) throw new Error("Invalid coupon protobuf length.");
      const value = bytes.slice(state.offset, state.offset + length);
      state.offset += length;
      if ([4,5,8].includes(field)) {
        if (values.has(field)) throw new Error("Duplicate coupon protobuf identity.");
        values.set(field, new TextDecoder().decode(value));
      }
    } else if (wire === 5) state.offset += 4;
    else if (wire === 1) state.offset += 8;
    else throw new Error("Unsupported coupon protobuf wire type.");
    if (state.offset > bytes.length) throw new Error("Truncated coupon protobuf.");
  }
  return values;
}
function readDer(bytes: Uint8Array, offset: number) {
  if (offset + 2 > bytes.length) throw new Error("Invalid certificate DER.");
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 4 || cursor + count > bytes.length) throw new Error("Invalid certificate DER length.");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++];
  }
  const end = cursor + length;
  if (end > bytes.length) throw new Error("Truncated certificate DER.");
  return { tag, start: offset, contentStart: cursor, end };
}
function certSpki(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const cert = readDer(bytes, 0);
  const tbs = readDer(bytes, cert.contentStart);
  let cursor = tbs.contentStart;
  let node = readDer(bytes, cursor);
  if (node.tag === 0xa0) { cursor = node.end; node = readDer(bytes, cursor); }
  for (let i = 0; i < 5; i++) { cursor = node.end; node = readDer(bytes, cursor); }
  if (node.tag !== 0x30) throw new Error("Certificate SubjectPublicKeyInfo missing.");
  return bytes.slice(node.start, node.end);
}
function derSignatureToRaw(signatureBase64: string): Uint8Array {
  const binary = atob(signatureBase64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length === 64) return bytes; // WebCrypto/.NET fixed-width IEEE-P1363 signature.
  const seq = readDer(bytes, 0);
  if (seq.tag !== 0x30 || seq.end !== bytes.length) throw new Error("ECDSA signature is not DER.");
  const r = readDer(bytes, seq.contentStart);
  const s = readDer(bytes, r.end);
  if (r.tag !== 0x02 || s.tag !== 0x02 || s.end !== seq.end) throw new Error("Malformed ECDSA signature.");
  const normalize = (node: {contentStart:number;end:number}) => {
    let value = bytes.slice(node.contentStart, node.end);
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error("ECDSA integer exceeds P-256.");
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(normalize(r), 0);
  raw.set(normalize(s), 32);
  return raw;
}
async function verifyPayload(certificatePem: string, payload: string, signature: string) {
  const key = await crypto.subtle.importKey("spki", Uint8Array.from(certSpki(certificatePem)).buffer,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, key, Uint8Array.from(derSignatureToRaw(signature)).buffer, new TextEncoder().encode(payload),
  );
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function headers(env: Env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function dbGet<T>(env: Env, table: string, query: URLSearchParams): Promise<T[]> {
  const response = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + table + "?" + query.toString(), {
    headers: headers(env),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Supabase read failed (" + response.status + ") for " + table);
  return await response.json() as T[];
}

async function dbPatch(env: Env, table: string, query: URLSearchParams, value: Json): Promise<Json[]> {
  const response = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + table + "?" + query.toString(), {
    method: "PATCH",
    headers: { ...headers(env), Prefer: "return=representation" },
    body: JSON.stringify(value),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Supabase update failed (" + response.status + ") for " + table);
  return await response.json() as Json[];
}

async function dbRpc<T>(env: Env, name: string, body: Json): Promise<T> {
  const response = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Supabase trusted receipt RPC failed (" + response.status + ").");
  return await response.json() as T;
}

function postgrestQuery(values: Record<string, string>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) query.set(key, value);
  return query;
}

function transportCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { code?: unknown; cause?: unknown; message?: unknown };
  if (typeof candidate.code === "string") return candidate.code.toUpperCase();
  if (candidate.cause && typeof candidate.cause === "object") {
    const cause = candidate.cause as { code?: unknown; message?: unknown };
    if (typeof cause.code === "string") return cause.code.toUpperCase();
    if (typeof cause.message === "string") {
      const match = cause.message.match(/\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/i);
      if (match) return match[1].toUpperCase();
    }
  }
  if (typeof candidate.message === "string") {
    const match = candidate.message.match(/\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/i);
    if (match) return match[1].toUpperCase();
  }
  return "";
}

function definitelyNotDelivered(error: unknown): boolean {
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(transportCode(error));
}

async function markNeedsReconciliation(env: Env, doc: FiscalDoc, reason: string) {
  await dbPatch(env, "fiskalo_basic_fiscal_documents",
    postgrestQuery({ id: "eq." + doc.id, submission_state: "eq.submitting" }),
    { submission_state: "needs_reconciliation", last_error: reason.slice(0, 500), next_attempt_at: null },
  );
}

async function processDocument(env: Env, doc: FiscalDoc, now: Date) {
  const docs = await dbPatch(env, "fiskalo_basic_fiscal_documents",
    postgrestQuery({ id: "eq." + doc.id, submission_state: "eq.queued" }),
    { submission_state: "submitting", last_attempt_at: now.toISOString(), last_error: null },
  );
  if (!docs.length) return "skipped";

  const deadline = Date.parse(doc.recovery_deadline_at);
  if (!Number.isFinite(deadline) || deadline <= now.getTime()) {
    await markNeedsReconciliation(env, doc, "48-hour ATK recovery window expired before successful submission.");
    return "expired";
  }

  const sales = await dbGet<Sale>(env, "fiskalo_basic_sales",
    postgrestQuery({ select: "id,operator_id,pos_id,coupon_id,status,created_at,total,subtotal,vat_total", id: "eq." + doc.sale_id, business_id: "eq." + doc.business_id, limit: "1" }));
  const expectedSaleCouponId = doc.document_type === 1 ? doc.coupon_id : doc.reference_coupon_id;
  const expectedSaleStatus = doc.document_type === 1 ? "paid" : "fiscalized";
  if (sales.length !== 1 || !sales[0].operator_id || sales[0].status !== expectedSaleStatus || String(sales[0].coupon_id) !== String(expectedSaleCouponId)) {
    await markNeedsReconciliation(env, doc, "Sale identity could not be verified for automatic ATK recovery.");
    return "reconciliation";
  }
  const sale = sales[0];
  const poses = await dbGet<Pos>(env, "fiskalo_basic_pos",
    postgrestQuery({ select: "id,branch_id,pos_id,application_id,certificate_status", id: "eq." + sale.pos_id, business_id: "eq." + doc.business_id, limit: "1" }));
  if (poses.length !== 1 || poses[0].certificate_status !== "certificate_issued") {
    await markNeedsReconciliation(env, doc, "The original POS certificate or POS identity is no longer available.");
    return "reconciliation";
  }
  const pos = poses[0];
  const businesses = await dbGet<Business>(env, "fiskalo_basic_businesses",
    postgrestQuery({ select: "id,nui", id: "eq." + doc.business_id, limit: "1" }));
  const certificates = await dbGet<PosCertificate>(env, "fiskalo_basic_pos_certificates",
    postgrestQuery({ select: "business_id,pos_id,certificate_pem", business_id: "eq." + doc.business_id, pos_id: "eq." + pos.id, limit: "1" }));
  if (businesses.length !== 1 || certificates.length !== 1) {
    await markNeedsReconciliation(env, doc, "Business identity or server-registered ATK certificate is missing.");
    return "reconciliation";
  }
  const business = businesses[0];
  const certificatePem = certificates[0].certificate_pem;
  try {
    const posFields = parseCouponFields(doc.signed_payload);
    const citizenFields = parseCouponFields(doc.citizen_payload);
    const originalDocs = doc.document_type === 1 ? [] : await dbGet<OriginalDoc>(env, "fiskalo_basic_fiscal_documents",
      postgrestQuery({ select: "id,coupon_id,atk_transaction_id,submission_state,document_type", id: "eq." + doc.parent_document_id, business_id: "eq." + doc.business_id, limit: "1" }));
    const original = originalDocs[0];
    if (doc.document_type !== 1 && (!original || original.document_type !== 1 || original.submission_state !== "accepted" || String(original.coupon_id) !== String(doc.reference_coupon_id) || String(original.coupon_id) !== String(sale.coupon_id))) throw new Error("Original accepted ATK sale is missing for this correction.");
    const unixTime = BigInt(Math.floor(new Date(doc.document_type === 1 ? sale.created_at : doc.created_at).getTime() / 1000));
    const expectedPos: Array<[number,bigint]> = [
      [1,BigInt(business.nui)],[2,BigInt(doc.coupon_id)],[3,BigInt(pos.branch_id)],
      [6,BigInt(pos.pos_id)],[7,BigInt(pos.application_id)],[9,BigInt(doc.document_type)],
      [13,BigInt(Math.round(Number(sale.total)*100))],[15,BigInt(Math.round(Number(sale.vat_total)*100))],
      [16,BigInt(Math.round(Number(sale.subtotal)*100))],
    ];
    for (const [field,value] of expectedPos) if (posFields.get(field)!==value) throw new Error("POS coupon identity or totals mismatch.");
    const posTimestamp=posFields.get(10);
    if (typeof posTimestamp!=="bigint" || (doc.document_type===1 ? posTimestamp!==unixTime : (posTimestamp>unixTime+BigInt(300)||posTimestamp<unixTime-BigInt(300)))) throw new Error("POS coupon timestamp does not match its issue record.");
    if (posFields.get(8)!==doc.nui_kf || doc.verification_no!==doc.nui_kf) throw new Error("POS coupon NUIKF/VerificationNo mismatch.");
    if (doc.document_type !== 1 && (posFields.get(17)!==BigInt(doc.reference_coupon_id!) ||
      (posFields.get(18)!==undefined && posFields.get(18)!==BigInt(0)))) throw new Error("Correction ReferenceNo does not match the original sale coupon.");
    const expectedCitizen: Array<[number,bigint]> = [
      [1,BigInt(business.nui)],[2,BigInt(doc.coupon_id)],[3,BigInt(pos.branch_id)],
      [4,BigInt(pos.pos_id)],[6,BigInt(doc.document_type)],
      [8,BigInt(Math.round(Number(sale.total)*100))],
      [10,BigInt(Math.round(Number(sale.vat_total)*100))],
      [11,BigInt(Math.round(Number(sale.subtotal)*100))],
    ];
    for (const [field,value] of expectedCitizen) if (citizenFields.get(field)!==value) throw new Error("CitizenCoupon identity or totals mismatch.");
    const citizenTimestamp=citizenFields.get(7);
    if (typeof citizenTimestamp!=="bigint" || (doc.document_type===1 ? citizenTimestamp!==unixTime : (citizenTimestamp>unixTime+BigInt(300)||citizenTimestamp<unixTime-BigInt(300)))) throw new Error("CitizenCoupon timestamp does not match its issue record.");
    if (citizenFields.get(5)!==doc.nui_kf) throw new Error("CitizenCoupon NUIKF mismatch.");
    const [posValid,citizenValid]=await Promise.all([
      verifyPayload(certificatePem,doc.signed_payload,doc.signature),
      verifyPayload(certificatePem,doc.citizen_payload,doc.citizen_signature),
    ]);
    if (!posValid || !citizenValid) throw new Error("POS or CitizenCoupon signature does not verify against the server-registered ATK certificate.");
  } catch (error) {
    await dbPatch(env, "fiskalo_basic_fiscal_documents",
      postgrestQuery({ id: "eq." + doc.id, submission_state: "eq.submitting" }),
      { submission_state: "rejected", next_attempt_at: null, last_error: error instanceof Error ? error.message.slice(0,500) : "Queued fiscal document validation failed." },
    );
    return "rejected";
  }
  const qrSvg = await QRCode.toString(doc.citizen_payload + "|" + doc.citizen_signature, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 320 });
  const qrSvgBase64 = encodeBase64(new TextEncoder().encode(qrSvg));

  let response: Response;
  try {
    response = await fetch(ATK_TEST_ORIGIN + "/pos/coupon", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ details: doc.signed_payload, signature: doc.signature }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (!definitelyNotDelivered(error)) {
      await markNeedsReconciliation(env, doc, "ATK delivery result is ambiguous; automatic retry stopped to prevent duplicate fiscalization.");
      return "reconciliation";
    }
    const attempt = Number(doc.attempt_count ?? 0) + 1;
    const delayMinutes = Math.min(MAX_BACKOFF_MINUTES, 2 ** Math.min(attempt - 1, 5));
    const nextAttempt = new Date(now.getTime() + delayMinutes * 60_000);
    if (nextAttempt.getTime() >= deadline) {
      await markNeedsReconciliation(env, doc, "ATK could not be reached before the 48-hour recovery deadline.");
      return "expired";
    }
    await dbPatch(env, "fiskalo_basic_fiscal_documents",
      postgrestQuery({ id: "eq." + doc.id, submission_state: "eq.submitting" }),
      {
        submission_state: "queued",
        attempt_count: attempt,
        next_attempt_at: nextAttempt.toISOString(),
        last_error: "ATK transport failure before request delivery (" + transportCode(error) + ").",
      },
    );
    return "retry";
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      await dbPatch(env, "fiskalo_basic_fiscal_documents",
        postgrestQuery({ id: "eq." + doc.id, submission_state: "eq.submitting" }),
        { submission_state: "rejected", next_attempt_at: null, last_error: "ATK rejected queued coupon (HTTP " + response.status + ")." },
      );
      return "rejected";
    }
    await markNeedsReconciliation(env, doc, "ATK returned HTTP " + response.status + "; response does not prove non-acceptance.");
    return "reconciliation";
  }
  if (!body || typeof body !== "object" || !("transaction_id" in body)) {
    await markNeedsReconciliation(env, doc, "ATK response did not include a transaction_id; do not retry automatically.");
    return "reconciliation";
  }
  const rawTransactionId = (body as { transaction_id: unknown }).transaction_id;
  const transactionId = typeof rawTransactionId === "string"
    ? rawTransactionId
    : typeof rawTransactionId === "number" && Number.isSafeInteger(rawTransactionId)
      ? String(rawTransactionId) : "";
  if (!/^[1-9][0-9]{0,19}$/.test(transactionId) || BigInt(transactionId) > BigInt("18446744073709551615")) {
    await markNeedsReconciliation(env, doc, "ATK returned an invalid transaction_id; do not retry automatically.");
    return "reconciliation";
  }

  const bodyMessage = (body as Record<string, unknown>).message;
  const trustedResponse = {
    status: "accepted",
    transactionId,
    message: typeof bodyMessage === "string" ? bodyMessage : "",
    environment: "ATK TEST",
  };
  try {
    if (doc.document_type === 1) {
      await dbRpc(env, "fiskalo_basic_server_record_atk_receipt_v2", {
        p_actor_id: sale.operator_id,
        p_business_id: doc.business_id,
        p_sale_id: doc.sale_id,
        p_pos_record_id: sale.pos_id,
        p_coupon_id: doc.coupon_id,
        p_idempotency_key: doc.idempotency_key,
        p_signed_payload: doc.signed_payload,
        p_signature: doc.signature,
        p_atk_transaction_id: transactionId,
        p_atk_response: trustedResponse,
        p_nui_kf: doc.nui_kf,
        p_verification_no: doc.nui_kf,
        p_citizen_payload: doc.citizen_payload,
        p_citizen_signature: doc.citizen_signature,
        p_daily_number: doc.daily_number,
        p_offline_issued_at: doc.offline_issued_at,
        p_qr_svg_base64: qrSvgBase64,
      });
    } else {
      await dbRpc(env, "fiskalo_basic_server_record_atk_correction_v2", {
        p_actor_id: sale.operator_id,
        p_business_id: doc.business_id,
        p_sale_id: doc.sale_id,
        p_original_coupon_id: doc.reference_coupon_id,
        p_correction_coupon_id: doc.coupon_id,
        p_document_type: doc.document_type,
        p_idempotency_key: doc.idempotency_key,
        p_signed_payload: doc.signed_payload,
        p_signature: doc.signature,
        p_atk_transaction_id: transactionId,
        p_atk_response: trustedResponse,
        p_nui_kf: doc.nui_kf,
        p_verification_no: doc.nui_kf,
        p_citizen_payload: doc.citizen_payload,
        p_citizen_signature: doc.citizen_signature,
        p_daily_number: doc.daily_number,
        p_qr_svg_base64: qrSvgBase64,
      });
    }
    return "accepted";
  } catch {
    await markNeedsReconciliation(env, doc, "ATK accepted the queued coupon (transaction " + transactionId + ") but the trusted ledger update failed.");
    return "accepted_not_persisted";
  }
}

async function runRecovery(env: Env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Recovery worker environment is not configured.");
  const now = new Date();
  const docs = await dbGet<FiscalDoc>(env, "fiskalo_basic_fiscal_documents",
    postgrestQuery({
      select: "id,business_id,sale_id,coupon_id,idempotency_key,document_type,reference_coupon_id,parent_document_id,created_at,signed_payload,signature,nui_kf,verification_no,citizen_payload,citizen_signature,daily_number,offline_issued_at,recovery_deadline_at,qr_svg_base64,attempt_count,next_attempt_at",
      submission_state: "eq.queued",
      document_type: "in.(1,2,3)",
      order: "next_attempt_at.asc.nullsfirst",
      limit: String(MAX_BATCH),
    }));
  const due = docs.filter(doc => !doc.next_attempt_at || Date.parse(doc.next_attempt_at) <= now.getTime());
  const results = { checked: due.length, accepted: 0, retry: 0, accepted_not_persisted: 0, rejected: 0, reconciliation: 0, expired: 0, skipped: 0 };
  for (const doc of due) {
    try {
      const result = await processDocument(env, doc, now);
      if (result in results) results[result as keyof typeof results]++;
    } catch {
      results.reconciliation++;
      await markNeedsReconciliation(env, doc, "Recovery worker encountered an internal error; automatic retry stopped.");
    }
  }
  // A worker crash after claiming a document leaves it in submitting. Never retry it blindly.
  const stale = await dbGet<{id:string}>(env, "fiskalo_basic_fiscal_documents",
    postgrestQuery({
      select: "id",
      submission_state: "eq.submitting",
      last_attempt_at: "lt." + new Date(now.getTime() - 5 * 60_000).toISOString(),
      limit: String(MAX_BATCH),
    }));
  for (const item of stale) {
    await dbPatch(env, "fiskalo_basic_fiscal_documents",
      postgrestQuery({ id: "eq." + item.id, submission_state: "eq.submitting" }),
      { submission_state: "needs_reconciliation", next_attempt_at: null, last_error: "Recovery worker stopped after claiming this document; ATK delivery outcome is unknown." },
    );
    results.reconciliation++;
  }
  return results;
}

export default {
  async scheduled(_controller: { scheduledTime: number; cron: string }, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    ctx.waitUntil(runRecovery(env));
  },
  async fetch(request: Request, env: Env) {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ service: "fiskalo-atk-recovery", environment: "ATK TEST", productionEnabled: false });
  },
};
