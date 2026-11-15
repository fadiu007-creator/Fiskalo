import assert from "node:assert/strict";
import test from "node:test";
import { OfflineCheckoutJournal, OfflineSaleConflictError, validateNewOfflineSale } from "../src/lib/pos/offline-ledger.ts";
class MemoryStorage {
  records = new Map();
  async get(key) { return this.records.get(key); }
  async insert(record) { if (this.records.has(record.idempotencyKey)) throw new Error("duplicate"); this.records.set(record.idempotencyKey, record); }
  async put(record) { this.records.set(record.idempotencyKey, record); }
  async list() { return [...this.records.values()]; }
}
const sale = (overrides = {}) => ({
  idempotencyKey: "8f57c540-5b38-4e1a-b7e1-9f04c14f3d29", businessId: "business-1",
  posId: "pos-1", operatorId: "operator-1", createdAtUtc: "2026-11-15T20:00:00.000Z",
  paymentMethod: "cash", currency: "EUR", subtotalMinor: 1000, vatTotalMinor: 180, totalMinor: 1180,
  lines: [{ productId: "product-1", description: "Coffee", quantityMilli: 1000,
    unitPriceMinor: 1000, vatRateBasisPoints: 1800, atkUnitCode: "Cope",
    atkCategoryCode: "category-1", atkVatCode: "vat-1", lineNetMinor: 1000,
    lineVatMinor: 180, lineTotalMinor: 1180 }], ...overrides,
});
test("validates immutable offline sale snapshots and integer-cent totals", () => {
  assert.doesNotThrow(() => validateNewOfflineSale(sale()));
  assert.throws(() => validateNewOfflineSale(sale({ totalMinor: 1179 })), /totals do not reconcile/);
  assert.throws(() => validateNewOfflineSale(sale({ lines: [] })), /at least one line/);
});
test("records once and rejects idempotency-key content reuse", async () => {
  const journal = new OfflineCheckoutJournal(new MemoryStorage(), () => new Date("2026-11-15T20:01:00.000Z"));
  const first = await journal.recordSale(sale()), duplicate = await journal.recordSale(sale());
  assert.equal(first.idempotencyKey, duplicate.idempotencyKey);
  await assert.rejects(journal.recordSale(sale({ subtotalMinor: 1001, totalMinor: 1181, lines: [{ ...sale().lines[0], lineNetMinor: 1001, lineTotalMinor: 1181 }] })), OfflineSaleConflictError);
});
test("cloud synchronization and ATK acceptance are independent", async () => {
  const journal = new OfflineCheckoutJournal(new MemoryStorage()), key = sale().idempotencyKey;
  await journal.recordSale(sale()); await journal.markFiscalQueued(key);
  await journal.markFiscalAccepted(key, { status: "accepted", environment: "ATK TEST", transactionId: "987654321" });
  const pending = await journal.listPendingCloudSync();
  assert.equal(pending.length, 1); assert.equal(pending[0].fiscalState, "accepted");
  await journal.markCloudSynced(key, "server-sale-1", 42);
  assert.equal((await journal.listPendingCloudSync()).length, 0);
});
test("uncertain ATK outcome is locked against blind retry", async () => {
  const journal = new OfflineCheckoutJournal(new MemoryStorage()), key = sale().idempotencyKey;
  await journal.recordSale(sale()); await journal.markFiscalQueued(key);
  await journal.markNeedsReconciliation(key, "Timeout after request write");
  await assert.rejects(journal.markFiscalQueued(key), /Reconcile the ATK outcome/);
  assert.equal((await journal.listNeedsReconciliation()).length, 1);
});
test("acceptance requires a positive uint64 ATK TEST transaction ID", async () => {
  const journal = new OfflineCheckoutJournal(new MemoryStorage()), key = sale().idempotencyKey;
  await journal.recordSale(sale()); await journal.markFiscalQueued(key);
  await assert.rejects(journal.markFiscalAccepted(key, {
    status: "accepted", environment: "ATK TEST", transactionId: "0",
  }), /valid accepted ATK TEST/);
});
