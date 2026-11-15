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
        select: "id,branch_id,pos_id",
        id: "eq." + posRecordId,
        business_id: "eq." + businessId,
        limit: "1",
      });
      const poses = await supabaseRequest(restOrigin + "fiskalo_basic_pos?" + posQuery.toString(), token, anonKey);
      if (!Array.isArray(poses) || poses.length !== 1 || !isRecord(poses[0])) return jsonError("POS does not belong to this business.", 403);
      const pos = poses[0];
      const fiscalizationNo = requiredString(body.fiscalizationNumber, "ATK fiscalization number", 128);
      const applicationId = requiredPositiveInteger(body.applicationId, "Application ID");
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
        select: "id,branch_id,pos_id",
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
        verification_no: requiredPositiveInteger(body.verificationCode, "ATK verification code"),
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
      const details = requiredString(body.details, "Signed coupon details", 200_000);
      const signature = requiredString(body.signature, "Coupon signature", 16_384);
      // ATK is the authority for acceptance. A browser-supplied status or transaction ID is never used.
      const result = await atkPost<JsonRecord>("/pos/coupon", { details, signature });
      const transactionId = result.transaction_id;
      const parsedTransactionId = typeof transactionId === "string" || typeof transactionId === "number"
        ? Number(transactionId) : 0;
      if (!Number.isSafeInteger(parsedTransactionId) || parsedTransactionId <= 0) {
        return jsonError("ATK TEST returned no valid transaction_id; coupon is not marked accepted.", 502);
      }
      return NextResponse.json({
        status: "accepted",
        transactionId: String(parsedTransactionId),
        message: typeof result.message === "string" ? result.message : "",
        environment: "ATK TEST",
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
