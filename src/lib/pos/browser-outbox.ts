import { decryptBrowserFiscalData, encryptBrowserFiscalData } from "../atk/browser-key-vault.ts";
import type { EncryptedBrowserPayload } from "../atk/local-storage-crypto.ts";
import { createPosHeartbeatCanonicalMessage } from "./heartbeat-canonical.ts";

const DB_NAME = "fiskalo-fiscal-outbox";
const STORE_NAME = "signed-documents";
const OUTAGE_STORE_NAME = "connectivity-outages";
const HEARTBEAT_STORE_NAME = "trusted-heartbeats";
const OUTBOX_ENCRYPTION_SCOPE = "basic-fiscal-outbox";
const OUTAGE_ENCRYPTION_SCOPE = "basic-pos-connectivity-outage";
const HEARTBEAT_ENCRYPTION_SCOPE = "basic-pos-trusted-heartbeat";
const HEARTBEAT_PUBLIC_KEY_SPKI_BASE64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHwziGBcgBfjbJ120yQ93+B+0Yqe1iP3C0ZDOaFxyMN6du4G0pCEI7AwYrHpIMkxRwV2/nNSdVZHsLt7Cwmlcww==";

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
  timeEvidence?: "server_signed_heartbeat" | "browser_local_untrusted";
};

export type TrustedPosHeartbeat = {
  id: string;
  businessId: string;
  posRecordId: string;
  serverTimeUtc: string;
  previousHeartbeatAtUtc: string | null;
  gapSeconds: number | null;
  gapDetected: boolean;
  nonce: string;
  issuedAtUnixMs: number;
  signatureBase64: string;
};
type EncryptedHeartbeatRecord = EncryptedRecord & { id: string; serverTimeUnixMs: number };

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
      if (!request.result.objectStoreNames.contains(HEARTBEAT_STORE_NAME)) {
        request.result.createObjectStore(HEARTBEAT_STORE_NAME, { keyPath: "id" });
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

export function resolvePosOutageEvidence(
  existing: PosConnectivityOutage | null,
  trustedLastHeartbeatAt: string | null,
  detectedAt: string,
): Pick<PosConnectivityOutage, "startedAt" | "timeEvidence"> {
  if (!Number.isFinite(Date.parse(detectedAt))) throw new Error("Invalid POS connectivity outage timestamp.");
  if (trustedLastHeartbeatAt && Number.isFinite(Date.parse(trustedLastHeartbeatAt))) {
    const preserveEarlierTrusted = existing?.timeEvidence === "server_signed_heartbeat" &&
      Number.isFinite(Date.parse(existing.startedAt)) &&
      Date.parse(existing.startedAt) <= Date.parse(trustedLastHeartbeatAt);
    return {
      startedAt: preserveEarlierTrusted ? existing!.startedAt : trustedLastHeartbeatAt,
      timeEvidence: "server_signed_heartbeat",
    };
  }
  return {
    startedAt: resolvePosOutageStart(existing?.startedAt ?? null, detectedAt),
    timeEvidence: existing?.timeEvidence ?? "browser_local_untrusted",
  };
}

/** The 48-hour recovery deadline is measured from the first observed outage time. */
export function outageRecoveryDeadline(startedAt: string): string {
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid POS connectivity outage timestamp.");
  return new Date(timestamp + 48 * 60 * 60 * 1000).toISOString();
}

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
      request.onerror = () => reject(request.error ?? new Error("Could not read the trusted POS heartbeat."));
    });
  } finally { db.close(); }
  if (!raw) return null;
  if (!isEncryptedRecord(raw)) throw new Error("Trusted POS heartbeat is not encrypted. Preserve the fiscal browser storage.");
  const heartbeat = await decryptBrowserFiscalData<TrustedPosHeartbeat>(HEARTBEAT_ENCRYPTION_SCOPE, raw.encrypted);
  const timestamp = Date.parse(heartbeat.serverTimeUtc);
  if (heartbeat.id !== id || heartbeat.businessId !== businessId || heartbeat.posRecordId !== posRecordId ||
      !Number.isFinite(timestamp) || timestamp !== (raw as EncryptedHeartbeatRecord).serverTimeUnixMs ||
      !await verifyTrustedHeartbeatSignature(heartbeat)) {
    throw new Error("Stored trusted POS heartbeat identity, timestamp or signature is invalid.");
  }
  return heartbeat;
}

