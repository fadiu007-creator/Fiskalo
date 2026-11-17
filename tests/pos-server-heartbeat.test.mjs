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
