import test from "node:test";
import assert from "node:assert/strict";
import { parseAtkTransactionId } from "../src/lib/atk/transaction-id.ts";

test("preserves the exact top-level ATK uint64 transaction identifier", () => {
  assert.equal(parseAtkTransactionId('{"transaction_id":18446744073709551615}'), "18446744073709551615");
  assert.equal(parseAtkTransactionId('{"transaction_id":"9007199254740993"}'), "9007199254740993");
  assert.equal(parseAtkTransactionId('{"transaction_id":42,"message":"accepted"}'), "42");
});

test("does not mistake nested identifiers or message text for ATK acceptance", () => {
  assert.equal(parseAtkTransactionId('{"error":{"transaction_id":"123"}}'), null);
  assert.equal(parseAtkTransactionId('{"message":"response included \\"transaction_id\\":123"}'), null);
  assert.equal(parseAtkTransactionId('{"message":"accepted","data":{"transaction_id":123}}'), null);
});

test("rejects invalid, zero, negative, fractional, and overflowing identifiers", () => {
  assert.equal(parseAtkTransactionId('{"transaction_id":0}'), null);
  assert.equal(parseAtkTransactionId('{"transaction_id":-1}'), null);
  assert.equal(parseAtkTransactionId('{"transaction_id":1.5}'), null);
  assert.equal(parseAtkTransactionId('{"transaction_id":18446744073709551616}'), null);
  assert.equal(parseAtkTransactionId('{"transaction_id":"not-a-number"}'), null);
  assert.equal(parseAtkTransactionId('{"transaction_id":null}'), null);
  assert.equal(parseAtkTransactionId('{"transaction_id":123'), null);
  assert.equal(parseAtkTransactionId('[]'), null);
});

test("uses the final top-level value when duplicate JSON keys are present", () => {
  assert.equal(parseAtkTransactionId('{"transaction_id":12,"transaction_id":0}'), null);
  assert.equal(parseAtkTransactionId('{"transaction_id":0,"transaction_id":12}'), "12");
});
