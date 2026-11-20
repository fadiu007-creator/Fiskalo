import assert from "node:assert/strict";
import test from "node:test";
import { outageRecoveryDeadline, resolvePosOutageStart, resolvePosOutageEvidence } from "../src/lib/pos/browser-outbox.ts";

test("48-hour recovery deadline is anchored to outage start, not coupon issue time", () => {
  const outageStart = "2026-11-17T08:00:00.000Z";
  const couponIssuedAt = "2026-11-17T09:15:00.000Z";
  assert.equal(outageRecoveryDeadline(outageStart), "2026-11-19T08:00:00.000Z");
  assert.notEqual(outageRecoveryDeadline(outageStart), outageRecoveryDeadline(couponIssuedAt));
});

test("outage tracking preserves the first observed outage timestamp", () => {
  const firstObservation = "2026-11-17T08:00:00.000Z";
  const laterObservation = "2026-11-17T09:15:00.000Z";
  assert.equal(resolvePosOutageStart(null, firstObservation), firstObservation);
  assert.equal(resolvePosOutageStart(firstObservation, laterObservation), firstObservation);
});

test("outage timestamp helpers reject invalid clock values", () => {
  assert.throws(() => outageRecoveryDeadline("not-a-date"), /Invalid POS connectivity outage timestamp/);
  assert.throws(() => resolvePosOutageStart(null, "not-a-date"), /Invalid POS connectivity outage timestamp/);
});

test("server-signed heartbeat time overrides an untrusted browser clock", () => {
  const local = {
    id: "outage-1", businessId: "business-1", posRecordId: "pos-1",
    startedAt: "2026-11-17T08:10:00.000Z", timeEvidence: "browser_local_untrusted",
  };
  const trusted = "2026-11-17T08:00:00.000Z";
  assert.deepEqual(resolvePosOutageEvidence(local, trusted, "2026-11-17T08:10:00.000Z"), {
    startedAt: trusted,
    timeEvidence: "server_signed_heartbeat",
  });
});

test("the earliest trusted outage anchor is preserved across later heartbeats", () => {
  const existing = {
    id: "outage-1", businessId: "business-1", posRecordId: "pos-1",
    startedAt: "2026-11-17T08:00:00.000Z", timeEvidence: "server_signed_heartbeat",
  };
  assert.deepEqual(resolvePosOutageEvidence(
    existing,
    "2026-11-17T08:30:00.000Z",
    "2026-11-17T08:30:00.000Z",
  ), {
    startedAt: "2026-11-17T08:00:00.000Z",
    timeEvidence: "server_signed_heartbeat",
  });
});

test("invalid server heartbeat time cannot be promoted to trusted outage evidence", () => {
  const result = resolvePosOutageEvidence(null, "invalid", "2026-11-17T08:10:00.000Z");
  assert.deepEqual(result, {
    startedAt: "2026-11-17T08:10:00.000Z",
    timeEvidence: "browser_local_untrusted",
  });
});
