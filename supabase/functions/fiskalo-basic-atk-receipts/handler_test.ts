// deno-lint-ignore-file require-await
// Async mocks intentionally preserve the Promise-based dependency contract.
Deno.test("matches the POS Agent canonical coupon snapshot hash fixture",async()=>{
  const pos:AtkReceiptPos={id:posUuid,businessId,branchId:1,posNumber:2,applicationId:"3",certificateStatus:"certificate_issued",location:"Ferizaj"};
  const sale:AtkReceiptSale={
    id:saleId,businessId,posId:posUuid,couponId:9001,status:"paid",dailyNumber:12,
    createdAt:new Date(1799999999*1000).toISOString(),checkoutIdempotencyKey:null,
    operatorName:"Operator",paymentMethod:"cash",paymentAllocations:null,
    subtotal:"4.00",vatTotal:"0.72",total:"4.72",
  };
  const items:AtkReceiptSaleItem[]=[
    {description:"Bread",unitPrice:"1.0000",quantity:"2.000",lineTotal:"2.36",lineNet:"2.00",lineVat:"0.36",unitCode:"C62",categoryCode:"P",vatCode:"A"},
    {description:"Milk",unitPrice:"2.0000",quantity:"1.000",lineTotal:"2.36",lineNet:"2.00",lineVat:"0.36",unitCode:"C62",categoryCode:"P",vatCode:"A"},
  ];
  const hash=await computeSaleSnapshotSha256(123456789,pos,sale,items,"0123456789ABCDEF",12);
  assert(hash==="501626cc9856ab9e0ec49b7eb871198414881decb73e471ceaf58934d253553a",
    "Edge Function canonical hash must match the Windows POS Agent implementation");
});

import {
  computeSaleSnapshotSha256, createAtkReceiptHandler,
  type AtkReceiptDependencies, type AtkReceiptPos, type AtkReceiptSale, type AtkReceiptSaleItem,
} from "./handler.ts";

