const DB_NAME = "fiskalo-atk-pos-keys";
const STORE_NAME = "pos-keys";
const encoder = new TextEncoder();

type StoredPosKey = {
  id: string;
  privateKey: CryptoKey;
  publicKeySpki: ArrayBuffer;
  certificatePem?: string;
  createdAt: string;
};

export type BrowserPosIdentity = {
  businessNui: string;
  branchId: number;
  posId: number;
  businessName: string;
};

function requireBrowserCrypto() {
  if (typeof window === "undefined" || !globalThis.crypto?.subtle || !globalThis.indexedDB) {
    throw new Error("This POS browser does not support secure WebCrypto and IndexedDB storage.");
  }
}

function posKeyId(identity: BrowserPosIdentity) {
  return [identity.businessNui, identity.branchId, identity.posId].join(":");
}

function openKeyDb(): Promise<IDBDatabase> {
  requireBrowserCrypto();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the POS key store."));
  });
}

async function getStoredKey(id: string): Promise<StoredPosKey | null> {
  const db = await openKeyDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve((request.result as StoredPosKey | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Could not read the POS key store."));
    });
  } finally { db.close(); }
}

async function putStoredKey(value: StoredPosKey): Promise<void> {
  const db = await openKeyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the POS key."));
      transaction.onabort = () => reject(transaction.error ?? new Error("POS key storage was aborted."));
    });
  } finally { db.close(); }
}

function derLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 255);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
function der(tag: number, content: Uint8Array): Uint8Array {
  const length = derLength(content.length);
  return join([new Uint8Array([tag]), length, content]);
}
function join(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function derOid(value: string): Uint8Array {
  const arcs = value.split(".").map(Number);
  if (arcs.length < 2 || arcs.some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error("Invalid ASN.1 object identifier.");
  const values = [arcs[0] * 40 + arcs[1], ...arcs.slice(2)];
  const encoded: number[] = [];
  for (const value of values) {
    let n = value;
    const bytes = [n & 0x7f];
    n = Math.floor(n / 128);
    while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    encoded.push(...bytes);
  }
  return der(0x06, new Uint8Array(encoded));
}
function derInteger(bytes: Uint8Array): Uint8Array {
  let first = 0;
  while (first < bytes.length - 1 && bytes[first] === 0) first++;
  let value = bytes.slice(first);
  if (!value.length) value = new Uint8Array([0]);
  if (value[0] & 0x80) value = join([new Uint8Array([0]), value]);
  return der(0x02, value);
}
function rawEcdsaToDer(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("Expected a P-256 ECDSA signature.");
  return der(0x30, join([derInteger(signature.slice(0, 32)), derInteger(signature.slice(32))]));
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function pem(label: string, bytes: Uint8Array): string {
  const value = base64(bytes);
  return "-----BEGIN " + label + "-----\n" + (value.match(/.{1,64}/g) ?? []).join("\n") +
    "\n-----END " + label + "-----\n";
}
function createSubject(identity: BrowserPosIdentity): Uint8Array {
  const attrs: Array<[string, string, number]> = [
    ["2.5.4.6", "RKS", 0x13],
    ["2.5.4.10", identity.businessNui, 0x0c],
    ["2.5.4.11", String(identity.posId), 0x0c],
    ["2.5.4.7", String(identity.branchId), 0x0c],
    ["2.5.4.3", identity.businessName.trim(), 0x0c],
  ];
  return der(0x30, join(attrs.map(([oid, value, tag]) =>
    der(0x31, der(0x30, join([derOid(oid), der(tag, encoder.encode(value))]))),
  )));
}
type DerNode = { tag: number; start: number; contentStart: number; end: number };
function readDer(bytes: Uint8Array, offset: number): DerNode {
  if (offset + 2 > bytes.length) throw new Error("Invalid certificate DER.");
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 4 || cursor + count > bytes.length) throw new Error("Invalid certificate DER length.");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++];
  }
  const end = cursor + length;
  if (end > bytes.length) throw new Error("Truncated certificate DER.");
  return { tag, start: offset, contentStart: cursor, end };
}
function pemBytes(value: string): Uint8Array {
  const body = value.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function certificateSpki(certificatePem: string): Uint8Array {
  const bytes = pemBytes(certificatePem);
  const cert = readDer(bytes, 0);
  if (cert.tag !== 0x30) throw new Error("ATK certificate is not a DER sequence.");
  const tbs = readDer(bytes, cert.contentStart);
  if (tbs.tag !== 0x30) throw new Error("ATK certificate has no TBSCertificate.");
  let cursor = tbs.contentStart;
  let node = readDer(bytes, cursor);
  if (node.tag === 0xa0) { cursor = node.end; node = readDer(bytes, cursor); }
  for (let index = 0; index < 5; index++) { cursor = node.end; node = readDer(bytes, cursor); }
  if (node.tag !== 0x30) throw new Error("ATK certificate has no valid SubjectPublicKeyInfo.");
  return bytes.slice(node.start, node.end);
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Creates a per-POS P-256 key and PKCS#10 CSR; private key is non-exportable and stays in IndexedDB. */
export async function createOrLoadPosCsr(identity: BrowserPosIdentity): Promise<{ csrPem: string; existingKey: boolean }> {
  requireBrowserCrypto();
  if (!/^[0-9]{9}$/.test(identity.businessNui) || !Number.isSafeInteger(identity.branchId) || identity.branchId <= 0 ||
      !Number.isSafeInteger(identity.posId) || identity.posId <= 0 || !identity.businessName.trim()) {
    throw new Error("Business and POS identifiers are incomplete.");
  }
  const id = posKeyId(identity);
  let stored = await getStoredKey(id);
  const existingKey = !!stored;
  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
    stored = { id, privateKey: pair.privateKey, publicKeySpki: spki, createdAt: new Date().toISOString() };
    await putStoredKey(stored);
  }
  const requestInfo = der(0x30, join([
    der(0x02, new Uint8Array([0])),
    createSubject(identity),
    new Uint8Array(stored.publicKeySpki),
    der(0xa0, new Uint8Array()),
  ]));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, stored.privateKey, requestInfo,
  ));
  const algorithm = der(0x30, derOid("1.2.840.10045.4.3.2"));
  const csr = der(0x30, join([
    requestInfo, algorithm, der(0x03, join([new Uint8Array([0]), rawEcdsaToDer(signature)])),
  ]));
  return { csrPem: pem("CERTIFICATE REQUEST", csr), existingKey };
}

