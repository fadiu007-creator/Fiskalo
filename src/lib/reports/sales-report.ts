export type ReportSale = {
  id: string;
  coupon_id: string | number;
  created_at: string;
  status: string;
  subtotal: number | string;
  vat_total: number | string;
  total: number | string;
  payment_method: string;
  payment_allocations?: Array<{ method: string; amount_cents: number | string }> | null;
  item_count?: number | string | null;
};

export type ReportSaleItem = {
  sale_id?: string | null;
  line_count?: number | string;
  vat_rate: number | string;
  atk_vat_code: string;
  line_net: number | string;
  line_vat: number | string;
  line_total: number | string;
};

export type ReportFiscalDocument = {
  sale_id: string;
  submission_state: string;
  atk_transaction_id: string | null;
  document_type?: number | string;
  reference_coupon_id?: string | null;
};

export type FiscalReportState =
  | "accepted"
  | "queued"
  | "rejected"
  | "needs_reconciliation"
  | "unconfirmed";

export type SalesReport = {
  count: number;
  netCents: number;
  vatCents: number;
  grossCents: number;
  averageCents: number;
  correctionCount: number;
  correctionNetCents: number;
  correctionVatCents: number;
  correctionGrossCents: number;
  adjustedNetCents: number;
  adjustedVatCents: number;
  adjustedGrossCents: number;
  acceptedCount: number;
  queuedCount: number;
  rejectedCount: number;
  reconciliationCount: number;
  unconfirmedCount: number;
  payments: Array<{ method: string; label: string; count: number; amountCents: number }>;
  vatGroups: Array<{ code: string; rate: number; lineCount: number; netCents: number; vatCents: number; grossCents: number }>;
  days: Array<{ date: string; count: number; grossCents: number }>;
};

const MAX_UINT64 = BigInt("18446744073709551615");
const SUPPORTED_PAYMENT_METHODS = new Set(["cash", "card", "bank_transfer", "voucher", "cheque", "crypto"]);

function toCents(value: number | string | null | undefined): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : 0;
}

function positiveCount(value: number | string | null | undefined, fallback = 1): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : fallback;
}

export function hasPositiveUint64(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(normalized)) return false;
  try {
    const parsed = BigInt(normalized);
    return parsed > BigInt(0) && parsed <= MAX_UINT64;
  } catch {
    return false;
  }
}

