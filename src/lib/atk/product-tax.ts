// ATK fiscal VAT classifications. A (exempt) and C (zero-rated) both
// calculate at 0%, but they are legally distinct coupon classifications.
export const ATK_VAT_CLASSIFICATIONS = {
  A: { rate: 0, label: "I liruar nga TVSH" },
  C: { rate: 0, label: "Normë zero" },
  D: { rate: 8, label: "Normë e reduktuar" },
  E: { rate: 18, label: "Normë standarde" },
} as const;

export type AtkVatCode = keyof typeof ATK_VAT_CLASSIFICATIONS;

export function isAtkVatCode(value: string): value is AtkVatCode {
  return Object.prototype.hasOwnProperty.call(ATK_VAT_CLASSIFICATIONS, value);
}

export function getAtkVatRate(code: AtkVatCode): number {
  return ATK_VAT_CLASSIFICATIONS[code].rate;
}

export function isValidAtkVatClassification(code: string, rate: number): boolean {
  return isAtkVatCode(code) && Number.isFinite(rate) && getAtkVatRate(code) === rate;
}
