import { isValidAtkVatClassification } from "../atk/product-tax.ts";
import { isAtkUnitCode } from "../atk/product-units.ts";

export type OfflinePaymentMethod = "cash" | "card" | "bank_transfer";
export type OfflineSaleLine = {
  productId: string; description: string; quantityMilli: number; unitPriceMinor: number;
  vatRateBasisPoints: number; atkUnitCode: string; atkCategoryCode: string; atkVatCode: string;
  lineNetMinor: number; lineVatMinor: number; lineTotalMinor: number;
};
export type OfflineSaleRecord = {
  idempotencyKey: string; businessId: string; posId: string; operatorId: string;
  createdAtUtc: string; updatedAtUtc: string; paymentMethod: OfflinePaymentMethod; currency: "EUR";
  subtotalMinor: number; vatTotalMinor: number; totalMinor: number; lines: OfflineSaleLine[];
  cloudSyncState: "pending" | "synced" | "conflict";
  fiscalState: "not_prepared" | "queued" | "accepted" | "rejected" | "needs_reconciliation";
  serverSaleId?: string; couponId?: string; atkTransactionId?: string;
  atkEnvironment?: "ATK TEST"; lastError?: string;
};
export type NewOfflineSale = Omit<OfflineSaleRecord,
  "updatedAtUtc" | "cloudSyncState" | "fiscalState" | "serverSaleId" |
  "couponId" | "atkTransactionId" | "atkEnvironment" | "lastError">;
