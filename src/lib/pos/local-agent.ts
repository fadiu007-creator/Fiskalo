import { decryptBrowserFiscalData, encryptBrowserFiscalData } from "@/lib/atk/browser-key-vault";
const AGENT = "http://127.0.0.1:17843";
async function call<T>(path:string,token?:string,body?:unknown):Promise<T>{
  const response=await fetch(AGENT+path,{method:body===undefined?"GET":"POST",headers:{...(body===undefined?{}:{"Content-Type":"application/json"}),...(token?{Authorization:"Bearer "+token}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(typeof payload.detail==="string"?payload.detail:typeof payload.message==="string"?payload.message:typeof payload.error==="string"?payload.error:"POS Agent request failed ("+response.status+").");
  return payload as T;
}
export type AgentStatus={service:string;version:string;paired:boolean;fiscalizationEnabled:boolean;capabilities:string[];windowsKeyStoreAvailable:boolean;testCertificateInstalled:boolean;testInstallationVerified:boolean};
export async function requestPosHeartbeatChallenge(
  agentSessionToken: string,
  businessId: string,
  posUuid: string,
) {
  return call<{nonce:string;expiresInSeconds:number}>(
    "/api/v1/connectivity/challenge",
    agentSessionToken,
    {businessId,posUuid},
  );
}

export async function persistVerifiedPosHeartbeat(
  agentSessionToken: string,
  heartbeat: {
    businessId:string;
    posUuid:string;
    nonce:string;
    issuedAtUnixMs:number;
    signatureBase64:string;
  },
) {
  const result = await call<{
    verified:boolean;
    businessId:string;
    posUuid:string;
    serverTimeUtc:string;
    productionEnabled:boolean;
  }>("/api/v1/connectivity/heartbeat",agentSessionToken,{
    nonce:heartbeat.nonce,
    issuedAtUnixMilliseconds:heartbeat.issuedAtUnixMs,
    signatureBase64:heartbeat.signatureBase64,
  });
  if(!result.verified||result.businessId!==heartbeat.businessId||result.posUuid!==heartbeat.posUuid||
    result.serverTimeUtc!==new Date(heartbeat.issuedAtUnixMs).toISOString()||result.productionEnabled!==false){
    throw new Error("Windows POS Agent did not persist the verified server heartbeat.");
  }
  return result;
}

export async function refreshVerifiedPosHeartbeat(
  agentSessionToken: string,
  supabaseAccessToken: string,
  businessId: string,
  posUuid: string,
) {
  if (!agentSessionToken || !supabaseAccessToken) throw new Error("Both POS Agent and Supabase sessions are required.");
  const challenge = await call<{nonce:string;expiresInSeconds:number}>(
    "/api/v1/connectivity/challenge",
    agentSessionToken,
    {businessId,posUuid},
  );
  const response = await fetch("/api/pos/heartbeat",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:"Bearer "+supabaseAccessToken,
    },
    body:JSON.stringify({businessId,posUuid,nonce:challenge.nonce}),
    cache:"no-store",
    credentials:"same-origin",
    referrerPolicy:"same-origin",
  });
  const signed = await response.json().catch(()=>null) as null|{
    businessId?:string;posUuid?:string;nonce?:string;issuedAtUnixMs?:number;signatureBase64?:string;
    environment?:string;productionEnabled?:boolean;
  };
  if(!response.ok||!signed||signed.businessId!==businessId||signed.posUuid!==posUuid||
    signed.nonce!==challenge.nonce||signed.environment!=="ATK TEST"||signed.productionEnabled!==false||
    !Number.isSafeInteger(signed.issuedAtUnixMs)||typeof signed.signatureBase64!=="string"){
    throw new Error("Cloudflare did not return a valid signed POS Agent heartbeat.");
  }
  const verified = await call<{
    verified:boolean;businessId:string;posUuid:string;serverTimeUtc:string;productionEnabled:boolean;
  }>("/api/v1/connectivity/heartbeat",agentSessionToken,{
    nonce:challenge.nonce,
    issuedAtUnixMilliseconds:signed.issuedAtUnixMs,
    signatureBase64:signed.signatureBase64,
  });
  if(!verified.verified||verified.businessId!==businessId||verified.posUuid!==posUuid||
    verified.serverTimeUtc!==new Date(signed.issuedAtUnixMs!).toISOString()||verified.productionEnabled!==false){
    throw new Error("Windows POS Agent did not persist the verified server heartbeat.");
  }
  return verified;
}

export type AtkVerification={businessName:string;verificationCode:string;environment:string;productionEnabled:boolean};
export type AtkCertificate={certificateStatus:string;subject:string;thumbprint:string;environment:string;privateKeyExported:boolean;productionEnabled:boolean};
const AGENT_SESSION_KEY = "fiskalo.pos-agent.session.v1";
const AGENT_SESSION_ENCRYPTION_SCOPE = "pos-agent-session-token";

export async function getAgentToken(): Promise<string | null> {
  try {
    const raw = window.localStorage.getItem(AGENT_SESSION_KEY);
    if (!raw) return null;
    const encrypted = JSON.parse(raw);
    const token = await decryptBrowserFiscalData<string>(AGENT_SESSION_ENCRYPTION_SCOPE, encrypted);
    return typeof token === "string" && token.length >= 32 ? token : null;
  } catch {
    clearAgentToken();
    return null;
  }
}

export function clearAgentToken(): void {
  try { window.localStorage.removeItem(AGENT_SESSION_KEY); }
  catch { /* encrypted local cache is optional */ }
}

export async function pairLocalAgent(pairingCode:string){
  const paired = await call<{sessionToken:string;agentVersion:string}>("/api/v1/pair",undefined,{pairingCode});
  if (!paired.sessionToken) throw new Error("POS Agent did not return a pairing session.");
  try {
    const encrypted = await encryptBrowserFiscalData(AGENT_SESSION_ENCRYPTION_SCOPE, paired.sessionToken);
    window.localStorage.setItem(AGENT_SESSION_KEY, JSON.stringify(encrypted));
  } catch {
    throw new Error("Could not protect the POS Agent session in the browser key vault.");
  }
  return paired;
}
export async function getLocalAgentStatus(token:string){return call<AgentStatus>("/api/v1/status",token);}
export async function verifyLocalTestPos(token:string,input:{nui:number;fiscalizationNumber:string;posId:number;branchId:number;applicationId:number}){return call<AtkVerification>("/api/v1/atk/test/verify",token,input);}
export async function issueLocalTestCertificate(token:string,input:{businessName:string;businessNui:number;branchId:number;verificationCode:string;posId:number;applicationId:number}){return call<AtkCertificate>("/api/v1/atk/test/sign-csr",token,input);}
export async function getLocalAtkCertificateAttestation(token:string,input:{businessId:string;posUuid:string}){
  return call<{attestationPayloadBase64:string;attestationSignatureBase64:string}>(
    "/api/v1/atk/test/certificate-attestation",token,input);
}

export type AtkCouponSubmitResult={
  status:"accepted"|"queued_offline";
  transactionId:string|null;
  detailsBase64:string;
  signatureBase64:string;
  nuiKf:string;
  dailyNumber:number;
  citizenQrPayload:string;
  qrSvgBase64:string;
  offline:boolean;
  recoveryDeadlineUtc?:string;
  offlineIssuedAtUtc?:string|null;
  retryScheduled?:boolean;
  duplicateRequest?:boolean;
  environment:"ATK TEST";
  productionEnabled?:false;
  message?:string;
};
export type LocalFiscalQueueItem={
  idempotencyKey:string;
  documentType:string;
  createdAtUtc:string;
  recoveryDeadlineUtc:string;
  nextAttemptAtUtc:string;
  status:string;
  attemptCount:number;
  lastError:string|null;
  atkTransactionId:string|null;
  nuiKf:string|null;
  legacyNuiKf:string|null;
  dailyNumber:number|null;
  offlineIssuedAtUtc:string|null;
  citizenPayloadBase64:string|null;
  citizenSignatureBase64:string|null;
  citizenQrPayload:string|null;
  qrSvgBase64:string|null;
  detailsBase64:string|null;
  signatureBase64:string|null;
  recoveryDeadlineExceeded:boolean;
};
export async function submitLocalTestCoupon(token:string,idempotencyKey:string,coupon:unknown,metadata?:{
  businessId:string;posUuid:string;businessDate:string;checkoutIdempotencyKey?:string;
}){
  return call<AtkCouponSubmitResult>("/api/v1/atk/test/coupon",token,{
    idempotencyKey,coupon,businessId:metadata?.businessId,posUuid:metadata?.posUuid,
    businessDate:metadata?.businessDate,checkoutIdempotencyKey:metadata?.checkoutIdempotencyKey
  });
}
export async function getLocalAgentQueue(token:string){
  return call<{count:number;overdueCount:number;items:LocalFiscalQueueItem[]}>("/api/v1/queue",token);
}
export type LocalQueueReconcileInput={decision:"not_found_confirmed";confirmedNoAtkRecord:true};
export type LocalQueueReconcileResult={
  idempotencyKey:string;status:string;transactionId:string|null;lastError:string|null;
  manualResubmissionPermitted:boolean;automaticRetryEnabled:boolean;
};
export async function reconcileLocalAgentQueue(token:string,idempotencyKey:string,input:LocalQueueReconcileInput){
  return call<LocalQueueReconcileResult>("/api/v1/queue/reconcile",token,{idempotencyKey,...input});
}

export type OfflineReservationSummary={availableCouponIds:number;availableDailyNumbers:Record<string,number>};
export async function getLocalOfflineReservationSummary(token:string){
  return call<OfflineReservationSummary>("/api/v1/offline/reservations",token);
}
export async function provisionLocalOfflineNumbers(token:string,input:{
  businessId:string;posUuid:string;supabaseUrl:string;anonKey:string;accessToken:string;
  couponCount:number;daysAhead:number;
}){
  return call<{provisionedCouponIds:number;provisionedDailyDates:number;availableCouponIds:number;availableDailyNumbers:Record<string,number>}>(
    "/api/v1/offline/reservations/provision",token,input);
}
export async function claimLocalOfflineNumbers(token:string,input:{
  checkoutIdempotencyKey:string;businessId:string;posUuid:string;businessDate:string;
}){
  return call<{couponId:number;dailyNumber:number;businessDate:string}>(
    "/api/v1/offline/reservations/claim",token,input);
}

export type LocalFiscalAttestation={
  status:"queued"|"accepted";transactionId?:string|null;attestationPayloadBase64:string;attestationSignatureBase64:string;
  publicKeySpkiBase64:string;certificateThumbprint:string;
};
export async function getLocalFiscalAttestation(token:string,input:{
  idempotencyKey:string;businessId:string;posUuid:string;
}){
  return call<LocalFiscalAttestation>("/api/v1/queue/attestation",token,input);
}
