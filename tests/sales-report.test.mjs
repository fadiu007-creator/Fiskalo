import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSalesReport,
  buildSalesReportCsv,
  hasPositiveUint64,
  localDateRangeToIso,
  resolveFiscalReportState,
} from "../src/lib/reports/sales-report.ts";

test("summarizes sales, VAT groups, payment methods and Kosovo-local days", () => {
  const sales = [
    {
      id: "sale-1", coupon_id: "10", created_at: "2026-11-11T22:30:00.000Z",
      status: "fiscalized", subtotal: "10.00", vat_total: "2.34", total: "12.34",
      payment_method: "cash",
    },
    {
      id: "sale-2", coupon_id: "11", created_at: "2026-11-12T00:30:00.000Z",
      status: "paid", subtotal: "5.00", vat_total: "0.00", total: "5.00",
      payment_method: "card",
    },
  ];
  const items = [
    { sale_id: "sale-1", quantity: "1", vat_rate: "18", atk_vat_code: "E", line_net: "10.00", line_vat: "2.34", line_total: "12.34" },
    { sale_id: "sale-2", quantity: "1", vat_rate: "0", atk_vat_code: "A", line_net: "5.00", line_vat: "0.00", line_total: "5.00" },
  ];
  const documents = [
    { sale_id: "sale-1", submission_state: "accepted", atk_transaction_id: "123456" },
    { sale_id: "sale-2", submission_state: "accepted", atk_transaction_id: null },
  ];

  const report = buildSalesReport(sales, items, documents);
  assert.equal(report.count, 2);
  assert.equal(report.netCents, 1500);
  assert.equal(report.vatCents, 234);
  assert.equal(report.grossCents, 1734);
  assert.equal(report.averageCents, 867);
  assert.equal(report.acceptedCount, 1);
  assert.equal(report.unconfirmedCount, 1);
  assert.deepEqual(report.payments.map(row => [row.method, row.amountCents]), [
    ["cash", 1234],
    ["card", 500],
  ]);
  assert.deepEqual(report.vatGroups.map(row => [row.code, row.netCents, row.vatCents]), [
    ["A", 500, 0],
    ["E", 1000, 234],
  ]);
  assert.deepEqual(report.days.map(row => row.date), ["2026-11-11", "2026-11-12"]);
});

test("an ATK acceptance requires a positive uint64 transaction ID", () => {
  assert.equal(hasPositiveUint64("1"), true);
  assert.equal(hasPositiveUint64("18446744073709551615"), true);
  assert.equal(hasPositiveUint64("18446744073709551616"), false);
  assert.equal(hasPositiveUint64("9007199254740993"), true);
  assert.equal(hasPositiveUint64(9007199254740993), false);
  assert.equal(hasPositiveUint64("0"), false);
  assert.equal(hasPositiveUint64(""), false);
  assert.equal(resolveFiscalReportState({ sale_id: "x", submission_state: "accepted", atk_transaction_id: "9007199254740993" }), "accepted");
  assert.equal(resolveFiscalReportState({ sale_id: "x", submission_state: "accepted", atk_transaction_id: null }), "unconfirmed");
  assert.equal(resolveFiscalReportState({ sale_id: "x", submission_state: "needs_reconciliation", atk_transaction_id: null }), "needs_reconciliation");
});

test("date filters use an inclusive end date and reject reversed ranges", () => {
  const range = localDateRangeToIso("2026-11-01", "2026-11-02");
  assert.equal(range.from, "2026-11-01T00:00:00.000Z");
  assert.equal(range.to, "2026-11-03T00:00:00.000Z");
  assert.throws(() => localDateRangeToIso("2026-11-03", "2026-11-02"), /para datës së fillimit/);
  assert.throws(() => localDateRangeToIso("2026-02-30", "2026-03-01"), /nuk është e vlefshme/);
});

test("CSV output neutralizes spreadsheet formulas from stored text", () => {
  const csv = buildSalesReportCsv([
    {
      id: "sale-1", coupon_id: "10", created_at: "2026-11-12T00:00:00.000Z",
      status: "=HYPERLINK(\"https://example.invalid\")", subtotal: "1.00",
      vat_total: "0.18", total: "1.18", payment_method: "cash",
    },
  ], [], []);
  assert.match(csv, /'=HYPERLINK/);
  assert.ok(csv.startsWith("\uFEFF"));
});

test("correction documents do not replace the original sale fiscal status", () => {
  const sale = {
    id: "sale-1", coupon_id: "10", created_at: "2026-11-12T00:00:00.000Z",
    status: "fiscalized", subtotal: "1.00", vat_total: "0.18", total: "1.18",
    payment_method: "cash",
  };
  const documents = [
    { sale_id: "sale-1", document_type: 1, submission_state: "accepted", atk_transaction_id: "123" },
    { sale_id: "sale-1", document_type: 2, submission_state: "accepted", atk_transaction_id: "999" },
  ];
  const report = buildSalesReport([sale], [], documents);
  const csv = buildSalesReportCsv([sale], [], documents);
  assert.equal(report.acceptedCount, 1);
  assert.match(csv, /"123"/);
  assert.doesNotMatch(csv, /"999"/);
});


test("reports split tenders by their actual allocations and falls back for legacy sales", () => {
  const sales = [
    {
      id: "split-sale", coupon_id: "20", created_at: "2026-11-12T10:00:00.000Z",
      status: "paid", subtotal: "10.00", vat_total: "2.34", total: "12.34",
      payment_method: "card",
      payment_allocations: [
        { method: "cash", amount_cents: 234 },
        { method: "card", amount_cents: 1000 },
      ],
    },
    {
      id: "legacy-sale", coupon_id: "21", created_at: "2026-11-12T11:00:00.000Z",
      status: "paid", subtotal: "5.00", vat_total: "0.00", total: "5.00",
      payment_method: "cash", payment_allocations: null,
    },
  ];

  const report = buildSalesReport(sales, [], []);
  assert.deepEqual(report.payments.map(row => [row.method, row.count, row.amountCents]), [
    ["card", 1, 1000],
    ["cash", 2, 734],
  ]);

  const csv = buildSalesReportCsv(sales, [], []);
  assert.match(csv, /Kartelë €10\.00 \+ Cash €2\.34/);
  assert.match(csv, /Cash €5\.00/);
});

test("flags inconsistent tender allocations instead of reporting them as the legacy payment method", () => {
  const report = buildSalesReport([{
    id: "sale-1", coupon_id: "30", created_at: "2026-11-12T12:00:00.000Z",
    status: "paid", subtotal: "10.00", vat_total: "0.00", total: "10.00",
    payment_method: "cash", payment_allocations: [{ method: "card", amount_cents: 900 }],
  }], [], []);
  assert.deepEqual(report.payments.map(row => [row.method, row.label, row.amountCents]), [
    ["invalid_allocation", "Ndarje e pavlefshme", 1000],
  ]);
});
