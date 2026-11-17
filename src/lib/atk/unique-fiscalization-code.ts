/**
 * Validate the taxpayer-issued ATK Unique Fiscalization Code without assuming
 * a format that ATK has not published as a stable public validation contract.
 * The value is an identifier, not an Application ID, POS number or ARBK unit.
 */
export function normalizeUniqueFiscalizationCode(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Kodi Unik për Fiskalizim i lëshuar nga ATK në EDI është i detyrueshëm.");
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Kodi Unik për Fiskalizim përmban karaktere të pavlefshme.");
  }
  if (normalized.length > 128) {
    throw new Error("Kodi Unik për Fiskalizim është shumë i gjatë.");
  }
  return normalized;
}
