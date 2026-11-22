import test from "node:test";
import assert from "node:assert/strict";
import { canManageAtkPos } from "../src/lib/atk/pos-authorization.ts";

test("ATK POS certificate provisioning is limited to owners and administrators", () => {
  assert.equal(canManageAtkPos("owner"), true);
  assert.equal(canManageAtkPos("administrator"), true);
  assert.equal(canManageAtkPos("manager"), false);
  assert.equal(canManageAtkPos("cashier"), false);
  assert.equal(canManageAtkPos("accountant"), false);
  assert.equal(canManageAtkPos(null), false);
  assert.equal(canManageAtkPos(undefined), false);
  assert.equal(canManageAtkPos("OWNER"), false);
});
