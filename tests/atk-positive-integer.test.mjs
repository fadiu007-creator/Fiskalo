import test from "node:test";
import assert from "node:assert/strict";
import { positiveInteger } from "../src/lib/atk/positive-integer.ts";

test("accepts only positive safe integer JSON numbers and decimal digit strings", () => {
  assert.equal(positiveInteger(1), 1);
  assert.equal(positiveInteger(9007199254740991), 9007199254740991);
  assert.equal(positiveInteger("1"), 1);
  assert.equal(positiveInteger("0012"), 12);
  for (const value of [0, "0", -1, "-1", 1.5, "1.5", "1e2", " 1", "1 ", true, false, null, undefined, {}, "9007199254740992"]) {
    assert.equal(positiveInteger(value), null, "rejects " + String(value));
  }
});
