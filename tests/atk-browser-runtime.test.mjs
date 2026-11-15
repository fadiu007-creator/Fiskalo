import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, X509Certificate, verify as verifySignature } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import "fake-indexeddb/auto";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
globalThis.window = globalThis;

const {
  encodeAtkPosCoupon,
  encodeAtkCitizenCoupon,
  encodeAtkBase64,
} = await import("../src/lib/atk/protobuf.ts");

const {
  createOrLoadPosCsr,
  installPosCertificate,
  hasMatchingPosCertificate,
  signAtkBase64Payload,
  generateNuiKf,
} = await import("../src/lib/atk/browser-runtime.ts");

function openssl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || "OpenSSL command failed");
  return result.stdout;
}


test("POS Coupon and CitizenCoupon bytes match the official ATK C# ModelBuilder sample", () => {
  const taxGroups = [
    { taxRate: "C", totalForTaxCents: 450, totalTaxCents: 0 },
    { taxRate: "D", totalForTaxCents: 296, totalTaxCents: 24 },
    { taxRate: "E", totalForTaxCents: 889, totalTaxCents: 161 },
  ];
  const pos = encodeAtkBase64(encodeAtkPosCoupon({
    businessId: 60100, couponId: 10, branchId: 1, location: "Prishtine",
    operatorId: "Kushtrimi", posId: 1, applicationId: 1234,
    verificationNo: "1234567890123456", type: 1, unixTime: 1727796620,
    items: [
      { name: "uje rugove", unitPriceEuro: 1.5, unit: "cope", quantity: 3, lineTotalCents: 450, taxRate: "C", itemType: "TT" },
      { name: "sendviq", unitPriceEuro: 3, unit: "cope", quantity: 2, lineTotalCents: 600, taxRate: "E", itemType: "TT" },
      { name: "buke", unitPriceEuro: 0.8, unit: "cope", quantity: 4, lineTotalCents: 320, taxRate: "D", itemType: "TT" },
      { name: "machiato e madhe", unitPriceEuro: 1.5, unit: "cope", quantity: 3, lineTotalCents: 450, taxRate: "E", itemType: "TT" },
    ],
    payments: [
      { type: 1, amountCents: 500 },
      { type: 2, amountCents: 1000 },
      { type: 3, amountCents: 320 },
    ],
    totalCents: 1820, taxGroups, totalTaxCents: 185, totalNoTaxCents: 1635, totalDiscountCents: 0,
  }));
  const citizen = encodeAtkBase64(encodeAtkCitizenCoupon({
    businessId: 60100, couponId: 10, branchId: 1, posId: 1,
    verificationNo: "1234567890123456", type: 1, unixTime: 1727796620,
    totalCents: 1820, taxGroups, totalTaxCents: 185, totalNoTaxCents: 1635,
  }));
  assert.equal(pos, "CMTVAxAKGAEiCVByaXNodGluZSoJS3VzaHRyaW1pMAE40glCEDEyMzQ1Njc4OTAxMjM0NTZIAVCMq/C3BlokCgp1amUgcnVnb3ZlEJh1GgRjb3BlJQAAQEAowgMyAUM6AlRUWiIKB3NlbmR2aXEQsOoBGgRjb3BlJQAAAEAo2AQyAUU6AlRUWh4KBGJ1a2UQwD4aBGNvcGUlAACAQCjAAjIBRDoCVFRaKgoQbWFjaGlhdG8gZSBtYWRoZRCYdRoEY29wZSUAAEBAKMIDMgFFOgJUVGIFCAEQ9ANiBQgCEOgHYgUIAxDAAmicDnIGCgFDEMIDcggKAUQQqAIYGHIJCgFFEPkGGKEBeLkBgAHjDA==");
  assert.equal(citizen, "CMTVAxAKGAEgASoQMTIzNDU2Nzg5MDEyMzQ1NjABOIyr8LcGQJwOSgYKAUMQwgNKCAoBRBCoAhgYSgkKAUUQ+QYYoQFQuQFY4ww=");
});

