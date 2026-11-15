export type DerNode = { tag: number; start: number; contentStart: number; end: number };

function decodePem(pem: string, begin: string, end: string): Uint8Array {
  const body = pem.replace(begin, "").replace(end, "").replace(/\s/g, "");
  if (!body || body.length > 200_000) throw new Error("Invalid or oversized PEM value.");
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function readDerNode(bytes: Uint8Array, offset: number): DerNode {
  if (offset + 2 > bytes.length) throw new Error("Invalid DER data.");
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 4 || cursor + count > bytes.length) throw new Error("Invalid DER length.");
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + bytes[cursor++];
  }
  const finish = cursor + length;
  if (finish > bytes.length) throw new Error("Truncated DER data.");
  return { tag, start: offset, contentStart: cursor, end: finish };
}

export function getCertificateSpki(certificatePem: string): Uint8Array {
  const bytes = decodePem(certificatePem, "-----BEGIN CERTIFICATE-----", "-----END CERTIFICATE-----");
  const certificate = readDerNode(bytes, 0);
  if (certificate.tag !== 0x30 || certificate.end !== bytes.length) throw new Error("Invalid X.509 certificate sequence.");
  const tbs = readDerNode(bytes, certificate.contentStart);
  if (tbs.tag !== 0x30) throw new Error("Certificate has no TBSCertificate.");
  let cursor = tbs.contentStart;
  let node = readDerNode(bytes, cursor);
  if (node.tag === 0xa0) { cursor = node.end; node = readDerNode(bytes, cursor); }
  for (let index = 0; index < 5; index++) { cursor = node.end; node = readDerNode(bytes, cursor); }
  if (node.tag !== 0x30) throw new Error("Certificate has no SubjectPublicKeyInfo.");
  return bytes.slice(node.start, node.end);
}

export function getCsrSpki(csrPem: string): Uint8Array {
  const bytes = decodePem(csrPem, "-----BEGIN CERTIFICATE REQUEST-----", "-----END CERTIFICATE REQUEST-----");
  const request = readDerNode(bytes, 0);
  if (request.tag !== 0x30 || request.end !== bytes.length) throw new Error("Invalid PKCS#10 request.");
  const info = readDerNode(bytes, request.contentStart);
  if (info.tag !== 0x30) throw new Error("PKCS#10 request has no CertificationRequestInfo.");
  let cursor = info.contentStart;
  let node = readDerNode(bytes, cursor); // version
  cursor = node.end;
  node = readDerNode(bytes, cursor); // subject
  cursor = node.end;
  node = readDerNode(bytes, cursor); // SubjectPublicKeyInfo
  if (node.tag !== 0x30) throw new Error("PKCS#10 request has no SubjectPublicKeyInfo.");
  return bytes.slice(node.start, node.end);
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function derSignatureToP1363(signatureBase64: string): Uint8Array {
  const binary = atob(signatureBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length === 64) return bytes;
  const sequence = readDerNode(bytes, 0);
  if (sequence.tag !== 0x30 || sequence.end !== bytes.length) throw new Error("ECDSA signature must be a DER sequence.");
  const r = readDerNode(bytes, sequence.contentStart);
  const s = readDerNode(bytes, r.end);
  if (r.tag !== 0x02 || s.tag !== 0x02 || s.end !== sequence.end) throw new Error("ECDSA DER signature is malformed.");
  const normalize = (node: DerNode) => {
    let value = bytes.slice(node.contentStart, node.end);
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error("ECDSA signature integer is too large.");
    const result = new Uint8Array(32);
    result.set(value, 32 - value.length);
    return result;
  };
  const raw = new Uint8Array(64);
  raw.set(normalize(r), 0);
  raw.set(normalize(s), 32);
  return raw;
}

export async function verifySignedBase64Payload(
  certificatePem: string,
  payloadBase64: string,
  signatureBase64: string,
): Promise<boolean> {
  const spki = getCertificateSpki(certificatePem);
  const publicKey = await crypto.subtle.importKey(
    "spki", Uint8Array.from(spki).buffer,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Uint8Array.from(derSignatureToP1363(signatureBase64)).buffer,
    new TextEncoder().encode(payloadBase64),
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into an owned ArrayBuffer; TS 5.9 models Uint8Array input as ArrayBufferLike,
  // while WebCrypto BufferSource requires an ArrayBuffer-backed view.
  const input = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function certificateSpkiFingerprint(certificatePem: string): Promise<string> {
  return sha256Hex(getCertificateSpki(certificatePem));
}
