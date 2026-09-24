import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { createAgent } from "../services/agentService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Raft-Client": "cli",
  };
}

async function seed() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `app-config-${suffix}@slock.test`,
    name: `app-config-${suffix}`,
    displayName: "App Config Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("App Config API", `app-config-${suffix}`, owner.id);
  const agentA = await createAgent(server.id, `ConfigA${suffix.slice(0, 6)}`);
  const agentB = await createAgent(server.id, `ConfigB${suffix.slice(0, 6)}`);
  const writeA = await mintAgentCredential({
    agentId: agentA.id,
    scopes: ["read", "tasks"],
    name: "app-config-write-a",
    createdByUserId: null,
  });
  const readA = await mintAgentCredential({
    agentId: agentA.id,
    scopes: ["read"],
    name: "app-config-read-a",
    createdByUserId: null,
  });
  const writeB = await mintAgentCredential({
    agentId: agentB.id,
    scopes: ["read", "tasks"],
    name: "app-config-write-b",
    createdByUserId: null,
  });
  return {
    writeA: writeA.apiKey,
    readA: readA.apiKey,
    writeB: writeB.apiKey,
    agentAId: agentA.id,
    agentBId: agentB.id,
  };
}

/** Captures what the route actually pushed to the owner's Computer. */
type PushCall = { agentId: string; config: { appId: string; ownerAgentId: string; revision: number; effective: Record<string, unknown> } };

function installPushRecorder(app: { get(key: string): unknown }): PushCall[] {
  const calls: PushCall[] = [];
  const orchestrator = app.get("agentOrchestrator") as {
    pushAppConfigUpsert: (agentId: string, config: PushCall["config"]) => Promise<boolean>;
  };
  orchestrator.pushAppConfigUpsert = async (agentId, config) => {
    calls.push({ agentId, config });
    return true;
  };
  return calls;
}

test("agent-api App config is credential-bound, capability-gated, CAS-safe, and omits Server timer ownership", async ({ app }) => {
  const fixture = await seed();
  const path = "/internal/agent-api/apps/system.cleaner/config";

  const initial = await fetch(`${app.baseUrl}${path}`, { headers: headers(fixture.writeA) });
  const initialText = await initial.text();
  assert.equal(initial.status, 200, initialText);
  assert.deepEqual(JSON.parse(initialText), {
    appId: "system.cleaner",
    revision: 0,
    schema: {
      enabled: { type: "boolean" },
      threshold_bytes: { type: "integer", minimum: 4096, maximum: 1073741824 },
      interval_seconds: { type: "integer", minimum: 900, maximum: 604800 },
    },
    defaults: { enabled: true, threshold_bytes: 65536, interval_seconds: 3600 },
    overrides: {},
    effective: { enabled: true, threshold_bytes: 65536, interval_seconds: 3600 },
  });

  const denied = await fetch(`${app.baseUrl}${path}`, {
    method: "PATCH",
    headers: headers(fixture.readA),
    body: JSON.stringify({ expectedRevision: 0, set: { enabled: false }, unset: [] }),
  });
  assert.equal(denied.status, 403);

  const updated = await fetch(`${app.baseUrl}${path}`, {
    method: "PATCH",
    headers: headers(fixture.writeA),
    body: JSON.stringify({
      expectedRevision: 0,
      set: { enabled: false, threshold_bytes: 131072 },
      unset: [],
    }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as Record<string, unknown>;
  assert.equal(updatedBody.revision, 1);
  assert.deepEqual(updatedBody.overrides, { enabled: false, threshold_bytes: 131072 });
  assert.equal(
    Object.hasOwn(updatedBody, "apply"),
    false,
    "Computer-local config must not expose a dead Server timer apply receipt",
  );

  const stale = await fetch(`${app.baseUrl}${path}`, {
    method: "PATCH",
    headers: headers(fixture.writeA),
    body: JSON.stringify({ expectedRevision: 0, set: { enabled: true }, unset: [] }),
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: "Config revision is stale; current revision is 1",
    errorCode: "RAP_APP_CONFIG_REVISION_STALE",
    currentRevision: 1,
  });

  const otherOwner = await fetch(`${app.baseUrl}${path}`, { headers: headers(fixture.writeB) });
  assert.equal(otherOwner.status, 200);
  const otherOwnerBody = await otherOwner.json() as { revision: number; overrides: unknown; effective: Record<string, unknown> };
  assert.equal(otherOwnerBody.revision, 0);
  assert.deepEqual(otherOwnerBody.overrides, {});
  assert.equal(otherOwnerBody.effective.enabled, true);

  const unknown = await fetch(`${app.baseUrl}/internal/agent-api/apps/system.unknown/config`, {
    headers: headers(fixture.writeA),
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json() as { errorCode?: string }).errorCode, "RAP_APP_CONFIG_APP_UNKNOWN");
});

test("task #204: a durable config PATCH pushes exactly one re-read envelope to the owner's Computer", async ({ app }) => {
  const fixture = await seed();
  const path = "/internal/agent-api/apps/system.cleaner/config";
  const pushes = installPushRecorder(app.app);

  // N -> N+1 with a real override, so a defaults-only source cannot pass.
  const patched = await fetch(`${app.baseUrl}${path}`, {
    method: "PATCH",
    headers: headers(fixture.writeA),
    body: JSON.stringify({
      expectedRevision: 0,
      set: { threshold_bytes: 131072, interval_seconds: 1800 },
      unset: [],
    }),
  });
  assert.equal(patched.status, 200, await patched.clone().text());
  const patchedBody = await patched.json() as { revision: number };
  assert.equal(patchedBody.revision, 1);

  assert.equal(pushes.length, 1, "the route must push exactly once per durable mutation");

  const [only] = pushes;
  assert.equal(only!.agentId, fixture.agentAId, "push must target the owning agent");
  assert.equal(only!.config.ownerAgentId, fixture.agentAId);
  assert.equal(only!.config.appId, "system.cleaner");
  assert.equal(only!.config.revision, 1, "envelope must carry the post-patch revision, not 0");
  assert.deepEqual(
    only!.config.effective,
    { enabled: true, thresholdBytes: 131072, intervalMs: 1_800_000 },
    "effective must be the same-source re-read, converted seconds -> ms",
  );
});

test("task #204: a rejected PATCH pushes nothing", async ({ app }) => {
  const fixture = await seed();
  const path = "/internal/agent-api/apps/system.cleaner/config";
  const pushes = installPushRecorder(app.app);

  const stale = await fetch(`${app.baseUrl}${path}`, {
    method: "PATCH",
    headers: headers(fixture.writeA),
    body: JSON.stringify({ expectedRevision: 9, set: { enabled: false }, unset: [] }),
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(pushes, [], "a refused mutation must not reach the Computer");
});
