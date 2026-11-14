import assert from "node:assert/strict";
import test from "node:test";
import {
  ATK_MEASUREMENT_UNITS,
  ATK_MEASUREMENT_UNIT_SOURCE,
  getAtkUnitLabel,
  isAtkUnitCode,
  normalizeAtkUnitCode,
} from "../src/lib/atk/product-units.ts";

test("contains the 21 measurement-unit codes from the 29 September 2026 ATK catalogue", () => {
  assert.equal(ATK_MEASUREMENT_UNIT_SOURCE.publishedOn, "2026-09-29");
  assert.equal(ATK_MEASUREMENT_UNITS.length, 21);
  assert.deepEqual(
    ATK_MEASUREMENT_UNITS.map((unit) => unit.code),
    ["EA", "CP", "LTR", "SEC", "MIN", "HUR", "DAY", "MON", "ANN", "KGB", "KGN", "TN", "GRM", "M4", "UDH", "KMT", "LM", "MTS", "MTV", "MSK", "KWH"],
  );
  assert.equal(new Set(ATK_MEASUREMENT_UNITS.map((unit) => unit.code)).size, 21);
});

test("validates exact ATK unit codes and preserves their official labels", () => {
  assert.equal(isAtkUnitCode("CP"), true);
  assert.equal(isAtkUnitCode("EA"), true);
  assert.equal(isAtkUnitCode("cope"), false);
  assert.equal(isAtkUnitCode("XX"), false);
  assert.equal(getAtkUnitLabel("CP"), "Copë");
  assert.equal(getAtkUnitLabel("EA"), "Një (njësi)");
  assert.equal(getAtkUnitLabel("cope"), null);
});

test("normalizes whitespace and case only when the resulting code is official", () => {
  assert.equal(normalizeAtkUnitCode(" cp "), "CP");
  assert.equal(normalizeAtkUnitCode("ltr"), "LTR");
  assert.equal(normalizeAtkUnitCode("cope"), null);
  assert.equal(normalizeAtkUnitCode(""), null);
});
