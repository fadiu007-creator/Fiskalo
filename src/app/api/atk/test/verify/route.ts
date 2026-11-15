import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { authorizeAtkOrganization, getAtkRequestContext, positiveInteger } from "@/lib/atk/server-auth";

function readableProviderMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.slice(0, 800);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error", "description", "title"]) {
      if (record[key] !== undefined) {
        const message = readableProviderMessage(record[key], "");
        if (message) return message;
      }
    }
    try { return JSON.stringify(value).slice(0, 800); } catch { return fallback; }
  }
  return fallback;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

  const { supabase, user, authError } = await getAtkRequestContext(request);
  if (authError || !user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  const posInstallationId = typeof body.posInstallationId === "string" ? body.posInstallationId : "";
  const nui = typeof body.nui === "string" ? body.nui : String(body.nui ?? "");
  const fiscalizationNumber = typeof body.fiscalizationNumber === "string" ? body.fiscalizationNumber.trim() : "";
  const branchId = positiveInteger(body.branchId);
  const posId = positiveInteger(body.posId);
  const applicationId = positiveInteger(body.applicationId);
  if (!organizationId || !posInstallationId || !/^\d{9}$/.test(nui) || !fiscalizationNumber || !branchId || !posId || !applicationId) {
    return Response.json({ error: "invalid_test_identifiers", detail: "Organization, 9-digit taxpayer NUI, test fiscalization number, branch ID, POS ID and Application ID are required." }, { status: 400 });
  }
  const platformAdmins = (process.env.FISKALO_PLATFORM_ADMIN_EMAILS || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  const isPlatformAdmin = Boolean(user.email && platformAdmins.includes(user.email.toLowerCase()));
  let dataClient = supabase;
  if (isPlatformAdmin) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return Response.json({ error: "admin_backend_not_configured", detail: "Platform admin service is not configured." }, { status: 503 });
    dataClient = createSupabaseClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) as typeof supabase;
    const { data: organization, error: organizationError } = await dataClient.from("fiskalo_organizations").select("nui").eq("id", organizationId).maybeSingle();
    if (organizationError || !organization || String(organization.nui) !== nui) {
      return Response.json({ error: "organization_not_authorized", detail: "The taxpayer NUI does not match the selected business." }, { status: 403 });
    }
  } else {
    const authorization = await authorizeAtkOrganization(supabase, user.id, organizationId, nui);
    if (!authorization.ok) return Response.json({ error: "organization_not_authorized", detail: authorization.detail }, { status: authorization.status });
  }

  const { data: pos, error: posError } = await dataClient.from("fiskalo_atk_pos_installations")
    .select("id,organization_id,atk_branch_id,pos_id,environment")
    .eq("id", posInstallationId).eq("organization_id", organizationId).maybeSingle();
  if (posError || !pos || pos.environment !== "test" || Number(pos.atk_branch_id) !== branchId || Number(pos.pos_id) !== posId) {
    return Response.json({ error: "test_pos_mismatch", detail: "The selected TEST POS does not match the submitted branch and POS identifiers." }, { status: 409 });
  }

  try {
    const response = await fetch("https://fiskalizimi-test.atk-ks.org/ca/verify/" + encodeURIComponent(nui), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ fiscalization_no: fiscalizationNumber, pos_id: posId, branch_id: branchId, application_id: applicationId }),
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    });
    const text = await response.text();
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(text) as Record<string, unknown>; } catch { /* handled below */ }
    if (!response.ok) {
      const detail = readableProviderMessage(result, readableProviderMessage(text, "ATK test verification was rejected."));
      return Response.json({ error: "atk_verification_rejected", detail, atkStatus: response.status }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const nested = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : result;
    const businessName = typeof nested.business_name === "string" ? nested.business_name
      : typeof nested.businessName === "string" ? nested.businessName : "";
    const verificationCode = typeof nested.verification_code === "string" ? nested.verification_code
      : typeof nested.verificationCode === "string" ? nested.verificationCode : "";
    if (!businessName || !verificationCode) {
      const providerMessage = readableProviderMessage(result, "");
      return Response.json({
        error: "atk_unexpected_response",
        detail: "ATK returned HTTP " + response.status + " but its verification response did not contain the required business name and verification code." +
          (providerMessage ? " ATK message: " + providerMessage : ""),
        responseKeys: Object.keys(result),
        atkStatus: response.status,
      }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const { error: saveError } = await dataClient.from("fiskalo_atk_pos_verifications").upsert({
      organization_id: organizationId, pos_installation_id: posInstallationId, nui,
      atk_branch_id: branchId, pos_id: posId, application_id: applicationId,
      verification_code: verificationCode, business_name: businessName, verified_at: new Date().toISOString(), created_by: user.id,
    }, { onConflict: "pos_installation_id" });
    if (saveError) return Response.json({ error: "verification_save_failed", detail: "ATK verified the POS, but Fiskalo could not save the verification to the business account: " + saveError.message }, { status: 500 });
    return Response.json({ businessName, verificationCode, environment: "TEST" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return Response.json({ error: timeout ? "atk_timeout" : "atk_unreachable", detail: timeout ? "ATK test service timed out." : "Could not reach ATK test service." }, { status: 502 });
  }
}
