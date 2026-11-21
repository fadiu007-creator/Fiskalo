/**
 * Parse a positive integer identifier from a JSON number or a decimal digit string.
 * Reject coercible non-identifiers such as booleans, whitespace, decimals and exponents.
 */
export function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
