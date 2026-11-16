import type { EncryptedBrowserPayload } from "./local-storage-crypto";

const DATABASE = "fiskalo-browser-fiscal-crypto";
const KEY_STORE = "non-exportable-keys";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requireCrypto(): void {
  if (typeof window === "undefined" || !globalThis.crypto?.subtle || !globalThis.indexedDB) {
    throw new Error("Secure browser encryption and IndexedDB are required for the fiscal outbox.");
  }
}

function openDatabase(): Promise<IDBDatabase> {
  requireCrypto();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE)) {
        request.result.createObjectStore(KEY_STORE, { keyPath: "scope" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open the protected browser key store."));
    request.onblocked = () => reject(new Error("Close other Fiskalo tabs and retry the protected key-store operation."));
  });
}

async function readKey(db: IDBDatabase, scope: string): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(scope);
    request.onsuccess = () => resolve((request.result as { key?: CryptoKey } | undefined)?.key ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read the protected browser encryption key."));
  });
}

async function getKey(scope: string): Promise<CryptoKey> {
  if (!scope || scope.length > 128) throw new Error("A valid fiscal encryption scope is required.");
  const db = await openDatabase();
  try {
    const existing = await readKey(db, scope);
    if (existing) return existing;
    const generated = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(KEY_STORE, "readwrite");
        tx.objectStore(KEY_STORE).add({ scope, key: generated, createdAt: new Date().toISOString() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Could not persist the non-exportable fiscal encryption key."));
        tx.onabort = () => reject(tx.error ?? new Error("Fiscal encryption key creation was aborted."));
      });
      return generated;
    } catch {
      // Another tab may have won the unique-key race. Reuse that persisted key.
      const raced = await readKey(db, scope);
      if (raced) return raced;
      throw new Error("Could not create a protected fiscal encryption key.");
    }
  } finally {
    db.close();
  }
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Encrypted fiscal record contains invalid base64.");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function encryptBrowserFiscalData<T>(scope: string, value: T): Promise<EncryptedBrowserPayload> {
  const key = await getKey(scope);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode("fiskalo:fiscal:v1:" + scope);
  const plaintext = encoder.encode(JSON.stringify(value));
  try {
    const encrypted = await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: Uint8Array.from(iv).buffer as ArrayBuffer,
      additionalData: Uint8Array.from(additionalData).buffer as ArrayBuffer,
      tagLength: 128,
    }, key, plaintext);
    return { version: 1, ivBase64: toBase64(iv), ciphertextBase64: toBase64(new Uint8Array(encrypted)) };
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptBrowserFiscalData<T>(scope: string, payload: EncryptedBrowserPayload): Promise<T> {
  if (!payload || payload.version !== 1) throw new Error("Unsupported encrypted fiscal record version.");
  const iv = fromBase64(payload.ivBase64);
  const ciphertext = fromBase64(payload.ciphertextBase64);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error("Encrypted fiscal record is incomplete.");
  const key = await getKey(scope);
  const additionalData = encoder.encode("fiskalo:fiscal:v1:" + scope);
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: Uint8Array.from(iv).buffer,
      additionalData: Uint8Array.from(additionalData).buffer,
      tagLength: 128,
    }, key, Uint8Array.from(ciphertext).buffer as ArrayBuffer);
    try {
      return JSON.parse(decoder.decode(plaintext)) as T;
    } finally {
      new Uint8Array(plaintext).fill(0);
    }
  } catch {
    throw new Error("Fiscal outbox record cannot be decrypted. Data was not deleted or overwritten.");
  }
}
