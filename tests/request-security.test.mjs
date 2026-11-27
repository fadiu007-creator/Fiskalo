import assert from "node:assert/strict";
import test from "node:test";
import { validateSameOriginJsonPost } from "../src/lib/http/request-security.ts";

function request(headers = {}) {
  return new Request("https://fiskalo.example/api/article-44/authority-export", {
    method: "POST",
    headers,
    body: "{}",
  });
}

test("same-origin JSON POST is accepted", () => {
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "https://fiskalo.example",
    "Content-Type": "application/json",
  })), null);
});

test("same-origin JSON POST accepts a UTF-8 charset parameter and case-insensitive media type", () => {
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "https://fiskalo.example",
    "Content-Type": "Application/JSON; charset=utf-8",
  })), null);
});

test("cross-origin POST is rejected before content-type validation", () => {
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "https://attacker.example",
    "Content-Type": "application/json",
  })), "origin");
});

test("missing Origin is rejected", () => {
  assert.equal(validateSameOriginJsonPost(request({
    "Content-Type": "application/json",
  })), "origin");
});

test("malformed and opaque origins are rejected", () => {
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "not-an-origin",
    "Content-Type": "application/json",
  })), "origin");
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "null",
    "Content-Type": "application/json",
  })), "origin");
});

test("missing and non-JSON content types are rejected", () => {
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "https://fiskalo.example",
  })), "content-type");
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "https://fiskalo.example",
    "Content-Type": "text/plain",
  })), "content-type");
});

test("JSONP and form content types are not accepted as JSON", () => {
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "https://fiskalo.example",
    "Content-Type": "application/jsonp",
  })), "content-type");
  assert.equal(validateSameOriginJsonPost(request({
    Origin: "https://fiskalo.example",
    "Content-Type": "application/x-www-form-urlencoded",
  })), "content-type");
});
