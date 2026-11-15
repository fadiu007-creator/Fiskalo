import { decryptBrowserFiscalData, encryptBrowserFiscalData } from "../atk/browser-key-vault";
import type { EncryptedBrowserPayload } from "../atk/local-storage-crypto";

const DB_NAME = "fiskalo-fiscal-outbox";
const STORE_NAME = "signed-documents";
const OUTAGE_STORE_NAME = "connectivity-outages";
const OUTBOX_ENCRYPTION_SCOPE = "basic-fiscal-outbox";
const OUTAGE_ENCRYPTION_SCOPE = "basic-pos-connectivity-outage";

export type BrowserFiscalOutboxItem = {
  idempotencyKey: string;
  businessId: string;
  saleId: string;
  posRecordId: string;
  couponId: number;
  documentType: 1 | 2 | 3;
  originalCouponId?: number;
  originalTransactionId?: string;
  detailsBase64: string;
  signatureBase64: string;
  certificatePem: string;
  citizenPayloadBase64: string;
  citizenSignatureBase64: string;
  citizenQrPayload: string;
  nuiKf: string;
  verificationNo: string;
  dailyNumber: number;
  qrSvg: string;
  issuedAtUtc: string;
  offlineIssuedAtUtc: string | null;
  recoveryDeadlineUtc: string;
  state: "prepared" | "accepted" | "queued" | "cloud_queued" | "needs_reconciliation" | "rejected";
  transactionId: string | null;
  lastError: string | null;
};

type EncryptedRecord = {
  revision: number;
  encrypted: EncryptedBrowserPayload;
};
type EncryptedOutboxRecord = EncryptedRecord & { idempotencyKey: string };
type EncryptedOutageRecord = EncryptedRecord & { id: string };

export type PosConnectivityOutage = {
  id: string;
  businessId: string;
  posRecordId: string;
  startedAt: string;
};

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !globalThis.indexedDB) {
    throw new Error("This browser does not support a durable offline fiscal outbox.");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "idempotencyKey" });
      }
      if (!request.result.objectStoreNames.contains(OUTAGE_STORE_NAME)) {
        request.result.createObjectStore(OUTAGE_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the fiscal outbox."));
  });
}

function strictTransaction(db: IDBDatabase, storeName: string): IDBTransaction {
  try {
    return db.transaction(storeName, "readwrite", { durability: "strict" });
  } catch {
    // Safari and older embedded browsers may not implement IDB durability options.
    return db.transaction(storeName, "readwrite");
  }
}

function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<EncryptedRecord>;
  return Number.isInteger(record.revision) && !!record.encrypted && record.encrypted.version === 1;
}

async function readOutboxRecord(idempotencyKey: string): Promise<unknown | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(idempotencyKey);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("Could not read the fiscal outbox record."));
    });
  } finally { db.close(); }
}

async function writeOutboxRecordIfRevision(
  idempotencyKey: string,
  expectedRevision: number,
  encrypted: EncryptedBrowserPayload,
): Promise<boolean> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = strictTransaction(db, STORE_NAME);
      const store = tx.objectStore(STORE_NAME);
      let conflict = false;
      let missing = false;
      const request = store.get(idempotencyKey);
      request.onsuccess = () => {
        const current = request.result as (EncryptedOutboxRecord | BrowserFiscalOutboxItem) | undefined;
        if (!current) { missing = true; tx.abort(); return; }
        const revision = isEncryptedRecord(current) ? current.revision : 0;
        if (revision !== expectedRevision) { conflict = true; tx.abort(); return; }
        store.put({ idempotencyKey, revision: expectedRevision + 1, encrypted } satisfies EncryptedOutboxRecord);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read the fiscal outbox record."));
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => {
        if (conflict) resolve(false);
        else reject(tx.error ?? new Error(missing ? "Fiscal outbox document was not found." : "Fiscal outbox update was aborted."));
      };
      tx.onerror = () => {
        if (!conflict && !missing) reject(tx.error ?? new Error("Could not update the fiscal outbox."));
      };
    });
  } finally { db.close(); }
}

