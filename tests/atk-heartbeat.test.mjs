import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  createHeartbeatCanonicalMessage,
  handleHeartbeat,
} from "../src/app/api/pos/heartbeat/route.ts";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const businessId = "22222222-2222-4222-8222-222222222222";
const posUuid = "33333333-3333-4333-8333-333333333333";
const userId = "11111111-1111-4111-8111-111111111111";
const nonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const origin = "https://fiskalo.example";

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
  const publicDer = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    privatePem,
    publicKey: pair.publicKey,
    publicKeySpkiBase64: btoa(String.fromCharCode(...publicDer)),
  };
}

function makeRequest(requestNonce = nonce) {
  return new Request(origin + "/api/pos/heartbeat", {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer valid-user-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ businessId, posUuid, nonce: requestNonce }),
  });
}

function mockSupabaseFetch(originalFetch, options = {}) {
  let rpcCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/auth/v1/user") {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer valid-user-token");
      return Response.json({ id: userId });
    }
    if (url.pathname === "/rest/v1/fiskalo_basic_members") {
      return Response.json(options.memberDenied ? [] : [{ business_id: businessId }]);
    }
    if (url.pathname === "/rest/v1/fiskalo_basic_pos") {
      return Response.json(options.posDenied ? [] : [{ id: posUuid, business_id: businessId }]);
    }
    if (url.pathname === "/rest/v1/rpc/fiskalo_record_atk_pos_heartbeat") {
      rpcCalls += 1;
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      assert.equal(body.p_business_id, businessId);
      assert.equal(body.p_pos_id, posUuid);
      assert.equal(body.p_actor_id, userId);
      assert.match(body.p_nonce_sha256, /^[0-9a-f]{64}$/);
      assert.match(body.p_signature_base64, /^[A-Za-z0-9+/]{86}==$/);
      return Response.json([{
        previous_heartbeat_at: options.previousHeartbeatAt ?? null,
        gap_seconds: options.gapSeconds ?? null,
      }]);
    }
    return originalFetch(input, init);
  };
  return () => rpcCalls;
}

test("issues a server-signed heartbeat only after authenticating business membership and POS", async () => {
  const originalFetch = globalThis.fetch;
  const keys = await makeKeyPair();
  const rpcCalls = mockSupabaseFetch(originalFetch, {
    previousHeartbeatAt: "2026-11-17T09:00:00.000Z",
    gapSeconds: 3600,
  });
  try {
    const response = await handleHeartbeat(makeRequest(), {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      ATK_HEARTBEAT_PRIVATE_KEY_PEM: keys.privatePem,
    }, keys.publicKeySpkiBase64);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.environment, "ATK TEST");
    assert.equal(payload.productionEnabled, false);
    assert.equal(payload.businessId, businessId);
    assert.equal(payload.posUuid, posUuid);
    assert.equal(payload.nonce, nonce);
    assert.equal(payload.gapSeconds, 3600);
    assert.equal(payload.gapDetected, true);
    assert.equal(payload.previousHeartbeatAtUtc, "2026-11-17T09:00:00.000Z");
    assert.equal(rpcCalls(), 1);

    const signature = Uint8Array.from(atob(payload.signatureBase64), char => char.charCodeAt(0));
    const canonical = createHeartbeatCanonicalMessage(businessId, posUuid, nonce, payload.issuedAtUnixMs);
    assert.equal(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      signature,
      new TextEncoder().encode(canonical),
    ), true);
    assert.equal(response.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects users without business membership before signing", async () => {
  const originalFetch = globalThis.fetch;
  const keys = await makeKeyPair();
  const rpcCalls = mockSupabaseFetch(originalFetch, { memberDenied: true });
  try {
    const response = await handleHeartbeat(makeRequest(), {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      ATK_HEARTBEAT_PRIVATE_KEY_PEM: keys.privatePem,
    }, keys.publicKeySpkiBase64);
    assert.equal(response.status, 403);
    assert.equal(rpcCalls(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a POS not owned by the requested business", async () => {
  const originalFetch = globalThis.fetch;
  const keys = await makeKeyPair();
  const rpcCalls = mockSupabaseFetch(originalFetch, { posDenied: true });
  try {
    const response = await handleHeartbeat(makeRequest(), {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      ATK_HEARTBEAT_PRIVATE_KEY_PEM: keys.privatePem,
    }, keys.publicKeySpkiBase64);
    assert.equal(response.status, 403);
    assert.equal(rpcCalls(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when the configured signing key does not match the pinned public key", async () => {
  const originalFetch = globalThis.fetch;
  const keys = await makeKeyPair();
  mockSupabaseFetch(originalFetch);
  try {
    const response = await handleHeartbeat(makeRequest(), {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      ATK_HEARTBEAT_PRIVATE_KEY_PEM: keys.privatePem,
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "heartbeat_signing_key_invalid_or_mismatched",
      environment: "ATK TEST",
      productionEnabled: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects cross-origin, unauthenticated and malformed nonce requests", async () => {
  const originalFetch = globalThis.fetch;
  const keys = await makeKeyPair();
  mockSupabaseFetch(originalFetch);
  try {
    const crossOrigin = new Request(origin + "/api/pos/heartbeat", {
      method: "POST",
      headers: { Origin: "https://attacker.example", Authorization: "Bearer valid-user-token" },
      body: JSON.stringify({ businessId, posUuid, nonce }),
    });
    assert.equal((await handleHeartbeat(crossOrigin, {
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role", ATK_HEARTBEAT_PRIVATE_KEY_PEM: keys.privatePem,
    }, keys.publicKeySpkiBase64)).status, 403);

    const unauthenticated = new Request(origin + "/api/pos/heartbeat", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, posUuid, nonce }),
    });
    assert.equal((await handleHeartbeat(unauthenticated, {
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role", ATK_HEARTBEAT_PRIVATE_KEY_PEM: keys.privatePem,
    }, keys.publicKeySpkiBase64)).status, 401);

    assert.equal((await handleHeartbeat(makeRequest("short"), {
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "test-anon",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role", ATK_HEARTBEAT_PRIVATE_KEY_PEM: keys.privatePem,
    }, keys.publicKeySpkiBase64)).status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
