export const ARTICLE44_EXPORT_COLUMNS = [
  "generated_at_utc",
  "authority_request_reference",
  "business_name",
  "business_nui",
  "pos_label",
  "branch_id",
  "pos_number",
  "period_from_utc",
  "period_to_utc",
  "source",
  "fiscal_document_id",
  "sale_id",
  "idempotency_key",
  "coupon_id",
  "document_type",
  "reference_coupon_id",
  "original_transaction_id",
  "sale_created_at",
  "document_created_at",
  "issued_at_utc",
  "offline_issued_at_utc",
  "recovery_deadline_utc",
  "status",
  "atk_transaction_id",
  "daily_number",
  "nui_kf",
  "verification_no",
  "fiscalization_number",
  "total_eur",
  "signed_payload_base64",
  "signature_base64",
  "citizen_payload_base64",
  "citizen_signature_base64",
  "citizen_qr_payload",
  "qr_svg_base64",
  "atk_response",
  "last_error",
  "attempt_count"
] as const;

export type Article44ExportColumn = typeof ARTICLE44_EXPORT_COLUMNS[number];
export type Article44ExportRow = Partial<Record<Article44ExportColumn, string | number | null | undefined>>;

function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = typeof value === "string" && /^[=+@\t\r-]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function buildArticle44Csv(rows: readonly Article44ExportRow[]): string {
  const header = ARTICLE44_EXPORT_COLUMNS.map(csvCell).join(",");
  const records = rows.map(row => ARTICLE44_EXPORT_COLUMNS.map(column => csvCell(row[column])).join(","));
  return [header, ...records].join("\r\n") + "\r\n";
}

export type Article44AuthorityEvidenceManifestEntry = {
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
};

export type Article44EvidenceDownload = {
  bytes: ArrayBuffer;
  mimeType: string;
};

const ARTICLE44_AUTHORITY_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
const ARTICLE44_AUTHORITY_EVIDENCE_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
}

function evidenceMimeMismatch(): never {
  throw new Error("Stored evidence bytes do not match the declared MIME type.");
}

function decodeEvidenceText(bytes: Uint8Array): string {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
  } catch {
    return evidenceMimeMismatch();
  }
}

/**
 * Storage content-type metadata is supplied at upload time and is not proof of
 * the file format. Verify a conservative signature or text encoding against
 * the downloaded bytes before recording Article 44 evidence.
 */
function assertEvidenceBytesMatchMime(bytes: ArrayBuffer, mimeType: string): void {
  const data = new Uint8Array(bytes);
  switch (mimeType) {
    case "application/pdf": {
      const header = data.subarray(0, Math.min(data.byteLength, 1024));
      const marker = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
      let found = false;
      for (let offset = 0; offset <= header.byteLength - marker.length; offset += 1) {
        if (marker.every((value, index) => header[offset + index] === value)) {
          found = true;
          break;
        }
      }
      if (!found) evidenceMimeMismatch();
      return;
    }
    case "image/png": {
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (data.byteLength < signature.length ||
          !signature.every((value, index) => data[index] === value)) evidenceMimeMismatch();
      return;
    }
    case "image/jpeg":
      if (data.byteLength < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
        evidenceMimeMismatch();
      }
      return;
    case "text/plain":
    case "text/csv": {
      const text = decodeEvidenceText(data);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
        evidenceMimeMismatch();
      }
      return;
    }
    case "application/json": {
      const text = decodeEvidenceText(data);
      try {
        JSON.parse(text);
      } catch {
        evidenceMimeMismatch();
      }
      return;
    }
    default:
      evidenceMimeMismatch();
  }
}

/** Verify authority-request evidence against bytes downloaded from private Storage. */
export async function verifyArticle44AuthorityEvidenceManifest(
  input: unknown,
  businessId: string,
  incidentId: string,
  download: (storagePath: string) => Promise<Article44EvidenceDownload>,
): Promise<Article44AuthorityEvidenceManifestEntry[]> {
  if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(incidentId)) {
    throw new Error("A valid business and incident identity are required.");
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    throw new Error("One to twenty authority-request evidence files are required.");
  }

  const seen = new Set<string>();
  const verified: Article44AuthorityEvidenceManifestEntry[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Authority-request evidence manifest contains an invalid entry.");
    }
    const entry = candidate as Record<string, unknown>;
    const storagePath = typeof entry.storage_path === "string" ? entry.storage_path : "";
    const fileName = typeof entry.file_name === "string" ? entry.file_name : "";
    const mimeType = typeof entry.mime_type === "string" ? entry.mime_type.toLowerCase().trim() : "";
    const sizeBytes = entry.size_bytes;
    const expectedHash = typeof entry.sha256 === "string" ? entry.sha256 : "";
    const pathParts = storagePath.split("/");
    const storedName = pathParts[2] ?? "";

    if (pathParts.length !== 3 || pathParts[0] !== businessId || pathParts[1] !== incidentId ||
        !storedName.startsWith("authority-request-") ||
        !/^[A-Za-z0-9._-]{1,220}$/.test(storedName) || storedName.includes("..") ||
        storagePath.length > 512 || seen.has(storagePath)) {
      throw new Error("Authority-request evidence must use a unique private path for this business and incident.");
    }
    if (!fileName || fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(fileName)) {
      throw new Error("Authority-request evidence has an invalid file name.");
    }
    if (!ARTICLE44_AUTHORITY_EVIDENCE_MIMES.has(mimeType)) {
      throw new Error("Authority-request evidence must be PDF, JPG, PNG or TXT.");
    }
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 || sizeBytes > ARTICLE44_AUTHORITY_EVIDENCE_MAX_BYTES) {
      throw new Error("Authority-request evidence must be between 1 byte and 10 MB.");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error("Authority-request evidence must include a lowercase SHA-256 digest.");
    }

    seen.add(storagePath);
    const stored = await download(storagePath);
    if (!(stored.bytes instanceof ArrayBuffer) || stored.bytes.byteLength !== sizeBytes) {
      throw new Error("Stored authority-request evidence size does not match its manifest.");
    }
    if (typeof stored.mimeType !== "string" || stored.mimeType.toLowerCase().trim() !== mimeType) {
      throw new Error("Stored authority-request evidence MIME type does not match its manifest.");
    }
    assertEvidenceBytesMatchMime(stored.bytes, mimeType);
    if (await sha256Hex(stored.bytes) !== expectedHash) {
      throw new Error("Stored authority-request evidence SHA-256 does not match its manifest.");
    }
    verified.push({ storage_path: storagePath, file_name: fileName, mime_type: mimeType, size_bytes: sizeBytes, sha256: expectedHash });
  }
  return verified;
}


