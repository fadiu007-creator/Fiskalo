/**
 * ATK POS Protobuf v3 encoder.
 *
 * Field numbers and scalar types mirror the official fiskalizimi/pos-csharp
 * models.proto. ATK unit prices are expressed in 1/10,000 EUR; coupon totals,
 * line totals and tax/payment allocations are expressed in cents.
 *
 * This module only serializes a validated payload. It does not decide ATK
 * catalogue codes or certify that a tax mapping is legally correct.
 */
export type AtkCouponItemInput = {
  name: string;
  unitPriceEuro: number;
  unit: string;
  quantity: number;
  lineTotalCents: number;
  taxRate: string;
  itemType: string;
};

export type AtkPaymentInput = {
  type: number;
  amountCents: number;
};

export type AtkTaxGroupInput = {
  taxRate: string;
  totalForTaxCents: number;
  totalTaxCents: number;
};

export type AtkPosCouponInput = {
  businessId: string | number | bigint;
  couponId: string | number | bigint;
  branchId: string | number | bigint;
  location: string;
  operatorId: string;
  posId: string | number | bigint;
  applicationId: string | number | bigint;
  verificationNo: string;
  type: 1 | 2 | 3;
  unixTime: number;
  items: AtkCouponItemInput[];
  payments: AtkPaymentInput[];
  totalCents: number;
  taxGroups: AtkTaxGroupInput[];
  totalTaxCents: number;
  totalNoTaxCents: number;
  referenceNo?: string | number | bigint;
  transactionNo?: string | number | bigint;
  totalDiscountCents?: number;
};

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function varint(value: bigint): Uint8Array {
  if (value < BigInt(0)) throw new Error("ATK Protobuf integer fields must not be negative.");
  const bytes: number[] = [];
  while (value > BigInt(127)) {
    bytes.push(Number(value & BigInt(127)) | 128);
    value >>= BigInt(7);
  }
  bytes.push(Number(value));
  return new Uint8Array(bytes);
}

function key(field: number, wire: 0 | 2 | 5): Uint8Array {
  return varint(BigInt((field << 3) | wire));
}

function uintField(field: number, value: string | number | bigint): Uint8Array {
  const parsed = BigInt(value);
  if (parsed < BigInt(0) || parsed > BigInt("18446744073709551615")) {
    throw new Error("ATK identifier is outside the uint64 range.");
  }
  return parsed === BigInt(0) ? new Uint8Array() : concat([key(field, 0), varint(parsed)]);
}

function intField(field: number, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("ATK monetary and timestamp values must be non-negative safe integers.");
  }
  return value === 0 ? new Uint8Array() : concat([key(field, 0), varint(BigInt(value))]);
}

function stringField(field: number, value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const bytes = encoder.encode(value);
  return concat([key(field, 2), varint(BigInt(bytes.length)), bytes]);
}

function floatField(field: number, value: number): Uint8Array {
  if (!Number.isFinite(value) || value <= 0) throw new Error("ATK item quantity must be a positive finite number.");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return concat([key(field, 5), bytes]);
}

function messageField(field: number, value: Uint8Array): Uint8Array {
  return concat([key(field, 2), varint(BigInt(value.length)), value]);
}

function cents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(label + " must be a non-negative integer number of cents.");
  return value;
}

function encodeItem(item: AtkCouponItemInput): Uint8Array {
  if (!item.name.trim() || !item.unit.trim() || !item.itemType.trim() || !/^[A-Z]$/.test(item.taxRate)) {
    throw new Error("Each ATK item needs a name, unit, one-character tax code and item-type code.");
  }
  if (!Number.isFinite(item.unitPriceEuro) || item.unitPriceEuro < 0 ||
      Math.round(item.unitPriceEuro * 10000) !== item.unitPriceEuro * 10000) {
    throw new Error("ATK unit price must be exact to four decimal places.");
  }
  const price = Math.round(item.unitPriceEuro * 10000);
  if (!Number.isSafeInteger(price)) throw new Error("ATK unit price exceeds the supported integer range.");
  const quantity = item.quantity;
  const total = cents(item.lineTotalCents, "ATK item total");
  return concat([
    stringField(1, item.name.trim()),
    intField(2, price),
    stringField(3, item.unit.trim()),
    floatField(4, quantity),
    intField(5, total),
    stringField(6, item.taxRate),
    stringField(7, item.itemType.trim()),
  ]);
}

