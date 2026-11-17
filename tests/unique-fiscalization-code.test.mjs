import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUniqueFiscalizationCode } from "../src/lib/atk/unique-fiscalization-code.ts";

test("requires the taxpayer-issued EDI Unique Fiscalization Code", () => {
  assert.throws(() => normalizeUniqueFiscalizationCode(""), /i detyrueshëm/);
  assert.throws(() => normalizeUniqueFiscalizationCode("   "), /i detyrueshëm/);
});

test("trims surrounding whitespace but preserves the issued identifier", () => {
  assert.equal(normalizeUniqueFiscalizationCode("  ATK-ISSUED-IDENTIFIER  "), "ATK-ISSUED-IDENTIFIER");
});

test("does not impose an undocumented ATK identifier format", () => {
  assert.equal(normalizeUniqueFiscalizationCode("123456789"), "123456789");
  assert.equal(normalizeUniqueFiscalizationCode("AbC/2026+X"), "AbC/2026+X");
});

test("rejects control characters and unreasonable input length", () => {
  assert.throws(() => normalizeUniqueFiscalizationCode("ABC\\nDEF"), /karaktere të pavlefshme/);
  assert.throws(() => normalizeUniqueFiscalizationCode("A".repeat(129)), /shumë i gjatë/);
});
