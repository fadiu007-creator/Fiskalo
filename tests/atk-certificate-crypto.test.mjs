import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, sign as signData } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  certificateSpkiFingerprint,
  equalBytes,
  getCertificateSpki,
  getCsrSpki,
  verifySignedBase64Payload,
} from "../src/lib/atk/certificate-crypto.ts";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

function openssl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || "OpenSSL failed");
}

test("ATK certificate registry binds the issued certificate to the exact POS CSR key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fiskalo-cert-crypto-"));
  try {
    const keyPath = join(dir, "pos.key");
    const csrPath = join(dir, "pos.csr");
    const certPath = join(dir, "pos.crt");
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
    openssl(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", "/CN=Fiskalo Test POS"]);
    openssl(["req", "-new", "-x509", "-key", keyPath, "-out", certPath, "-subj", "/CN=Fiskalo Test POS", "-days", "1"]);
    const privateKey = readFileSync(keyPath);
    const csr = readFileSync(csrPath, "utf8");
    const certificate = readFileSync(certPath, "utf8");
    assert.equal(equalBytes(getCsrSpki(csr), getCertificateSpki(certificate)), true);
    const fingerprint = await certificateSpkiFingerprint(certificate);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    const payload = "ATK-SIGNED-POS-COUPON-TEST";
    const signature = signData("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "der" }).toString("base64");
    assert.equal(await verifySignedBase64Payload(certificate, payload, signature), true);
    assert.equal(await verifySignedBase64Payload(certificate, payload + "-tampered", signature), false);
    const otherKeyPath = join(dir, "other.key");
    const otherCertPath = join(dir, "other.crt");
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", otherKeyPath]);
    openssl(["req", "-new", "-x509", "-key", otherKeyPath, "-out", otherCertPath, "-subj", "/CN=Other POS", "-days", "1"]);
    const otherCertificate = readFileSync(otherCertPath, "utf8");
    assert.equal(await verifySignedBase64Payload(otherCertificate, payload, signature), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
