import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { decryptJsonPayload, encryptJsonPayload } from "../src/lib/atk/full-local-storage-crypto.ts";

test("Full POS local metadata is AES-GCM encrypted and bound to its application scope", async () => {
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const value = { organizationId: "org-1", posId: "pos-1", certificateSerial: "TEST-001" };
  const encrypted = await encryptJsonPayload(webcrypto, key, "full-pos-key-vault", value);
  assert.equal(encrypted.version, 1);
  assert.notEqual(encrypted.ciphertext, JSON.stringify(value));
  assert.deepEqual(await decryptJsonPayload(webcrypto, key, "full-pos-key-vault", encrypted), value);
  await assert.rejects(decryptJsonPayload(webcrypto, key, "basic-fiscal-outbox", encrypted));
});

test("Full POS local metadata rejects tampering and malformed ciphertext", async () => {
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const encrypted = await encryptJsonPayload(webcrypto, key, "full-pos-key-vault", { secret: "value" });
  const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -4) + "AAAA" };
  await assert.rejects(decryptJsonPayload(webcrypto, key, "full-pos-key-vault", tampered));
  await assert.rejects(decryptJsonPayload(webcrypto, key, "full-pos-key-vault", { version: 1, iv: "", ciphertext: "" }));
});
