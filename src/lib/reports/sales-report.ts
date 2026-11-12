export type ReportSale = {
  id: string;
  coupon_id: number | string;
  created_at: string;
  status: string;
  subtotal: number | string;
  vat_total: number | string;
  total: number | string;
  payment_method: string;
};

export type ReportSaleItem = {
  sale_id: string;
  quantity: number | string;
  vat_rate: number | string;
  atk_vat_code: string;
  line_net: number | string;
  line_vat: number | string;
  line_total: number | string;
};

export type ReportFiscalDocument = {
  sale_id: string;
  submission_state: string;
  atk_transaction_id: number | string | null;
  document_type?: number | string;
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

function toCents(value: number | string | null | undefined): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : 0;
}

export function hasPositiveUint64(value: unknown): boolean {
  const normalized = String(value ?? "").trim();
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
  if (state === "queued" || state === "submitted") return "queued";
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
    case "cash": return "Cash";
    case "card": return "Kartelë";
    case "bank_transfer": return "Transfer bankar";
    case "voucher": return "Kupon";
    case "cheque": return "Çek";
    case "crypto": return "Kriptovalutë";
    default: return "Tjetër";
  }
}

export function buildSalesReport(
  sales: ReportSale[],
  items: ReportSaleItem[],
  documents: ReportFiscalDocument[],
): SalesReport {
  const documentsBySale = new Map(documents.filter(document => document.document_type == null || Number(document.document_type) === 1).map(document => [document.sale_id, document]));
  const payments = new Map<string, { method: string; label: string; count: number; amountCents: number }>();
  const days = new Map<string, { date: string; count: number; grossCents: number }>();
  const vatGroups = new Map<string, { code: string; rate: number; lineCount: number; netCents: number; vatCents: number; grossCents: number }>();

  let netCents = 0;
  let vatCents = 0;
  let grossCents = 0;
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

    const method = sale.payment_method || "other";
    const payment = payments.get(method) ?? {
      method,
      label: paymentMethodLabel(method),
      count: 0,
      amountCents: 0,
    };
    payment.count += 1;
    payment.amountCents += saleGross;
    payments.set(method, payment);

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
    const lineNet = toCents(item.line_net);
    const lineVat = toCents(item.line_vat);
    group.lineCount += 1;
    group.netCents += lineNet;
    group.vatCents += lineVat;
    group.grossCents += toCents(item.line_total);
    vatGroups.set(key, group);
  }

  return {
    count: sales.length,
    netCents,
    vatCents,
    grossCents,
    averageCents: sales.length ? Math.round(grossCents / sales.length) : 0,
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
  for (const item of items) itemCounts.set(item.sale_id, (itemCounts.get(item.sale_id) ?? 0) + 1);
  const documentsBySale = new Map(documents.filter(document => document.document_type == null || Number(document.document_type) === 1).map(document => [document.sale_id, document]));
  const headers = [
    "Coupon ID", "Date", "Payment status", "Payment method", "Net EUR",
    "VAT EUR", "Gross EUR", "ATK status", "ATK transaction ID", "Item lines",
  ];
  const rows = sales.map(sale => {
    const document = documentsBySale.get(sale.id);
    const state = resolveFiscalReportState(document);
    return [
      sale.coupon_id,
      sale.created_at,
      sale.status,
      paymentMethodLabel(sale.payment_method),
      (toCents(sale.subtotal) / 100).toFixed(2),
      (toCents(sale.vat_total) / 100).toFixed(2),
      (toCents(sale.total) / 100).toFixed(2),
      state,
      state === "accepted" ? String(document?.atk_transaction_id ?? "") : "",
      itemCounts.get(sale.id) ?? 0,
    ];
  });
  return "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
}

function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Zgjidh datat në formatin e vlefshëm.");
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) ||
      date.getMonth() !== Number(match[2]) - 1 ||
      date.getDate() !== Number(match[3])) {
    throw new Error("Data e zgjedhur nuk është e vlefshme.");
  }
  return date;
}

export function localDateRangeToIso(startDate: string, endDate: string): { from: string; to: string } {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  if (end.getTime() < start.getTime()) throw new Error("Data e përfundimit nuk mund të jetë para datës së fillimit.");
  const exclusiveEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  return { from: start.toISOString(), to: exclusiveEnd.toISOString() };
}
