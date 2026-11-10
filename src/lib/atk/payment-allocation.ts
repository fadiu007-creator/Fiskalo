export type PaymentMethod = "cash" | "card" | "bank_transfer" | "voucher" | "cheque" | "crypto";
export type AdditionalPaymentMethod = Exclude<PaymentMethod, "cash">;
export type AdditionalPaymentDraft = { method: AdditionalPaymentMethod; amount: string };
export type PaymentAllocation = { method: PaymentMethod; amountCents: number };
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
 * Cash is the remainder. Every other tender is an explicit amount.
 * The resulting array is canonical so retries do not depend on UI row order.
 */
export function buildPaymentAllocations(
  totalCents: number,
  additionalPayments: readonly AdditionalPaymentDraft[],
): PaymentAllocationResult {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    return { valid: false, allocations: [], cashRemainderCents: 0, error: "Vlera totale e pagesës është e pavlefshme." };
  }

  const seen = new Set<AdditionalPaymentMethod>();
  const parsed: Array<{ method: AdditionalPaymentMethod; amountCents: number }> = [];
  for (const payment of additionalPayments) {
    if (!["card", "bank_transfer", "voucher", "cheque", "crypto"].includes(payment.method)) {
      return { valid: false, allocations: [], cashRemainderCents: 0, error: "Zgjidh një mënyrë të vlefshme pagese." };
    }
    if (seen.has(payment.method)) {
      return { valid: false, allocations: [], cashRemainderCents: 0, error: "Çdo mënyrë pagese mund të shtohet vetëm një herë." };
    }
    seen.add(payment.method);
    const amountCents = parseEuroAmountToCents(payment.amount);
    if (amountCents === null) {
      return {
        valid: false,
        allocations: [],
        cashRemainderCents: 0,
        error: "Shumat e pagesës duhet të jenë pozitive ose zero, me maksimum dy shifra dhjetore.",
      };
    }
    if (amountCents > 0) parsed.push({ method: payment.method, amountCents });
  }

  const nonCashCents = parsed.reduce((sum, payment) => sum + payment.amountCents, 0);
  if (nonCashCents > totalCents) {
    return {
      valid: false,
      allocations: [],
      cashRemainderCents: totalCents - nonCashCents,
      error: "Shuma e pagesave të tjera tejkalon totalin e porosisë.",
    };
  }

  const cashRemainderCents = totalCents - nonCashCents;
  const allocations: PaymentAllocation[] = [];
  if (cashRemainderCents > 0 || totalCents === 0) allocations.push({ method: "cash", amountCents: cashRemainderCents });
  parsed.sort((a, b) => a.method.localeCompare(b.method));
  allocations.push(...parsed);
  allocations.sort((a, b) => a.method.localeCompare(b.method));

  return { valid: true, allocations, cashRemainderCents, error: null };
}

export function toAtkPaymentType(method: PaymentMethod): number {
  switch (method) {
    case "cash":
      return 1; // ATK PaymentType.Cash
    case "card":
      return 2; // ATK PaymentType.CreditCard
    case "voucher":
      return 3; // ATK PaymentType.Voucher
    case "cheque":
      return 4; // ATK PaymentType.Cheque
    case "crypto":
      return 5; // ATK PaymentType.CryptoCurrency
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
    case "voucher":
      return "VAUÇER";
    case "cheque":
      return "ÇEK";
    case "crypto":
      return "KRIPTOVALUTË";
    case "bank_transfer":
      return "TRANSFER BANKAR / TJETËR";
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
