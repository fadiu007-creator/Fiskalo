/**
 * Browser-local P-256 key vault for the Fiskalo Web POS.
 *
 * This is a prototype/test-environment key store, not a certification claim.
 * The private CryptoKey is non-extractable and persisted in IndexedDB. Browser
 * profile storage is not equivalent to an OS/hardware keystore and can be
 * lost or exposed by a compromised browser profile or same-origin XSS.
 */
export type BrowserCsrIdentity = {
  businessName: string;
  nui: string;
  branchId: string;
  posId: string;
};

type StoredKey = {
  id: string;
  privateKey: CryptoKey;
  publicKeySpki: ArrayBuffer;
  csrPem: string;
  certificatePem?: string;
  createdAt: string;
};

const DB_NAME = "fiskalo-atk-local";
const DB_VERSION = 1;
const STORE_NAME = "pos-keys";

function requireBrowserCrypto(): Crypto {
  if (typeof window === "undefined" || !window.isSecureContext || !window.crypto?.subtle) {
    throw new Error("ATK browser key storage requires a supported browser on HTTPS or localhost.");
  }
  return window.crypto;
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local key storage."));
  });
}

async function readKey(id: string): Promise<StoredKey | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve((request.result as StoredKey | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Could not read the local POS key."));
    });
  } finally { db.close(); }
}

async function writeKey(record: StoredKey): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save the local POS key."));
      tx.onabort = () => reject(tx.error ?? new Error("Local POS key storage was aborted."));
    });
  } finally { db.close(); }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function derLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) { bytes.unshift(value & 255); value >>>= 8; }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(value.length), value);
}

function derSequence(...values: Uint8Array[]): Uint8Array { return der(0x30, concat(...values)); }
function derSet(value: Uint8Array): Uint8Array { return der(0x31, value); }
function derOid(bytes: number[]): Uint8Array { return der(0x06, new Uint8Array(bytes)); }
function derUtf8(value: string): Uint8Array { return der(0x0c, new TextEncoder().encode(value)); }
function derPrintable(value: string): Uint8Array { return der(0x13, new TextEncoder().encode(value)); }

function derInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let value: Uint8Array = new Uint8Array(bytes.slice(start));
  if ((value[0] & 0x80) !== 0) value = concat(new Uint8Array([0]), value);
  return der(0x02, value);
}

function ecdsaRawToDer(signature: ArrayBuffer): Uint8Array {
  const raw = new Uint8Array(signature);
  if (raw.length !== 64) throw new Error("Unexpected P-256 signature length.");
  return derSequence(derInteger(raw.slice(0, 32)), derInteger(raw.slice(32, 64)));
}

function subjectName(identity: BrowserCsrIdentity): Uint8Array {
  const attributes = [
    derSequence(derOid([0x55, 0x04, 0x06]), derPrintable("RKS")),
    derSequence(derOid([0x55, 0x04, 0x0a]), derUtf8(identity.nui)),
    derSequence(derOid([0x55, 0x04, 0x0b]), derUtf8(identity.posId)),
    derSequence(derOid([0x55, 0x04, 0x07]), derUtf8(identity.branchId)),
    derSequence(derOid([0x55, 0x04, 0x03]), derUtf8(identity.businessName.trim())),
  ];
  return derSequence(...attributes.map(derSet));
}

function toPem(label: string, bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  const lines = encoded.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

function validateIdentity(identity: BrowserCsrIdentity): void {
  if (!identity.businessName.trim()) throw new Error("Business name is required.");
  for (const [label, value] of [["NUI", identity.nui], ["unit/branch ID", identity.branchId], ["POS ID", identity.posId]] as const) {
    if (!/^\d{1,20}$/.test(value)) throw new Error(`${label} must contain digits only.`);
  }
}

export async function hasBrowserPosKey(id: string): Promise<boolean> {
  return Boolean(await readKey(id));
}

export async function createBrowserPosCsr(id: string, identity: BrowserCsrIdentity): Promise<{
  csrPem: string;
  publicKeySpkiBase64: string;
  publicKeySha256: string;
  createdAt: string;
}> {
  const cryptoApi = requireBrowserCrypto();
  validateIdentity(identity);
  if (await readKey(id)) throw new Error("A key already exists for this POS. Do not replace it during ATK testing.");

  const generated = await cryptoApi.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  ) as CryptoKeyPair;
  const [privatePkcs8, publicSpki] = await Promise.all([
    cryptoApi.subtle.exportKey("pkcs8", generated.privateKey),
    cryptoApi.subtle.exportKey("spki", generated.publicKey),
  ]);
  const privateKey = await cryptoApi.subtle.importKey(
    "pkcs8", privatePkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  new Uint8Array(privatePkcs8).fill(0);

  const info = derSequence(
    der(0x02, new Uint8Array([0])),
    subjectName(identity),
    new Uint8Array(publicSpki),
    der(0xa0, new Uint8Array()),
  );
  const signature = await cryptoApi.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, info.buffer as ArrayBuffer);
  const algorithm = derSequence(derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const csr = derSequence(info, algorithm, der(0x03, concat(new Uint8Array([0]), ecdsaRawToDer(signature))));
  const createdAt = new Date().toISOString();
  const csrPem = toPem("CERTIFICATE REQUEST", csr);
  await writeKey({ id, privateKey, publicKeySpki: publicSpki, csrPem, createdAt });

  const fingerprint = await cryptoApi.subtle.digest("SHA-256", publicSpki);
  const fingerprintHex = Array.from(new Uint8Array(fingerprint), (b) => b.toString(16).padStart(2, "0")).join(":");
  let publicBinary = "";
  for (const byte of new Uint8Array(publicSpki)) publicBinary += String.fromCharCode(byte);
  return {
    csrPem,
    publicKeySpkiBase64: btoa(publicBinary),
    publicKeySha256: fingerprintHex,
    createdAt,
  };
}

export async function signAtkBase64Payload(id: string, base64Payload: string): Promise<string> {
  const cryptoApi = requireBrowserCrypto();
  const record = await readKey(id);
  if (!record) throw new Error("No local signing key exists for this POS.");
  const signature = await cryptoApi.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    record.privateKey,
    new TextEncoder().encode(base64Payload).buffer as ArrayBuffer,
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function deleteBrowserPosKey(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not delete the local POS key."));
      tx.onabort = () => reject(tx.error ?? new Error("Local POS key deletion was aborted."));
    });
  } finally { db.close(); }
}

