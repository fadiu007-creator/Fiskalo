function skipWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /\s/.test(raw[index])) index += 1;
  return index;
}

function scanStringEnd(raw: string, start: number): number | null {
  if (raw[start] !== '"') return null;
  for (let index = start + 1; index < raw.length; index += 1) {
    if (raw[index] === "\\") {
      index += 1;
    } else if (raw[index] === '"') {
      return index + 1;
    }
  }
  return null;
}

function scanValueEnd(raw: string, start: number): number | null {
  if (raw[start] === '"') return scanStringEnd(raw, start);
  if (raw[start] !== "{" && raw[start] !== "[") {
    let index = start;
    while (index < raw.length && !/[\s,}\]]/.test(raw[index])) index += 1;
    return index > start ? index : null;
  }

  const closers: string[] = [raw[start] === "{" ? "}" : "]"];
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"') {
      const end = scanStringEnd(raw, index);
      if (end === null) return null;
      index = end - 1;
    } else if (character === "{" || character === "[") {
      closers.push(character === "{" ? "}" : "]");
    } else if (character === "}" || character === "]") {
      if (closers.pop() !== character) return null;
      if (closers.length === 0) return index + 1;
    }
  }
  return null;
}

/**
 * Read transaction_id only from the top-level ATK JSON response. The lexical
 * scan preserves integer digits beyond Number.MAX_SAFE_INTEGER and ignores
 * similarly named fields nested in error details or quoted message text.
 */
export function parseAtkTransactionId(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  let index = skipWhitespace(raw, 0);
  if (raw[index] !== "{") return null;
  index += 1;
  let found = false;
  let candidate: string | null = null;

  while (index < raw.length) {
    index = skipWhitespace(raw, index);
    if (raw[index] === "}") break;
    const keyEnd = scanStringEnd(raw, index);
    if (keyEnd === null) return null;
    let key: unknown;
    try {
      key = JSON.parse(raw.slice(index, keyEnd));
    } catch {
      return null;
    }
    index = skipWhitespace(raw, keyEnd);
    if (raw[index] !== ":") return null;
    index = skipWhitespace(raw, index + 1);
    const valueStart = index;
    const valueEnd = scanValueEnd(raw, valueStart);
    if (valueEnd === null) return null;

    if (key === "transaction_id") {
      // Duplicate JSON object names are not interoperable across parsers. A
      // fiscal transaction ID must have exactly one unambiguous top-level value.
      if (found) return null;
      found = true;
      if (raw[valueStart] === '"') {
        try {
          const value: unknown = JSON.parse(raw.slice(valueStart, valueEnd));
          candidate = typeof value === "string" ? value : null;
        } catch {
          candidate = null;
        }
      } else {
        const token = raw.slice(valueStart, valueEnd);
        candidate = /^[0-9]+$/.test(token) ? token : null;
      }
    }

    index = skipWhitespace(raw, valueEnd);
    if (raw[index] === ",") {
      index += 1;
      continue;
    }
    if (raw[index] === "}") break;
    return null;
  }

  if (!found || !candidate || !/^[0-9]+$/.test(candidate)) return null;
  try {
    const value = BigInt(candidate);
    if (value <= BigInt("0") || value > BigInt("18446744073709551615")) return null;
    return value.toString();
  } catch {
    return null;
  }
}
