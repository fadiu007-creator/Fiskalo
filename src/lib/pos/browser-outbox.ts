const DB_NAME = "fiskalo-fiscal-outbox";
const STORE_NAME = "signed-documents";

export type BrowserFiscalOutboxItem = {
  idempotencyKey: string;
  businessId: string;
  saleId: string;
  posRecordId: string;
  couponId: number;
  documentType: 1 | 2 | 3;
  detailsBase64: string;
  signatureBase64: string;
  certificatePem: string;
  citizenPayloadBase64: string;
  citizenSignatureBase64: string;
  citizenQrPayload: string;
  nuiKf: string;
  dailyNumber: number;
  qrSvg: string;
  issuedAtUtc: string;
  offlineIssuedAtUtc: string | null;
  recoveryDeadlineUtc: string;
  state: "prepared" | "accepted" | "queued" | "needs_reconciliation" | "rejected";
  transactionId: string | null;
  lastError: string | null;
};

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !globalThis.indexedDB) {
    throw new Error("This browser does not support a durable offline fiscal outbox.");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "idempotencyKey" });
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
  patch: Partial<Pick<BrowserFiscalOutboxItem, "state" | "transactionId" | "lastError" | "qrSvg">>,
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
