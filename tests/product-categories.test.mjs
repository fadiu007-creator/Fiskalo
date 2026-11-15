import test from "node:test";
import assert from "node:assert/strict";
import {
  ATK_ITEM_CATEGORIES,
  ATK_ITEM_CATEGORY_SOURCE,
  getAtkItemCategoryLabel,
  isAtkItemCategoryCode,
} from "../src/lib/atk/product-categories.ts";

test("uses the published ATK May 2026 goods and services categories", () => {
  assert.equal(ATK_ITEM_CATEGORY_SOURCE.publishedOn, "2026-05-29");
  assert.equal(ATK_ITEM_CATEGORIES.length, 35);
  assert.equal(new Set(ATK_ITEM_CATEGORIES.map((item) => item.code)).size, 35);
  assert.ok(ATK_ITEM_CATEGORIES.every((item) => item.label.length > 0));
});

test("accepts exact official category codes and rejects arbitrary text", () => {
  for (const item of ATK_ITEM_CATEGORIES) {
    assert.equal(isAtkItemCategoryCode(item.code), true);
    assert.equal(getAtkItemCategoryLabel(item.code), item.label);
  }
  for (const invalid of ["", "food", "TT ", "ur", "99", "UNKNOWN"]) {
    assert.equal(isAtkItemCategoryCode(invalid), false);
    assert.equal(getAtkItemCategoryLabel(invalid), null);
  }
});