async function addOutboxRecord(item: BrowserFiscalOutboxItem, encrypted: EncryptedBrowserPayload): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
      tx.objectStore(STORE_NAME).add({
        idempotencyKey: item.idempotencyKey, revision: 1, encrypted,
      } satisfies EncryptedOutboxRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not persist the encrypted fiscal document."));
      tx.onabort = () => reject(tx.error ?? new Error("Encrypted fiscal outbox write was aborted."));
    });
  } finally { db.close(); }
}

async function decodeOutboxRecord(raw: unknown): Promise<BrowserFiscalOutboxItem> {
  if (isEncryptedRecord(raw)) {
    return decryptBrowserFiscalData<BrowserFiscalOutboxItem>(OUTBOX_ENCRYPTION_SCOPE, raw.encrypted);
  }
  // One-time migration for older browser profiles that stored plaintext outbox rows.
  const legacy = raw as BrowserFiscalOutboxItem;
  if (!legacy || typeof legacy.idempotencyKey !== "string" || typeof legacy.businessId !== "string") {
    throw new Error("Unrecognized local fiscal outbox record. Do not clear browser data; contact Fiskalo support.");
  }
  const encrypted = await encryptBrowserFiscalData(OUTBOX_ENCRYPTION_SCOPE, legacy);
  await writeOutboxRecordIfRevision(legacy.idempotencyKey, 0, encrypted).catch(() => false);
  return legacy;
}

export async function saveFiscalOutboxItem(item: BrowserFiscalOutboxItem): Promise<void> {
  const existing = await readOutboxRecord(item.idempotencyKey);
  if (existing) {
    const current = await decodeOutboxRecord(existing);
    if (current.detailsBase64 !== item.detailsBase64 || current.signatureBase64 !== item.signatureBase64) {
      throw new Error("Fiscal outbox idempotency key is already bound to a different signed coupon.");
    }
    return;
  }
  const encrypted = await encryptBrowserFiscalData(OUTBOX_ENCRYPTION_SCOPE, item);
  try {
    await addOutboxRecord(item, encrypted);
  } catch (error) {
    const raced = await readOutboxRecord(item.idempotencyKey);
    if (!raced) throw error;
    const current = await decodeOutboxRecord(raced);
    if (current.detailsBase64 !== item.detailsBase64 || current.signatureBase64 !== item.signatureBase64) {
      throw new Error("Fiscal outbox idempotency key is already bound to a different signed coupon.");
    }
  }
}

export async function listFiscalOutboxItems(businessId?: string): Promise<BrowserFiscalOutboxItem[]> {
  const db = await openDb();
  let rawRecords: unknown[];
  try {
    rawRecords = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as unknown[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read the fiscal outbox."));
    });
  } finally { db.close(); }
  const all = await Promise.all(rawRecords.map(decodeOutboxRecord));
  return businessId ? all.filter(item => item.businessId === businessId) : all;
}

export async function updateFiscalOutboxItem(
  idempotencyKey: string,
  patch: Partial<Pick<BrowserFiscalOutboxItem, "state" | "transactionId" | "lastError" | "qrSvg" | "offlineIssuedAtUtc" | "recoveryDeadlineUtc">>,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = await readOutboxRecord(idempotencyKey);
    if (!raw) throw new Error("Fiscal outbox document was not found.");
    const current = await decodeOutboxRecord(raw);
    const revision = isEncryptedRecord(raw) ? raw.revision : 0;
    const encrypted = await encryptBrowserFiscalData(OUTBOX_ENCRYPTION_SCOPE, { ...current, ...patch });
    if (await writeOutboxRecordIfRevision(idempotencyKey, revision, encrypted)) return;
  }
  throw new Error("Fiscal outbox changed repeatedly; retry the update.");
}

/** Preserve the first observed connectivity-loss time until the outage is recovered. */
export function resolvePosOutageStart(existingStart: string | null | undefined, detectedAt: string): string {
  if (!Number.isFinite(Date.parse(detectedAt))) throw new Error("Invalid POS connectivity outage timestamp.");
  return existingStart && Number.isFinite(Date.parse(existingStart)) ? existingStart : detectedAt;
}

/** The 48-hour recovery deadline is measured from the first observed outage time. */
export function outageRecoveryDeadline(startedAt: string): string {
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid POS connectivity outage timestamp.");
  return new Date(timestamp + 48 * 60 * 60 * 1000).toISOString();
}

