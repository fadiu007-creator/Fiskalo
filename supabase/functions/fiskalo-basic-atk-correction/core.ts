const MAX_UINT64 = 18446744073709551615n;

export type AtkCorrectionIdentity = {
  businessId: string;
  couponId: string;
  branchId: string;
  posId: string;
  applicationId: string;
  verificationNo: string;
  type: number;
  referenceNo: string;
  location?: string;
  operatorId?: string;
  time?: string;
  totalCents?: string;
  totalTaxCents?: string;
  totalNoTaxCents?: string;
};

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isUint64String(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_UINT64;
  } catch {
    return false;
  }
}

export function isBase64(value: unknown, maxLength = 2_000_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let index = offset;
  for (let count = 0; count < 10 && index < bytes.length; count += 1) {
    const byte = bytes[index++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > MAX_UINT64) throw new Error("ATK protobuf uint64 value is out of range.");
      return { value, next: index };
    }
    shift += 7n;
  }
  throw new Error("ATK protobuf varint is truncated or too large.");
}

function readLengthDelimited(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  const length = readVarint(bytes, offset);
  if (length.value > BigInt(bytes.length) || length.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ATK protobuf field length is invalid.");
  }
  const end = length.next + Number(length.value);
  if (end > bytes.length) throw new Error("ATK protobuf field is truncated.");
  return { value: bytes.subarray(length.next, end), next: end };
}

function skipWireValue(bytes: Uint8Array, offset: number, wire: number): number {
  if (wire === 0) return readVarint(bytes, offset).next;
  if (wire === 1) {
    if (offset + 8 > bytes.length) throw new Error("ATK protobuf fixed64 field is truncated.");
    return offset + 8;
  }
  if (wire === 2) return readLengthDelimited(bytes, offset).next;
  if (wire === 5) {
    if (offset + 4 > bytes.length) throw new Error("ATK protobuf fixed32 field is truncated.");
    return offset + 4;
  }
  throw new Error("ATK protobuf wire type is unsupported.");
}

/** Decode only the top-level POS coupon identity fields needed to bind a correction to its sale/POS. */
export function decodeAtkCorrectionIdentity(detailsBase64: string): AtkCorrectionIdentity {
  const bytes = decodeBase64(detailsBase64);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const values = new Map<number, string>();
  const seen = new Set<number>();
  let items = 0;
  let payments = 0;
  let taxGroups = 0;
  let offset = 0;

  const uintFields = new Set([1, 2, 3, 6, 7, 9, 10, 13, 15, 16, 17, 18, 19]);
  const stringFields = new Set([4, 5, 8]);

  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field <= 0) throw new Error("ATK protobuf field number is invalid.");

    if (field === 11 || field === 12 || field === 14) {
      if (wire !== 2) throw new Error("ATK coupon repeated message has an invalid wire type.");
      const message = readLengthDelimited(bytes, offset);
      offset = message.next;
      if (field === 11) items += 1;
      if (field === 12) payments += 1;
      if (field === 14) taxGroups += 1;
      continue;
    }

    if (uintFields.has(field)) {
      if (wire !== 0 || seen.has(field)) throw new Error("ATK coupon identity field is malformed or duplicated.");
      const scalar = readVarint(bytes, offset);
      offset = scalar.next;
      values.set(field, scalar.value.toString());
      seen.add(field);
      continue;
    }

    if (stringFields.has(field)) {
      if (wire !== 2 || seen.has(field)) throw new Error("ATK coupon string field is malformed or duplicated.");
      const encoded = readLengthDelimited(bytes, offset);
      offset = encoded.next;
      const value = decoder.decode(encoded.value);
      if (!value) throw new Error("ATK coupon identity string is empty.");
      values.set(field, value);
      seen.add(field);
      continue;
    }

    offset = skipWireValue(bytes, offset, wire);
  }

  // Protobuf omits zero-valued scalar fields (for example a 0% VAT total).
  const required = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 17];
  if (required.some((field) => !seen.has(field)) || items === 0 || payments === 0 || taxGroups === 0) {
    throw new Error("ATK correction coupon is missing required identity, item, payment or tax fields.");
  }

  return {
    businessId: values.get(1)!,
    couponId: values.get(2)!,
    branchId: values.get(3)!,
    location: values.get(4)!,
    operatorId: values.get(5)!,
    posId: values.get(6)!,
    applicationId: values.get(7)!,
    verificationNo: values.get(8)!,
    type: Number(values.get(9)),
    time: values.get(10)!,
    totalCents: values.get(13)!,
    totalTaxCents: values.get(15)!,
    totalNoTaxCents: values.get(16)!,
    referenceNo: values.get(17)!,
  } as AtkCorrectionIdentity;
}

export type ExpectedAtkCorrectionIdentity = Pick<
  AtkCorrectionIdentity,
  "businessId" | "couponId" | "branchId" | "posId" | "applicationId" | "type" | "referenceNo"
>;

