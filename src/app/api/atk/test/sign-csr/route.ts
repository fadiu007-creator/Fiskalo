import { getAtkRequestContext, positiveInteger } from "@/lib/atk/server-auth";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

  const { supabase, user, authError } = await getAtkRequestContext(request);
  if (authError || !user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  const posInstallationId = typeof body.posInstallationId === "string" ? body.posInstallationId : "";
  const nui = typeof body.nui === "string" ? body.nui : String(body.nui ?? "");
  const businessName = typeof body.businessName === "string" ? body.businessName.trim() : "";
  const verificationCode = typeof body.verificationCode === "string" ? body.verificationCode.trim() : "";
  const csrPem = typeof body.csrPem === "string" ? body.csrPem.trim() : "";
  const branchId = positiveInteger(body.branchId);
  const posId = positiveInteger(body.posId);
  const applicationId = positiveInteger(body.applicationId);
  if (!organizationId || !posInstallationId || !/^\d{9}$/.test(nui) || !businessName || !verificationCode ||
      !csrPem.startsWith("-----BEGIN CERTIFICATE REQUEST-----") ||
      !csrPem.includes("-----END CERTIFICATE REQUEST-----") || csrPem.length > 20000 ||
      !branchId || !posId || !applicationId) {
    return Response.json({ error: "invalid_certificate_request", detail: "Verified business identity, POS installation, NUI, verification code, CSR, branch ID, POS ID and Application ID are required." }, { status: 400 });
  }

  // Initial ATK verification remains owner/admin-only. Staff can provision a
  // local key only after the exact POS has a matching saved verification.
  const { data: membership, error: membershipError } = await supabase
    .from("fiskalo_organization_users").select("role")
    .eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle();
  if (membershipError || !membership || !["owner", "administrator", "manager", "cashier"].includes(membership.role)) {
    return Response.json({ error: "organization_not_authorized", detail: "This account cannot provision an ATK POS certificate." }, { status: 403 });
  }
  const [{ data: organization, error: organizationError }, { data: pos, error: posError }, { data: verification, error: verificationError }] = await Promise.all([
    supabase.from("fiskalo_organizations").select("nui").eq("id", organizationId).single(),
    supabase.from("fiskalo_atk_pos_installations").select("id,environment,atk_branch_id,pos_id")
      .eq("id", posInstallationId).eq("organization_id", organizationId).maybeSingle(),
    supabase.from("fiskalo_atk_pos_verifications").select("nui,atk_branch_id,pos_id,application_id,verification_code,business_name")
      .eq("organization_id", organizationId).eq("pos_installation_id", posInstallationId).maybeSingle(),
  ]);
  if (organizationError || !organization || String(organization.nui) !== nui ||
      posError || !pos || pos.environment !== "test" ||
      Number(pos.atk_branch_id) !== branchId || Number(pos.pos_id) !== posId ||
      verificationError || !verification || verification.nui !== nui ||
      Number(verification.atk_branch_id) !== branchId || Number(verification.pos_id) !== posId ||
      Number(verification.application_id) !== applicationId ||
      verification.verification_code !== verificationCode ||
      (verification.business_name && verification.business_name !== businessName)) {
    return Response.json({ error: "pos_verification_mismatch", detail: "A matching saved ATK TEST verification is required before a device certificate can be issued." }, { status: 403 });
  }

  try {
    const response = await fetch("https://fiskalizimi-test.atk-ks.org/ca/signcsr", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        business_name: businessName, business_id: Number(nui), branch_id: branchId,
        verification_code: verificationCode, pos_id: posId, application_id: applicationId, csr: csrPem,
      }),
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    });
    const text = await response.text();
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(text) as Record<string, unknown>; } catch { /* handled below */ }
    if (!response.ok) {
      const detail = String(result.message ?? result.error ?? result.detail ?? "ATK rejected the CSR request.").slice(0, 800);
      return Response.json({ error: "atk_certificate_rejected", detail, atkStatus: response.status }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const signedCertificate = typeof result.signed_certificate === "string" ? result.signed_certificate : "";
    if (!signedCertificate) return Response.json({ error: "atk_unexpected_certificate_response" }, { status: 502 });
    return Response.json({ signedCertificate, environment: "TEST" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return Response.json({ error: timeout ? "atk_timeout" : "atk_unreachable", detail: timeout ? "ATK test certificate request timed out." : "Could not reach ATK test service." }, { status: 502 });
  }
}
