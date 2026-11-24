const DEFINITIVE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422]);

export type AtkHttpFailureClassification = "rejected" | "ambiguous";

/**
 * Classifies a non-success ATK HTTP response without assuming that every 4xx
 * proves the coupon was not committed. This allowlist intentionally matches
 * the Windows POS Agent's definitive-rejection policy.
 *
 * Unknown statuses remain ambiguous and require reconciliation; they must not
 * trigger an automatic resubmission of the same fiscal document.
 */
export function classifyAtkHttpFailure(status: number): AtkHttpFailureClassification {
  if (!Number.isInteger(status) || status < 300 || status > 599) {
    throw new RangeError("ATK HTTP failure status must be an integer between 300 and 599.");
  }

  return DEFINITIVE_REJECTION_STATUSES.has(status) ? "rejected" : "ambiguous";
}
