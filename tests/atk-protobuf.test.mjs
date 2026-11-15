import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAtkPosCoupon,
  encodeAtkCitizenCoupon,
  encodeAtkBase64,
} from "../src/lib/atk/protobuf.ts";
import { createCitizenQrSvg } from "../src/lib/atk/citizen-qr.ts";

const taxGroups = [{ taxRate: "E", totalForTaxCents: 100, totalTaxCents: 18 }];
const coupon = {
  businessId: "123456789",
  couponId: 100,
  branchId: 1,
  location: "Ferizaj",
  operatorId: "Operator 1",
  posId: 2,
  applicationId: 1234,
  verificationNo: "1234567890123456",
  type: 1,
  unixTime: 1770000000,
  items: [{ name: "Tea", unitPriceEuro: 1, unit: "CP", quantity: 1, lineTotalCents: 118, taxRate: "E", itemType: "TT" }],
  payments: [{ type: 1, amountCents: 118 }],
  totalCents: 118,
  taxGroups,
  totalTaxCents: 18,
  totalNoTaxCents: 100,
  totalDiscountCents: 0,
};

test("POS and CitizenCoupon protobuf totals reconcile and produce a QR SVG", async () => {
  const posBytes = encodeAtkPosCoupon(coupon);
  const citizenBytes = encodeAtkCitizenCoupon({
    businessId: coupon.businessId,
    couponId: coupon.couponId,
    branchId: coupon.branchId,
    posId: coupon.posId,
    verificationNo: coupon.verificationNo,
    type: coupon.type,
    unixTime: coupon.unixTime,
    totalCents: coupon.totalCents,
    taxGroups,
    totalTaxCents: coupon.totalTaxCents,
    totalNoTaxCents: coupon.totalNoTaxCents,
  });
  const posBase64 = encodeAtkBase64(posBytes);
  const citizenBase64 = encodeAtkBase64(citizenBytes);
  assert.ok(posBytes.length > 0);
  assert.ok(citizenBytes.length > 0);
  assert.ok(posBase64.length > 0);
  assert.ok(citizenBase64.length > 0);
  const qr = await createCitizenQrSvg(citizenBase64 + "|" + "signature");
  assert.match(qr, /<svg/);
  assert.match(qr, /<\/svg>/);
});

test("invalid ATK totals are rejected before signing", () => {
  assert.throws(() => encodeAtkPosCoupon({ ...coupon, totalCents: 117 }), /do not reconcile/);
  assert.throws(() => encodeAtkCitizenCoupon({
    businessId: coupon.businessId, couponId: coupon.couponId, branchId: coupon.branchId, posId: coupon.posId,
    verificationNo: coupon.verificationNo, type: 1, unixTime: coupon.unixTime,
    totalCents: 117, taxGroups, totalTaxCents: 18, totalNoTaxCents: 100,
  }), /do not reconcile/);
});
