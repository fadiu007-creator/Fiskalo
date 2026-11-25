import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyAtkHttpFailure } from "../src/lib/atk/http-submission-outcome.ts";

test("ATK coupon submission never follows redirects", () => {
  const routePath = new URL("../src/app/api/atk/test/coupon/route.ts", import.meta.url);
  const source = readFileSync(routePath, "utf8");
  const requestStart = source.indexOf('fetch("https://fiskalizimi-test.atk-ks.org/pos/coupon"');
  assert.notEqual(requestStart, -1, "the fixed ATK TEST coupon endpoint must remain explicit");
  const requestEnd = source.indexOf("});", requestStart);
  assert.notEqual(requestEnd, -1, "the ATK fetch options must be present");
  const requestOptions = source.slice(requestStart, requestEnd);
  assert.match(requestOptions, /redirect:\s*"manual"/,
    "a redirect must remain a 3xx ambiguous outcome; never forward signed coupon data to another host");
});

test("classifies only known ATK validation and authorization responses as definitive rejections", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(classifyAtkHttpFailure(status), "rejected", String(status));
  }
});

test("keeps unknown client errors and duplicate-sensitive responses ambiguous", () => {
  for (const status of [405, 408, 409, 410, 413, 415, 418, 425, 428, 429, 431, 451]) {
    assert.equal(classifyAtkHttpFailure(status), "ambiguous", String(status));
  }
});

test("keeps redirects and server failures ambiguous", () => {
  for (const status of [300, 301, 302, 304, 307, 308, 500, 501, 502, 503, 504, 599]) {
    assert.equal(classifyAtkHttpFailure(status), "ambiguous", String(status));
  }
});

test("rejects success and invalid HTTP status values", () => {
  for (const status of [100, 199, 200, 201, 204, 299, 600, 999, 400.5, Number.NaN]) {
    assert.throws(() => classifyAtkHttpFailure(status), RangeError, String(status));
  }
});
