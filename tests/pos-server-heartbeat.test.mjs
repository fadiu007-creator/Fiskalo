import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
globalThis.window = globalThis;
globalThis.isSecureContext = true;

const {
  getOrStartPosConnectivityOutage,
  clearPosConnectivityOutage,
} = await import("../src/lib/pos/browser-outbox.ts");
const { encryptBrowserFiscalData } = await import("../src/lib/atk/browser-key-vault.ts");

test("anchors Basic POS outage to the last server-signed heartbeat", async () => {
  const businessId = "business-heartbeat-test";
  const posRecordId = "pos-heartbeat-test";
  const outage = await getOrStartPosConnectivityOutage(
    businessId,
    posRecordId,
    "2026-11-17T10:02:00.000Z",
    "2026-11-17T10:01:00.000Z",
  );
  assert.equal(outage.startedAt, "2026-11-17T10:01:00.000Z");
  assert.equal(outage.timeEvidence, "server_signed");
  await clearPosConnectivityOutage(businessId, posRecordId);
});

test("loads the last encrypted server heartbeat automatically when the browser goes offline", async () => {
  const businessId = "business-heartbeat-auto";
  const posRecordId = "pos-heartbeat-auto";
  const serverTimeUtc = "2026-11-17T10:01:00.000Z";
  const idBytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(businessId + ":" + posRecordId),
  ));
  const id = "heartbeat-" + Array.from(idBytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const value = {
    id,
    businessId,
    posRecordId,
    serverTimeUtc,
    nonce: "test-heartbeat-nonce",
    previousHeartbeatAtUtc: null,
    gapSeconds: null,
    gapDetected: false,
  };
  const encrypted = await encryptBrowserFiscalData("basic-pos-trusted-heartbeat", value);
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("fiskalo-fiscal-outbox", 4);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("signed-documents")) {
        request.result.createObjectStore("signed-documents", { keyPath: "idempotencyKey" });
      }
      if (!request.result.objectStoreNames.contains("connectivity-outages")) {
        request.result.createObjectStore("connectivity-outages", { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains("trusted-heartbeats")) {
        request.result.createObjectStore("trusted-heartbeats", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction("trusted-heartbeats", "readwrite");
    tx.objectStore("trusted-heartbeats").put({
      id,
      revision: 1,
      serverTimeUnixMs: Date.parse(serverTimeUtc),
      encrypted,
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();

  const outage = await getOrStartPosConnectivityOutage(
    businessId,
    posRecordId,
    "2026-11-17T10:02:00.000Z",
  );
  assert.equal(outage.startedAt, serverTimeUtc);
  assert.equal(outage.timeEvidence, "server_signed");
  await clearPosConnectivityOutage(businessId, posRecordId);
});

test("upgrades a later browser-local outage timestamp to an earlier verified server anchor", async () => {
  const businessId = "business-heartbeat-upgrade";
  const posRecordId = "pos-heartbeat-upgrade";
  const local = await getOrStartPosConnectivityOutage(
    businessId,
    posRecordId,
    "2026-11-17T10:05:00.000Z",
  );
  assert.equal(local.startedAt, "2026-11-17T10:05:00.000Z");
  assert.equal(local.timeEvidence, "local_untrusted");

  const upgraded = await getOrStartPosConnectivityOutage(
    businessId,
    posRecordId,
    "2026-11-17T10:06:00.000Z",
    "2026-11-17T10:04:00.000Z",
  );
  assert.equal(upgraded.startedAt, "2026-11-17T10:04:00.000Z");
  assert.equal(upgraded.timeEvidence, "server_signed");
  await clearPosConnectivityOutage(businessId, posRecordId);
});

test("does not relabel an earlier browser clock timestamp as server-signed", async () => {
  const businessId = "business-heartbeat-clock-skew";
  const posRecordId = "pos-heartbeat-clock-skew";
  const local = await getOrStartPosConnectivityOutage(
    businessId,
    posRecordId,
    "2026-11-17T09:00:00.000Z",
    "2026-11-17T10:00:00.000Z",
  );
  assert.equal(local.startedAt, "2026-11-17T09:00:00.000Z");
  assert.equal(local.timeEvidence, "local_untrusted");
  await clearPosConnectivityOutage(businessId, posRecordId);
});
