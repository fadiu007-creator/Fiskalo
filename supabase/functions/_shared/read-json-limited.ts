export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the configured size limit.");
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidRequestBodyError extends Error {
  constructor(message = "Request body must contain valid UTF-8 JSON.") {
    super(message);
    this.name = "InvalidRequestBodyError";
  }
}

/**
 * Read and parse a JSON request while enforcing the byte limit on the actual
 * streamed body. Content-Length is only an early-rejection hint: it is not
 * trusted as the sole size check because it may be absent or smaller than the
 * bytes delivered by a streaming request.
 */
export async function readJsonBodyLimited(request: Request, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new InvalidRequestBodyError("Request Content-Length is invalid.");
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      throw new RequestBodyTooLargeError();
    }
  }

  if (!request.body) {
    throw new InvalidRequestBodyError();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new InvalidRequestBodyError("Request body stream returned an invalid chunk.");
      }
      if (value.byteLength > maxBytes - totalBytes) {
        try {
          await reader.cancel("Request body size limit exceeded.");
        } catch {
          // Cancellation is best-effort; the size violation remains decisive.
        }
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || error instanceof InvalidRequestBodyError) {
      throw error;
    }
    throw new InvalidRequestBodyError("Request body could not be read.");
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && Number(declaredLength) !== totalBytes) {
    throw new InvalidRequestBodyError("Request Content-Length does not match the received body.");
  }
  if (totalBytes === 0) {
    throw new InvalidRequestBodyError();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidRequestBodyError("Request body must be valid UTF-8.");
  }

  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new InvalidRequestBodyError();
  }
}
