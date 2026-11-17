export const dynamic = "force-dynamic";

const PINNED_HEARTBEAT_PUBLIC_KEY_SPKI_BASE64 = "MFkwEwYHKoZIzj0DAQcDQgAE8JZgYcM2G4QYtWc1vHnh7FXjWAaPyJcUh/VAR8qAThZnZ1UAvmN5OK8DgNkeLfWVBSHEGlM1KCykjp66dNIeZA==";
const MAX_BODY_BYTES = 4096;

type HeartbeatEnvironment = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ATK_HEARTBEAT_PRIVATE_KEY_PEM?: string;
};
type JsonRecord = Record<string, unknown>;

function jsonError(error: string, status: number): Response {
  return Response.json({ error, environment: "ATK TEST", productionEnabled: false }, {
    status,
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache" },
  });
}
function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function decodeNonce(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return bytes.length === 32 ? bytes : null;
  } catch { return null; }
}
function pemPkcs8Bytes(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length < 48 || bytes.length > 256) throw new Error("Invalid PKCS#8 heartbeat key length.");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
export function createHeartbeatCanonicalMessage(
  businessId: string, posUuid: string, nonce: string, issuedAtUnixMilliseconds: number,
): string {
  if (!isUuid(businessId) || !isUuid(posUuid) || !decodeNonce(nonce) ||
      !Number.isSafeInteger(issuedAtUnixMilliseconds) || issuedAtUnixMilliseconds <= 0) {
    throw new Error("Invalid canonical POS heartbeat fields.");
  }
  return [
    "fiskalo-atk-heartbeat-v1", "ATK TEST",
    businessId.toLowerCase(), posUuid.toLowerCase(), nonce,
    String(issuedAtUnixMilliseconds),
  ].join("\n");
}
async function readJsonArray(response: Response): Promise<JsonRecord[]> {
  if (!response.ok) throw new Error("Supabase request failed with HTTP " + response.status + ".");
  const value: unknown = await response.json();
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Supabase returned an invalid heartbeat response.");
  return value;
}

export async function handleHeartbeat(
  request: Request,
  env: HeartbeatEnvironment,
  expectedPublicKeySpkiBase64 = PINNED_HEARTBEAT_PUBLIC_KEY_SPKI_BASE64,
): Promise<Response> {
  if (request.method !== "POST") return jsonError("method_not_allowed", 405);
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) return jsonError("origin_not_allowed", 403);
    } catch { return jsonError("origin_not_allowed", 403); }
  }
  const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
  if (!supabaseUrl || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError("heartbeat_server_not_configured", 503);
  }
  if (!env.ATK_HEARTBEAT_PRIVATE_KEY_PEM) return jsonError("heartbeat_signing_secret_missing", 503);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return jsonError("request_too_large", 413);
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || token.length > 8192) return jsonError("authentication_required", 401);

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return jsonError("request_too_large", 413);
    body = JSON.parse(raw);
  } catch { return jsonError("invalid_json", 400); }
  if (!isRecord(body) || !isUuid(body.businessId) || !isUuid(body.posUuid) ||
      typeof body.nonce !== "string" || !decodeNonce(body.nonce)) {
    return jsonError("invalid_heartbeat_request", 400);
  }

  try {
    const userResponse = await fetch(supabaseUrl + "/auth/v1/user", {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
      cache: "no-store",
    });
    if (!userResponse.ok) return jsonError("invalid_session", 401);
    const user: unknown = await userResponse.json();
    if (!isRecord(user) || !isUuid(user.id)) return jsonError("invalid_session", 401);

    const memberQuery = new URLSearchParams({
      select: "business_id", business_id: "eq." + body.businessId, user_id: "eq." + user.id, limit: "1",
    });
    const memberRows = await readJsonArray(await fetch(
      supabaseUrl + "/rest/v1/fiskalo_basic_members?" + memberQuery.toString(),
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token, Accept: "application/json" }, cache: "no-store" },
    ));
    if (memberRows.length !== 1) return jsonError("business_access_denied", 403);

    const posQuery = new URLSearchParams({
      select: "id,business_id", id: "eq." + body.posUuid, business_id: "eq." + body.businessId, limit: "1",
    });
    const posRows = await readJsonArray(await fetch(
      supabaseUrl + "/rest/v1/fiskalo_basic_pos?" + posQuery.toString(),
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token, Accept: "application/json" }, cache: "no-store" },
    ));
    if (posRows.length !== 1) return jsonError("pos_access_denied", 403);

    let signingKey: CryptoKey;
    try {
      signingKey = await crypto.subtle.importKey(
        "pkcs8", pemPkcs8Bytes(env.ATK_HEARTBEAT_PRIVATE_KEY_PEM),
        { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"],
      );
      const privateJwk = await crypto.subtle.exportKey("jwk", signingKey);
      if (!privateJwk.x || !privateJwk.y) throw new Error("Heartbeat key has no public point.");
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, ext: true, key_ops: ["verify"] },
        { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"],
      );
      const publicSpki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
      if (toBase64(publicSpki) !== expectedPublicKeySpkiBase64) throw new Error("Heartbeat key does not match the pinned public key.");
    } catch { return jsonError("heartbeat_signing_key_invalid_or_mismatched", 503); }

    const issuedAtUnixMs = Date.now();
    const canonical = createHeartbeatCanonicalMessage(body.businessId, body.posUuid, body.nonce, issuedAtUnixMs);
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(canonical),
    ));
    if (signature.length !== 64) return jsonError("heartbeat_signature_invalid", 503);
    const signatureBase64 = toBase64(signature);
    const nonceSha256 = await sha256Hex(decodeNonce(body.nonce)!);

    const evidenceResponse = await fetch(supabaseUrl + "/rest/v1/rpc/fiskalo_record_atk_pos_heartbeat", {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json", Accept: "application/json",
      },
      body: JSON.stringify({
        p_business_id: body.businessId, p_pos_id: body.posUuid, p_actor_id: user.id,
        p_server_time_utc: new Date(issuedAtUnixMs).toISOString(),
        p_nonce_sha256: nonceSha256, p_signature_base64: signatureBase64,
      }),
      cache: "no-store",
    });
    if (!evidenceResponse.ok) return jsonError("heartbeat_evidence_persistence_failed", 503);
    const evidence: unknown = await evidenceResponse.json();
    if (!Array.isArray(evidence) || evidence.length !== 1 || !isRecord(evidence[0])) {
      return jsonError("heartbeat_evidence_response_invalid", 503);
    }
    const previousHeartbeatAtUtc = typeof evidence[0].previous_heartbeat_at === "string"
      ? evidence[0].previous_heartbeat_at : null;
    const gapSeconds = typeof evidence[0].gap_seconds === "number" && Number.isSafeInteger(evidence[0].gap_seconds)
      ? evidence[0].gap_seconds : null;

    return Response.json({
      version: 1, businessId: body.businessId, posUuid: body.posUuid, nonce: body.nonce,
      issuedAtUnixMs, serverTimeUtc: new Date(issuedAtUnixMs).toISOString(),
      previousHeartbeatAtUtc, gapSeconds, gapDetected: gapSeconds !== null && gapSeconds > 60,
      signatureBase64, environment: "ATK TEST", productionEnabled: false,
    }, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache" },
    });
  } catch { return jsonError("heartbeat_service_unavailable", 503); }
}

export async function POST(request: Request): Promise<Response> {
  return handleHeartbeat(request, {
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ATK_HEARTBEAT_PRIVATE_KEY_PEM: process.env.ATK_HEARTBEAT_PRIVATE_KEY_PEM,
  });
}
