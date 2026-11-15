import type { SupabaseClient } from "@supabase/supabase-js";

type GatewayBase = { environment: "ATK TEST"; productionEnabled: false };
export type CloudAtkVerification = GatewayBase & {
  businessName: string;
  verificationCode: string;
};
export type CloudAtkCertificate = GatewayBase & { signedCertificate: string };
export type CloudAtkSubmission = GatewayBase & {
  status: "accepted";
  transactionId: string;
  message: string;
};

async function callGateway<T>(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in before using ATK TEST.");

  const response = await fetch("/api/atk/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null &&
      "error" in payload && typeof payload.error === "string"
      ? payload.error : "Cloud ATK TEST request failed (" + response.status + ").";
    throw new Error(message);
  }
  return payload as T;
}

export function verifyCloudTestPos(
  supabase: SupabaseClient,
  input: { businessId: string; posRecordId: string; fiscalizationNumber: string; applicationId: number },
) {
  return callGateway<CloudAtkVerification>(supabase, { action: "verify", ...input });
}

export function issueCloudTestCertificate(
  supabase: SupabaseClient,
  input: {
    businessId: string;
    posRecordId: string;
    verificationCode: string;
    applicationId: number;
    csrPem: string;
  },
) {
  return callGateway<CloudAtkCertificate>(supabase, { action: "sign-csr", ...input });
}

export function submitCloudTestCoupon(
  supabase: SupabaseClient,
  input: { businessId: string; details: string; signature: string },
) {
  return callGateway<CloudAtkSubmission>(supabase, { action: "coupon", ...input });
}