export async function getBrowserPosCsr(id: string): Promise<{ csrPem: string; publicKeySha256: string; createdAt: string } | null> {
  const cryptoApi = requireBrowserCrypto();
  const record = await readKey(id);
  if (!record) return null;
  const fingerprint = await cryptoApi.subtle.digest("SHA-256", record.publicKeySpki);
  const publicKeySha256 = Array.from(new Uint8Array(fingerprint), (b) => b.toString(16).padStart(2, "0")).join(":");
  return { csrPem: record.csrPem, publicKeySha256, createdAt: record.createdAt };
}

type DerNode = { tag: number; start: number; contentStart: number; end: number; next: number };

function readDerNode(bytes: Uint8Array, offset: number): DerNode {
  if (offset + 2 > bytes.length) throw new Error("Malformed ATK certificate DER.");
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let cursor = offset + 2;
  if ((length & 0x80) !== 0) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || cursor + count > bytes.length) throw new Error("Malformed ATK certificate DER length.");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++];
  }
  const end = cursor + length;
  if (end > bytes.length) throw new Error("ATK certificate DER is truncated.");
  return { tag, start: offset, contentStart: cursor, end, next: end };
}

function derChildren(bytes: Uint8Array, node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let cursor = node.contentStart;
  while (cursor < node.end) {
    const child = readDerNode(bytes, cursor);
    children.push(child);
    cursor = child.next;
  }
  if (cursor !== node.end) throw new Error("Malformed ATK certificate structure.");
  return children;
}

function certificateSpki(certificatePem: string): Uint8Array {
  const base64 = certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\\s+/g, "");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const root = readDerNode(bytes, 0);
  if (root.tag !== 0x30) throw new Error("ATK returned an invalid X.509 certificate.");
  const certificateFields = derChildren(bytes, root);
  const tbs = certificateFields[0];
  if (!tbs || tbs.tag !== 0x30) throw new Error("ATK certificate has no TBSCertificate.");
  const fields = derChildren(bytes, tbs);
  let index = fields[0]?.tag === 0xa0 ? 1 : 0;
  index += 5; // serial, signature, issuer, validity, subject
  const spki = fields[index];
  if (!spki || spki.tag !== 0x30) throw new Error("ATK certificate has no SubjectPublicKeyInfo.");
  return bytes.slice(spki.start, spki.end);
}

function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let i = 0; i < first.length; i++) difference |= first[i] ^ second[i];
  return difference === 0;
}

export async function installBrowserPosCertificate(id: string, certificatePem: string): Promise<{ publicKeySha256: string; installed: boolean }> {
  const cryptoApi = requireBrowserCrypto();
  const record = await readKey(id);
  if (!record) throw new Error("No local signing key exists for this POS.");
  const certificateKey = certificateSpki(certificatePem);
  if (!equalBytes(certificateKey, new Uint8Array(record.publicKeySpki))) {
    throw new Error("ATK certificate public key does not match this browser POS private key. Certificate was not installed.");
  }
  const fingerprint = await cryptoApi.subtle.digest("SHA-256", record.publicKeySpki);
  const publicKeySha256 = Array.from(new Uint8Array(fingerprint), (b) => b.toString(16).padStart(2, "0")).join(":");
  await writeKey({ ...record, certificatePem });
  return { publicKeySha256, installed: true };
}

export async function hasBrowserPosCertificate(id: string): Promise<boolean> {
  return Boolean((await readKey(id))?.certificatePem);
}
