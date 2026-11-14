export type WorkerMemberRow = {
  userId: string;
  role: "owner" | "cashier";
  operatorName: string | null;
  createdAt: string;
};
export type WorkerResolvedUser = {
  id: string;
  invited: boolean;
  delivery: "sent" | "existing" | "not_confirmed";
};
export type WorkerHandlerDependencies = {
  authenticate(token: string): Promise<{ id: string } | null>;
  isOwner(businessId: string, userId: string): Promise<boolean>;
  listMembers(businessId: string): Promise<WorkerMemberRow[]>;
  getUserEmail(userId: string): Promise<string | null>;
  resolveUser(email: string): Promise<WorkerResolvedUser>;
  attachCashier(businessId: string, userId: string): Promise<"added" | "already_member">;
};
export class WorkerRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "WorkerRequestError";
  }
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const MAX_REQUEST_BYTES = 16 * 1024;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function normalizeWorkerEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}
export function createWorkerHandler(deps: WorkerHandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "POST") return jsonResponse(405, { error: "Përdor metodën POST." });

    const authorization = request.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!bearer) return jsonResponse(401, { error: "Kërkohet hyrja në llogari." });

    let user: { id: string } | null;
    try {
      user = await deps.authenticate(bearer[1]);
    } catch {
      return jsonResponse(401, { error: "Sesioni nuk është i vlefshëm. Hyr përsëri." });
    }
    if (!user) return jsonResponse(401, { error: "Sesioni nuk është i vlefshëm. Hyr përsëri." });

    const contentLength = request.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
      return jsonResponse(413, { error: "Kërkesa është shumë e madhe." });
    }

    let rawBody: string;
    try {
      rawBody = await request.text();
    } catch {
      return jsonResponse(400, { error: "Kërkesa nuk përmban JSON të vlefshëm." });
    }
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return jsonResponse(413, { error: "Kërkesa është shumë e madhe." });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse(400, { error: "Kërkesa nuk përmban JSON të vlefshëm." });
    }
    if (!isRecord(body)) return jsonResponse(400, { error: "Kërkesa nuk është e vlefshme." });

    const businessId = typeof body.businessId === "string" ? body.businessId.trim() : "";
    if (!UUID_PATTERN.test(businessId)) {
      return jsonResponse(400, { error: "Identifikuesi i biznesit nuk është i vlefshëm." });
    }
    const action = body.action;
    if (action !== "list" && action !== "invite") {
      return jsonResponse(400, { error: "Veprimi nuk mbështetet." });
    }

    try {
      if (!(await deps.isOwner(businessId, user.id))) {
        return jsonResponse(403, { error: "Vetëm pronari i biznesit mund të menaxhojë punonjësit." });
      }
      if (action === "list") {
        const rows = await deps.listMembers(businessId);
        const members = await Promise.all(rows.map(async (member) => ({
          ...member,
          email: await deps.getUserEmail(member.userId),
        })));
        return jsonResponse(200, { members });
      }

      const email = normalizeWorkerEmail(body.email);
      if (!email) return jsonResponse(400, { error: "Shkruaj një adresë email të vlefshme." });
      const resolved = await deps.resolveUser(email);
      const membership = await deps.attachCashier(businessId, resolved.id);
      return jsonResponse(200, {
        ok: true,
        email,
        invited: resolved.invited,
        delivery: resolved.delivery,
        alreadyMember: membership === "already_member",
      });
    } catch (error) {
      if (error instanceof WorkerRequestError) return jsonResponse(error.status, { error: error.message });
      console.error("Fiskalo worker-management request failed", error instanceof Error ? error.name : "unknown");
      return jsonResponse(500, { error: "Nuk u përfundua veprimi për punonjësin. Provo përsëri." });
    }
  };
}
