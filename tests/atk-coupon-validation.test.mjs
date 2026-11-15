import test from "node:test";
import assert from "node:assert/strict";
import { encodeAtkBase64, encodeAtkPosCoupon } from "../src/lib/atk/protobuf.ts";
import { validateAtkCouponPayload } from "../src/lib/atk/validate-coupon-payload.ts";

function makePayload(overrides = {}) {
  const input = {
    businessId: "123456789",
    couponId: 100,
    branchId: 1,
    location: "Ferizaj",
    operatorId: "Cashier",
    posId: 2,
    applicationId: 3,
    verificationNo: "123456789",
    type: 1,
    unixTime: 1794760000,
    items: [{ name: "Tea", unitPriceEuro: 1, unit: "CP", quantity: 1, lineTotalCents: 118, taxRate: "E", itemType: "TT" }],
    payments: [
      { type: 1, amountCents: 20 }, { type: 1, amountCents: 10 },
      { type: 2, amountCents: 20 }, { type: 3, amountCents: 20 },
      { type: 4, amountCents: 20 }, { type: 5, amountCents: 10 },
      { type: 6, amountCents: 18 },
    ],
    totalCents: 118,
    taxGroups: [{ taxRate: "E", totalForTaxCents: 100, totalTaxCents: 18 }],
    totalTaxCents: 18,
    totalNoTaxCents: 100,
    totalDiscountCents: 0,
    ...overrides,
  };
  return encodeAtkBase64(encodeAtkPosCoupon(input));
}

const context = {
  nui: "123456789",
  couponId: 100,
  branchId: 1,
  posId: 2,
  applicationId: 3,
  operatorId: "Cashier",
  location: "Ferizaj",
  total: 1.18,
  subtotal: 1,
  vatTotal: 0.18,
  lines: [{ product_id: "product-1", description: "Tea", quantity: 1, unit_price: 1, line_subtotal: 1, line_vat: 0.18, vat_rate: 18 }],
  products: [{ id: "product-1", atk_unit_code: "CP", atk_tax_code: "E", atk_item_category_code: "TT" }],
  payments: [
    { amount: 0.2, payment_method: "cash" }, { amount: 0.1, payment_method: "cash" },
    { amount: 0.2, payment_method: "card" }, { amount: 0.2, payment_method: "voucher" },
    { amount: 0.2, payment_method: "cheque" }, { amount: 0.1, payment_method: "crypto" },
    { amount: 0.18, payment_method: "bank_transfer" },
  ],
};

test("Full coupon validation accepts official catalogues and aggregates repeated tender types", () => {
  assert.deepEqual(validateAtkCouponPayload(makePayload(), context), { ok: true });
});

test("Full coupon validation rejects legacy invalid ATK unit codes", () => {
  const invalid = { ...context, products: [{ ...context.products[0], atk_unit_code: "KG" }] };
  const result = validateAtkCouponPayload(makePayload(), invalid);
  assert.equal(result.ok, false);
  assert.match(result.detail, /ATK catalogue mapping/);
});

test("Full coupon validation rejects invalid ATK item category codes", () => {
  const invalid = { ...context, products: [{ ...context.products[0], atk_item_category_code: "XX" }] };
  const result = validateAtkCouponPayload(makePayload(), invalid);
  assert.equal(result.ok, false);
  assert.match(result.detail, /ATK catalogue mapping/);
});

test("Full coupon validation rejects VAT code and rate mismatches", () => {
  const invalid = { ...context, products: [{ ...context.products[0], atk_tax_code: "D" }] };
  const result = validateAtkCouponPayload(makePayload(), invalid);
  assert.equal(result.ok, false);
  assert.match(result.detail, /VAT rate/);
});
