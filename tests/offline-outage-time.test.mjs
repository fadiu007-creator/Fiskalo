import assert from "node:assert/strict";
import test from "node:test";
import { outageRecoveryDeadline, resolvePosOutageStart } from "../src/lib/pos/browser-outbox.ts";

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
