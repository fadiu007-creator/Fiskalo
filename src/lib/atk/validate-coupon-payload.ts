type ProtoValue = bigint | Uint8Array;
type ProtoField = { number: number; wire: number; value: ProtoValue };

function readVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
  let value = BigInt(0);
  let shift = BigInt(0);
  let cursor = start;
  while (cursor < bytes.length && shift < BigInt(70)) {
    const byte = bytes[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += BigInt(7);
  }
  throw new Error("Protobuf varint is malformed.");
}

function parseFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const tag = readVarint(bytes, cursor);
    cursor = tag.next;
    const number = Number(tag.value >> BigInt(3));
    const wire = Number(tag.value & BigInt(7));
    if (number <= 0) throw new Error("Invalid Protobuf field number.");
    if (wire === 0) {
      const parsed = readVarint(bytes, cursor);
      cursor = parsed.next;
      fields.push({ number, wire, value: parsed.value });
    } else if (wire === 1) {
      if (cursor + 8 > bytes.length) throw new Error("Truncated Protobuf fixed64.");
      fields.push({ number, wire, value: bytes.slice(cursor, cursor + 8) });
      cursor += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, cursor);
      cursor = length.next;
      const size = Number(length.value);
      if (!Number.isSafeInteger(size) || size < 0 || cursor + size > bytes.length) throw new Error("Invalid Protobuf field length.");
      fields.push({ number, wire, value: bytes.slice(cursor, cursor + size) });
      cursor += size;
    } else if (wire === 5) {
      if (cursor + 4 > bytes.length) throw new Error("Truncated Protobuf fixed32.");
      fields.push({ number, wire, value: bytes.slice(cursor, cursor + 4) });
      cursor += 4;
    } else {
      throw new Error("Unsupported Protobuf wire type.");
    }
  }
  return fields;
}

function one(fields: ProtoField[], number: number, wire: number): ProtoValue | null {
  const matches = fields.filter((field) => field.number === number);
  if (matches.length > 1) throw new Error("Duplicate singular Protobuf field.");
  if (!matches.length) return null;
  if (matches[0].wire !== wire) throw new Error("Unexpected Protobuf wire type.");
  return matches[0].value;
}

function repeatedBytes(fields: ProtoField[], number: number): Uint8Array[] {
  return fields.filter((field) => field.number === number).map((field) => {
    if (field.wire !== 2 || !(field.value instanceof Uint8Array)) throw new Error("Invalid nested Protobuf message.");
    return field.value;
  });
}

function asUint(fields: ProtoField[], number: number, required = true): bigint {
  const value = one(fields, number, 0);
  if (value === null) {
    if (required) throw new Error("A required Protobuf integer is missing.");
    return BigInt(0);
  }
  if (typeof value !== "bigint") throw new Error("Invalid Protobuf integer.");
  return value;
}

