import test from "node:test";
import assert from "node:assert/strict";
import {
  ATK_ITEM_CATEGORIES,
  ATK_ITEM_CATEGORY_OPTIONS,
  ATK_ITEM_CATEGORY_SOURCE,
  getAtkItemCategoryLabel,
  isAtkItemCategoryCode,
} from "../src/lib/atk/product-categories.ts";

test("preserves all 53 published ATK 2026 category rows and 52 unique codes", () => {
  assert.equal(ATK_ITEM_CATEGORY_SOURCE.publishedOn, "2026-05-29");
  assert.equal(ATK_ITEM_CATEGORIES.length, 53);
  assert.equal(new Set(ATK_ITEM_CATEGORIES.map((item) => item.code)).size, 52);
  assert.equal(ATK_ITEM_CATEGORY_OPTIONS.length, 52);
  assert.ok(ATK_ITEM_CATEGORIES.every((item) => item.label.length > 0));
  assert.equal(getAtkItemCategoryLabel("PM"), "Pajisje mjekësore / Produkte të miellit");
});

test("accepts exact official category codes and rejects arbitrary text", () => {
  for (const item of ATK_ITEM_CATEGORIES) {
    assert.equal(isAtkItemCategoryCode(item.code), true);
    assert.notEqual(getAtkItemCategoryLabel(item.code), null);
  }
  for (const invalid of ["", "food", "TT ", "ur", "99", "UNKNOWN"]) {
    assert.equal(isAtkItemCategoryCode(invalid), false);
    assert.equal(getAtkItemCategoryLabel(invalid), null);
  }
});