async function verifyTrustedHeartbeatSignature(heartbeat: TrustedPosHeartbeat): Promise<boolean> {
  if (!Number.isSafeInteger(heartbeat.issuedAtUnixMs) ||
      heartbeat.serverTimeUtc !== new Date(heartbeat.issuedAtUnixMs).toISOString() ||
      !/^[A-Za-z0-9_-]{43}$/.test(heartbeat.nonce)) return false;
  try {
    const keyBinary = atob(HEARTBEAT_PUBLIC_KEY_SPKI_BASE64);
    const keyBytes = Uint8Array.from(keyBinary, char => char.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey(
      "spki",
      keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const canonical = createPosHeartbeatCanonicalMessage(
      heartbeat.businessId, heartbeat.posRecordId, heartbeat.nonce, heartbeat.issuedAtUnixMs,
    );
    const signatureBinary = atob(heartbeat.signatureBase64);
    const signature = Uint8Array.from(signatureBinary, char => char.charCodeAt(0));
    return signature.length === 64 && await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength),
      new TextEncoder().encode(canonical),
    );
  } catch { return false; }
}

async function saveTrustedPosHeartbeat(heartbeat: TrustedPosHeartbeat): Promise<void> {
  const timestamp = Date.parse(heartbeat.serverTimeUtc);
  if (!Number.isFinite(timestamp) || timestamp !== heartbeat.issuedAtUnixMs ||
      !await verifyTrustedHeartbeatSignature(heartbeat)) {
    throw new Error("Cannot persist an unverified server heartbeat.");
  }
  const encrypted = await encryptBrowserFiscalData(HEARTBEAT_ENCRYPTION_SCOPE, heartbeat);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = strictTransaction(db, HEARTBEAT_STORE_NAME);
      const store = tx.objectStore(HEARTBEAT_STORE_NAME);
      let stale = false;
      const request = store.get(heartbeat.id);
      request.onsuccess = () => {
        const current = request.result as EncryptedHeartbeatRecord | undefined;
        if (current && Number.isFinite(current.serverTimeUnixMs) && current.serverTimeUnixMs >= timestamp) {
          stale = true;
          tx.abort();
          return;
        }
        store.put({
          id: heartbeat.id,
          revision: (current?.revision ?? 0) + 1,
          serverTimeUnixMs: timestamp,
          encrypted,
        } satisfies EncryptedHeartbeatRecord);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not read trusted POS heartbeat metadata."));
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        if (!stale) reject(tx.error ?? new Error("Could not persist the trusted POS heartbeat."));
      };
      tx.onabort = () => reject(new Error(stale
        ? "A replayed or out-of-order server heartbeat was rejected."
        : "Trusted POS heartbeat write was aborted."));
    });
  } finally { db.close(); }
}

const heartbeatInFlight = new Map<string, Promise<TrustedPosHeartbeat>>();
const recentHeartbeatCache = new Map<string, { completedAt: number; value: TrustedPosHeartbeat }>();

export function requestServerSignedPosHeartbeat(
  businessId: string,
  posRecordId: string,
  accessToken: string,
  nonceOverride?: string,
): Promise<TrustedPosHeartbeat> {
  // A POS Agent challenge nonce must never be satisfied by a concurrent
  // browser-only heartbeat for the same POS. Keep challenge-bound and periodic
  // requests in separate idempotency lanes.
  const key = businessId + ":" + posRecordId + ":" + (nonceOverride ? "challenge:" + nonceOverride : "periodic");
  const inFlight = heartbeatInFlight.get(key);
  if (inFlight) return inFlight;
  if (!nonceOverride) {
    const now = performance.now();
    const recent = recentHeartbeatCache.get(key);
    if (recent && now - recent.completedAt < 5_000) return Promise.resolve(recent.value);
  }
  const request = performServerSignedPosHeartbeat(businessId, posRecordId, accessToken, nonceOverride);
  heartbeatInFlight.set(key, request);
  request.then(value => {
    recentHeartbeatCache.set(key, { completedAt: performance.now(), value });
    heartbeatInFlight.delete(key);
  }, () => {
    heartbeatInFlight.delete(key);
  });
  return request;
}

