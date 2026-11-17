import { decryptBrowserFiscalData, encryptBrowserFiscalData } from "../atk/browser-key-vault.ts";
import type { EncryptedBrowserPayload } from "../atk/local-storage-crypto.ts";

const DB_NAME = "fiskalo-fiscal-outbox";
const STORE_NAME = "signed-documents";
const OUTAGE_STORE_NAME = "connectivity-outages";
const HEARTBEAT_STORE_NAME = "trusted-heartbeats";
const OUTBOX_ENCRYPTION_SCOPE = "basic-fiscal-outbox";
const OUTAGE_ENCRYPTION_SCOPE = "basic-pos-connectivity-outage";
const HEARTBEAT_ENCRYPTION_SCOPE = "basic-pos-trusted-heartbeat";
const HEARTBEAT_PUBLIC_KEY_SPKI_BASE64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEk7Kh22GR/MCr1G1QizihiqiMMTcpBBbWA+xzJfXOLnQogcm5FstM26nOyg6hagbuhgNcksl7WAXVlbBWIfUqXA==";

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
type EncryptedHeartbeatRecord = EncryptedRecord & { id: string; serverTimeUnixMs: number };

export type PosConnectivityOutage = {
  id: string;
  businessId: string;
  posRecordId: string;
  startedAt: string;
  timeEvidence?: "server_signed" | "local_untrusted";
};

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !globalThis.indexedDB) {
    throw new Error("This browser does not support a durable offline fiscal outbox.");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
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

export type TrustedPosHeartbeat = {
  id: string;
  businessId: string;
  posRecordId: string;
  serverTimeUtc: string;
  nonce: string;
  previousHeartbeatAtUtc?: string | null;
  gapSeconds?: number | null;
  gapDetected?: boolean;
};

async function heartbeatRecordId(businessId: string, posRecordId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(businessId + ":" + posRecordId),
  ));
  return "heartbeat-" + Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function getLastTrustedPosHeartbeat(
  businessId: string,
  posRecordId: string,
): Promise<TrustedPosHeartbeat | null> {
  const id = await heartbeatRecordId(businessId, posRecordId);
  const db = await openDb();
  let raw: unknown;
  try {
    raw = await new Promise((resolve, reject) => {
      const request = db.transaction(HEARTBEAT_STORE_NAME, "readonly").objectStore(HEARTBEAT_STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("Could not read trusted POS heartbeat."));
    });
  } finally { db.close(); }
  if (!raw) return null;
  if (!isEncryptedRecord(raw)) throw new Error("Trusted POS heartbeat is not encrypted. Do not clear browser data.");
  const value = await decryptBrowserFiscalData<TrustedPosHeartbeat>(HEARTBEAT_ENCRYPTION_SCOPE, raw.encrypted);
  if (value.id !== id || value.businessId !== businessId || value.posRecordId !== posRecordId ||
      !Number.isFinite(Date.parse(value.serverTimeUtc)) || typeof value.nonce !== "string") {
    throw new Error("Trusted POS heartbeat identity or timestamp is invalid.");
  }
  return value;
}

async function saveTrustedPosHeartbeat(value: TrustedPosHeartbeat): Promise<void> {
  const serverTimeUnixMs = Date.parse(value.serverTimeUtc);
  if (!Number.isFinite(serverTimeUnixMs)) throw new Error("Signed heartbeat has an invalid server timestamp.");
  const encrypted = await encryptBrowserFiscalData(HEARTBEAT_ENCRYPTION_SCOPE, value);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = strictTransaction(db, HEARTBEAT_STORE_NAME);
      const store = tx.objectStore(HEARTBEAT_STORE_NAME);
      let replayed = false;
      const request = store.get(value.id);
      request.onsuccess = () => {
        const current = request.result as EncryptedHeartbeatRecord | undefined;
        if (current && Number.isFinite(current.serverTimeUnixMs) &&
            current.serverTimeUnixMs >= serverTimeUnixMs) {
          replayed = true;
          tx.abort();
          return;
        }
        store.put({
          id: value.id,
          revision: (current?.revision ?? 0) + 1,
          serverTimeUnixMs,
          encrypted,
        } satisfies EncryptedHeartbeatRecord);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read trusted heartbeat metadata."));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error(
        replayed ? "Replayed or out-of-order server heartbeat rejected." : "Trusted POS heartbeat write was aborted.",
      ));
      tx.onerror = () => {
        if (!replayed) reject(tx.error ?? new Error("Could not persist trusted POS heartbeat."));
      };
    });
  } finally { db.close(); }
}

