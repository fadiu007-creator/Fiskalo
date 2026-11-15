const DB_NAME = "fiskalo-fiscal-outbox";
const STORE_NAME = "signed-documents";
const OUTAGE_STORE_NAME = "connectivity-outages";

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

export async function saveFiscalOutboxItem(item: BrowserFiscalOutboxItem): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not persist the signed fiscal document."));
      tx.onabort = () => reject(tx.error ?? new Error("Fiscal outbox write was aborted."));
    });
  } finally { db.close(); }
}

export async function listFiscalOutboxItems(businessId?: string): Promise<BrowserFiscalOutboxItem[]> {
  const db = await openDb();
  try {
    const all = await new Promise<BrowserFiscalOutboxItem[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as BrowserFiscalOutboxItem[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read the fiscal outbox."));
    });
    return businessId ? all.filter(item => item.businessId === businessId) : all;
  } finally { db.close(); }
}

export async function updateFiscalOutboxItem(
  idempotencyKey: string,
  patch: Partial<Pick<BrowserFiscalOutboxItem, "state" | "transactionId" | "lastError" | "qrSvg" | "offlineIssuedAtUtc" | "recoveryDeadlineUtc">>,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(idempotencyKey);
      request.onsuccess = () => {
        if (!request.result) { reject(new Error("Fiscal outbox document was not found.")); return; }
        store.put({ ...request.result, ...patch });
      };
      request.onerror = () => reject(request.error ?? new Error("Could not load fiscal outbox document."));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not update fiscal outbox document."));
    });
  } finally { db.close(); }
}


export type PosConnectivityOutage = {
  id: string;
  businessId: string;
  posRecordId: string;
  startedAt: string;
};

/** Use the first observed connectivity-loss time for every coupon in one POS outage. */
export function outageRecoveryDeadline(startedAt: string): string {
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid POS connectivity outage timestamp.");
  return new Date(timestamp + 48 * 60 * 60 * 1000).toISOString();
}

function outageKey(businessId: string, posRecordId: string): string {
  if (!businessId || !posRecordId) throw new Error("Business and POS are required to track a connectivity outage.");
  return businessId + ":" + posRecordId;
}

export async function getOrStartPosConnectivityOutage(
  businessId: string,
  posRecordId: string,
  detectedAt = new Date().toISOString(),
): Promise<PosConnectivityOutage> {
  if (!Number.isFinite(Date.parse(detectedAt))) throw new Error("Invalid POS connectivity outage timestamp.");
  const db = await openDb();
  try {
    return await new Promise<PosConnectivityOutage>((resolve, reject) => {
      const tx = db.transaction(OUTAGE_STORE_NAME, "readwrite", { durability: "strict" });
      const store = tx.objectStore(OUTAGE_STORE_NAME);
      const id = outageKey(businessId, posRecordId);
      let result: PosConnectivityOutage = { id, businessId, posRecordId, startedAt: detectedAt };
      const request = store.get(id);
      request.onsuccess = () => {
        const existing = request.result as PosConnectivityOutage | undefined;
        if (existing && existing.businessId === businessId && existing.posRecordId === posRecordId &&
            Number.isFinite(Date.parse(existing.startedAt))) {
          result = existing;
        } else {
          store.put(result);
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read the POS connectivity outage."));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("Could not persist the POS connectivity outage."));
      tx.onabort = () => reject(tx.error ?? new Error("POS connectivity outage write was aborted."));
    });
  } finally {
    db.close();
  }
}

export async function clearPosConnectivityOutage(businessId: string, posRecordId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTAGE_STORE_NAME, "readwrite", { durability: "strict" });
      tx.objectStore(OUTAGE_STORE_NAME).delete(outageKey(businessId, posRecordId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear the POS connectivity outage."));
      tx.onabort = () => reject(tx.error ?? new Error("POS connectivity outage clear was aborted."));
    });
  } finally {
    db.close();
  }
}