/** Accepts a certificate only when its SPKI is identical to this POS's stored public key. */
export async function installPosCertificate(identity: BrowserPosIdentity, certificatePem: string): Promise<void> {
  const stored = await getStoredKey(posKeyId(identity));
  if (!stored) throw new Error("Generate the CSR on this browser before installing the ATK certificate.");
  if (!equalBytes(certificateSpki(certificatePem), new Uint8Array(stored.publicKeySpki))) {
    throw new Error("ATK certificate public key does not match this browser's POS private key.");
  }
  await putStoredKey({ ...stored, certificatePem });
}
export async function hasMatchingPosCertificate(identity: BrowserPosIdentity): Promise<boolean> {
  const stored = await getStoredKey(posKeyId(identity));
  if (!stored?.certificatePem) return false;
  try { return equalBytes(certificateSpki(stored.certificatePem), new Uint8Array(stored.publicKeySpki)); }
  catch { return false; }
}

/** Signs SHA-256(UTF8(Base64(Protobuf))) and converts WebCrypto P1363 to the DER sequence ATK expects. */
export async function signAtkBase64Payload(identity: BrowserPosIdentity, detailsBase64: string): Promise<string> {
  const stored = await getStoredKey(posKeyId(identity));
  if (!stored?.certificatePem || !await hasMatchingPosCertificate(identity)) {
    throw new Error("The selected POS has no matching ATK TEST certificate in this browser.");
  }
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, stored.privateKey, encoder.encode(detailsBase64),
  );
  return base64(rawEcdsaToDer(new Uint8Array(signature)));
}
export function generateNuiKf(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const output: string[] = [];
  const bytes = new Uint8Array(32);
  while (output.length < 16) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 252) output.push(alphabet[byte % alphabet.length]);
      if (output.length === 16) break;
    }
  }
  return output.join("");
}

/** Returns the public ATK certificate; private key material is never returned. */
export async function getPosCertificatePem(identity: BrowserPosIdentity): Promise<string> {
  const stored = await getStoredKey(posKeyId(identity));
  if (!stored?.certificatePem || !await hasMatchingPosCertificate(identity)) {
    throw new Error("This browser does not have a matching ATK TEST certificate for the selected POS.");
  }
  return stored.certificatePem;
}