export function resolveFiscalReportState(document: ReportFiscalDocument | undefined): FiscalReportState {
  const state = String(document?.submission_state ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (state === "accepted" && hasPositiveUint64(document?.atk_transaction_id)) return "accepted";
  if (state === "needs_reconciliation" || state === "needsreconciliation") return "needs_reconciliation";
  if (state === "rejected") return "rejected";
  if (state === "queued" || state === "submitted" || state === "submitting" || state === "cloud_queued") return "queued";
  return "unconfirmed";
}

function kosovoDateKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Data e panjohur";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

export function paymentMethodLabel(method: string): string {
  switch (method) {
    case "cash": return "Kesh";
    case "card": return "Kartelë";
    case "bank_transfer": return "Transfer bankar";
    case "voucher": return "Vauçer";
    case "cheque": return "Çek";
    case "crypto": return "Kriptovalutë";
    case "invalid_allocation": return "Ndarje e pavlefshme";
    default: return "Tjetër";
  }
}

type NormalizedPaymentAllocation = { method: string; amountCents: number };

function resolveSalePaymentAllocations(sale: ReportSale, saleGrossCents: number): NormalizedPaymentAllocation[] {
  if (sale.payment_allocations == null) {
    const method = SUPPORTED_PAYMENT_METHODS.has(sale.payment_method) ? sale.payment_method : "invalid_allocation";
    return [{ method, amountCents: saleGrossCents }];
  }

  const allocations = sale.payment_allocations;
  const invalid = [{ method: "invalid_allocation", amountCents: saleGrossCents }];
  if (!Array.isArray(allocations) || allocations.length < 1 || allocations.length > 6) return invalid;

  const seen = new Set<string>();
  const normalized: NormalizedPaymentAllocation[] = [];
  for (const allocation of allocations) {
    const method = String(allocation?.method ?? "");
    const amountCents = Number(allocation?.amount_cents);
    if (!SUPPORTED_PAYMENT_METHODS.has(method) || seen.has(method) ||
        !Number.isSafeInteger(amountCents) || amountCents < 0) return invalid;
    seen.add(method);
    normalized.push({ method, amountCents });
  }

  const allocatedTotal = normalized.reduce((sum, allocation) => sum + allocation.amountCents, 0);
  if (!Number.isSafeInteger(allocatedTotal) || allocatedTotal !== saleGrossCents) return invalid;
  return normalized.sort((a, b) => a.method.localeCompare(b.method));
}

export function formatSalePaymentAllocations(sale: ReportSale): string {
  return resolveSalePaymentAllocations(sale, toCents(sale.total))
    .map(allocation => paymentMethodLabel(allocation.method) + " €" + (allocation.amountCents / 100).toFixed(2))
    .join(" + ");
}

function documentPriority(document: ReportFiscalDocument): number {
  switch (resolveFiscalReportState(document)) {
    case "accepted": return 5;
    case "needs_reconciliation": return 4;
    case "queued": return 3;
    case "rejected": return 2;
    default: return 1;
  }
}

function indexDocuments(
  documents: ReportFiscalDocument[],
  predicate: (document: ReportFiscalDocument) => boolean,
): Map<string, ReportFiscalDocument> {
  const result = new Map<string, ReportFiscalDocument>();
  for (const document of documents) {
    if (!predicate(document)) continue;
    const current = result.get(document.sale_id);
    if (!current || documentPriority(document) > documentPriority(current)) {
      result.set(document.sale_id, document);
    }
  }
  return result;
}

export function getOriginalSaleDocumentsBySale(documents: ReportFiscalDocument[]): Map<string, ReportFiscalDocument> {
  return indexDocuments(documents, document =>
    document.document_type == null || Number(document.document_type) === 1
  );
}

export function getCorrectionDocumentsBySale(
  documents: ReportFiscalDocument[],
  sales?: ReportSale[],
): Map<string, ReportFiscalDocument> {
  const couponBySale = sales ? new Map(sales.map(sale => [sale.id, String(sale.coupon_id)])) : null;
  return indexDocuments(documents, document => {
    if (Number(document.document_type) !== 2 && Number(document.document_type) !== 3) return false;
    if (!couponBySale) return true;
    const originalCoupon = couponBySale.get(document.sale_id);
    return originalCoupon != null && document.reference_coupon_id != null &&
      String(document.reference_coupon_id) === originalCoupon;
  });
}

export function buildSalesReport(
  sales: ReportSale[],
  items: ReportSaleItem[],
  documents: ReportFiscalDocument[],
): SalesReport {
  const documentsBySale = getOriginalSaleDocumentsBySale(documents);
  const correctionsBySale = getCorrectionDocumentsBySale(documents, sales);
  const payments = new Map<string, { method: string; label: string; count: number; amountCents: number }>();
  const days = new Map<string, { date: string; count: number; grossCents: number }>();
  const vatGroups = new Map<string, { code: string; rate: number; lineCount: number; netCents: number; vatCents: number; grossCents: number }>();

  let netCents = 0;
  let vatCents = 0;
  let grossCents = 0;
  let correctionCount = 0;
  let correctionNetCents = 0;
  let correctionVatCents = 0;
  let correctionGrossCents = 0;
  let acceptedCount = 0;
  let queuedCount = 0;
  let rejectedCount = 0;
  let reconciliationCount = 0;
  let unconfirmedCount = 0;

  for (const sale of sales) {
    const saleNet = toCents(sale.subtotal);
    const saleVat = toCents(sale.vat_total);
    const saleGross = toCents(sale.total);
    netCents += saleNet;
    vatCents += saleVat;
    grossCents += saleGross;

    const correction = correctionsBySale.get(sale.id);
    if (correction && resolveFiscalReportState(correction) === "accepted") {
      correctionCount += 1;
      correctionNetCents += saleNet;
      correctionVatCents += saleVat;
      correctionGrossCents += saleGross;
    }

    for (const allocation of resolveSalePaymentAllocations(sale, saleGross)) {
      const payment = payments.get(allocation.method) ?? {
        method: allocation.method,
        label: paymentMethodLabel(allocation.method),
        count: 0,
        amountCents: 0,
      };
      payment.count += 1;
      payment.amountCents += allocation.amountCents;
      payments.set(allocation.method, payment);
    }

    const date = kosovoDateKey(sale.created_at);
    const day = days.get(date) ?? { date, count: 0, grossCents: 0 };
    day.count += 1;
    day.grossCents += saleGross;
    days.set(date, day);

    switch (resolveFiscalReportState(documentsBySale.get(sale.id))) {
      case "accepted": acceptedCount += 1; break;
      case "queued": queuedCount += 1; break;
      case "rejected": rejectedCount += 1; break;
      case "needs_reconciliation": reconciliationCount += 1; break;
      default: unconfirmedCount += 1; break;
    }
  }

  for (const item of items) {
    const code = String(item.atk_vat_code || "?").trim().toUpperCase() || "?";
    const rate = Number(item.vat_rate);
    const safeRate = Number.isFinite(rate) ? rate : 0;
    const key = code + ":" + safeRate;
    const group = vatGroups.get(key) ?? {
      code,
      rate: safeRate,
      lineCount: 0,
      netCents: 0,
      vatCents: 0,
      grossCents: 0,
    };
    group.lineCount += positiveCount(item.line_count);
    group.netCents += toCents(item.line_net);
    group.vatCents += toCents(item.line_vat);
    group.grossCents += toCents(item.line_total);
    vatGroups.set(key, group);
  }

  return {
    count: sales.length,
    netCents,
    vatCents,
    grossCents,
    averageCents: sales.length ? Math.round(grossCents / sales.length) : 0,
    correctionCount,
    correctionNetCents,
    correctionVatCents,
    correctionGrossCents,
    adjustedNetCents: netCents - correctionNetCents,
    adjustedVatCents: vatCents - correctionVatCents,
    adjustedGrossCents: grossCents - correctionGrossCents,
    acceptedCount,
    queuedCount,
    rejectedCount,
    reconciliationCount,
    unconfirmedCount,
    payments: Array.from(payments.values()).sort((a, b) => b.amountCents - a.amountCents),
    vatGroups: Array.from(vatGroups.values()).sort((a, b) => a.code.localeCompare(b.code)),
    days: Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function buildSalesReportCsv(
  sales: ReportSale[],
  items: ReportSaleItem[],
  documents: ReportFiscalDocument[],
): string {
  const itemCounts = new Map<string, number>();
  for (const item of items) {
    if (!item.sale_id) continue;
    itemCounts.set(item.sale_id, (itemCounts.get(item.sale_id) ?? 0) + positiveCount(item.line_count));
  }
  const documentsBySale = getOriginalSaleDocumentsBySale(documents);
  const correctionsBySale = getCorrectionDocumentsBySale(documents, sales);
  const headers = [
    "Coupon ID", "Date", "Payment status", "Payment allocations", "Original net EUR",
    "Original VAT EUR", "Original gross EUR", "ATK status", "ATK transaction ID", "Item lines",
    "Correction type", "Correction status", "Correction transaction ID",
    "Adjusted net EUR", "Adjusted VAT EUR", "Adjusted gross EUR",
  ];
  const rows = sales.map(sale => {
    const document = documentsBySale.get(sale.id);
    const correction = correctionsBySale.get(sale.id);
    const state = resolveFiscalReportState(document);
    const correctionState = correction ? resolveFiscalReportState(correction) : "unconfirmed";
    const correctionAccepted = correctionState === "accepted";
    const itemCount = sale.item_count == null
      ? itemCounts.get(sale.id) ?? 0
      : positiveCount(sale.item_count, 0);
    const net = toCents(sale.subtotal);
    const vat = toCents(sale.vat_total);
    const gross = toCents(sale.total);
    return [
      sale.coupon_id,
      sale.created_at,
      sale.status,
      formatSalePaymentAllocations(sale),
      (net / 100).toFixed(2),
      (vat / 100).toFixed(2),
      (gross / 100).toFixed(2),
      state,
      state === "accepted" ? String(document?.atk_transaction_id ?? "") : "",
      itemCount,
      correction ? (Number(correction.document_type) === 2 ? "cancellation" : "full return") : "",
      correction ? correctionState : "",
      correctionAccepted ? String(correction?.atk_transaction_id ?? "") : "",
      ((correctionAccepted ? 0 : net) / 100).toFixed(2),
      ((correctionAccepted ? 0 : vat) / 100).toFixed(2),
      ((correctionAccepted ? 0 : gross) / 100).toFixed(2),
    ];
  });
  return "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
}

type CalendarDate = { year: number; month: number; day: number };

function parseLocalDate(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Zgjidh datat në formatin e vlefshëm.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Data e zgjedhur nuk është e vlefshme.");
  }
  return { year, month, day };
}

function kosovoMidnightUtc(value: CalendarDate): Date {
  const target = Date.UTC(value.year, value.month - 1, value.day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Belgrade",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
    const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const adjustment = target - localAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(guess);
}

function nextCalendarDate(value: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function localDateRangeToIso(startDate: string, endDate: string): { from: string; to: string } {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  const startKey = start.year * 10000 + start.month * 100 + start.day;
  const endKey = end.year * 10000 + end.month * 100 + end.day;
  if (endKey < startKey) throw new Error("Data e përfundimit nuk mund të jetë para datës së fillimit.");
  return {
    from: kosovoMidnightUtc(start).toISOString(),
    to: kosovoMidnightUtc(nextCalendarDate(end)).toISOString(),
  };
}