const businessId="b4a65b6e-14b5-4a1c-9b0c-8a4b6b1c0a22";
const posUuid="2a9b0d6d-62f0-4e3e-9b24-7bb0e0a1c022";
const saleId="3a9b0d6d-62f0-4e3e-9b24-7bb0e0a1c033";
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}
function b64(value:Uint8Array){let raw="";for(const b of value)raw+=String.fromCharCode(b);return btoa(raw);}
function bytes(value:string){return new TextEncoder().encode(value);}
const TEST_PRIVATE_KEY_DER=Uint8Array.from(atob("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaNMiMIyKgBVhC7OBr8FiFqvXCSa5ElI/YFZZz7baWxihRANCAARi7/tb1VSsaniJPDyhYi97FFwaDZvwtQAj+3xMNR5okJJ1Rhb+Lsg0UrwnZbokY/wv0pV9xV3Xg+2hrjRCv5xj"),c=>c.charCodeAt(0));
const TEST_CERTIFICATE_BASE64="MIIBwzCCAWmgAwIBAgIUIcIQ5twWcVrbBEX/92eppci5vxQwCgYIKoZIzj0EAwIwNzELMAkGA1UEBhMCVVMxETAPBgNVBAoMCFRlc3QgUE9TMRUwEwYDVQQDDAxGaXNrYWxvIFRlc3QwHhcNMjYxMTE2MTIwNzI5WhcNMzYxMTEzMTIwNzI5WjA3MQswCQYDVQQGEwJVUzERMA8GA1UECgwIVGVzdCBQT1MxFTATBgNVBAMMDEZpc2thbG8gVGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABGLv+1vVVKxqeIk8PKFiL3sUXBoNm/C1ACP7fEw1HmiQknVGFv4uyDRSvCdluiRj/C/SlX3FXdeD7aGuNEK/nGOjUzBRMB0GA1UdDgQWBBSmf40rxOL5LkLH6SRaKmQ7cXS/NjAfBgNVHSMEGDAWgBSmf40rxOL5LkLH6SRaKmQ7cXS/NjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIGFPyaeP97gPTfOKXvyljm3Uf+SWR/IOFHTe78MfO4IbAiEApl3hnkk5JVaD7BqNd674fywChHxiykLWHLeHn6KCOa0=";
const TEST_CERTIFICATE_PEM="-----BEGIN CERTIFICATE-----\n"+TEST_CERTIFICATE_BASE64+"\n-----END CERTIFICATE-----";
const TEST_SPKI_BASE64="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYu/7W9VUrGp4iTw8oWIvexRcGg2b8LUAI/t8TDUeaJCSdUYW/i7INFK8J2W6JGP8L9KVfcVd14Ptoa40Qr+cYw==";
const TEST_SPKI=Uint8Array.from(atob(TEST_SPKI_BASE64),c=>c.charCodeAt(0));
const TEST_CERTIFICATE_THUMBPRINT="4925AC41860A1BA9DF67762705029C5D88E353B5";
async function testKeyPair(){
  const privateKey=await crypto.subtle.importKey("pkcs8",TEST_PRIVATE_KEY_DER,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const publicKey=await crypto.subtle.importKey("spki",TEST_SPKI,{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  return {privateKey,publicKey};
}
async function hash(value:Uint8Array,algorithm:"SHA-256"|"SHA-1"="SHA-256"){
  const input=new Uint8Array(value.byteLength);input.set(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest(algorithm,input.buffer)),b=>b.toString(16).padStart(2,"0")).join("");
}
function dateOf(timestamp:string){
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Belgrade",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(timestamp));
  const values=Object.fromEntries(parts.map(p=>[p.type,p.value]));return `${values.year}-${values.month}-${values.day}`;
}
async function setup(status:"queued"|"accepted"="queued",offlineAgeMinutes=10,transactionId="987654321"){
  const keyPair=await testKeyPair();
  const spki=TEST_SPKI;
  const now=new Date();
  const createdAt=now.toISOString();
  const saleItems:AtkReceiptSaleItem[]=[
    {description:"Bread",unitPrice:"1.0000",quantity:"2.000",lineTotal:"2.36",lineNet:"2.00",lineVat:"0.36",unitCode:"C62",categoryCode:"P",vatCode:"A"},
    {description:"Milk",unitPrice:"2.0000",quantity:"1.000",lineTotal:"2.36",lineNet:"2.00",lineVat:"0.36",unitCode:"C62",categoryCode:"P",vatCode:"A"},
  ];
  const pos:AtkReceiptPos={id:posUuid,businessId,branchId:1,posNumber:2,applicationId:"3",certificateStatus:"certificate_issued",location:"Ferizaj"};
  const sale:AtkReceiptSale={
    id:saleId,businessId,posId:posUuid,couponId:9001,status:"paid",dailyNumber:42,createdAt,
    checkoutIdempotencyKey:null,operatorName:"Operator",paymentMethod:"cash",paymentAllocations:null,
    subtotal:"4.00",vatTotal:"0.72",total:"4.72",
  };
  const couponSnapshotSha256=await computeSaleSnapshotSha256(123456789,pos,sale,saleItems,"0123456789ABCDEF",42);
  const posPayload=bytes("signed-pos-coupon");
  const posSignature=new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keyPair.privateKey,posPayload));
  const citizenPayload=bytes("signed-citizen-coupon");
  const citizenSignature=new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keyPair.privateKey,citizenPayload));
  const qr=bytes("<svg/>");
  const certificatePem=TEST_CERTIFICATE_PEM;
  const certificateThumbprint=TEST_CERTIFICATE_THUMBPRINT;
  const offlineIssued=status==="queued"?new Date(now.getTime()-offlineAgeMinutes*60_000).toISOString():null;
  const payload={
    version:1,businessId,posUuid,businessNui:123456789,branchId:1,posNumber:2,applicationId:3,
    couponId:9001,idempotencyKey:"123456789:1:2:9001",checkoutIdempotencyKey:null,
    businessDate:dateOf(createdAt),documentType:"Sale",
    signedPayloadBase64:b64(posPayload),signatureBase64:b64(posSignature),
    payloadSha256:await hash(posPayload),signatureSha256:await hash(posSignature),couponSnapshotSha256,
    status,transactionId:status==="accepted"?transactionId:null,
    atkResponseMessage:status==="accepted"?"Accepted by ATK TEST":null,
    nuiKf:"0123456789ABCDEF",verificationNo:"0123456789ABCDEF",
    citizenPayloadBase64:b64(citizenPayload),citizenSignatureBase64:b64(citizenSignature),
    dailyNumber:42,offlineIssuedAtUtc:offlineIssued,qrSvgBase64:b64(qr),certificateThumbprint,
  };
  const payloadBytes=bytes(JSON.stringify(payload));
  const attestationSignature=new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keyPair.privateKey,payloadBytes));
  let queued:Record<string,unknown>|null=null,recorded:Record<string,unknown>|null=null;
  const deps:AtkReceiptDependencies={
    authenticate:async token=>token==="valid-token"?{id:"owner-user"}:null,
    isMember:async()=>true,
    isOwner:async()=>true,
    registerCertificate:async()=> "certificate-id",
    getBusiness:async()=>({nui:"123456789"}),
    getPos:async()=>pos,
    getCertificate:async()=>({applicationId:3,spkiSha256:await hash(spki),certificatePem,status:"active",revokedAt:null}),
    getSale:async()=>sale,
    getSaleItems:async()=>saleItems,
    queueReceipt:async args=>{queued=args;return "doc-queued";},
    recordReceipt:async args=>{recorded=args;return "doc-accepted";},
  };
  const handler=createAtkReceiptHandler(deps);
  const body={
    action:status==="queued"?"queue":"accepted",businessId,posUuid,saleId,couponId:9001,
    idempotencyKey:"123456789:1:2:9001",
    attestationPayloadBase64:b64(payloadBytes),attestationSignatureBase64:b64(attestationSignature),
    publicKeySpkiBase64:b64(spki),
  };
  const request=()=>new Request("https://example.test/functions/v1/fiskalo-basic-atk-receipts",{
    method:"POST",headers:{authorization:"Bearer valid-token","content-type":"application/json",
      origin:"https://fiskalo.shqiptare.workers.dev"},body:JSON.stringify(body),
  });
  return {handler,request,body,queued:()=>queued,recorded:()=>recorded};
}

