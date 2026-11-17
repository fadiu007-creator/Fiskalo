import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker from "../workers/atk-recovery.ts";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const businessId = "6f54e9ac-7b21-4c8d-a84b-8a9e1d8f0001";
const posUuid = "7f54e9ac-7b21-4c8d-a84b-8a9e1d8f0002";
const userId = "8f54e9ac-7b21-4c8d-a84b-8a9e1d8f0003";
const nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const origin = "https://fiskalo.shqiptare.workers.dev";

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privatePem = "-----BEGIN PRIVATE KEY-----\n" +
    btoa(String.fromCharCode(...privateDer)).match(/.{1,64}/g).join("\n") +
    "\n-----END PRIVATE KEY-----";
  return { privatePem, publicKey: pair.publicKey };
}

function mockFetch(originalFetch) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/auth/v1/user") {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer valid-user-token");
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/fiskalo_basic_pos") {
      return Response.json([{ id: posUuid, business_id: businessId }]);
    }
    if (url.pathname === "/rest/v1/fiskalo_basic_members") {
      return Response.json([{ business_id: businessId, user_id: userId }]);
    }
    if (url.pathname === "/rest/v1/rpc/fiskalo_record_atk_pos_heartbeat") {
      assert.equal(init.method, "POST");
      const evidence = JSON.parse(init.body);
      assert.equal(evidence.p_business_id, businessId);
      assert.equal(evidence.p_pos_id, posUuid);
      assert.equal(evidence.p_actor_id, userId);
      assert.equal(evidence.p_server_time_utc !== undefined, true);
      assert.match(evidence.p_nonce_sha256, /^[0-9a-f]{64}$/);
      assert.ok(evidence.p_signature_base64);
      return Response.json([{ previous_heartbeat_at: null, gap_seconds: null }]);
    }
    if (url.pathname === "/rest/v1/fiskalo_atk_pos_installations" ||
        url.pathname === "/rest/v1/fiskalo_organization_users") {
      return Response.json([]);
    }
    return originalFetch(input, init);
  };
}

test("issues a P-256 signed heartbeat only for an authenticated POS member", async () => {
  const originalFetch = globalThis.fetch;
  const keys = await makeKeyPair();
  mockFetch(originalFetch);
  try {
    const request = new Request("https://recovery.example/heartbeat", {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer valid-user-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ businessId, posUuid, nonce }),
    });
    const response = await worker.fetch(request, {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      ATK_HEARTBEAT_PRIVATE_KEY_PEM: keys.privatePem,
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.version, 1);
    assert.equal(payload.businessId, businessId);
    assert.equal(payload.posUuid, posUuid);
    assert.equal(payload.nonce, nonce);
    assert.equal(payload.productionEnabled, false);
    assert.equal(payload.gapDetected, false);
    assert.equal(payload.previousHeartbeatAtUtc, null);
    assert.ok(Number.isSafeInteger(payload.issuedAtUnixMs));
    const message = [
      "fiskalo-atk-heartbeat-v1",
      businessId.toLowerCase(),
      posUuid.toLowerCase(),
      nonce,
      String(payload.issuedAtUnixMs),
    ].join("\n");
    const signature = Uint8Array.from(atob(payload.signatureBase64), char => char.charCodeAt(0));
    assert.equal(signature.length, 64);
    assert.equal(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      signature,
      new TextEncoder().encode(message),
    ), true);
    assert.equal(response.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when the signing secret is absent", async () => {
  const originalFetch = globalThis.fetch;
  mockFetch(originalFetch);
  try {
    const response = await worker.fetch(new Request("https://recovery.example/heartbeat", {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer valid-user-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ businessId, posUuid, nonce }),
    }), {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "heartbeat_not_configured" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects unauthenticated requests before reading POS membership", async () => {
  const response = await worker.fetch(new Request("https://recovery.example/heartbeat", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ businessId, posUuid, nonce }),
  }), {
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    ATK_HEARTBEAT_PRIVATE_KEY_PEM: "unused",
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
});
