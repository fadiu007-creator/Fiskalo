export type PaymentMethod = "cash" | "card" | "bank_transfer";

export type PaymentAllocation = {
  method: PaymentMethod;
  amountCents: number;
};

export type PaymentAllocationResult = {
  valid: boolean;
  allocations: PaymentAllocation[];
  cashRemainderCents: number;
  error: string | null;
};

export function parseEuroAmountToCents(value: string): number | null {
  let normalized = value.trim().replace(",", ".");
  if (normalized === "") return 0;
  if (/^\.\d{1,2}$/.test(normalized)) normalized = "0" + normalized;
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;

  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

/**
 * Cash is the remainder. Card and bank-transfer inputs are explicit amounts.
 * This makes a normal cash sale zero-configuration while supporting split tender.
 */
export function buildPaymentAllocations(
  totalCents: number,
  cardAmount: string,
  bankTransferAmount: string,
): PaymentAllocationResult {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    return { valid: false, allocations: [], cashRemainderCents: 0, error: "Vlera totale e pagesës është e pavlefshme." };
  }

  const cardCents = parseEuroAmountToCents(cardAmount);
  const bankTransferCents = parseEuroAmountToCents(bankTransferAmount);
  if (cardCents === null || bankTransferCents === null) {
    return {
      valid: false,
      allocations: [],
      cashRemainderCents: 0,
      error: "Shumat e kartelës dhe transferit duhet të jenë pozitive ose zero, me maksimum dy shifra dhjetore.",
    };
  }

  if (cardCents + bankTransferCents > totalCents) {
    return {
      valid: false,
      allocations: [],
      cashRemainderCents: totalCents - cardCents - bankTransferCents,
      error: "Shuma e kartelës dhe transferit tejkalon totalin e porosisë.",
    };
  }

  const cashRemainderCents = totalCents - cardCents - bankTransferCents;
  const allocations: PaymentAllocation[] = [];
  if (cashRemainderCents > 0 || totalCents === 0) allocations.push({ method: "cash", amountCents: cashRemainderCents });
  if (cardCents > 0) allocations.push({ method: "card", amountCents: cardCents });
  if (bankTransferCents > 0) allocations.push({ method: "bank_transfer", amountCents: bankTransferCents });

  return { valid: true, allocations, cashRemainderCents, error: null };
}

export function toAtkPaymentType(method: PaymentMethod): number {
  switch (method) {
    case "cash":
      return 1; // ATK PaymentType.Cash
    case "card":
      return 2; // ATK PaymentType.CreditCard
    case "bank_transfer":
      return 6; // ATK PaymentType.Other; the official enum has no bank-transfer member
  }
}

export function paymentMethodLabel(method: string): string {
  switch (method) {
    case "cash":
      return "KESH";
    case "card":
      return "KARTELË";
    case "bank_transfer":
      return "TRANSFER BANKAR";
    default:
      return "TJETËR";
  }
}

export function formatPaymentAllocations(
  allocations: ReadonlyArray<{ method: string; amount_cents: number }> | null | undefined,
): string {
  if (!allocations?.length) return "Ndarja e pagesës nuk është ruajtur";
  return allocations
    .map((allocation) => paymentMethodLabel(allocation.method) + " €" + (Number(allocation.amount_cents) / 100).toFixed(2))
    .join(" + ");
}
