import assert from "node:assert/strict";
import test from "node:test";
import {
  ATK_VAT_CLASSIFICATIONS,
  getAtkVatRate,
  isAtkVatCode,
  isValidAtkVatClassification,
} from "../src/lib/atk/product-tax.ts";

test("keeps the four ATK VAT classifications distinct", () => {
  assert.deepEqual(Object.keys(ATK_VAT_CLASSIFICATIONS).sort(), ["A", "C", "D", "E"]);
  assert.equal(getAtkVatRate("A"), 0);
  assert.equal(getAtkVatRate("C"), 0);
  assert.equal(getAtkVatRate("D"), 8);
  assert.equal(getAtkVatRate("E"), 18);
  assert.notEqual(ATK_VAT_CLASSIFICATIONS.A.label, ATK_VAT_CLASSIFICATIONS.C.label);
});

test("accepts only a supported ATK VAT code and its matching numeric rate", () => {
  assert.equal(isAtkVatCode("A"), true);
  assert.equal(isAtkVatCode("X"), false);
  assert.equal(isValidAtkVatClassification("A", 0), true);
  assert.equal(isValidAtkVatClassification("C", 0), true);
  assert.equal(isValidAtkVatClassification("D", 8), true);
  assert.equal(isValidAtkVatClassification("E", 18), true);
  assert.equal(isValidAtkVatClassification("A", 18), false);
  assert.equal(isValidAtkVatClassification("D", 0), false);
  assert.equal(isValidAtkVatClassification("X", 0), false);
  assert.equal(isValidAtkVatClassification("E", Number.NaN), false);
});
