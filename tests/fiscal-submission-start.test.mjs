import test from "node:test";
import assert from "node:assert/strict";
import { recordFiscalSubmissionStartBestEffort } from "../src/lib/atk/submission-start.ts";

test("sale submission continues through audit and status write failures after durable reservation", async () => {
  const calls = [];
  const errors = [];
  await recordFiscalSubmissionStartBestEffort([
    {
      label: "audit failed",
      run: async () => {
        calls.push("audit");
        return { error: { message: "audit table unavailable" } };
      },
    },
    {
      label: "status failed",
      run: async () => {
        calls.push("status");
        throw new Error("status update unavailable");
      },
    },
    {
      label: "later ledger write",
      run: async () => {
        calls.push("later");
        return { error: null };
      },
    },
  ], (message) => errors.push(message));

  assert.deepEqual(calls, ["audit", "status", "later"]);
  assert.deepEqual(errors, [
    "audit failed: audit table unavailable",
    "status failed: status update unavailable",
  ]);
});

test("successful submission-start ledger writes are quiet", async () => {
  const errors = [];
  await recordFiscalSubmissionStartBestEffort([
    { label: "audit", run: async () => ({ error: null }) },
    { label: "status", run: async () => undefined },
  ], (message) => errors.push(message));
  assert.deepEqual(errors, []);
});