export function assertAtkCorrectionIdentity(
  actual: AtkCorrectionIdentity,
  expected: ExpectedAtkCorrectionIdentity,
): void {
  const fields: (keyof ExpectedAtkCorrectionIdentity)[] = [
    "businessId", "couponId", "branchId", "posId", "applicationId",
    "type", "referenceNo",
  ];
  for (const field of fields) {
    if (String(actual[field]) !== String(expected[field])) {
      throw new Error("Signed ATK correction does not match the reserved sale/POS identity (" + field + ").");
    }
  }
  if (!/^[A-Z0-9]{16}$/.test(actual.verificationNo)) {
    throw new Error("ATK correction coupon must contain a new 16-character alphanumeric NUIKF.");
  }
  if (!isUint64String(actual.businessId) || !isUint64String(actual.couponId) ||
      !isUint64String(actual.branchId) || !isUint64String(actual.posId) ||
      !isUint64String(actual.applicationId) || !isUint64String(actual.referenceNo) ||
      !isUint64String(actual.time)) {
    throw new Error("Signed ATK correction contains an invalid uint64 identity or timestamp.");
  }
  if (actual.type !== 2 && actual.type !== 3) {
    throw new Error("Signed ATK correction must be Cancel (2) or Return (3).");
  }
}
 

function topLevelFieldSegments(detailsBase64: string): Uint8Array[] {
  const bytes = decodeBase64(detailsBase64);
  const mutableCorrectionFields = new Set([2, 8, 9, 10, 17]);
  const stable: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    const key = readVarint(bytes, offset);
    offset = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field <= 0) throw new Error("ATK protobuf field number is invalid.");
    offset = skipWireValue(bytes, offset, wire);
    if (!mutableCorrectionFields.has(field)) stable.push(bytes.slice(start, offset));
  }
  return stable;
}

/** Ensure a Cancel/Return changes only coupon identity, NUIKF, type, timestamp and reference. */
export function assertFullCorrectionMatchesOriginal(
  originalDetailsBase64: string,
  correctionDetailsBase64: string,
): void {
  const original = topLevelFieldSegments(originalDetailsBase64);
  const correction = topLevelFieldSegments(correctionDetailsBase64);
  if (original.length !== correction.length) {
    throw new Error("ATK full correction must preserve every original item, payment, discount and tax field.");
  }
  for (let index = 0; index < original.length; index += 1) {
    const left = original[index];
    const right = correction[index];
    if (left.length !== right.length) {
      throw new Error("ATK full correction must preserve every original item, payment, discount and tax field.");
    }
    for (let byte = 0; byte < left.length; byte += 1) {
      if (left[byte] !== right[byte]) {
        throw new Error("ATK full correction must preserve every original item, payment, discount and tax field.");
      }
    }
  }
}

function skipJsonWhitespace(source: string, offset: number): number {
  while (offset < source.length && /\s/.test(source[offset])) offset += 1;
  return offset;
}

function jsonStringEnd(source: string, offset: number): number {
  if (source[offset] !== '"') throw new Error("Expected a JSON string.");
  let escaped = false;
  for (let index = offset + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index + 1;
  }
  throw new Error("JSON string is unterminated.");
}

function jsonValueEnd(source: string, offset: number): number {
  const first = source[offset];
  if (first === '"') return jsonStringEnd(source, offset);
  if (first === "{" || first === "[") {
    const stack: string[] = [first === "{" ? "}" : "]"];
    let index = offset + 1;
    while (index < source.length && stack.length) {
      const character = source[index];
      if (character === '"') {
        index = jsonStringEnd(source, index);
        continue;
      }
      if (character === "{") stack.push("}");
      else if (character === "[") stack.push("]");
      else if (character === "}" || character === "]") {
        if (stack.pop() !== character) throw new Error("JSON response has mismatched delimiters.");
      }
      index += 1;
    }
    if (stack.length) throw new Error("JSON value is unterminated.");
    return index;
  }
  let index = offset;
  while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
  return index;
}

/** Extract a root-level uint64 transaction_id without converting it through JS Number. */
export function extractAtkTransactionId(responseText: string): string | null {
  const parsed: unknown = JSON.parse(responseText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ATK response must be a JSON object.");
  }

  let offset = skipJsonWhitespace(responseText, 0);
  if (responseText[offset] !== "{") throw new Error("ATK response must be a JSON object.");
  offset += 1;
  let transactionId: string | null = null;
  let found = false;

  while (true) {
    offset = skipJsonWhitespace(responseText, offset);
    if (responseText[offset] === "}") break;
    const keyEnd = jsonStringEnd(responseText, offset);
    const key = JSON.parse(responseText.slice(offset, keyEnd)) as string;
    offset = skipJsonWhitespace(responseText, keyEnd);
    if (responseText[offset] !== ":") throw new Error("ATK response JSON is malformed.");
    offset = skipJsonWhitespace(responseText, offset + 1);
    const valueEnd = jsonValueEnd(responseText, offset);

    if (key === "transaction_id") {
      if (found) throw new Error("ATK response contains duplicate transaction_id fields.");
      found = true;
      const raw = responseText.slice(offset, valueEnd);
      if (raw.startsWith('"')) {
        const value = JSON.parse(raw) as unknown;
        transactionId = typeof value === "string" && isUint64String(value) ? value : null;
      } else {
        transactionId = /^[1-9][0-9]{0,19}$/.test(raw) && isUint64String(raw) ? raw : null;
      }
    }

    offset = skipJsonWhitespace(responseText, valueEnd);
    if (responseText[offset] === ",") {
      offset += 1;
      continue;
    }
    if (responseText[offset] === "}") break;
    throw new Error("ATK response JSON is malformed.");
  }
  return transactionId;
}
