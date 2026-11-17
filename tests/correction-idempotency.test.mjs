import assert from "node:assert/strict";
import test from "node:test";
import { getOrCreateCorrectionIdempotencyKey } from "../src/lib/pos/correction-idempotency.ts";

test("reuses a persisted correction key without generating a replacement", () => {
  let generated = 0;
  const key = getOrCreateCorrectionIdempotencyKey("persisted-key", () => {
    generated += 1;
    return "new-key";
  });

  assert.equal(key, "persisted-key");
  assert.equal(generated, 0);
});

test("trims a persisted correction key before reuse", () => {
  const key = getOrCreateCorrectionIdempotencyKey("  persisted-key  ", () => "new-key");
  assert.equal(key, "persisted-key");
});

test("generates and returns a key only when no persisted key exists", () => {
  let generated = 0;
  const key = getOrCreateCorrectionIdempotencyKey(null, () => {
    generated += 1;
    return "new-key";
  });

  assert.equal(key, "new-key");
  assert.equal(generated, 1);
});

test("rejects an empty generated correction key", () => {
  assert.throws(
    () => getOrCreateCorrectionIdempotencyKey(null, () => "  "),
    /generator returned an empty value/,
  );
});
