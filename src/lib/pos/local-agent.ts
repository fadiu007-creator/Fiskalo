/**
 * Legacy POS Agent API surface retained temporarily for backwards-compatible imports.
 * The web application no longer contacts localhost or depends on a Windows companion process.
 * Use browser-runtime.ts and cloud-atk.ts for the web-only ATK TEST flow.
 */
const legacyDisabled = (): never => {
  throw new Error("The legacy local POS Agent is disabled. Use the Cloudflare web ATK runtime and complete onboarding in this browser.");
};

export type AgentStatus={service:string;version:string;paired:boolean;fiscalizationEnabled:boolean;capabilities:string[];windowsKeyStoreAvailable:boolean;testCertificateInstalled:boolean;testInstallationVerified:boolean};
export type AtkVerification={businessName:string;verificationCode:string;environment:string;productionEnabled:boolean};
export type AtkCertificate={certificateStatus:string;subject:string;thumbprint:string;environment:string;privateKeyExported:boolean;productionEnabled:boolean};
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
  idempotencyKey:string;documentType:string;createdAtUtc:string;recoveryDeadlineUtc:string;
  nextAttemptAtUtc:string;status:string;attemptCount:number;lastError:string|null;
  atkTransactionId:string|null;nuiKf:string|null;legacyNuiKf:string|null;dailyNumber:number|null;
  offlineIssuedAtUtc:string|null;citizenPayloadBase64:string|null;citizenSignatureBase64:string|null;
  citizenQrPayload:string|null;qrSvgBase64:string|null;detailsBase64:string|null;
  signatureBase64:string|null;recoveryDeadlineExceeded:boolean;
};
export type LocalQueueReconcileInput={decision:"not_found_confirmed";confirmedNoAtkRecord:true};
export type LocalQueueReconcileResult={
  idempotencyKey:string;status:string;transactionId:string|null;lastError:string|null;
  manualResubmissionPermitted:boolean;automaticRetryEnabled:boolean;
};

export async function pairLocalAgent(_pairingCode:string):Promise<never>{return legacyDisabled();}
export async function getLocalAgentStatus(_token:string):Promise<never>{return legacyDisabled();}
export async function verifyLocalTestPos(_token:string,_input:{nui:number;fiscalizationNumber:string;posId:number;branchId:number;applicationId:number}):Promise<never>{return legacyDisabled();}
export async function issueLocalTestCertificate(_token:string,_input:{businessName:string;businessNui:number;branchId:number;verificationCode:string;posId:number;applicationId:number}):Promise<never>{return legacyDisabled();}
export async function submitLocalTestCoupon(_token:string,_idempotencyKey:string,_coupon:unknown):Promise<never>{return legacyDisabled();}
export async function getLocalAgentQueue(_token:string):Promise<never>{return legacyDisabled();}
export async function reconcileLocalAgentQueue(_token:string,_idempotencyKey:string,_input:LocalQueueReconcileInput):Promise<never>{return legacyDisabled();}
