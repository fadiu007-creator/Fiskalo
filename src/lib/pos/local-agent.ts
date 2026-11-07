const AGENT = "http://127.0.0.1:17843";
async function call<T>(path:string,token?:string,body?:unknown):Promise<T>{
  const response=await fetch(AGENT+path,{method:body===undefined?"GET":"POST",headers:{...(body===undefined?{}:{"Content-Type":"application/json"}),...(token?{Authorization:"Bearer "+token}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(typeof payload.detail==="string"?payload.detail:typeof payload.message==="string"?payload.message:typeof payload.error==="string"?payload.error:"POS Agent request failed ("+response.status+").");
  return payload as T;
}
export type AgentStatus={service:string;version:string;paired:boolean;fiscalizationEnabled:boolean;capabilities:string[];windowsKeyStoreAvailable:boolean;testCertificateInstalled:boolean;testInstallationVerified:boolean};
export type AtkVerification={businessName:string;verificationCode:string;environment:string;productionEnabled:boolean};
export type AtkCertificate={certificateStatus:string;subject:string;thumbprint:string;environment:string;privateKeyExported:boolean;productionEnabled:boolean};
export async function pairLocalAgent(pairingCode:string){return call<{sessionToken:string;agentVersion:string}>("/api/v1/pair",undefined,{pairingCode});}
export async function getLocalAgentStatus(token:string){return call<AgentStatus>("/api/v1/status",token);}
export async function verifyLocalTestPos(token:string,input:{nui:number;fiscalizationNumber:string;posId:number;branchId:number;applicationId:number}){return call<AtkVerification>("/api/v1/atk/test/verify",token,input);}
export async function issueLocalTestCertificate(token:string,input:{businessName:string;businessNui:number;branchId:number;verificationCode:string;posId:number;applicationId:number}){return call<AtkCertificate>("/api/v1/atk/test/sign-csr",token,input);}

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
export async function submitLocalTestCoupon(token:string,idempotencyKey:string,coupon:unknown){
  return call<AtkCouponSubmitResult>("/api/v1/atk/test/coupon",token,{idempotencyKey,coupon});
}
export async function getLocalAgentQueue(token:string){
  return call<{count:number;overdueCount:number;items:LocalFiscalQueueItem[]}>("/api/v1/queue",token);
}