async function performServerSignedPosHeartbeat(
  businessId: string,
  posRecordId: string,
  accessToken: string,
  nonceOverride?: string,
): Promise<TrustedPosHeartbeat> {
  if (!accessToken) throw new Error("An authenticated session is required for a trusted POS heartbeat.");
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error("Secure browser cryptography is required for trusted POS heartbeat verification.");
  }
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonceBinary = Array.from(nonceBytes, byte => String.fromCharCode(byte)).join("");
  const generatedNonce = btoa(nonceBinary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const nonce = nonceOverride ?? generatedNonce;
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error("POS Agent heartbeat challenge nonce is invalid.");
  const response = await fetch("/api/pos/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
    body: JSON.stringify({ businessId, posUuid: posRecordId, nonce }),
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "same-origin",
  });
  const payload = await response.json().catch(() => null) as null | {
    version?: number;
    businessId?: string;
    posUuid?: string;
    nonce?: string;
    issuedAtUnixMs?: number;
    serverTimeUtc?: string;
    previousHeartbeatAtUtc?: string | null;
    gapSeconds?: number | null;
    gapDetected?: boolean;
    signatureBase64?: string;
    environment?: string;
    productionEnabled?: boolean;
  };
  if (!response.ok || !payload || payload.version !== 1 ||
      payload.businessId !== businessId || payload.posUuid !== posRecordId ||
      payload.nonce !== nonce || payload.environment !== "ATK TEST" ||
      payload.productionEnabled !== false || !Number.isSafeInteger(payload.issuedAtUnixMs) ||
      typeof payload.signatureBase64 !== "string" ||
      payload.serverTimeUtc !== new Date(payload.issuedAtUnixMs!).toISOString()) {
    throw new Error("The server did not return a valid signed POS heartbeat.");
  }
  if (payload.previousHeartbeatAtUtc !== null &&
      (typeof payload.previousHeartbeatAtUtc !== "string" || !Number.isFinite(Date.parse(payload.previousHeartbeatAtUtc)))) {
    throw new Error("The signed heartbeat contains an invalid previous server timestamp.");
  }
  if (payload.gapSeconds !== null && payload.gapSeconds !== undefined &&
      (!Number.isSafeInteger(payload.gapSeconds) || payload.gapSeconds < 0)) {
    throw new Error("The heartbeat gap is invalid.");
  }

  const keyBinary = atob(HEARTBEAT_PUBLIC_KEY_SPKI_BASE64);
  const publicKeyBytes = Uint8Array.from(keyBinary, char => char.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    publicKeyBytes.buffer.slice(publicKeyBytes.byteOffset, publicKeyBytes.byteOffset + publicKeyBytes.byteLength),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const canonical = createPosHeartbeatCanonicalMessage(
    businessId, posRecordId, nonce, payload.issuedAtUnixMs!,
  );
  const signatureBinary = atob(payload.signatureBase64);
  const signature = Uint8Array.from(signatureBinary, char => char.charCodeAt(0));
  if (signature.length !== 64 || !await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength),
    new TextEncoder().encode(canonical),
  )) {
    throw new Error("The server-signed POS heartbeat signature is invalid.");
  }

  const heartbeat: TrustedPosHeartbeat = {
    id: await heartbeatRecordId(businessId, posRecordId),
    businessId,
    posRecordId,
    serverTimeUtc: payload.serverTimeUtc!,
    previousHeartbeatAtUtc: payload.previousHeartbeatAtUtc ?? null,
    gapSeconds: payload.gapSeconds ?? null,
    gapDetected: payload.gapDetected === true,
    nonce,
    issuedAtUnixMs: payload.issuedAtUnixMs!,
    signatureBase64: payload.signatureBase64,
  };
  await saveTrustedPosHeartbeat(heartbeat);
  return heartbeat;
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
  trustedLastHeartbeatAt?: string | null,
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
    const lastTrusted = trustedLastHeartbeatAt === undefined
      ? await getLastTrustedPosHeartbeat(businessId, posRecordId).catch(() => null)
      : null;
    const trustedStart = trustedLastHeartbeatAt ??
      (lastTrusted && Number.isFinite(Date.parse(lastTrusted.serverTimeUtc)) ? lastTrusted.serverTimeUtc : null);
    const evidence = resolvePosOutageEvidence(
      existing && existing.businessId === businessId && existing.posRecordId === posRecordId ? existing : null,
      trustedStart,
      detectedAt,
    );
    const result: PosConnectivityOutage = { id, businessId, posRecordId, ...evidence };
    if (existing && existing.startedAt === evidence.startedAt && existing.timeEvidence === evidence.timeEvidence && isEncryptedRecord(raw)) return existing;
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