Deno.test("verifies device, coupon and sale snapshot signatures before queuing an offline coupon",async()=>{
  const fixture=await setup("queued");
  const response=await fixture.handler(fixture.request());
  const result=await response.json() as {state?:string;documentId?:string};
  assert(response.status===200,"valid offline attestation should be accepted");
  assert(result.state==="queued"&&result.documentId==="doc-queued","offline receipt should be queued");
  assert(fixture.queued()?.p_daily_number===42,"daily number must be passed to the server RPC");
  assert(fixture.queued()?.p_qr_svg_base64!==undefined,"signed QR must be persisted");
});

Deno.test("verifies device, coupon and sale snapshot signatures before recording ATK acceptance",async()=>{
  const fixture=await setup("accepted");
  const response=await fixture.handler(fixture.request());
  const result=await response.json() as {state?:string;transactionId?:string};
  assert(response.status===200,"valid ATK acceptance attestation should be accepted");
  assert(result.state==="accepted"&&result.transactionId==="987654321","ATK transaction must be recorded");
  assert(fixture.recorded()?.p_actor_id==="owner-user","server record must bind the authenticated actor");
});

Deno.test("rejects a forged or tampered local Agent attestation",async()=>{
  const fixture=await setup("accepted");
  const body=fixture.body as Record<string,unknown>;
  const originalBytes=Uint8Array.from(atob(String(body.attestationPayloadBase64)),c=>c.charCodeAt(0));
  const originalPayload=JSON.parse(new TextDecoder().decode(originalBytes)) as Record<string,unknown>;
  body.attestationPayloadBase64=b64(bytes(JSON.stringify({...originalPayload,tampered:true})));
  const response=await fixture.handler(fixture.request());
  assert(response.status===403,"tampered attestation must fail cryptographic verification");
  assert(fixture.recorded()===null,"forged response must never reach the database writer");
});

Deno.test("rejects an unauthenticated request",async()=>{
  const fixture=await setup("queued");
  const response=await fixture.handler(new Request("https://example.test",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(fixture.body),
  }));
  assert(response.status===401,"unauthenticated users must not persist fiscal receipts");
});


