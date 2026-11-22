import test from "node:test";
import assert from "node:assert/strict";
import { encodeAtkBase64, encodeAtkCitizenCoupon, encodeAtkPosCoupon } from "../src/lib/atk/protobuf.ts";
import { readAtkPosCouponVerificationNo, recoverAtkMappingsFromOriginalCoupon, validateAtkCitizenCouponPayload, validateAtkCouponPayload } from "../src/lib/atk/validate-coupon-payload.ts";

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

test("legacy correction mapping is recovered from the accepted original ATK coupon", () => {
  assert.deepEqual(
    recoverAtkMappingsFromOriginalCoupon(makePayload(), context.lines),
    [{ id: "product-1", atk_unit_code: "CP", atk_tax_code: "E", atk_item_category_code: "TT" }],
  );
});

test("legacy correction mapping fails closed when original coupon items do not match the invoice", () => {
  assert.throws(
    () => recoverAtkMappingsFromOriginalCoupon(makePayload(), [{ ...context.lines[0], description: "Different item" }]),
    /cannot be matched/,
  );
});

function makeCitizenPayload() {
  return encodeAtkBase64(encodeAtkCitizenCoupon({
    businessId: "123456789",
    couponId: 100,
    branchId: 1,
    posId: 2,
    verificationNo: "123456789",
    type: 1,
    unixTime: 1794760000,
    totalCents: 118,
    taxGroups: [{ taxRate: "E", totalForTaxCents: 100, totalTaxCents: 18 }],
    totalTaxCents: 18,
    totalNoTaxCents: 100,
  }));
}

const citizenContext = {
  nui: "123456789",
  couponId: 100,
  branchId: 1,
  posId: 2,
  verificationNo: "123456789",
  type: 1,
  unixTime: 1794760000,
  totalCents: 118,
  totalTaxCents: 18,
  totalNoTaxCents: 100,
  taxGroups: [{ taxRate: "E", totalForTaxCents: 100, totalTaxCents: 18 }],
};

test("official CitizenCoupon validation accepts the signed receipt QR payload", () => {
  assert.deepEqual(validateAtkCitizenCouponPayload(makeCitizenPayload(), citizenContext), { ok: true });
  assert.equal(readAtkPosCouponVerificationNo(makePayload()), citizenContext.verificationNo);
});

function readVarint(bytes, start) {
  let value = 0n;
  let shift = 0n;
  let cursor = start;
  while (cursor < bytes.length && shift < 70n) {
    const byte = bytes[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
  }
  throw new Error("Malformed test Protobuf varint.");
}

function encodeVarint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return bytes;
}

function replaceProtoField(base64, targetField, replacement, wireType) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  let cursor = 0;
  while (cursor < bytes.length) {
    const tagStart = cursor;
    const tag = readVarint(bytes, cursor);
    cursor = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const value = readVarint(bytes, cursor);
      if (field === targetField && wireType === 0) {
        const updated = [
          ...bytes.slice(0, cursor),
          ...encodeVarint(replacement),
          ...bytes.slice(value.next),
        ];
        return encodeAtkBase64(Uint8Array.from(updated));
      }
      cursor = value.next;
    } else if (wire === 1) {
      cursor += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, cursor);
      cursor = length.next + Number(length.value);
      if (field === targetField && wireType === 2) {
        const replacementBytes = new TextEncoder().encode(String(replacement));
        const updated = [
          ...bytes.slice(0, tagStart),
          ...encodeVarint((BigInt(field) << 3n) | 2n),
          ...encodeVarint(replacementBytes.length),
          ...replacementBytes,
          ...bytes.slice(cursor),
        ];
        return encodeAtkBase64(Uint8Array.from(updated));
      }
    } else if (wire === 5) {
      cursor += 4;
    } else {
      throw new Error("Unsupported test Protobuf wire type.");
    }
    if (cursor > bytes.length) throw new Error("Truncated test Protobuf payload.");
  }
  throw new Error("Target Protobuf field was not found.");
}

test("CitizenCoupon validation rejects totals that differ from the POS Coupon", () => {
  const invalid = replaceProtoField(makeCitizenPayload(), 8, 117, 0);
  const result = validateAtkCitizenCouponPayload(invalid, citizenContext);
  assert.equal(result.ok, false);
  assert.match(result.detail, /identifiers or totals/);
});

test("CitizenCoupon validation rejects verification numbers that differ from the POS Coupon", () => {
  const invalid = replaceProtoField(makeCitizenPayload(), 5, "DIFFERENT", 2);
  const result = validateAtkCitizenCouponPayload(invalid, citizenContext);
  assert.equal(result.ok, false);
  assert.match(result.detail, /verification number/);
});
