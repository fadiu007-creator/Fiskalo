import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { encodeAtkBase64, encodeAtkPosCoupon } from "../../../src/lib/atk/protobuf.ts";
import {
  assertAtkCorrectionIdentity,
  assertFullCorrectionMatchesOriginal,
  decodeAtkCorrectionIdentity,
  extractAtkTransactionId,
  isBase64,
  isUint64String,
} from "./core.ts";

function correctionPayload(overrides: Record<string, unknown> = {}) {
  return encodeAtkBase64(encodeAtkPosCoupon({
    businessId: "810123456",
    couponId: "9001",
    branchId: "1",
    location: "Prishtine",
    operatorId: "Operator 1",
    posId: "2",
    applicationId: "300",
    verificationNo: "NUIKF12345678901",
    type: 2,
    unixTime: 1794729600,
    referenceNo: "9000",
    items: [{
      name: "Test item",
      unitPriceEuro: 1,
      unit: "CP",
      quantity: 1,
      lineTotalCents: 100,
      taxRate: "A",
      itemType: "TT",
    }],
    payments: [{ type: 1, amountCents: 100 }],
    totalCents: 100,
    taxGroups: [{ taxRate: "A", totalForTaxCents: 100, totalTaxCents: 0 }],
    totalTaxCents: 0,
    totalNoTaxCents: 100,
    ...overrides,
  } as Parameters<typeof encodeAtkPosCoupon>[0]));
}


function originalPayload() {
  return encodeAtkBase64(encodeAtkPosCoupon({
    businessId: "810123456",
    couponId: "9000",
    branchId: "1",
    location: "Prishtine",
    operatorId: "Operator 1",
    posId: "2",
    applicationId: "300",
    verificationNo: "ORIGINAL12345678",
    type: 1,
    unixTime: 1794729500,
    items: [{
      name: "Test item",
      unitPriceEuro: 1,
      unit: "CP",
      quantity: 1,
      lineTotalCents: 100,
      taxRate: "A",
      itemType: "TT",
    }],
    payments: [{ type: 1, amountCents: 100 }],
    totalCents: 100,
    taxGroups: [{ taxRate: "A", totalForTaxCents: 100, totalTaxCents: 0 }],
    totalTaxCents: 0,
    totalNoTaxCents: 100,
  }));
}

Deno.test("ATK correction protobuf identity is decoded from signed details", () => {
  const identity = decodeAtkCorrectionIdentity(correctionPayload());
  assertEquals(identity.businessId, "810123456");
  assertEquals(identity.couponId, "9001");
  assertEquals(identity.branchId, "1");
  assertEquals(identity.posId, "2");
  assertEquals(identity.applicationId, "300");
  assertEquals(identity.verificationNo, "NUIKF12345678901");
  assertEquals(identity.type, 2);
  assertEquals(identity.referenceNo, "9000");
  assertEquals(identity.location, "Prishtine");
  assertEquals(identity.operatorId, "Operator 1");
});

Deno.test("ATK correction identity must match the reserved original sale and POS", () => {
  const identity = decodeAtkCorrectionIdentity(correctionPayload());
  assertThrows(() => assertAtkCorrectionIdentity(identity, {
    businessId: "810123456",
    couponId: "9001",
    branchId: "1",
    posId: "2",
    applicationId: "300",
    type: 3,
    referenceNo: "9000",
  }));
  assertThrows(() => assertAtkCorrectionIdentity(identity, {
    businessId: "810123456",
    couponId: "9001",
    branchId: "1",
    posId: "2",
    applicationId: "300",
    type: 2,
    referenceNo: "8999",
  }));
});


Deno.test("full cancellation/return must preserve original lines, payments, discount and tax totals", () => {
  assertFullCorrectionMatchesOriginal(originalPayload(), correctionPayload());
  const altered = correctionPayload({
    items: [{
      name: "Test item",
      unitPriceEuro: 2,
      unit: "CP",
      quantity: 1,
      lineTotalCents: 200,
      taxRate: "A",
      itemType: "TT",
    }],
    payments: [{ type: 1, amountCents: 200 }],
    totalCents: 200,
    taxGroups: [{ taxRate: "A", totalForTaxCents: 200, totalTaxCents: 0 }],
    totalTaxCents: 0,
    totalNoTaxCents: 200,
  });
  assertThrows(() => assertFullCorrectionMatchesOriginal(originalPayload(), altered));
});

Deno.test("ATK uint64 identifiers are validated without JavaScript number conversion", () => {
  assertEquals(isUint64String("1"), true);
  assertEquals(isUint64String("18446744073709551615"), true);
  assertEquals(isUint64String("18446744073709551616"), false);
  assertEquals(isUint64String("0"), false);
  assertEquals(isUint64String("1e5"), false);
  assertEquals(isUint64String("9007199254740993"), true);
  assertEquals(isBase64("YWJj"), true);
  assertEquals(isBase64("YWJj!"), false);
});

Deno.test("ATK transaction_id parser preserves exact root-level uint64 JSON tokens", () => {
  assertEquals(
    extractAtkTransactionId('{"message":"ok","transaction_id":18446744073709551615}'),
    "18446744073709551615",
  );
  assertEquals(
    extractAtkTransactionId('{"transaction_id":"9007199254740993","message":"ok"}'),
    "9007199254740993",
  );
  assertEquals(extractAtkTransactionId('{"transaction_id":0}'), null);
  assertEquals(extractAtkTransactionId('{"transaction_id":18446744073709551616}'), null);
  assertEquals(extractAtkTransactionId('{"transaction_id":1e5}'), null);
  assertEquals(extractAtkTransactionId('{"nested":{"transaction_id":123}}'), null);
  assertThrows(() => extractAtkTransactionId('{"transaction_id":1,"transaction_id":2}'));
  assertThrows(() => extractAtkTransactionId("[]"));
});

Deno.test("server-side correction endpoint reserves before ATK and never trusts browser response fields", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(source.includes("body.atkResponse"), false);
  assertEquals(source.includes("body.transactionId"), false);
  assertEquals(source.includes('member?.role !== "owner"'), true);
  assertEquals(source.includes('submission_state: "submitted"'), true);
  assertEquals(source.indexOf('.insert({') < source.indexOf("fetch(ATK_TEST_COUPON_URL,"), true);
  assertEquals(source.includes('https://fiskalizimi-test.atk-ks.org/pos/coupon'), true);
  assertEquals(source.includes('redirect: "error"'), true);
  assertEquals(source.includes("extractAtkTransactionId(responseText)"), true);
});