Deno.test("registers an ATK certificate only with a valid local POS proof-of-possession",async()=>{
  const privateKeyDer=Uint8Array.from(atob("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaNMiMIyKgBVhC7OBr8FiFqvXCSa5ElI/YFZZz7baWxihRANCAARi7/tb1VSsaniJPDyhYi97FFwaDZvwtQAj+3xMNR5okJJ1Rhb+Lsg0UrwnZbokY/wv0pV9xV3Xg+2hrjRCv5xj"),c=>c.charCodeAt(0));
  const privateKey=await crypto.subtle.importKey("pkcs8",privateKeyDer,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const certificateBase64="MIIBwzCCAWmgAwIBAgIUIcIQ5twWcVrbBEX/92eppci5vxQwCgYIKoZIzj0EAwIwNzELMAkGA1UEBhMCVVMxETAPBgNVBAoMCFRlc3QgUE9TMRUwEwYDVQQDDAxGaXNrYWxvIFRlc3QwHhcNMjYxMTE2MTIwNzI5WhcNMzYxMTEzMTIwNzI5WjA3MQswCQYDVQQGEwJVUzERMA8GA1UECgwIVGVzdCBQT1MxFTATBgNVBAMMDEZpc2thbG8gVGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABGLv+1vVVKxqeIk8PKFiL3sUXBoNm/C1ACP7fEw1HmiQknVGFv4uyDRSvCdluiRj/C/SlX3FXdeD7aGuNEK/nGOjUzBRMB0GA1UdDgQWBBSmf40rxOL5LkLH6SRaKmQ7cXS/NjAfBgNVHSMEGDAWgBSmf40rxOL5LkLH6SRaKmQ7cXS/NjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIGFPyaeP97gPTfOKXvyljm3Uf+SWR/IOFHTe78MfO4IbAiEApl3hnkk5JVaD7BqNd674fywChHxiykLWHLeHn6KCOa0=";
  const certificatePem="-----BEGIN CERTIFICATE-----\n"+certificateBase64+"\n-----END CERTIFICATE-----";
  const attestation={
    version:1,businessId,posUuid,businessNui:123456789,branchId:1,posNumber:2,applicationId:3,
    certificatePem,certificateThumbprint:TEST_CERTIFICATE_THUMBPRINT,
    spkiBase64:TEST_SPKI_BASE64,
    issuedAtUtc:new Date().toISOString(),
  };
  const payloadBytes=new TextEncoder().encode(JSON.stringify(attestation));
  const signature=new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},privateKey,payloadBytes));
  const registered:{value:Record<string,unknown>|null}={value:null};
  const deps:AtkReceiptDependencies={
    authenticate:async token=>token==="valid-token"?{id:"owner-user"}:null,
    isMember:async()=>true,
    isOwner:async()=>true,
    registerCertificate:async args=>{registered.value=args;return "registered-certificate-id";},
    getBusiness:async()=>({nui:"123456789",name:"Test Business"}),
    getPos:async()=>({id:posUuid,businessId,branchId:1,posNumber:2,applicationId:"3",certificateStatus:"verified",location:"Ferizaj",verifiedBusinessName:"Test Business"}),
    getCertificate:async()=>null,
    getSale:async()=>null,
    getSaleItems:async()=>[],
    queueReceipt:async()=>"",
    recordReceipt:async()=>""
  };
  const handler=createAtkReceiptHandler(deps);
  const response=await handler(new Request("https://example.test/functions/v1/fiskalo-basic-atk-receipts",{
    method:"POST",headers:{authorization:"Bearer valid-token","content-type":"application/json",
      origin:"https://fiskalo.shqiptare.workers.dev"},
    body:JSON.stringify({action:"register",businessId,posUuid,
      certificateAttestationPayloadBase64:b64(payloadBytes),
      certificateAttestationSignatureBase64:b64(signature)})
  }));
  const result=await response.json() as {ok?:boolean;certificateThumbprint?:string};
  assert(response.status===200&&result.ok===true,"valid POS certificate proof should register");
  assert(registered.value!==null&&"p_spki_sha256" in registered.value,"registered certificate must persist the derived SPKI fingerprint");
});

Deno.test("rejects a forged certificate proof-of-possession",async()=>{
  const deps:AtkReceiptDependencies={
    authenticate:async()=>({id:"owner-user"}),isMember:async()=>true,isOwner:async()=>true,
    registerCertificate:async()=>"should-not-register",
    getBusiness:async()=>({nui:"123456789",name:"Test Business"}),
    getPos:async()=>({id:posUuid,businessId,branchId:1,posNumber:2,applicationId:"3",certificateStatus:"verified",location:"Ferizaj",verifiedBusinessName:"Test Business"}),
    getCertificate:async()=>null,getSale:async()=>null,getSaleItems:async()=>[],
    queueReceipt:async()=>"doc",recordReceipt:async()=>"doc"
  };
  const handler=createAtkReceiptHandler(deps);
  const response=await handler(new Request("https://example.test/functions/v1/fiskalo-basic-atk-receipts",{
    method:"POST",headers:{authorization:"Bearer valid-token","content-type":"application/json",
      origin:"https://fiskalo.shqiptare.workers.dev"},
    body:JSON.stringify({action:"register",businessId,posUuid,
      certificateAttestationPayloadBase64:b64(bytes("forged")),
      certificateAttestationSignatureBase64:b64(bytes("invalid"))})
  }));
  assert(response.status===400,"invalid certificate attestation must be rejected");
});


Deno.test("keeps an offline fiscal document synchronizable after the 48-hour deadline",async()=>{
  const fixture=await setup("queued",49*60);
  const response=await fixture.handler(fixture.request());
  const result=await response.json() as {state?:string;overdue?:boolean;recoveryDeadlineAt?:string};
  assert(response.status===200,"overdue offline receipts must remain persistable");
  assert(result.state==="queued"&&result.overdue===true,"the server must mark the 48-hour deadline as overdue without discarding the receipt");
  assert(typeof result.recoveryDeadlineAt==="string","the original recovery deadline must be retained");
});

Deno.test("rejects zero and overflowing ATK uint64 transaction IDs before persistence",async()=>{
  for (const transactionId of ["0","18446744073709551616"]) {
    const fixture=await setup("accepted",10,transactionId);
    const response=await fixture.handler(fixture.request());
    assert(response.status===409,`invalid transaction ID ${transactionId} must be rejected`);
    assert(fixture.recorded()===null,"invalid ATK transaction IDs must never reach the database writer");
  }
});
