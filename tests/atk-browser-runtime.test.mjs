import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, X509Certificate, verify as verifySignature } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import "fake-indexeddb/auto";

globalThis.crypto = webcrypto;
globalThis.window = globalThis;

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
      { key: x509.publicKey, dsaEncoding: "der" },
      Buffer.from(signature, "base64"),
    ), true);
    assert.match(generateNuiKf(), /^[A-Z0-9]{16}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