function encodePayment(payment: AtkPaymentInput): Uint8Array {
  if (!Number.isInteger(payment.type) || payment.type < 1 || payment.type > 6) {
    throw new Error("ATK payment type must be between 1 and 6.");
  }
  return concat([intField(1, payment.type), intField(2, cents(payment.amountCents, "ATK payment"))]);
}

function encodeTaxGroup(group: AtkTaxGroupInput): Uint8Array {
  if (!/^[A-Z]$/.test(group.taxRate)) throw new Error("ATK tax group requires a one-character tax code.");
  return concat([
    stringField(1, group.taxRate),
    intField(2, cents(group.totalForTaxCents, "ATK tax base")),
    intField(3, cents(group.totalTaxCents, "ATK tax amount")),
  ]);
}

export function encodeAtkPosCoupon(input: AtkPosCouponInput): Uint8Array {
  if (![input.businessId, input.couponId, input.branchId, input.posId, input.applicationId].every(v => BigInt(v) > BigInt(0))) {
    throw new Error("ATK business, coupon, branch, POS and application IDs are required.");
  }
  if (!input.location.trim() || !input.operatorId.trim()) throw new Error("ATK location and operator ID are required.");
  if (!input.verificationNo || input.verificationNo.length > 16) throw new Error("ATK verification number must contain 1 to 16 characters.");
  if (![1, 2, 3].includes(input.type)) throw new Error("ATK coupon type must be Sale, Cancel or Return.");
  if (!Number.isSafeInteger(input.unixTime) || input.unixTime <= 0) throw new Error("ATK coupon timestamp is invalid.");
  if ((input.type === 1 && input.referenceNo != null && BigInt(input.referenceNo) !== BigInt(0)) ||
      (input.type !== 1 && (input.referenceNo == null || BigInt(input.referenceNo) <= BigInt(0)))) {
    throw new Error("ATK Cancel and Return coupons require the original coupon ID; Sale must not reference one.");
  }
  if (!input.items.length || !input.payments.length || !input.taxGroups.length) {
    throw new Error("ATK coupon requires items, payment allocations and tax groups.");
  }

  const total = cents(input.totalCents, "ATK coupon total");
  const totalTax = cents(input.totalTaxCents, "ATK coupon tax total");
  const totalNet = cents(input.totalNoTaxCents, "ATK coupon net total");
  const discount = cents(input.totalDiscountCents ?? 0, "ATK coupon discount");
  const itemTotal = input.items.reduce((sum, item) => sum + cents(item.lineTotalCents, "ATK item total"), 0);
  const paymentTotal = input.payments.reduce((sum, payment) => sum + cents(payment.amountCents, "ATK payment"), 0);
  const taxBase = input.taxGroups.reduce((sum, group) => sum + cents(group.totalForTaxCents, "ATK tax base"), 0);
  const taxValue = input.taxGroups.reduce((sum, group) => sum + cents(group.totalTaxCents, "ATK tax amount"), 0);
  if (itemTotal - discount !== total || paymentTotal !== total || totalNet + totalTax !== total ||
      taxBase !== totalNet || taxValue !== totalTax) {
    throw new Error("ATK item, payment, tax-group and coupon totals do not reconcile.");
  }

  const parts: Uint8Array[] = [
    uintField(1, input.businessId),
    uintField(2, input.couponId),
    uintField(3, input.branchId),
    stringField(4, input.location.trim()),
    stringField(5, input.operatorId.trim()),
    uintField(6, input.posId),
    uintField(7, input.applicationId),
    stringField(8, input.verificationNo),
    intField(9, input.type),
    intField(10, input.unixTime),
    ...input.items.map(item => messageField(11, encodeItem(item))),
    ...input.payments.map(payment => messageField(12, encodePayment(payment))),
    intField(13, total),
    ...input.taxGroups.map(group => messageField(14, encodeTaxGroup(group))),
    intField(15, totalTax),
    intField(16, totalNet),
    uintField(17, input.referenceNo ?? 0),
    uintField(18, input.transactionNo ?? 0),
    intField(19, discount),
  ];
  return concat(parts.filter(part => part.length > 0));
}

export function encodeAtkBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
