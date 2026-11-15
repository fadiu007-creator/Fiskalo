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
type Sale = { id: string; operator_id: string; pos_id: string; coupon_id: number | string };
type Pos = { id: string; branch_id: number | string; pos_id: number | string; application_id: number | string; certificate_status: string };

const ATK_TEST_ORIGIN = "https://fiskalizimi-test.atk-ks.org";
const MAX_BATCH = 25;
const MAX_BACKOFF_MINUTES = 30;

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
    postgrestQuery({ select: "id,operator_id,pos_id,coupon_id", id: "eq." + doc.sale_id, business_id: "eq." + doc.business_id, limit: "1" }));
  if (sales.length !== 1 || !sales[0].operator_id || String(sales[0].coupon_id) !== String(doc.coupon_id)) {
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

  const trustedResponse = {
    status: "accepted",
    transactionId,
    message: typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : "",
    environment: "ATK TEST",
  };
  try {
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
      p_verification_no: doc.verification_no || doc.nui_kf,
      p_citizen_payload: doc.citizen_payload,
      p_citizen_signature: doc.citizen_signature,
      p_daily_number: doc.daily_number,
      p_offline_issued_at: doc.offline_issued_at,
      p_qr_svg_base64: doc.qr_svg_base64,
    });
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
      select: "id,business_id,sale_id,coupon_id,idempotency_key,document_type,signed_payload,signature,nui_kf,verification_no,citizen_payload,citizen_signature,daily_number,offline_issued_at,recovery_deadline_at,qr_svg_base64,attempt_count,next_attempt_at",
      submission_state: "eq.queued",
      document_type: "eq.1",
      order: "next_attempt_at.asc.nullsfirst",
      limit: String(MAX_BATCH),
    }));
  const due = docs.filter(doc => !doc.next_attempt_at || Date.parse(doc.next_attempt_at) <= now.getTime());
  const results = { checked: due.length, accepted: 0, retried: 0, rejected: 0, reconciliation: 0, expired: 0, skipped: 0 };
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
