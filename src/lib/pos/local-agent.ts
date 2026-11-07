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
  status:"accepted";
  transactionId:string;
  detailsBase64:string;
  signatureBase64:string;
  duplicateRequest?:boolean;
  environment:"ATK TEST";
  productionEnabled?:false;
};
export async function submitLocalTestCoupon(token:string,idempotencyKey:string,coupon:unknown){
  return call<AtkCouponSubmitResult>("/api/v1/atk/test/coupon",token,{idempotencyKey,coupon});
}
