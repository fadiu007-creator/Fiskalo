/**
 * Reuse a previously persisted correction idempotency key for every retry.
 * A new key is created only before the first reservation attempt.
 */
export function getOrCreateCorrectionIdempotencyKey(
  existingKey: string | null,
  createKey: () => string,
): string {
  const existing = existingKey?.trim();
  if (existing) return existing;

  const generated = createKey();
  if (!generated.trim()) {
    throw new Error("Correction idempotency key generator returned an empty value.");
  }
  return generated;
}
