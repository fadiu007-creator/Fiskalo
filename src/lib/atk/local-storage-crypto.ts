export type EncryptedBrowserPayload = {
  version: 1;
  iv: string;
  ciphertext: string;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function additionalData(scope: string): Uint8Array {
  if (!scope.trim() || scope.length > 128) throw new Error("A valid local storage encryption scope is required.");
  return new TextEncoder().encode("fiskalo-local-storage:" + scope + ":v1");
}

export async function encryptJsonPayload(
  cryptoApi: Crypto,
  key: CryptoKey,
  scope: string,
  value: unknown,
): Promise<EncryptedBrowserPayload> {
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(scope), tagLength: 128 },
    key,
    plaintext,
  );
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptJsonPayload<T>(
  cryptoApi: Crypto,
  key: CryptoKey,
  scope: string,
  encrypted: EncryptedBrowserPayload,
): Promise<T> {
  if (!encrypted || encrypted.version !== 1 || !encrypted.iv || !encrypted.ciphertext) {
    throw new Error("Unsupported or malformed encrypted Fiskalo local record.");
  }
  const plaintext = await cryptoApi.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(encrypted.iv), additionalData: additionalData(scope), tagLength: 128 },
    key,
    fromBase64(encrypted.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
