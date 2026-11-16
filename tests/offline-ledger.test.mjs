import assert from "node:assert/strict";
import test from "node:test";
import { OfflineCheckoutJournal, OfflineSaleConflictError, validateNewOfflineSale } from "../src/lib/pos/offline-ledger.ts";
class MemoryStorage {
  records = new Map();
  async get(key) { return this.records.get(key); }
  async insert(record) { if (this.records.has(record.idempotencyKey)) throw new Error("duplicate"); this.records.set(record.idempotencyKey, record); }
  async update(key, updater) {
    const current = this.records.get(key);
    if (!current) throw new Error("Offline sale was not found.");
    const next = updater(current);
    this.records.set(key, next);
    return next;
  }
  async list() { return [...this.records.values()]; }
}
const sale = (overrides = {}) => ({
  idempotencyKey: "8f57c540-5b38-4e1a-b7e1-9f04c14f3d29", businessId: "business-1",
  posId: "pos-1", operatorId: "operator-1", createdAtUtc: "2026-11-15T20:00:00.000Z",
  paymentMethod: "cash", currency: "EUR", subtotalMinor: 1000, vatTotalMinor: 180, totalMinor: 1180,
  lines: [{ productId: "product-1", description: "Coffee", quantityMilli: 1000,
    unitPriceMinor: 1000, vatRateBasisPoints: 1800, atkUnitCode: "CP",
    atkCategoryCode: "category-1", atkVatCode: "E", lineNetMinor: 1000,
    lineVatMinor: 180, lineTotalMinor: 1180 }], ...overrides,
});
test("validates immutable offline sale snapshots and integer-cent totals", () => {
  assert.doesNotThrow(() => validateNewOfflineSale(sale()));
  assert.throws(() => validateNewOfflineSale(sale({ totalMinor: 1179 })), /totals do not reconcile/);
  assert.throws(() => validateNewOfflineSale(sale({ lines: [] })), /at least one line/);
  assert.throws(() => validateNewOfflineSale(sale({ lines: [{ ...sale().lines[0], atkUnitCode: "Cope" }] })), /measurement-unit code/);
  assert.throws(() => validateNewOfflineSale(sale({ lines: [{ ...sale().lines[0], atkVatCode: "D" }] })), /VAT code\/rate/);
  assert.throws(() => validateNewOfflineSale(sale({ lines: [{ ...sale().lines[0], atkVatCode: "X" }] })), /VAT code\/rate/);
});
test("records once and rejects idempotency-key content reuse", async () => {
  const journal = new OfflineCheckoutJournal(new MemoryStorage(), () => new Date("2026-11-15T20:01:00.000Z"));
  const first = await journal.recordSale(sale()), duplicate = await journal.recordSale(sale());
  assert.equal(first.idempotencyKey, duplicate.idempotencyKey);
  await assert.rejects(journal.recordSale(sale({ subtotalMinor: 1001, totalMinor: 1181, lines: [{ ...sale().lines[0], lineNetMinor: 1001, lineTotalMinor: 1181 }] })), OfflineSaleConflictError);
});
test("cloud synchronization and ATK acceptance are independent", async () => {
  const storage = new MemoryStorage();
  const journal = new OfflineCheckoutJournal(storage), key = sale().idempotencyKey;
  await journal.recordSale(sale()); await journal.markFiscalQueued(key);
  await journal.markFiscalAccepted(key, { status: "accepted", environment: "ATK TEST", transactionId: "987654321" });
  const pending = await journal.listPendingCloudSync();
  assert.equal(pending.length, 1); assert.equal(pending[0].fiscalState, "accepted");
  await journal.markCloudSynced(key, "server-sale-1", "9007199254740993");
  assert.equal((await journal.listPendingCloudSync()).length, 0);
  assert.equal((await storage.get(key)).couponId, "9007199254740993");
  await assert.rejects(journal.markCloudSynced(key, "server-sale-1", "18446744073709551616"), /uint64 coupon ID/);
});
test("concurrent cloud and fiscal transitions preserve both journal states", async () => {
  const storage = new MemoryStorage();
  const journal = new OfflineCheckoutJournal(storage), key = sale().idempotencyKey;
  await journal.recordSale(sale());
  await Promise.all([
    journal.markCloudSynced(key, "server-sale-2", "9007199254740993"),
    journal.markFiscalQueued(key),
  ]);
  const saved = await storage.get(key);
  assert.equal(saved.cloudSyncState, "synced");
  assert.equal(saved.fiscalState, "queued");
  assert.equal(saved.couponId, "9007199254740993");
});
test("uncertain ATK outcome is locked against blind retry", async () => {
  const journal = new OfflineCheckoutJournal(new MemoryStorage()), key = sale().idempotencyKey;
  await journal.recordSale(sale()); await journal.markFiscalQueued(key);
  await journal.markNeedsReconciliation(key, "Timeout after request write");
  await assert.rejects(journal.markFiscalQueued(key), /Reconcile the ATK outcome/);
  assert.equal((await journal.listNeedsReconciliation()).length, 1);
  await journal.markFiscalAccepted(key,{status:"accepted",environment:"ATK TEST",transactionId:"123456"});
  assert.equal((await journal.listNeedsReconciliation()).length, 0);
});
test("acceptance requires a positive uint64 ATK TEST transaction ID", async () => {
  const journal = new OfflineCheckoutJournal(new MemoryStorage()), key = sale().idempotencyKey;
  await journal.recordSale(sale()); await journal.markFiscalQueued(key);
  await assert.rejects(journal.markFiscalAccepted(key, {
    status: "accepted", environment: "ATK TEST", transactionId: "0",
  }), /valid accepted ATK TEST/);
});

test("persists one immutable signed offline receipt beside the sale snapshot", async () => {
  const storage = new MemoryStorage();
  const journal = new OfflineCheckoutJournal(storage), key = sale().idempotencyKey;
  await journal.recordSale(sale({
    fiscalIdentity: {
      businessNui: 123456789, branchId: 1, posNumber: 2, applicationId: 3,
      location: "Ferizaj", operatorName: "Operator", operatorIdentifier: "ID-1",
      posLabel: "Arka 1", unitNumber: "1234567", businessDate: "2026-11-15",
    },
  }));
  const receipt = {
    couponId: 9001, dailyNumber: 12, fiscalIdempotencyKey: "123456789:1:2:9001",
    nuiKf: "0123456789ABCDEF", posPayloadBase64: "cG9z", posSignatureBase64: "c2ln",
    citizenPayloadBase64: "Y2l0aXplbg==", citizenSignatureBase64: "c2ln",
    qrSvgBase64: "PHN2Zz48L3N2Zz4=", offlineIssuedAtUtc: "2026-11-15T20:00:00.000Z",
    recoveryDeadlineUtc: "2026-11-17T20:00:00.000Z", status: "queued",
  };
  await journal.markFiscalQueued(key);
  await journal.attachFiscalReceipt(key, receipt);
  const saved = await storage.get(key);
  assert.equal(saved.fiscalReceipt.couponId, 9001);
  assert.equal(saved.fiscalIdentity.businessDate, "2026-11-15");
  await journal.recordSale(sale({ fiscalIdentity: saved.fiscalIdentity }));
  await assert.rejects(journal.attachFiscalReceipt(key, { ...receipt, couponId: 9002 }), /cannot be rebound/);
});
