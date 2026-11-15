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
  persisted: true;
};

export class CloudAtkError extends Error {
  readonly transactionId: string | null;
  readonly acceptedButNotPersisted: boolean;
  constructor(message: string, transactionId: string | null = null, acceptedButNotPersisted = false) {
    super(message);
    this.name = "CloudAtkError";
    this.transactionId = transactionId;
    this.acceptedButNotPersisted = acceptedButNotPersisted;
  }
}

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
    const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
    const message = typeof record.error === "string" ? record.error : "Cloud ATK TEST request failed (" + response.status + ").";
    throw new CloudAtkError(
      message,
      typeof record.transactionId === "string" ? record.transactionId : null,
      record.status === "accepted_not_persisted",
    );
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
  input: {
    businessId: string;
    posRecordId: string;
    saleId: string;
    couponId: number;
    idempotencyKey: string;
    details: string;
    signature: string;
    nuiKf: string;
    citizenPayload: string;
    citizenSignature: string;
    dailyNumber: number;
    qrSvgBase64: string;
    certificatePem: string;
    offlineIssuedAt: string | null;
  },
) {
  return callGateway<CloudAtkSubmission>(supabase, { action: "coupon", ...input });
}