export interface OfflineSaleStorage {
  get(key: string): Promise<OfflineSaleRecord | undefined>;
  insert(record: OfflineSaleRecord): Promise<void>;
  update(key: string, updater: (record: OfflineSaleRecord) => OfflineSaleRecord): Promise<OfflineSaleRecord>;
  list(): Promise<OfflineSaleRecord[]>;
}
export class OfflineSaleConflictError extends Error {
  constructor(message: string) { super(message); this.name = "OfflineSaleConflictError"; }
}
const nonEmpty = (v: string) => typeof v === "string" && v.trim().length > 0;
const minor = (v: number) => Number.isSafeInteger(v) && v >= 0;
const uint64Id = (value: string) => {
  if (!/^\d+$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= 18446744073709551615n;
  } catch {
    return false;
  }
};
export function validateNewOfflineSale(input: NewOfflineSale): void {
  if (!nonEmpty(input.idempotencyKey) || !nonEmpty(input.businessId) ||
      !nonEmpty(input.posId) || !nonEmpty(input.operatorId))
    throw new Error("Offline sale identity is incomplete.");
  if (!Number.isFinite(Date.parse(input.createdAtUtc)) || !input.createdAtUtc.endsWith("Z"))
    throw new Error("Offline sale timestamp must be a UTC ISO timestamp.");
  if (!["cash", "card", "bank_transfer"].includes(input.paymentMethod))
    throw new Error("Unsupported offline payment method.");
  if (input.currency !== "EUR" || !Array.isArray(input.lines) || input.lines.length === 0)
    throw new Error("Offline sale requires EUR currency and at least one line.");
  if (![input.subtotalMinor, input.vatTotalMinor, input.totalMinor].every(minor) ||
      input.subtotalMinor + input.vatTotalMinor !== input.totalMinor)
    throw new Error("Sale totals do not reconcile.");
  let net = 0, vat = 0, gross = 0;
  for (const line of input.lines) {
    if (!nonEmpty(line.productId) || !nonEmpty(line.description) ||
        !nonEmpty(line.atkCategoryCode) || line.atkCategoryCode.length > 128 ||
        /[\u0000-\u001f]/.test(line.atkCategoryCode))
      throw new Error("Every offline sale line requires a product snapshot and ATK category code.");
    if (!isAtkUnitCode(line.atkUnitCode))
      throw new Error("Offline sale contains an unrecognized ATK measurement-unit code.");
    if (!isValidAtkVatClassification(line.atkVatCode, line.vatRateBasisPoints / 100))
      throw new Error("Offline sale contains an invalid ATK VAT code/rate combination.");
    if (!Number.isSafeInteger(line.quantityMilli) || line.quantityMilli <= 0 ||
        !minor(line.unitPriceMinor) || !Number.isSafeInteger(line.vatRateBasisPoints) ||
        line.vatRateBasisPoints < 0 || !minor(line.lineNetMinor) || !minor(line.lineVatMinor) ||
        !minor(line.lineTotalMinor) || line.lineNetMinor + line.lineVatMinor !== line.lineTotalMinor)
      throw new Error("Offline sale line quantity, VAT or money values are invalid.");
    net += line.lineNetMinor; vat += line.lineVatMinor; gross += line.lineTotalMinor;
  }
  if (net !== input.subtotalMinor || vat !== input.vatTotalMinor || gross !== input.totalMinor)
    throw new Error("Offline sale lines do not reconcile with the sale totals.");
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export class OfflineCheckoutJournal {
  private readonly storage: OfflineSaleStorage;
  private readonly now: () => Date;
  constructor(storage: OfflineSaleStorage, now = () => new Date()) {
    this.storage = storage;
    this.now = now;
  }
  async recordSale(input: NewOfflineSale): Promise<OfflineSaleRecord> {
    validateNewOfflineSale(input);
    const record: OfflineSaleRecord = { ...structuredClone(input), updatedAtUtc: this.now().toISOString(),
      cloudSyncState: "pending", fiscalState: "not_prepared" };
    const existing = await this.storage.get(record.idempotencyKey);
    if (existing) return this.assertSameSale(existing, record);
    try { await this.storage.insert(record); return record; }
    catch (error) {
      const raced = await this.storage.get(record.idempotencyKey);
      if (raced) return this.assertSameSale(raced, record);
      throw error;
    }
  }
  async markCloudSynced(key: string, serverSaleId: string, couponId: string): Promise<OfflineSaleRecord> {
    if (!nonEmpty(serverSaleId) || !uint64Id(couponId))
      throw new Error("A server sale ID and positive uint64 coupon ID are required.");
    return this.mutate(key, r => {
      if (r.cloudSyncState === "conflict") throw new OfflineSaleConflictError("A conflicted sale cannot be marked synchronized.");
      if (r.serverSaleId && (r.serverSaleId !== serverSaleId || r.couponId !== couponId))
        throw new OfflineSaleConflictError("A synchronized sale cannot be rebound to another server sale or coupon.");
      return { ...r, cloudSyncState: "synced", serverSaleId, couponId, lastError: undefined };
    });
  }
  async markFiscalQueued(key: string): Promise<OfflineSaleRecord> {
    return this.mutate(key, r => {
      if (r.fiscalState === "accepted" || r.fiscalState === "rejected")
        throw new OfflineSaleConflictError("A final fiscal document cannot be queued again.");
      if (r.fiscalState === "needs_reconciliation")
        throw new OfflineSaleConflictError("Reconcile the ATK outcome before another submission.");
      return { ...r, fiscalState: "queued", lastError: undefined };
    });
  }
  async markFiscalAccepted(key: string, evidence: {
    transactionId: string; environment: "ATK TEST"; status: "accepted";
  }): Promise<OfflineSaleRecord> {
    if (evidence.status !== "accepted" || evidence.environment !== "ATK TEST" ||
        !/^\d+$/.test(evidence.transactionId) || BigInt(evidence.transactionId) <= BigInt("0") ||
        BigInt(evidence.transactionId) > BigInt("18446744073709551615"))
      throw new Error("A valid accepted ATK TEST transaction response is required.");
    return this.mutate(key, r => {
      if (r.fiscalState !== "queued" && r.fiscalState !== "accepted")
        throw new OfflineSaleConflictError("Only a queued fiscal document can be marked accepted.");
      if (r.atkTransactionId && r.atkTransactionId !== evidence.transactionId)
        throw new OfflineSaleConflictError("An accepted ATK transaction ID is immutable.");
      return { ...r, fiscalState: "accepted", atkTransactionId: evidence.transactionId,
        atkEnvironment: evidence.environment, lastError: undefined };
    });
  }
  async markFiscalRejected(key: string, reason: string): Promise<OfflineSaleRecord> {
    return this.mutate(key, r => {
      if (r.fiscalState !== "queued") throw new OfflineSaleConflictError("Only a queued fiscal document can be rejected.");
      return { ...r, fiscalState: "rejected", lastError: reason.slice(0, 500) };
    });
  }
  async markNeedsReconciliation(key: string, reason: string): Promise<OfflineSaleRecord> {
    return this.mutate(key, r => {
      if (r.fiscalState !== "queued" && r.fiscalState !== "needs_reconciliation")
        throw new OfflineSaleConflictError("Only an in-flight or uncertain fiscal document requires reconciliation.");
      return { ...r, fiscalState: "needs_reconciliation", lastError: reason.slice(0, 500) };
    });
  }
  async markCloudConflict(key: string, reason: string): Promise<OfflineSaleRecord> {
    return this.mutate(key, r => ({ ...r, cloudSyncState: "conflict", lastError: reason.slice(0, 500) }));
  }
  async listPendingCloudSync(): Promise<OfflineSaleRecord[]> {
    return (await this.storage.list()).filter(r => r.cloudSyncState === "pending")
      .sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
  }
  async listNeedsReconciliation(): Promise<OfflineSaleRecord[]> {
    return (await this.storage.list()).filter(r => r.fiscalState === "needs_reconciliation")
      .sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
  }
  private assertSameSale(existing: OfflineSaleRecord, candidate: OfflineSaleRecord): OfflineSaleRecord {
    const mutableFields = ["updatedAtUtc", "cloudSyncState", "fiscalState", "serverSaleId",
      "couponId", "atkTransactionId", "atkEnvironment", "lastError"];
    const stable = Object.fromEntries(Object.entries(existing).filter(([key]) => !mutableFields.includes(key)));
    const candidateStable = Object.fromEntries(Object.entries(candidate).filter(([key]) => !mutableFields.includes(key)));
    if (!equal(stable, candidateStable))
      throw new OfflineSaleConflictError("The offline idempotency key already belongs to different sale content.");
    return existing;
  }
  private mutate(key: string, update: (r: OfflineSaleRecord) => OfflineSaleRecord) {
    return this.storage.update(key, current => ({
      ...update(current),
      updatedAtUtc: this.now().toISOString(),
    }));
  }
}
const DB_NAME = "fiskalo-pos-offline";
const DB_VERSION = 1;
const STORE = "sales";
export class IndexedDbOfflineSaleStorage implements OfflineSaleStorage {
  private database?: Promise<IDBDatabase>;
  private readonly factory: IDBFactory;
  constructor(factory: IDBFactory = indexedDB) { this.factory = factory; }
  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: "idempotencyKey" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open offline POS storage."));
      request.onblocked = () => reject(new Error("Offline POS storage upgrade is blocked by another open tab."));
    });
    return this.database;
  }
  async get(key: string): Promise<OfflineSaleRecord | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly"), request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as OfflineSaleRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error("Unable to read offline sale."));
      tx.onabort = () => reject(tx.error ?? new Error("Offline sale read aborted."));
    });
  }
  async insert(record: OfflineSaleRecord): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Unable to persist offline sale."));
      tx.onabort = () => reject(tx.error ?? new Error("Offline sale persistence aborted."));
    });
  }
  async update(key: string, updater: (record: OfflineSaleRecord) => OfflineSaleRecord): Promise<OfflineSaleRecord> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let result: OfflineSaleRecord | undefined;
      let failure: unknown;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = store.get(key);
      request.onsuccess = () => {
        if (!request.result) {
          failure = new Error("Offline sale was not found.");
          try { tx.abort(); } catch { fail(failure); }
          return;
        }
        try {
          result = updater(request.result as OfflineSaleRecord);
          store.put(result);
        } catch (error) {
          failure = error;
          try { tx.abort(); } catch { fail(error); }
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("Unable to read offline sale for update.");
        try { tx.abort(); } catch { fail(failure); }
      };
      tx.oncomplete = () => {
        if (settled) return;
        if (!result) { fail(new Error("Offline sale update completed without a result.")); return; }
        settled = true;
        resolve(result);
      };
      tx.onerror = () => fail(failure ?? tx.error ?? new Error("Offline sale update failed."));
      tx.onabort = () => fail(failure ?? tx.error ?? new Error("Offline sale update aborted."));
    });
  }
  async list(): Promise<OfflineSaleRecord[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly"), request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as OfflineSaleRecord[]);
      request.onerror = () => reject(request.error ?? new Error("Unable to list offline sales."));
      tx.onabort = () => reject(tx.error ?? new Error("Offline sale listing aborted."));
    });
  }
}
