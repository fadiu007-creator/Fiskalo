"use client";

import type { createClient } from "@/lib/supabase/client";
import {
  createBrowserPosCsr, getBrowserPosCsr, hasBrowserPosCertificate,
  installBrowserPosCertificate,
} from "@/lib/atk/browser-key-vault";

type Client = ReturnType<typeof createClient>;

function responseMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    for (const key of ["detail", "message", "error"]) {
      if (typeof row[key] === "string" && String(row[key]).trim()) return String(row[key]);
    }
  }
  return fallback;
}

/**
 * Restores the saved ATK TEST onboarding on POS login. If this browser has not
 * completed onboarding, it verifies the POS once, creates a local P-256 key/CSR,
 * requests the TEST certificate and installs it in this browser's IndexedDB.
 * The private key never gets uploaded to Fiskalo.
 */
async function runEnsureATKTestPosReady(
  supabase: Client,
  organizationId: string,
): Promise<{ ready: boolean; message: string }> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Sesioni ka skaduar. Hyr përsëri.");

  const [{ data: org, error: orgError }, { data: profile, error: profileError }, { data: positions, error: posError }, { data: providerApplicationId, error: providerApplicationIdError }] = await Promise.all([
    supabase.from("fiskalo_organizations").select("nui,legal_name,municipality").eq("id", organizationId).single(),
    supabase.from("fiskalo_atk_taxpayer_profiles").select("fiscalization_number").eq("organization_id", organizationId).maybeSingle(),
    supabase.from("fiskalo_atk_pos_installations")
      .select("id,atk_branch_id,pos_id,label,location,environment,status")
      .eq("organization_id", organizationId).eq("environment", "test")
      .order("created_at", { ascending: false }),
    supabase.rpc("fiskalo_get_business_application_id", { target_org: organizationId }),
  ]);
  if (orgError || !org) throw new Error("Nuk u lexuan të dhënat e biznesit.");
  if (profileError || !profile?.fiscalization_number) {
    return { ready: false, message: "Ruaje numrin e fiskalizimit TEST një herë te konfigurimi i ATK-së." };
  }
  if (posError || !positions?.length) {
    return { ready: false, message: "Krijo POS-in TEST një herë te konfigurimi i ATK-së." };
  }
  if (!/^\d{9}$/.test(String(org.nui))) throw new Error("NUI i biznesit duhet të ketë 9 shifra.");

  const applicationStorageKey = "fiskalo-atk-application-id:" + organizationId;
  const savedApplicationId = window.localStorage.getItem(applicationStorageKey);
  const configuredApplicationId = Number(providerApplicationId ?? 0);
  let applicationId = configuredApplicationId > 0
    ? configuredApplicationId
    : Number(savedApplicationId && savedApplicationId !== "929645146946" ? savedApplicationId : 0);
  const orderedPositions = [...positions]
    .filter((candidate) => candidate.status !== "suspended" && candidate.status !== "revoked")
    .sort((a, b) => Number(a.atk_branch_id) - Number(b.atk_branch_id) || Number(a.pos_id) - Number(b.pos_id));
  if (!orderedPositions.length) throw new Error("Nuk ka POS TEST aktiv për këtë biznes. Zgjidh ose regjistro një POS të vlefshëm.");
  const { data: savedVerifications, error: savedError } = await supabase.from("fiskalo_atk_pos_verifications")
    .select("pos_installation_id,business_name,verification_code,nui,atk_branch_id,pos_id,application_id")
    .eq("organization_id", organizationId)
    .in("pos_installation_id", orderedPositions.map((candidate) => candidate.id));
  if (savedError) throw new Error("Verifikimet e ruajtura të POS-it nuk u lexuan: " + savedError.message);
  const verificationByPos = new Map((savedVerifications ?? []).map((row) => [row.pos_installation_id, row]));

  // Prefer the exact Application ID returned by the verified POS record. Never
  // silently substitute a sample/default identifier into a live ATK request.
  const savedForBusiness = orderedPositions
    .map((candidate) => verificationByPos.get(candidate.id))
    .find((row) => row && row.nui === String(org.nui) &&
      Number.isSafeInteger(Number(row.application_id)) && Number(row.application_id) > 0);
  if ((providerApplicationIdError || configuredApplicationId <= 0) && savedForBusiness) {
    applicationId = Number(savedForBusiness.application_id);
  }
  const validVerifiedPositions = orderedPositions.filter((candidate) => {
    const row = verificationByPos.get(candidate.id);
    return Boolean(row && row.nui === String(org.nui) &&
      Number(row.atk_branch_id) === Number(candidate.atk_branch_id) &&
      Number(row.pos_id) === Number(candidate.pos_id) &&
      Number(row.application_id) === applicationId && row.verification_code);
  });
  const certificateChecks = await Promise.all(validVerifiedPositions.map(async (candidate) => ({
    candidate,
    hasCertificate: await hasBrowserPosCertificate(organizationId + ":" + candidate.id + ":" + applicationId).catch(() => false),
  })));
  const pos = certificateChecks.find((entry) => entry.hasCertificate)?.candidate ??
    validVerifiedPositions[0] ?? orderedPositions[0];
  let keyId = "";
  const saved = verificationByPos.get(pos.id) ?? null;

  let businessName = "";
  let verificationCode = "";
  if (saved && saved.nui === String(org.nui) &&
      Number(saved.atk_branch_id) === Number(pos.atk_branch_id) &&
      Number(saved.pos_id) === Number(pos.pos_id) &&
      saved.verification_code && Number.isSafeInteger(Number(saved.application_id)) &&
      Number(saved.application_id) > 0 &&
      (!applicationId || Number(saved.application_id) === applicationId)) {
    businessName = saved.business_name || String(org.legal_name || "");
    verificationCode = saved.verification_code;
    applicationId = Number(saved.application_id);
  } else {
    if (!Number.isSafeInteger(applicationId) || applicationId <= 0) {
      throw new Error("Application ID mungon. Ruaje ID-në e saktë të aplikimit ATK në konfigurimin e ofruesit ose verifiko POS-in për ta ruajtur.");
    }
    const verifyResponse = await fetch("/api/atk/test/verify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId, posInstallationId: pos.id, nui: String(org.nui),
        fiscalizationNumber: profile.fiscalization_number,
        branchId: pos.atk_branch_id, posId: pos.pos_id, applicationId,
      }),
    });
    const verifyData = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok) {
      throw new Error("Verifikimi automatik i POS-it në ATK TEST dështoi: " +
        responseMessage(verifyData, "Kontrollo NUI, numrin e fiskalizimit, degën, POS ID dhe Application ID."));
    }
    businessName = String(verifyData.businessName || "");
    verificationCode = String(verifyData.verificationCode || "");
    if (!businessName || !verificationCode) throw new Error("ATK nuk ktheu business_name dhe verification_code.");
    window.localStorage.setItem(applicationStorageKey, String(applicationId));
  }

  // A certificate is issued for a specific ATK Application ID. Namespace the
  // browser key by that ID so a stale certificate can never sign a coupon for
  // a newly configured application.
  keyId = organizationId + ":" + pos.id + ":" + applicationId;

  if (await hasBrowserPosCertificate(keyId)) {
    if (pos.status !== "active") {
      const { error } = await supabase.rpc("fiskalo_activate_verified_test_pos", { target_pos: pos.id });
      if (error) throw new Error("Certifikata është instaluar, por statusi i POS-it nuk u ruajt: " + error.message);
    }
    return { ready: true, message: "POS-i ATK TEST është gati. Verifikimi u rikthye nga llogaria e biznesit." };
  }

  let csr = await getBrowserPosCsr(keyId);
  if (!csr) {
    csr = await createBrowserPosCsr(keyId, {
      businessName, nui: String(org.nui),
      branchId: String(pos.atk_branch_id), posId: String(pos.pos_id),
    });
  }
  const certificateResponse = await fetch("/api/atk/test/sign-csr", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId, posInstallationId: pos.id, nui: String(org.nui), businessName, verificationCode,
      branchId: pos.atk_branch_id, posId: pos.pos_id, applicationId, csrPem: csr.csrPem,
    }),
  });
  const certificateData = await certificateResponse.json().catch(() => ({}));
  if (!certificateResponse.ok) {
    throw new Error("ATK verifikoi POS-in, por certifikata TEST nuk u lëshua: " +
      responseMessage(certificateData, "Kontrollo përgjigjen e ATK-së."));
  }
  const signedCertificate = String(certificateData.signedCertificate || "");
  if (!signedCertificate) throw new Error("ATK nuk ktheu certifikatën e nënshkruar.");
  await installBrowserPosCertificate(keyId, signedCertificate);
  const { error: updateError } = await supabase.rpc("fiskalo_activate_verified_test_pos", { target_pos: pos.id });
  if (updateError) throw new Error("Certifikata u instalua në këtë pajisje, por statusi i POS-it nuk u ruajt: " + updateError.message);
  return { ready: true, message: "POS-i u verifikua dhe certifikata ATK TEST u instalua automatikisht në këtë pajisje." };
}


const inFlight = new Map<string, Promise<{ ready: boolean; message: string }>>();

export function ensureATKTestPosReady(
  supabase: Client,
  organizationId: string,
): Promise<{ ready: boolean; message: string }> {
  const current = inFlight.get(organizationId);
  if (current) return current;
  const pending = runEnsureATKTestPosReady(supabase, organizationId).finally(() => inFlight.delete(organizationId));
  inFlight.set(organizationId, pending);
  return pending;
}
