// Route-scoped JSON body limit for POST .../resumable/control.
//
// A control manifest may be up to 512 KB, but the global 100 KB `express.json()`
// rejected anything larger with an HTML 413 before the route ran, failing every
// workspace above ~6 GB after all chunks were uploaded. All requests go through
// the REAL app (real middleware order), so a global parser that runs first would
// be caught here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { computers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";

/** Manifest limit (512 KB) + 64 KB envelope headroom. Stated here, not imported, so the test pins the number. */
const CONTROL_REQUEST_MAX_BYTES = 512 * 1024 + 64 * 1024;

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "control-body-owner@slock.test",
    name: "control-body-owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Control Body", "control-body", owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "control-body-machine");
  const computer = await generateComputerApiKeyMaterial();
  await db.insert(computers).values({
    serverId: server.id,
    name: "control-body-computer",
    apiKeyHash: computer.apiKeyHash,
    apiKeyPrefix: computer.apiKeyPrefix,
    attachedByUserId: owner.id,
    machineId: machine.id,
  });
  return { apiKey: computer.apiKey };
}

/** A control request whose UTF-8 JSON body is exactly `bytes` long (whitespace-padded). */
function bodyOfExactly(bytes: number): string {
  const json = JSON.stringify({ control: { schemaVersion: 0 } });
  const padded = `${json}${" ".repeat(bytes - Buffer.byteLength(json))}`;
  assert.equal(Buffer.byteLength(padded), bytes);
  return padded;
}

function controlPath(migrationId = randomUUID()): string {
  return `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/control`;
}

function post(baseUrl: string, pathName: string, body: string, apiKey?: string) {
  return fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Raft-Migration-Token": "not-a-real-token",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  });
}

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>): Promise<T> {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

test("control registration parses a body up to the manifest limit and answers one byte over with a JSON 413", async () => {
  await withApp(async (app) => {
    const { apiKey } = await seed();
    for (const bytes of [180 * 1024, CONTROL_REQUEST_MAX_BYTES]) {
      const res = await post(app.baseUrl, controlPath(), bodyOfExactly(bytes), apiKey);
      // Parsed and handed to the route, which rejects the unknown migration.
      assert.notEqual(res.status, 413, `${bytes} bytes must reach the route`);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    }

    const over = await post(app.baseUrl, controlPath(), bodyOfExactly(CONTROL_REQUEST_MAX_BYTES + 1), apiKey);
    assert.equal(over.status, 413);
    assert.match(over.headers.get("content-type") ?? "", /application\/json/);
    const body = await over.json() as { code: string; limitBytes: number };
    assert.equal(body.code, "migration_control_body_too_large");
    assert.equal(body.limitBytes, CONTROL_REQUEST_MAX_BYTES);
  });
});

test("every other route keeps the global 100 KB JSON limit", async () => {
  await withApp(async (app) => {
    const { apiKey } = await seed();
    const big = bodyOfExactly(180 * 1024);
    for (const pathName of [`${controlPath()}-other`, "/internal/machine/agents/00000000-0000-4000-8000-000000000000/stop"]) {
      const res = await post(app.baseUrl, pathName, big, apiKey);
      assert.equal(res.status, 413, `${pathName} must still reject a 180 KB body`);
    }
  });
});

test("computer auth runs BEFORE the larger parser: an unauthenticated large body is 401, never parsed", async () => {
  await withApp(async (app) => {
    await seed();
    for (const bytes of [180 * 1024, CONTROL_REQUEST_MAX_BYTES + 1]) {
      const res = await post(app.baseUrl, controlPath(), bodyOfExactly(bytes), undefined);
      assert.equal(res.status, 401, `${bytes} bytes without auth`);
      const bad = await post(app.baseUrl, controlPath(), bodyOfExactly(bytes), "sk_computer_not_a_real_key");
      assert.equal(bad.status, 401, `${bytes} bytes with a bad key`);
    }
  });
});
