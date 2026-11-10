import { createWorkerHandler, type WorkerHandlerDependencies } from "./handler.ts";

const businessId = "b4a65b6e-14b5-4a1c-9b0c-8a4b6b1c0a22";
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function createDependencies(overrides: Partial<WorkerHandlerDependencies> = {}): WorkerHandlerDependencies {
  return {
    authenticate: async (token) => token === "valid-token" ? { id: "owner-user" } : null,
    isOwner: async () => true,
    listMembers: async () => [],
    getUserEmail: async () => null,
    resolveUser: async () => ({ id: "cashier-user", invited: true, delivery: "sent" }),
    attachCashier: async () => "added",
    ...overrides,
  };
}
function post(handler: (request: Request) => Promise<Response>, body: unknown, token = "valid-token") {
  return handler(new Request("https://fiskalo.test/functions/v1/fiskalo-basic-workers", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
  }));
}

Deno.test("rejects requests without an authenticated owner session", async () => {
  const response = await post(createWorkerHandler(createDependencies()), { action: "list", businessId }, "");
  assert(response.status === 401, "missing bearer token must be rejected");
});
Deno.test("rejects a non-owner before changing membership", async () => {
  let resolved = false;
  const handler = createWorkerHandler(createDependencies({
    isOwner: async () => false,
    resolveUser: async () => {
      resolved = true;
      return { id: "cashier-user", invited: true, delivery: "sent" };
    },
  }));
  const response = await post(handler, { action: "invite", businessId, email: "cashier@example.com" });
  assert(response.status === 403, "non-owner must be forbidden");
  assert(!resolved, "non-owner must not reach the invitation operation");
});
Deno.test("normalizes email and attaches a newly invited cashier", async () => {
  let attachedUser = "";
  const handler = createWorkerHandler(createDependencies({
    resolveUser: async (email) => {
      assert(email === "cashier@example.com", "email must be trimmed and lowercased");
      return { id: "cashier-user", invited: true, delivery: "sent" };
    },
    attachCashier: async (_businessId, userId) => {
      attachedUser = userId;
      return "added";
    },
  }));
  const response = await post(handler, { action: "invite", businessId, email: " Cashier@Example.com " });
  const body = await response.json() as { invited?: boolean; alreadyMember?: boolean };
  assert(response.status === 200, "valid owner invitation should succeed");
  assert(attachedUser === "cashier-user", "invited user must be attached to the business");
  assert(body.invited === true, "successful invite delivery must be reported");
  assert(body.alreadyMember === false, "new membership must not be reported as a duplicate");
});
Deno.test("adds an existing account without sending a second invitation", async () => {
  const handler = createWorkerHandler(createDependencies({
    resolveUser: async () => ({ id: "existing-user", invited: false, delivery: "existing" }),
  }));
  const response = await post(handler, { action: "invite", businessId, email: "existing@example.com" });
  const body = await response.json() as { invited?: boolean; delivery?: string };
  assert(response.status === 200, "existing account should be attachable");
  assert(body.invited === false, "existing account must not be reported as newly invited");
  assert(body.delivery === "existing", "existing account delivery state must be explicit");
});
Deno.test("treats repeated invitations as idempotent membership operations", async () => {
  const handler = createWorkerHandler(createDependencies({
    resolveUser: async () => ({ id: "cashier-user", invited: false, delivery: "existing" }),
    attachCashier: async () => "already_member",
  }));
  const response = await post(handler, { action: "invite", businessId, email: "cashier@example.com" });
  const body = await response.json() as { alreadyMember?: boolean };
  assert(response.status === 200, "repeated invitation should be safe");
  assert(body.alreadyMember === true, "existing cashier membership must be reported");
});
Deno.test("rejects invalid email addresses", async () => {
  let resolved = false;
  const handler = createWorkerHandler(createDependencies({
    resolveUser: async () => {
      resolved = true;
      return { id: "cashier-user", invited: true, delivery: "sent" };
    },
  }));
  const response = await post(handler, { action: "invite", businessId, email: "not-an-email" });
  assert(response.status === 400, "invalid email must be rejected");
  assert(!resolved, "invalid email must not reach Supabase Auth");
});
Deno.test("lists only the authorized business membership and resolves email addresses", async () => {
  const handler = createWorkerHandler(createDependencies({
    listMembers: async (requestedBusinessId) => {
      assert(requestedBusinessId === businessId, "member lookup must use the requested business scope");
      return [{ userId: "cashier-user", role: "cashier", operatorName: "Arketari", createdAt: "2026-11-10T08:00:00.000Z" }];
    },
    getUserEmail: async (userId) => userId === "cashier-user" ? "cashier@example.com" : null,
  }));
  const response = await post(handler, { action: "list", businessId });
  const body = await response.json() as { members?: Array<{ email?: string | null; role?: string }> };
  assert(response.status === 200, "owner should be able to list members");
  assert(body.members?.length === 1, "only the requested business members should be returned");
  assert(body.members?.[0].email === "cashier@example.com", "member email should be resolved");
  assert(body.members?.[0].role === "cashier", "member role should be preserved");
});
Deno.test("returns CORS preflight without requiring a session", async () => {
  const handler = createWorkerHandler(createDependencies());
  const response = await handler(new Request("https://fiskalo.test/functions/v1/fiskalo-basic-workers", { method: "OPTIONS" }));
  assert(response.status === 204, "preflight should succeed");
  assert(response.headers.get("Access-Control-Allow-Methods")?.includes("POST"), "POST should be allowed");
});