export async function requestServerSignedPosHeartbeat(
  workerUrl: string,
  accessToken: string,
  businessId: string,
  posRecordId: string,
): Promise<TrustedPosHeartbeat> {
  if (!accessToken) throw new Error("An authenticated session is required for a trusted POS heartbeat.");
  const endpoint = new URL(workerUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("The ATK recovery Worker must use a trusted HTTPS origin.");
  }
  if (!crypto?.subtle || !crypto.getRandomValues) throw new Error("Secure browser cryptography is required.");
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = btoa(String.fromCharCode(...nonceBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const response = await fetch(new URL("/heartbeat", endpoint.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
    body: JSON.stringify({ businessId, posUuid: posRecordId, nonce }),
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const payload = await response.json().catch(() => null) as null | {
    version?: number; businessId?: string; posUuid?: string; nonce?: string;
    issuedAtUnixMs?: number; signatureBase64?: string; productionEnabled?: boolean;
    previousHeartbeatAtUtc?: string | null; gapSeconds?: number | null; gapDetected?: boolean;
  };
  if (!response.ok || !payload || payload.version !== 1 ||
      payload.businessId !== businessId || payload.posUuid !== posRecordId ||
      payload.nonce !== nonce || payload.productionEnabled !== false ||
      !Number.isSafeInteger(payload.issuedAtUnixMs) ||
      typeof payload.signatureBase64 !== "string" ||
      (payload.previousHeartbeatAtUtc !== null && payload.previousHeartbeatAtUtc !== undefined &&
        (typeof payload.previousHeartbeatAtUtc !== "string" || !Number.isFinite(Date.parse(payload.previousHeartbeatAtUtc)))) ||
      (payload.gapSeconds !== null && payload.gapSeconds !== undefined &&
        (!Number.isSafeInteger(payload.gapSeconds) || payload.gapSeconds < 0)) ||
      typeof payload.gapDetected !== "boolean") {
    throw new Error("The recovery Worker did not return a valid signed heartbeat.");
  }
  const binaryKey = atob(HEARTBEAT_PUBLIC_KEY_SPKI_BASE64);
  const publicKeyBytes = Uint8Array.from(binaryKey, char => char.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    publicKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const canonical = [
    "fiskalo-atk-heartbeat-v1",
    businessId.toLowerCase(),
    posRecordId.toLowerCase(),
    nonce,
    String(payload.issuedAtUnixMs),
  ].join("\n");
  const signatureBinary = atob(payload.signatureBase64);
  const signature = Uint8Array.from(signatureBinary, char => char.charCodeAt(0));
  if (signature.length !== 64 || !await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    new TextEncoder().encode(canonical),
  )) {
    throw new Error("The POS heartbeat server signature is invalid.");
  }
  const serverTimeUtc = new Date(payload.issuedAtUnixMs).toISOString();
  const value: TrustedPosHeartbeat = {
    id: await heartbeatRecordId(businessId, posRecordId),
    businessId,
    posRecordId,
    serverTimeUtc,
    nonce,
    previousHeartbeatAtUtc: payload.previousHeartbeatAtUtc ?? null,
    gapSeconds: payload.gapSeconds ?? null,
    gapDetected: payload.gapDetected,
  };
  await saveTrustedPosHeartbeat(value);
  return value;
}

export async function getOrStartPosConnectivityOutage(
  businessId: string,
  posRecordId: string,
  detectedAt = new Date().toISOString(),
  trustedLastHeartbeatAt?: string | null,
): Promise<PosConnectivityOutage> {
  if (!Number.isFinite(Date.parse(detectedAt))) throw new Error("Invalid POS connectivity outage timestamp.");
  let trustedStart = trustedLastHeartbeatAt ?? null;
  if (!trustedStart) {
    try { trustedStart = (await getLastTrustedPosHeartbeat(businessId, posRecordId))?.serverTimeUtc ?? null; }
    catch { trustedStart = null; }
  }
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
    const existingStart = existing && existing.businessId === businessId && existing.posRecordId === posRecordId
      ? existing.startedAt : null;
    const hasTrustedStart = Boolean(trustedStart && Number.isFinite(Date.parse(trustedStart)));
    let startedAt = resolvePosOutageStart(existingStart, hasTrustedStart ? trustedStart! : detectedAt);
    if (hasTrustedStart && existingStart && Date.parse(trustedStart!) < Date.parse(existingStart)) {
      startedAt = trustedStart!;
    }
    const timeEvidence = hasTrustedStart
      ? "server_signed" as const
      : existing?.timeEvidence ?? "local_untrusted" as const;
    const result: PosConnectivityOutage = { id, businessId, posRecordId, startedAt, timeEvidence };
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
