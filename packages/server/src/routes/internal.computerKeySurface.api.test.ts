import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import { attachComputer } from "../services/computerCredentialService";
import { computerRestartDoneWebFrame } from "../services/agentOrchestrator";

// A Computer key (sk_computer_*) reaches /internal/* only for scope attestation,
// and no machine credential reads attachments (#proj-raft-computer:8e6a4629).
// Legacy sk_machine_* daemons keep the rest of the legacy surface until its own retirement.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed() {
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({
      email: "computer-key-surface@slock.test",
      name: "computer-key-surface",
      displayName: "Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  const server = await createServer("Computer Key Surface", "computer-key-surface", owner.id);
  const legacy = await registerMachine(server.id, owner.id, "legacy-machine");
  const computer = await attachComputer({ userId: owner.id, serverSlug: server.slug, name: "computer-machine" });
  assert.ok(computer.ok, "computer attachment should succeed");
  return { server, legacyKey: legacy.apiKey, computerKey: computer.apiKey };
}

function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

test("a Computer key is refused on the legacy machine and agent-on-behalf routes", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { computerKey } = await seed();
    const requests: Array<[string, string]> = [
      ["GET", "/internal/machine/agents"],
      ["GET", "/internal/machine/self"],
      ["POST", `/internal/machine/agents/${randomUUID()}/start`],
      ["POST", `/internal/agent/${randomUUID()}/send`],
      ["GET", `/internal/agent/${randomUUID()}/history`],
      ["PATCH", `/internal/agent/${randomUUID()}/server`],
    ];
    for (const [method, path] of requests) {
      const res = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers: bearer(computerKey),
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      assert.equal(res.status, 403, `${method} ${path}`);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "machine_key_route_retired", `${method} ${path}`);
    }
  } finally {
    await app.close();
  }
});

test("a legacy machine key still reaches the legacy machine routes", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { legacyKey } = await seed();
    const res = await fetch(`${app.baseUrl}/internal/machine/agents`, { headers: bearer(legacyKey) });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

test("no machine credential reads attachments", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { server, legacyKey, computerKey } = await seed();
    for (const key of [legacyKey, computerKey]) {
      const res = await fetch(`${app.baseUrl}/api/attachments/${randomUUID()}?serverId=${server.id}`, {
        headers: { ...bearer(key), "X-Server-Id": server.id },
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json() as { code?: string }).code, "machine_key_route_retired");
    }
  } finally {
    await app.close();
  }
});

test("a Computer key reaches scope attestation only with POST", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { computerKey } = await seed();
    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, { headers: bearer(computerKey) });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { code?: string }).code, "machine_key_route_retired");
  } finally {
    await app.close();
  }
});

test("computer:restart:done reaches web clients with only its declared fields and the server's machine id", () => {
  const spoofed = {
    type: "computer:restart:done" as const,
    requestId: "req-1",
    ok: false,
    error: "x".repeat(500),
    machineId: "someone-elses-machine",
    payload: "<script>",
  };
  const frame = computerRestartDoneWebFrame("this-machine", spoofed);
  assert.deepEqual(Object.keys(frame).sort(), ["error", "machineId", "ok", "requestId", "type"]);
  assert.equal(frame.machineId, "this-machine");
  assert.equal(frame.error?.length, 200);
  assert.deepEqual(
    computerRestartDoneWebFrame("this-machine", { type: "computer:restart:done", requestId: "req-2", ok: true }),
    { type: "computer:restart:done", machineId: "this-machine", requestId: "req-2", ok: true },
  );
});
