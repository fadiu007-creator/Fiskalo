export type OfflinePosDraft = {
  id: string;
  organizationId: string;
  createdAt: string;
  cart: Array<{ productId: string; quantity: string }>;
  customerId: string;
  paymentMethod: string;
  discountPercent?: number;
};

type EncryptedDraftRecord = {
  id: string;
  organizationId: string;
  createdAt: string;
  ivBase64: string;
  ciphertextBase64: string;
};

type LegacyDraftRecord = OfflinePosDraft;
type StoredDraftRecord = EncryptedDraftRecord | LegacyDraftRecord;

const DATABASE = "fiskalo-pos-local";
const STORE = "order-drafts";
const KEY_STORE = "crypto-keys";
const KEY_ID = "offline-drafts-aes-gcm-256";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Ruajtja lokale nuk mbështetet në këtë shfletues."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("organizationId", "organizationId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Nuk u hap ruajtja lokale."));
    request.onblocked = () => reject(new Error("Mbyll skedat e tjera të Fiskalo-s dhe provo përsëri."));
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readEncryptionKey(db: IDBDatabase): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, "readonly");
    const request = tx.objectStore(KEY_STORE).get(KEY_ID);
    request.onsuccess = () => resolve((request.result as { key?: CryptoKey } | undefined)?.key ?? null);
    request.onerror = () => reject(request.error ?? new Error("Çelësi i enkriptimit nuk u lexua."));
    tx.onabort = () => reject(tx.error ?? new Error("Leximi i çelësit u anulua."));
  });
}

async function getEncryptionKey(db: IDBDatabase): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error("Enkriptimi AES-GCM nuk mbështetet në këtë pajisje.");
  const existing = await readEncryptionKey(db);
  if (existing) return existing;

  const generated = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, "readwrite", { durability: "strict" });
      tx.objectStore(KEY_STORE).add({ id: KEY_ID, key: generated });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Çelësi AES nuk u ruajt."));
      tx.onabort = () => reject(tx.error ?? new Error("Ruajtja e çelësit AES u anulua."));
    });
    return generated;
  } catch {
    // Another Fiskalo tab may have created the non-extractable key first.
    const raced = await readEncryptionKey(db);
    if (raced) return raced;
    throw new Error("Çelësi AES për draftet lokale nuk mund të ruhej.");
  }
}

async function encryptDraft(db: IDBDatabase, draft: OfflinePosDraft): Promise<EncryptedDraftRecord> {
  const key = await getEncryptionKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(draft.id + ":" + draft.organizationId);
  const plaintext = encoder.encode(JSON.stringify(draft));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, plaintext);
    return {
      id: draft.id,
      organizationId: draft.organizationId,
      createdAt: draft.createdAt,
      ivBase64: toBase64(iv),
      ciphertextBase64: toBase64(new Uint8Array(ciphertext)),
    };
  } finally {
    plaintext.fill(0);
  }
}

async function decryptDraft(db: IDBDatabase, record: StoredDraftRecord): Promise<OfflinePosDraft> {
  if ("cart" in record) {
    // Migrate pre-encryption drafts in place so existing cashier work is retained.
    const encrypted = await encryptDraft(db, record);
    await putRecord(db, encrypted);
    return record;
  }
  const key = await getEncryptionKey(db);
  const iv = fromBase64(record.ivBase64);
  const ciphertext = fromBase64(record.ciphertextBase64);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error("Drafti i enkriptuar është i dëmtuar.");
  const additionalData = encoder.encode(record.id + ":" + record.organizationId);
  // WebCrypto's current TypeScript DOM types require ArrayBuffer-backed views.
  const ivBuffer = Uint8Array.from(iv).buffer as ArrayBuffer;
  const additionalDataBuffer = Uint8Array.from(additionalData).buffer as ArrayBuffer;
  const ciphertextBuffer = Uint8Array.from(ciphertext).buffer as ArrayBuffer;
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: ivBuffer, additionalData: additionalDataBuffer, tagLength: 128,
    }, key, ciphertextBuffer);
    const draft = JSON.parse(decoder.decode(plaintext)) as OfflinePosDraft;
    if (draft.id !== record.id || draft.organizationId !== record.organizationId ||
        !Array.isArray(draft.cart) || typeof draft.createdAt !== "string") {
      throw new Error("Të dhënat e draftit nuk përputhen me identifikuesit e ruajtur.");
    }
    new Uint8Array(plaintext).fill(0);
    return draft;
  } catch {
    throw new Error("Drafti lokal nuk mund të dekriptohet. Të dhënat nuk u fshinë.");
  }
}

async function putRecord(db: IDBDatabase, record: EncryptedDraftRecord): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Drafti nuk u ruajt."));
    tx.onabort = () => reject(tx.error ?? new Error("Ruajtja e draftit u anulua."));
  });
}

export async function listOfflinePosDrafts(organizationId: string): Promise<OfflinePosDraft[]> {
  const db = await openDatabase();
  try {
    const records = await new Promise<StoredDraftRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).index("organizationId").getAll(organizationId);
      request.onsuccess = () => resolve(request.result as StoredDraftRecord[]);
      request.onerror = () => reject(request.error ?? new Error("Draftet nuk u lexuan."));
      tx.onabort = () => reject(tx.error ?? new Error("Leximi i draftit u anulua."));
    });
    const drafts = await Promise.all(records.map((record) => decryptDraft(db, record)));
    return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    db.close();
  }
}

export async function saveOfflinePosDraft(draft: OfflinePosDraft): Promise<void> {
  const db = await openDatabase();
  try {
    const encrypted = await encryptDraft(db, draft);
    await putRecord(db, encrypted);
  } finally {
    db.close();
  }
}

export async function deleteOfflinePosDraft(id: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Drafti nuk u fshi."));
      tx.onabort = () => reject(tx.error ?? new Error("Fshirja e draftit u anulua."));
    });
  } finally {
    db.close();
  }
}
