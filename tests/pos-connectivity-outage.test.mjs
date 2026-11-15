import assert from "node:assert/strict";
import test from "node:test";
import {
  outageRecoveryDeadline,
  resolvePosOutageStart,
} from "../src/lib/pos/browser-outbox.ts";

test("all coupons in one POS outage share the first observed outage timestamp", () => {
  const first = "2026-11-15T08:00:00.000Z";
  const later = "2026-11-15T09:30:00.000Z";
  assert.equal(resolvePosOutageStart(null, first), first);
  assert.equal(resolvePosOutageStart(first, later), first);
  assert.equal(resolvePosOutageStart("invalid", later), later);
});

test("the 48-hour recovery deadline is measured from outage start, not coupon creation", () => {
  assert.equal(
    outageRecoveryDeadline("2026-11-15T08:00:00.000Z"),
    "2026-11-17T08:00:00.000Z",
  );
  assert.throws(() => outageRecoveryDeadline("invalid"), /timestamp/);
  assert.throws(() => resolvePosOutageStart(null, "invalid"), /timestamp/);
});
