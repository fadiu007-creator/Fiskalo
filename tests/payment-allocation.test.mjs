import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPaymentAllocations,
  formatPaymentAllocations,
  parseEuroAmountToCents,
  toAtkPaymentType,
} from "../src/lib/atk/payment-allocation.ts";

test("parses euro input exactly to cents and accepts comma decimals", () => {
  assert.equal(parseEuroAmountToCents("12.34"), 1234);
  assert.equal(parseEuroAmountToCents("12,34"), 1234);
  assert.equal(parseEuroAmountToCents(".5"), 50);
  assert.equal(parseEuroAmountToCents(""), 0);
});

test("rejects negative, non-numeric and more-than-two-decimal inputs", () => {
  assert.equal(parseEuroAmountToCents("-1.00"), null);
  assert.equal(parseEuroAmountToCents("1.001"), null);
  assert.equal(parseEuroAmountToCents("abc"), null);
});

test("defaults a normal checkout to one cash allocation", () => {
  assert.deepEqual(buildPaymentAllocations(12345, []).allocations, [
    { method: "cash", amountCents: 12345 },
  ]);
});

test("allocates the remaining balance to cash for split tender", () => {
  const result = buildPaymentAllocations(10000, [
    { method: "card", amount: "25.50" },
    { method: "bank_transfer", amount: "10" },
  ]);
  assert.equal(result.valid, true);
  assert.equal(result.cashRemainderCents, 6450);
  assert.deepEqual(result.allocations, [
    { method: "cash", amountCents: 6450 },
    { method: "bank_transfer", amountCents: 1000 },
    { method: "card", amountCents: 2550 },
  ].sort((a, b) => a.method.localeCompare(b.method)));
  assert.equal(result.allocations.reduce((sum, item) => sum + item.amountCents, 0), 10000);
});

test("supports card-only and zero-value supplies", () => {
  assert.deepEqual(buildPaymentAllocations(499, [{ method: "card", amount: "4.99" }]).allocations, [
    { method: "card", amountCents: 499 },
  ]);
  assert.deepEqual(buildPaymentAllocations(0, []).allocations, [
    { method: "cash", amountCents: 0 },
  ]);
});

test("supports voucher and cheque allocations", () => {
  const result = buildPaymentAllocations(1500, [
    { method: "voucher", amount: "5" },
    { method: "cheque", amount: "10" },
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.allocations, [
    { method: "cheque", amountCents: 1000 },
    { method: "voucher", amountCents: 500 },
  ]);
});

test("rejects duplicate methods and tender amounts above the order total", () => {
  assert.equal(buildPaymentAllocations(1000, [
    { method: "card", amount: "2" },
    { method: "card", amount: "1" },
  ]).valid, false);
  const overpaid = buildPaymentAllocations(1000, [
    { method: "card", amount: "8.00" },
    { method: "bank_transfer", amount: "3" },
  ]);
  assert.equal(overpaid.valid, false);
  assert.match(overpaid.error ?? "", /tejkalon totalin/);
});

test("maps methods to the official ATK PaymentType enum", () => {
  assert.equal(toAtkPaymentType("cash"), 1);
  assert.equal(toAtkPaymentType("card"), 2);
  assert.equal(toAtkPaymentType("voucher"), 3);
  assert.equal(toAtkPaymentType("cheque"), 4);
  assert.equal(toAtkPaymentType("crypto"), 5);
  assert.equal(toAtkPaymentType("bank_transfer"), 6);
});

test("formats stored allocations for receipt and sales history", () => {
  assert.equal(
    formatPaymentAllocations([
      { method: "cash", amount_cents: 700 },
      { method: "card", amount_cents: 300 },
    ]),
    "KESH €7.00 + KARTELË €3.00",
  );
});
