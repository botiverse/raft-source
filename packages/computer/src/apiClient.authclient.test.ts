// AuthClient.me() — pins the /api/auth/me parse for the signed-in user's
// display identity (task #112: menu showed a raw UUID because the session
// stored only the user id). apiClient imports `fetch` from undici, so network
// stubs go through the undici global dispatcher (MockAgent), not globalThis.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";

import { AuthClient, ServersClient } from "./apiClient.js";
import { ComputerLifecycleClient } from "./localLifecycleIntents.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const PARENT_OPERATION_ID = "44444444-4444-4444-8444-444444444444";

function withMockAgent<T>(
  origin: string,
  setup: (pool: ReturnType<MockAgent["get"]>) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const proxyKeys = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const;
  const previousProxyEnv = new Map(
    proxyKeys.map((key) => [key, process.env[key]] as const),
  );
  for (const key of proxyKeys) delete process.env[key];
  const prev = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  setup(agent.get(origin));
  return fn().finally(async () => {
    setGlobalDispatcher(prev);
    await agent.close();
    for (const [key, value] of previousProxyEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("ComputerLifecycleClient.create binds server identity and legacy completion mode to the lifecycle route", async () => {
  let routeReached = false;
  let receivedServerId: string | undefined;
  const server = createServer(async (req, res) => {
    receivedServerId = req.headers["x-server-id"] as string | undefined;
    if (receivedServerId !== SERVER_ID) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "missing_server_context" }));
      return;
    }

    assert.equal(
      req.url,
      `/api/servers/${SERVER_ID}/machines/${MACHINE_ID}/computer-lifecycle-operations`,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      operationId: string;
      parentOperationId: string;
      action: string;
      targetVersion?: string;
      completionMode?: string;
    };
    assert.deepEqual(body, {
      operationId: OPERATION_ID,
      parentOperationId: PARENT_OPERATION_ID,
      action: "upgrade",
      targetVersion: "1.0.18",
      completionMode: "legacy_k_promoted",
    });
    routeReached = true;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ operationId: OPERATION_ID }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await new ComputerLifecycleClient(
      `http://127.0.0.1:${address.port}`,
      "access-token",
    ).create({
      serverId: SERVER_ID,
      machineId: MACHINE_ID,
      operationId: OPERATION_ID,
      parentOperationId: PARENT_OPERATION_ID,
      action: "upgrade",
      targetVersion: "1.0.18",
      completionMode: "legacy_k_promoted",
    });

    assert.deepEqual(result, { status: "accepted", operationId: OPERATION_ID });
    assert.equal(receivedServerId, SERVER_ID);
    assert.equal(routeReached, true, "server auth must admit the request before lifecycle policy runs");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

async function withLifecycleRejection(
  body: unknown,
  fn: (client: ComputerLifecycleClient) => Promise<void>,
): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(new ComputerLifecycleClient(`http://127.0.0.1:${address.port}`, "access-token"));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("ComputerLifecycleClient preserves only the allowlisted upgrade-policy reason", async () => {
  await withLifecycleRejection({
    code: "computer_broadcast_not_eligible",
    error: "raw server detail must not escape",
    policy: {
      reasonCode: "policy_row_missing",
      policyRevision: "upgrade-kernel-dark-v0",
      internal: "must-not-escape",
    },
  }, async (client) => {
    assert.deepEqual(await client.create({
      serverId: SERVER_ID,
      machineId: MACHINE_ID,
      operationId: OPERATION_ID,
      parentOperationId: PARENT_OPERATION_ID,
      action: "upgrade",
      targetVersion: "1.0.22",
    }), {
      status: "rejected",
      code: "computer_broadcast_not_eligible",
      reason: "policy_row_missing",
    });
  });
});

test("ComputerLifecycleClient drops malformed or unknown policy fields", async () => {
  for (const policy of [
    { reasonCode: "private_internal_reason", policyRevision: "secret-revision" },
    { reasonCode: 123, policyRevision: "secret-revision" },
    "malformed",
  ]) {
    await withLifecycleRejection({
      code: "computer_broadcast_not_eligible",
      policy,
    }, async (client) => {
      assert.deepEqual(await client.create({
        serverId: SERVER_ID,
        machineId: MACHINE_ID,
        operationId: OPERATION_ID,
        parentOperationId: PARENT_OPERATION_ID,
        action: "upgrade",
        targetVersion: "1.0.22",
      }), {
        status: "rejected",
        code: "computer_broadcast_not_eligible",
      });
    });
  }
});

test("AuthClient.me: 200 → success with id/email/name/displayName", async () => {
  await withMockAgent(
    "https://api.test",
    (pool) => {
      pool.intercept({ path: "/api/auth/me", method: "GET" }).reply(200, {
        id: "u-1",
        email: "cindy@example.io",
        name: "cindy zhao",
        displayName: "Cindy",
        avatarUrl: null,
      });
    },
    async () => {
      const r = await new AuthClient("https://api.test", "tok").me();
      assert.equal(r.status, "success");
      if (r.status !== "success") return;
      assert.deepEqual(r.user, { id: "u-1", email: "cindy@example.io", name: "cindy zhao", displayName: "Cindy" });
    },
  );
});

test("AuthClient.me: null displayName tolerated (→ null, not error)", async () => {
  await withMockAgent(
    "https://api.test",
    (pool) => {
      pool.intercept({ path: "/api/auth/me", method: "GET" }).reply(200, { id: "u-1", email: "a@b.io", name: "a", displayName: null });
    },
    async () => {
      const r = await new AuthClient("https://api.test", "tok").me();
      assert.equal(r.status, "success");
      if (r.status !== "success") return;
      assert.equal(r.user.displayName, null);
      assert.equal(r.user.name, "a");
    },
  );
});

test("AuthClient.me: bearer token forwarded", async () => {
  await withMockAgent(
    "https://api.test",
    (pool) => {
      pool
        .intercept({ path: "/api/auth/me", method: "GET", headers: { authorization: "Bearer tok-xyz" } })
        .reply(200, { id: "u-1", email: "a@b.io", name: "a" });
    },
    async () => {
      // intercept only matches with the correct Authorization header; a mismatch
      // falls through to net-connect (disabled) → error.
      const r = await new AuthClient("https://api.test", "tok-xyz").me();
      assert.equal(r.status, "success", "request must carry the bearer token");
    },
  );
});

test("AuthClient.me: 401 → auth_required", async () => {
  await withMockAgent(
    "https://api.test",
    (pool) => {
      pool.intercept({ path: "/api/auth/me", method: "GET" }).reply(401, {});
    },
    async () => {
      const r = await new AuthClient("https://api.test", "stale").me();
      assert.equal(r.status, "auth_required");
    },
  );
});

test("AuthClient.me: 200 with missing required field → error (unexpected_shape), not a throw", async () => {
  await withMockAgent(
    "https://api.test",
    (pool) => {
      pool.intercept({ path: "/api/auth/me", method: "GET" }).reply(200, { id: "u-1" }); // no email/name
    },
    async () => {
      const r = await new AuthClient("https://api.test", "tok").me();
      assert.equal(r.status, "error");
      if (r.status !== "error") return;
      assert.equal(r.code, "unexpected_shape");
    },
  );
});

test("ServersClient.list: malformed 200 row fails closed instead of manufacturing an account mismatch", async () => {
  await withMockAgent(
    "https://api.test",
    (pool) => {
      pool.intercept({ path: "/api/servers/", method: "GET" }).reply(200, [
        { id: "server-1", slug: "alpha", role: "owner" },
        { id: "server-2", slug: "missing-role" },
      ]);
    },
    async () => {
      const result = await new ServersClient("https://api.test", "tok").list();
      assert.deepEqual(result, { status: "error", code: "unexpected_shape" });
    },
  );
});

test("ServersClient.list: valid empty roster remains a successful empty account view", async () => {
  await withMockAgent(
    "https://api.test",
    (pool) => {
      pool.intercept({ path: "/api/servers/", method: "GET" }).reply(200, []);
    },
    async () => {
      const result = await new ServersClient("https://api.test", "tok").list();
      assert.deepEqual(result, { status: "success", servers: [] });
    },
  );
});

test("ServersClient.list: unknown string role remains visible for forward compatibility", async () => {
  await withMockAgent(
    "https://api.test",
    (pool) => {
      pool.intercept({ path: "/api/servers/", method: "GET" }).reply(200, [
        { id: "server-1", slug: "alpha", role: "observer" },
      ]);
    },
    async () => {
      const result = await new ServersClient("https://api.test", "tok").list();
      assert.deepEqual(result, {
        status: "success",
        servers: [
          { id: "server-1", name: "alpha", slug: "alpha", role: "observer" },
        ],
      });
    },
  );
});
