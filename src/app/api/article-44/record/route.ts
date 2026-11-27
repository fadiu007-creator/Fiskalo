import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAtkServiceRoleClient } from "@/lib/atk/server-auth";
import { verifyArticle44FilingEvidenceManifest } from "@/lib/pos/article44-export";
import { validateSameOriginJsonPost } from "@/lib/http/request-security";
import {
  InvalidRequestBodyError,
  readJsonBodyLimited,
  RequestBodyTooLargeError,
} from "@/lib/http/read-json-limited";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "fiskalo-article44-evidence";
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonRecord = Record<string, unknown>;

class EvidenceStorageError extends Error {
  constructor() {
    super("Private Article 44 evidence could not be verified.");
    this.name = "EvidenceStorageError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const requestSecurityFailure = validateSameOriginJsonPost(request);
  if (requestSecurityFailure === "origin") return jsonError("Kërkesë nga burim i palejuar.", 403);
  if (requestSecurityFailure === "content-type") return jsonError("Kërkohet përmbajtje JSON.", 415);

  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 32 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return jsonError("Kërkesa është shumë e madhe.", 413);
    if (error instanceof InvalidRequestBodyError) return jsonError("Kërkohet JSON UTF-8 i vlefshëm.", 400);
    return jsonError("Kërkesa nuk mund të lexohet.", 400);
  }
  if (!isRecord(body)) return jsonError("Kërkesa për regjistrimin e dëshmisë është e pavlefshme.", 400);

  const action = body.action;
  const incidentId = typeof body.incidentId === "string" ? body.incidentId.trim() : "";
  const channel = body.channel;
  const authorityReference = body.authorityReference === null || body.authorityReference === undefined
    ? null
    : typeof body.authorityReference === "string" ? body.authorityReference.trim() : "";
  if (action !== "notice" && action !== "monthly_submission") {
    return jsonError("Lloji i regjistrimit është i pavlefshëm.", 400);
  }
  if (!UUID_PATTERN.test(incidentId)) return jsonError("Identifikuesi i incidentit është i pavlefshëm.", 400);
  if (channel !== "electronic" && channel !== "in_person") {
    return jsonError("Zgjidh një kanal të vlefshëm të dorëzimit.", 400);
  }
  if (authorityReference === "" || (authorityReference !== null && authorityReference.length > 200) ||
      (authorityReference !== null && /[\u0000-\u001f\u007f]/.test(authorityReference))) {
    return jsonError("Referenca e autoritetit është e pavlefshme.", 400);
  }

  const supabase = await createClient().catch(() => null);
  if (!supabase) return jsonError("Shërbimi i autentikimit nuk është i disponueshëm.", 503);
  const authResult = await supabase.auth.getUser().catch(() => null);
  if (!authResult) return jsonError("Shërbimi i autentikimit nuk është i disponueshëm.", 503);
  const { data: authData, error: authError } = authResult;
  if (authError || !authData.user) return jsonError("Duhet të kyçesh përsëri.", 401);

  let incidentResult;
  try {
    incidentResult = await supabase
      .from("fiskalo_basic_article44_incidents")
      .select("id,business_id")
      .eq("id", incidentId)
      .maybeSingle();
  } catch {
    return jsonError("Nuk u verifikua incidenti i Nenit 44.", 503);
  }
  const { data: incident, error: incidentError } = incidentResult;
  if (incidentError) return jsonError("Nuk u verifikua incidenti i Nenit 44.", 503);
  if (!incident || typeof incident.business_id !== "string" || !UUID_PATTERN.test(incident.business_id)) {
    return jsonError("Incidenti nuk u gjet ose nuk ke qasje.", 404);
  }

  let membershipResult;
  try {
    membershipResult = await supabase
      .from("fiskalo_basic_members")
      .select("business_id")
      .eq("business_id", incident.business_id)
      .eq("user_id", authData.user.id)
      .eq("role", "owner")
      .maybeSingle();
  } catch {
    return jsonError("Nuk u verifikuan të drejtat e pronarit.", 503);
  }
  const { data: membership, error: membershipError } = membershipResult;
  if (membershipError) return jsonError("Nuk u verifikuan të drejtat e pronarit.", 503);
  if (!membership) return jsonError("Vetëm pronari i biznesit mund të regjistrojë këtë dëshmi.", 403);

  let serviceClient: ReturnType<typeof getAtkServiceRoleClient>;
  try {
    serviceClient = getAtkServiceRoleClient();
  } catch {
    return jsonError("Shërbimi i dëshmive private nuk është i konfiguruar.", 503);
  }
  let verifiedManifest: Awaited<ReturnType<typeof verifyArticle44FilingEvidenceManifest>>;
  try {
    verifiedManifest = await verifyArticle44FilingEvidenceManifest(
      body.evidenceManifest,
      incident.business_id,
      incidentId,
      action,
      async storagePath => {
        const { data: file, error } = await serviceClient.storage.from(BUCKET).download(storagePath);
        if (error || !file || file.size < 1 || file.size > MAX_EVIDENCE_BYTES) {
          throw new EvidenceStorageError();
        }
        return { bytes: await file.arrayBuffer(), mimeType: file.type };
      },
    );
  } catch (error) {
    if (error instanceof EvidenceStorageError) {
      return jsonError("Një ose më shumë dëshmi nuk mund të lexohen nga ruajtja private.", 503);
    }
    const message = error instanceof Error ? error.message : "Dëshmia e Nenit 44 është e pavlefshme.";
    return jsonError(message, 422);
  }

  const rpcName = action === "notice"
    ? "fiskalo_basic_record_article44_notice_verified"
    : "fiskalo_basic_record_article44_monthly_submission_verified";
  const rpcArgs = action === "notice"
    ? {
        p_actor_id: authData.user.id,
        p_incident_id: incidentId,
        p_notice_channel: channel,
        p_authority_reference: authorityReference,
        p_evidence_manifest: verifiedManifest,
      }
    : {
        p_actor_id: authData.user.id,
        p_incident_id: incidentId,
        p_submission_channel: channel,
        p_authority_reference: authorityReference,
        p_evidence_manifest: verifiedManifest,
      };

  let rpcError: { message?: string } | null = null;
  try {
    const rpcResult = await serviceClient.rpc(rpcName, rpcArgs);
    rpcError = rpcResult.error;
  } catch {
    return jsonError("Shërbimi i regjistrimit të dëshmive nuk është i disponueshëm.", 503);
  }
  if (rpcError) {
    return jsonError(
      action === "notice"
        ? "Njoftimi nuk u regjistrua. Kontrollo kushtet e incidentit dhe dëshmitë."
        : "Dorëzimi mujor nuk u regjistrua. Kontrollo afatin, eksportin dhe dëshmitë.",
      409,
    );
  }

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