test("browser POS key stays non-exportable, CSR verifies, certificate matches, and signatures verify", async () => {
  const identity = {
    businessNui: "123456789",
    branchId: 1,
    posId: 2,
    businessName: "Fiskalo Test Company",
  };
  const dir = mkdtempSync(join(tmpdir(), "fiskalo-atk-"));
  try {
    const first = await createOrLoadPosCsr(identity);
    assert.equal(first.existingKey, false);
    assert.match(first.csrPem, /BEGIN CERTIFICATE REQUEST/);

    const second = await createOrLoadPosCsr(identity);
    assert.equal(second.existingKey, true);
    const csrPath = join(dir, "pos.csr.pem");
    writeFileSync(csrPath, first.csrPem);
    openssl(["req", "-in", csrPath, "-noout", "-verify"]);

    const dbRequest = indexedDB.open("fiskalo-atk-pos-keys", 1);
    const db = await new Promise((resolve, reject) => {
      dbRequest.onsuccess = () => resolve(dbRequest.result);
      dbRequest.onerror = () => reject(dbRequest.error);
    });
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction("pos-keys", "readonly").objectStore("pos-keys").get("123456789:1:2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    assert.equal(stored.privateKey.extractable, false);

    const caKey = join(dir, "ca.key");
    const caCert = join(dir, "ca.pem");
    const certPath = join(dir, "pos.pem");
    openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-nodes", "-keyout", caKey, "-out", caCert, "-subj", "/CN=Fiskalo Test CA", "-days", "1"]);
    openssl(["x509", "-req", "-in", csrPath, "-CA", caCert, "-CAkey", caKey,
      "-CAcreateserial", "-out", certPath, "-days", "1", "-sha256"]);
    const certificate = readFileSync(certPath, "utf8");
    await installPosCertificate(identity, certificate);
    assert.equal(await hasMatchingPosCertificate(identity), true);

    await assert.rejects(() => installPosCertificate(identity, readFileSync(caCert, "utf8")),
      /does not match/);
    assert.equal(await hasMatchingPosCertificate(identity), true);

    const payload = "ZmFrZS1wcm90b2J1Zi1wYXlsb2Fk";
    const signature = await signAtkBase64Payload(identity, payload);
    const x509 = new X509Certificate(certificate);
    assert.equal(verifySignature(
      "sha256",
      Buffer.from(payload, "utf8"),
      { key: x509.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64"),
    ), true);
    assert.match(generateNuiKf(), /^[A-Z0-9]{16}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("signed offline fiscal outbox persists and only changes state by idempotency key", async () => {
  const { saveFiscalOutboxItem, listFiscalOutboxItems, updateFiscalOutboxItem } =
    await import("../src/lib/pos/browser-outbox.ts");
  const item = {
    idempotencyKey: "nui:1:2:123",
    businessId: "business-1",
    saleId: "sale-1",
    posRecordId: "pos-1",
    couponId: 123,
    documentType: 1,
    detailsBase64: "cG9z",
    signatureBase64: "c2ln",
    certificatePem: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
    citizenPayloadBase64: "Y2l0aXplbg==",
    citizenSignatureBase64: "c2ln",
    citizenQrPayload: "Y2l0aXplbg==|c2ln",
    nuiKf: "0123456789ABCDEF",
    dailyNumber: 1,
    qrSvg: "PHN2Zy8+",
    issuedAtUtc: "2026-11-15T10:00:00.000Z",
    offlineIssuedAtUtc: "2026-11-15T10:00:00.000Z",
    recoveryDeadlineUtc: "2026-11-17T10:00:00.000Z",
    state: "queued",
    transactionId: null,
    lastError: null,
  };
  await saveFiscalOutboxItem(item);
  const saved = await listFiscalOutboxItems("business-1");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state, "queued");
  assert.equal(saved[0].posRecordId, "pos-1");
  await updateFiscalOutboxItem(item.idempotencyKey, { state: "accepted", transactionId: "456" });
  const accepted = await listFiscalOutboxItems("business-1");
  assert.equal(accepted[0].state, "accepted");
  assert.equal(accepted[0].transactionId, "456");
});
