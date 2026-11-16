import assert from "node:assert/strict";
import test from "node:test";
import { encodeAtkCitizenCoupon, encodeAtkPosCoupon } from "../src/lib/atk/protobuf.ts";

const taxGroups = [{ taxRate: "E", totalForTaxCents: 1000, totalTaxCents: 180 }];

test("encodes a valid ATK CitizenCoupon deterministically", () => {
  const coupon = {
    businessId: 123456789n, couponId: 9001n, branchId: 1, posId: 2,
    verificationNo: "0123456789ABCDEF", type: 1, unixTime: 1794763200,
    totalCents: 1180, taxGroups, totalTaxCents: 180, totalNoTaxCents: 1000,
  };
  const first = encodeAtkCitizenCoupon(coupon);
  const second = encodeAtkCitizenCoupon(coupon);
  assert.ok(first.length > 0);
  assert.deepEqual(first, second);
});

test("rejects CitizenCoupon totals that do not reconcile", () => {
  assert.throws(() => encodeAtkCitizenCoupon({
    businessId: 123456789, couponId: 9001, branchId: 1, posId: 2,
    verificationNo: "0123456789ABCDEF", type: 1, unixTime: 1794763200,
    totalCents: 1181, taxGroups, totalTaxCents: 180, totalNoTaxCents: 1000,
  }), /do not reconcile/);
});

test("rejects a malformed CitizenCoupon verification number", () => {
  assert.throws(() => encodeAtkCitizenCoupon({
    businessId: 123456789, couponId: 9001, branchId: 1, posId: 2,
    verificationNo: "", type: 1, unixTime: 1794763200,
    totalCents: 1180, taxGroups, totalTaxCents: 180, totalNoTaxCents: 1000,
  }), /verification number/);
});