function asString(fields: ProtoField[], number: number, required = true): string {
  const value = one(fields, number, 2);
  if (value === null) {
    if (required) throw new Error("A required Protobuf string is missing.");
    return "";
  }
  if (!(value instanceof Uint8Array)) throw new Error("Invalid Protobuf string.");
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function asFloat32(fields: ProtoField[], number: number): number {
  const value = one(fields, number, 5);
  if (!(value instanceof Uint8Array) || value.length !== 4) throw new Error("Invalid Protobuf quantity.");
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat32(0, true);
}

function cents(value: number): bigint {
  return BigInt(Math.round(value * 100));
}

function paymentType(method: string): number {
  const values: Record<string, number> = { cash: 1, card: 2, bank_transfer: 6 };
  const result = values[method];
  if (!result) throw new Error("Unsupported invoice payment method.");
  return result;
}

export type CouponInvoiceLine = {
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  line_subtotal: number;
  line_vat: number;
  vat_rate: number;
};

export type CouponProductMapping = {
  id: string;
  atk_unit_code: string | null;
  atk_tax_code: string | null;
  atk_item_category_code: string | null;
};

export type CouponPayment = { amount: number; payment_method: string };

export type CouponValidationContext = {
  nui: string;
  couponId: string | number | bigint;
  couponType?: 1 | 2 | 3;
  referenceCouponId?: string | number | bigint;
  branchId: number;
  posId: number;
  applicationId: number;
  operatorId: string;
  location: string;
  total: number;
  discountTotal?: number;
  subtotal: number;
  vatTotal: number;
  lines: CouponInvoiceLine[];
  products: CouponProductMapping[];
  payments: CouponPayment[];
};

/**
 * Validates the complete signed Protobuf coupon against the saved invoice,
 * product mappings and payment ledger. ATK remains responsible for validating
 * the actual certificate signature at its endpoint.
 */
export function validateAtkCouponPayload(details: string, context: CouponValidationContext): { ok: true } | { ok: false; detail: string } {
  try {
    const binary = atob(details);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const fields = parseFields(bytes);

    const header = [
      [1, BigInt(context.nui)], [2, BigInt(context.couponId)], [3, BigInt(context.branchId)],
      [6, BigInt(context.posId)], [7, BigInt(context.applicationId)], [9, BigInt(context.couponType ?? 1)],
      [13, cents(context.total)],
    ] as const;
    for (const [number, expected] of header) {
      if (asUint(fields, number) !== expected) throw new Error("Coupon identifiers or total do not match the selected business, POS and invoice.");
    }
    const verificationNo = asString(fields, 8);
    if (!verificationNo || verificationNo.length > 16) throw new Error("Coupon verification number is invalid.");
    if (asString(fields, 5) !== context.operatorId) throw new Error("Coupon operator does not match the signed-in cashier.");
    if (asString(fields, 4) !== context.location) throw new Error("Coupon location does not match the registered POS.");
    if (asUint(fields, 15, false) !== cents(context.vatTotal) ||
        asUint(fields, 16, false) !== cents(context.subtotal)) {
      throw new Error("Coupon VAT and net totals do not match the invoice.");
    }
    const couponDiscount = asUint(fields, 19, false);
    const expectedDiscount = cents(Number(context.discountTotal ?? 0));
    if (couponDiscount !== expectedDiscount) {
      throw new Error("Coupon discount does not match the saved invoice discount.");
    }
    const expectedReference = context.referenceCouponId == null ? BigInt(0) : BigInt(context.referenceCouponId);
    if (asUint(fields, 17, false) !== expectedReference || asUint(fields, 18, false) !== BigInt(0)) {
      throw new Error("Coupon reference does not match the original ATK sale coupon.");
    }
    if ((context.couponType ?? 1) === 1 && expectedReference !== BigInt(0)) {
      throw new Error("A sale coupon cannot reference another coupon.");
    }
    if ((context.couponType ?? 1) !== 1 && expectedReference <= BigInt(0)) {
      throw new Error("ATK cancellation and return coupons must reference the original sale coupon.");
    }

    const productMap = new Map(context.products.map((product) => [product.id, product]));
    const actualItems = repeatedBytes(fields, 11).map((payload) => {
      const nested = parseFields(payload);
      return {
        name: asString(nested, 1),
        unitPrice: asUint(nested, 2),
        unit: asString(nested, 3),
        quantity: asFloat32(nested, 4),
        total: asUint(nested, 5),
        tax: asString(nested, 6),
        itemType: asString(nested, 7),
      };
    });
    if (actualItems.length !== context.lines.length || !actualItems.length) throw new Error("Coupon item count does not match the invoice.");

    const expectedItems = context.lines.map((line) => {
      if (!line.product_id) throw new Error("An invoice line has no linked Fiskalo product.");
      const product = productMap.get(line.product_id);
      if (!product?.atk_unit_code || !product.atk_tax_code || !product.atk_item_category_code) {
        throw new Error("An invoice product is missing its required ATK catalogue mapping.");
      }
      const vat = Number(line.vat_rate);
      const taxMatches = vat === 8 ? product.atk_tax_code === "D"
        : vat === 18 ? product.atk_tax_code === "E"
        : vat === 0 ? ["A", "C"].includes(product.atk_tax_code)
        : false;
      if (!taxMatches) throw new Error("A product ATK tax code does not match its invoice VAT rate.");
      return {
        name: line.description,
        unitPrice: BigInt(Math.round(Number(line.unit_price) * 10000)),
        unit: product.atk_unit_code,
        quantity: Number(line.quantity),
        // ATK item rows carry the pre-discount gross line value. The coupon-level
        // TotalDiscount is then deducted once; tax groups and coupon totals use
        // the discounted taxable base saved on the invoice.
        total: cents(
          Math.round(Number(line.quantity) * Number(line.unit_price) * 100) / 100 +
          Math.round(Number(line.quantity) * Number(line.unit_price) * Number(line.vat_rate)) / 100
        ),
        tax: product.atk_tax_code,
        itemType: product.atk_item_category_code,
      };
    });
    const canonical = (item: typeof expectedItems[number]) =>
      JSON.stringify([item.name, item.unitPrice.toString(), item.unit, item.quantity.toFixed(3), item.total.toString(), item.tax, item.itemType]);
    const expectedKeys = expectedItems.map(canonical).sort();
    const actualKeys = actualItems.map((item) => {
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new Error("Coupon quantity is invalid.");
      return JSON.stringify([item.name, item.unitPrice.toString(), item.unit, item.quantity.toFixed(3), item.total.toString(), item.tax, item.itemType]);
    }).sort();
    if (expectedKeys.some((value, index) => value !== actualKeys[index])) {
      throw new Error("Signed coupon item details do not match the invoice lines and ATK product mappings.");
    }

    const expectedPayments = new Map<number, bigint>();
    for (const payment of context.payments) {
      const type = paymentType(payment.payment_method);
      expectedPayments.set(type, (expectedPayments.get(type) ?? BigInt(0)) + cents(Number(payment.amount)));
    }
    const actualPayments = new Map<number, bigint>();
    for (const payload of repeatedBytes(fields, 12)) {
      const nested = parseFields(payload);
      const type = Number(asUint(nested, 1));
      const amount = asUint(nested, 2);
      if (![1, 2, 6].includes(type) || amount <= BigInt(0) || actualPayments.has(type)) {
        throw new Error("Coupon payment allocations are invalid or duplicated.");
      }
      actualPayments.set(type, amount);
    }
    if (actualPayments.size !== expectedPayments.size) throw new Error("Coupon payment methods do not match the payment ledger.");
    for (const [type, amount] of expectedPayments) {
      if (actualPayments.get(type) !== amount) throw new Error("Coupon payment allocations do not match the payment ledger.");
    }

    const expectedTaxGroups = new Map<string, { base: bigint; tax: bigint }>();
    expectedItems.forEach((item, index) => {
      const line = context.lines[index];
      const current = expectedTaxGroups.get(item.tax) ?? { base: BigInt(0), tax: BigInt(0) };
      current.base += cents(Number(line.line_subtotal));
      current.tax += cents(Number(line.line_vat));
      expectedTaxGroups.set(item.tax, current);
    });
    const actualTaxGroups = new Map<string, { base: bigint; tax: bigint }>();
    for (const payload of repeatedBytes(fields, 14)) {
      const nested = parseFields(payload);
      const tax = asString(nested, 1);
      if (actualTaxGroups.has(tax)) throw new Error("Coupon contains duplicate tax groups.");
      actualTaxGroups.set(tax, { base: asUint(nested, 2), tax: asUint(nested, 3) });
    }
    if (actualTaxGroups.size !== expectedTaxGroups.size) throw new Error("Coupon tax groups do not match the invoice.");
    for (const [tax, values] of expectedTaxGroups) {
      const actual = actualTaxGroups.get(tax);
      if (!actual || actual.base !== values.base || actual.tax !== values.tax) {
        throw new Error("Coupon tax-group amounts do not match the invoice.");
      }
    }

    const itemTotal = expectedItems.reduce((sum, item) => sum + item.total, BigInt(0));
    const paymentTotal = Array.from(expectedPayments.values()).reduce((sum, amount) => sum + amount, BigInt(0));
    if (itemTotal - couponDiscount !== cents(context.total) || paymentTotal !== cents(context.total)) {
      throw new Error("Invoice lines or payment ledger do not reconcile to the invoice total.");
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "The signed coupon payload could not be validated." };
  }
}