export type Article44FilingEvidenceKind = "notice" | "monthly_submission";

/**
 * Verify Article 44(5)/(6) filing evidence against the exact bytes held in
 * private Storage. The database RPCs are server-role-only, so callers cannot
 * bypass this byte-level verification with a forged client-side digest.
 */
export async function verifyArticle44FilingEvidenceManifest(
  input: unknown,
  businessId: string,
  incidentId: string,
  kind: Article44FilingEvidenceKind,
  download: (storagePath: string) => Promise<Article44EvidenceDownload>,
): Promise<Article44AuthorityEvidenceManifestEntry[]> {
  if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(incidentId)) {
    throw new Error("A valid business and incident identity are required.");
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    throw new Error("One to twenty filing evidence files are required.");
  }

  const allowedMimes = kind === "notice"
    ? new Set(["application/pdf", "image/jpeg", "image/png", "text/plain"])
    : new Set(["application/pdf", "image/jpeg", "image/png", "text/plain", "application/json", "text/csv"]);
  const storedNamePattern = kind === "notice"
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,100}$/i
    : /^monthly-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,100}$/i;
  const maxBytes = 10 * 1024 * 1024;
  const seen = new Set<string>();
  const verified: Article44AuthorityEvidenceManifestEntry[] = [];

  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Filing evidence manifest contains an invalid entry.");
    }
    const entry = candidate as Record<string, unknown>;
    const storagePath = typeof entry.storage_path === "string" ? entry.storage_path : "";
    const fileName = typeof entry.file_name === "string" ? entry.file_name : "";
    const mimeType = typeof entry.mime_type === "string" ? entry.mime_type.toLowerCase().trim() : "";
    const sizeBytes = entry.size_bytes;
    const expectedHash = typeof entry.sha256 === "string" ? entry.sha256 : "";
    const pathParts = storagePath.split("/");
    const storedName = pathParts[2] ?? "";

    if (pathParts.length !== 3 || pathParts[0] !== businessId || pathParts[1] !== incidentId ||
        !storedNamePattern.test(storedName) || storedName.includes("..") ||
        storagePath.length > 512 || seen.has(storagePath)) {
      throw new Error("Filing evidence must use a unique private path for this business and incident.");
    }
    if (!fileName || fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(fileName)) {
      throw new Error("Filing evidence has an invalid file name.");
    }
    if (!allowedMimes.has(mimeType)) {
      throw new Error(kind === "notice"
        ? "Notice evidence must be PDF, JPG, PNG or TXT."
        : "Monthly filing evidence must be PDF, JPG, PNG, TXT, CSV or JSON.");
    }
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 || sizeBytes > maxBytes) {
      throw new Error("Filing evidence must be between 1 byte and 10 MB.");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error("Filing evidence must include a lowercase SHA-256 digest.");
    }

    seen.add(storagePath);
    const stored = await download(storagePath);
    if (!(stored.bytes instanceof ArrayBuffer) || stored.bytes.byteLength !== sizeBytes ||
        stored.bytes.byteLength > maxBytes) {
      throw new Error("Stored filing evidence size does not match its manifest.");
    }
    if (typeof stored.mimeType !== "string" || stored.mimeType.toLowerCase().trim() !== mimeType) {
      throw new Error("Stored filing evidence MIME type does not match its manifest.");
    }
    assertEvidenceBytesMatchMime(stored.bytes, mimeType);
    if (await sha256Hex(stored.bytes) !== expectedHash) {
      throw new Error("Stored filing evidence SHA-256 does not match its manifest.");
    }
    verified.push({
      storage_path: storagePath,
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      sha256: expectedHash
    });
  }

  if (kind === "monthly_submission") {
    const hasCsv = verified.some(entry => entry.mime_type === "text/csv");
    const hasDeliveryProof = verified.some(entry =>
      ["application/pdf", "image/jpeg", "image/png", "text/plain"].includes(entry.mime_type));
    if (!hasCsv || !hasDeliveryProof) {
      throw new Error("Monthly filing evidence must include a CSV export and proof of delivery.");
    }
  }
  return verified;
}