async function outageKey(businessId: string, posRecordId: string): Promise<string> {
  if (!businessId || !posRecordId) throw new Error("Business and POS are required to track a connectivity outage.");
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser cryptography is required for outage storage.");
  const input = new TextEncoder().encode(businessId + ":" + posRecordId);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
  return "outage-" + Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readOutageRecord(id: string): Promise<unknown | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(OUTAGE_STORE_NAME, "readonly").objectStore(OUTAGE_STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("Could not read the POS connectivity outage."));
    });
  } finally { db.close(); }
}

async function writeOutageRecordIfRevision(
  id: string,
  expectedRevision: number,
  encrypted: EncryptedBrowserPayload,
): Promise<boolean> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = strictTransaction(db, OUTAGE_STORE_NAME);
      const store = tx.objectStore(OUTAGE_STORE_NAME);
      let conflict = false;
      let missing = false;
      const request = store.get(id);
      request.onsuccess = () => {
        const current = request.result as (EncryptedOutageRecord | PosConnectivityOutage) | undefined;
        if (!current) { missing = true; tx.abort(); return; }
        const revision = isEncryptedRecord(current) ? current.revision : 0;
        if (revision !== expectedRevision) { conflict = true; tx.abort(); return; }
        store.put({ id, revision: expectedRevision + 1, encrypted } satisfies EncryptedOutageRecord);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read the POS connectivity outage."));
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => {
        if (conflict) resolve(false);
        else reject(tx.error ?? new Error(missing ? "POS connectivity outage was not found." : "POS outage update was aborted."));
      };
      tx.onerror = () => {
        if (!conflict && !missing) reject(tx.error ?? new Error("Could not update the POS connectivity outage."));
      };
    });
  } finally { db.close(); }
}

export async function getOrStartPosConnectivityOutage(
  businessId: string,
  posRecordId: string,
  detectedAt = new Date().toISOString(),
): Promise<PosConnectivityOutage> {
  if (!Number.isFinite(Date.parse(detectedAt))) throw new Error("Invalid POS connectivity outage timestamp.");
  const id = await outageKey(businessId, posRecordId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = await readOutageRecord(id);
    let existing: PosConnectivityOutage | null = null;
    if (raw) {
      if (isEncryptedRecord(raw)) {
        existing = await decryptBrowserFiscalData<PosConnectivityOutage>(OUTAGE_ENCRYPTION_SCOPE, raw.encrypted);
      } else {
        existing = raw as PosConnectivityOutage;
      }
    }
    const startedAt = resolvePosOutageStart(
      existing && existing.businessId === businessId && existing.posRecordId === posRecordId
        ? existing.startedAt : null,
      detectedAt,
    );
    const result: PosConnectivityOutage = { id, businessId, posRecordId, startedAt };
    if (existing && existing.startedAt === startedAt && isEncryptedRecord(raw)) return existing;
    const encrypted = await encryptBrowserFiscalData(OUTAGE_ENCRYPTION_SCOPE, result);
    if (raw) {
      const revision = isEncryptedRecord(raw) ? raw.revision : 0;
      if (await writeOutageRecordIfRevision(id, revision, encrypted)) return result;
    } else {
      const db = await openDb();
      try {
        const added = await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction(OUTAGE_STORE_NAME, "readwrite", { durability: "strict" });
          tx.objectStore(OUTAGE_STORE_NAME).add({ id, revision: 1, encrypted } satisfies EncryptedOutageRecord);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        });
        if (added) return result;
      } finally { db.close(); }
    }
  }
  throw new Error("Could not persist the encrypted POS connectivity outage.");
}

export async function clearPosConnectivityOutage(businessId: string, posRecordId: string): Promise<void> {
  const id = await outageKey(businessId, posRecordId);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTAGE_STORE_NAME, "readwrite", { durability: "strict" });
      tx.objectStore(OUTAGE_STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear the POS connectivity outage."));
      tx.onabort = () => reject(tx.error ?? new Error("POS connectivity outage clear was aborted."));
    });
  } finally { db.close(); }
}
