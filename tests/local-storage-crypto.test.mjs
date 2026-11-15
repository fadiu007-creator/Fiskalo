import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { decryptJsonPayload, encryptJsonPayload } from "../src/lib/atk/local-storage-crypto.ts";

const cryptoApi = webcrypto;

async function makeKey() {
  return cryptoApi.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

test("local fiscal records are AES-GCM encrypted and decrypt with the same scope", async () => {
  const key = await makeKey();
  const value = { coupon: "123", signedPayload: "sensitive-payload", offlineIssuedAt: "2026-11-15T10:00:00Z" };
  const encrypted = await encryptJsonPayload(cryptoApi, key, "basic-fiscal-outbox", value);
  assert.equal(encrypted.version, 1);
  assert.notEqual(encrypted.ciphertext, Buffer.from(JSON.stringify(value)).toString("base64"));
  assert.deepEqual(await decryptJsonPayload(cryptoApi, key, "basic-fiscal-outbox", encrypted), value);
});

test("AES-GCM binds ciphertext to its storage scope and detects tampering", async () => {
  const key = await makeKey();
  const encrypted = await encryptJsonPayload(cryptoApi, key, "basic-fiscal-outbox", { coupon: "456" });
  await assert.rejects(
    decryptJsonPayload(cryptoApi, key, "basic-pos-connectivity-outage", encrypted),
  );
  const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -2) + "AA" };
  await assert.rejects(decryptJsonPayload(cryptoApi, key, "basic-fiscal-outbox", tampered));
});

test("AES-GCM uses a fresh random IV for every local record encryption", async () => {
  const key = await makeKey();
  const first = await encryptJsonPayload(cryptoApi, key, "basic-fiscal-outbox", { same: true });
  const second = await encryptJsonPayload(cryptoApi, key, "basic-fiscal-outbox", { same: true });
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});
