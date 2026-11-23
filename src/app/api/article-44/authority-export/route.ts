import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAtkServiceRoleClient } from "@/lib/atk/server-auth";
import { verifyArticle44AuthorityEvidenceManifest } from "@/lib/pos/article44-export";

export const dynamic = "force-dynamic";

const BUCKET = "fiskalo-article44-evidence";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(field + " is required and must be no longer than " + maxLength + " characters.");
  }
  return value.trim();
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 32 * 1024) {
      return jsonError("Authority export request is too large.", 413);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("A valid JSON authority export request is required.", 400);
    }
    if (!isRecord(body)) return jsonError("A valid authority export request is required.", 400);

    const businessId = requiredString(body.businessId, "Business ID", 64);
    const incidentId = requiredString(body.incidentId, "Incident ID", 64);
    const posId = requiredString(body.posId, "POS ID", 64);
    const from = requiredString(body.from, "Incident start time", 64);
    const to = requiredString(body.to, "Export end time", 64);
    const authorityRequestReference = requiredString(body.authorityRequestReference, "Authority request reference", 100);
    if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(incidentId) || !UUID_PATTERN.test(posId)) {
      return jsonError("Business, incident and POS identifiers must be valid UUIDs.", 400);
    }
    if (authorityRequestReference.length < 3 ||
        !Number.isFinite(Date.parse(from)) ||
        !Number.isFinite(Date.parse(to)) ||
        Date.parse(to) <= Date.parse(from)) {
      return jsonError("A real authority reference and valid incident date range are required.", 400);
    }

    const supabase = await createClient();
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) return jsonError("Sign in is required for Article 44 export.", 401);

    const { data: membership, error: membershipError } = await supabase
      .from("fiskalo_basic_members")
      .select("business_id")
      .eq("business_id", businessId)
      .eq("user_id", authData.user.id)
      .eq("role", "owner")
      .maybeSingle();
    if (membershipError) return jsonError("Could not verify business-owner permissions.", 503);
    if (!membership) return jsonError("Only the business owner may export Article 44 evidence.", 403);

    // Service-role access is kept inside this server route. The owner session is
    // checked above, and the database repeats the owner check using this actor ID.
    const serviceClient = getAtkServiceRoleClient();
    const verifiedManifest = await verifyArticle44AuthorityEvidenceManifest(
      body.authorityRequestEvidenceManifest,
      businessId,
      incidentId,
      async storagePath => {
        const { data: file, error } = await serviceClient.storage.from(BUCKET).download(storagePath);
        if (error || !file) throw new Error("Could not read authority-request evidence from private storage.");
        return { bytes: await file.arrayBuffer(), mimeType: file.type };
      },
    );

    const { data, error: exportError } = await serviceClient.rpc(
      "fiskalo_basic_article44_unfiscalized_export",
      {
        p_actor_id: authData.user.id,
        p_incident_id: incidentId,
        p_business_id: businessId,
        p_pos_id: posId,
        p_from: from,
        p_to: to,
        p_authority_request_reference: authorityRequestReference,
        p_authority_request_evidence_manifest: verifiedManifest,
        p_limit: 5000,
      },
    );
    if (exportError) {
      return jsonError("The authority export could not be recorded. Verify the incident, request evidence and date range.", 409);
    }
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Article 44 authority export failed.";
    const status = message.includes("configuration is missing") ? 503 : 422;
    return jsonError(message, status);
  }
}
