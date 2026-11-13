// Route-scoped JSON body limit for POST /internal/machine/scope-attestation.
//
// Old daemons (<= a8039c677) put the feedback diagnostics inside the trace
// bundle attestation metadata; a busy machine sends ~180 KB, which the global
// 100 KB `express.json()` rejected with an HTML 413 before the route ran. Only
// this route gets a bounded 1 MiB limit; every other route keeps its own. All
// requests go through the REAL app (real middleware order), so a global parser
// that runs first would be caught here.
import assert from "node:assert/strict";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import { requestDaemonScopeAttestation } from "../../../daemon/src/directUploadCapability";

/** The route-scoped limit under test (1 MiB). Stated here, not imported, so the test pins the number. */
const SCOPE_ATTESTATION_REQUEST_MAX_BYTES = 1024 * 1024;

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "scope-body-owner@slock.test",
    name: "scope-body-owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Scope Body", "scope-body", owner.id);
  const { apiKey } = await registerMachine(server.id, owner.id, "scope-body-machine");
  return { apiKey };
}

/** A valid attestation request whose UTF-8 JSON body is exactly `bytes` long (whitespace-padded). */
function bodyOfExactly(bytes: number): string {
  const json = JSON.stringify({
    scope: "daemon-trace-bundle:create",
    metadata: { bundleId: "bundle-limit", bundleSha256: "c".repeat(64), bundleSizeBytes: 1024 },
  });
  const padded = `${json}${" ".repeat(bytes - Buffer.byteLength(json))}`;
  assert.equal(Buffer.byteLength(padded), bytes);
  return padded;
}

function post(baseUrl: string, pathName: string, body: string, apiKey?: string) {
  return fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body,
  });
}

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>, extraEnv: Record<string, string> = {}): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({ SCOPE_ATTESTATION_SECRET: "scope-body-secret", ...extraEnv })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    return await fn(app);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
  }
}

test("scope-attestation accepts a JSON body of exactly 1 MiB and answers 1 MiB + 1 with a JSON 413", async () => {
  await withApp(async (app) => {
    const { apiKey } = await seed();
    const legacySized = await post(app.baseUrl, "/internal/machine/scope-attestation", bodyOfExactly(180 * 1024), apiKey);
    assert.equal(legacySized.status, 200, "an old daemon's ~180 KB request is no longer rejected");

    const atLimit = await post(app.baseUrl, "/internal/machine/scope-attestation", bodyOfExactly(SCOPE_ATTESTATION_REQUEST_MAX_BYTES), apiKey);
    assert.equal(atLimit.status, 200, `exactly at the limit: ${atLimit.status}`);

    const over = await post(app.baseUrl, "/internal/machine/scope-attestation", bodyOfExactly(SCOPE_ATTESTATION_REQUEST_MAX_BYTES + 1), apiKey);
    assert.equal(over.status, 413);
    assert.match(over.headers.get("content-type") ?? "", /application\/json/);
    const body = await over.json() as { error: string; code: string; limitBytes: number };
    assert.equal(body.code, "scope_attestation_body_too_large");
    assert.equal(body.limitBytes, SCOPE_ATTESTATION_REQUEST_MAX_BYTES);
  });
});

test("every other route keeps the global 100 KB JSON limit", async () => {
  await withApp(async (app) => {
    const { apiKey } = await seed();
    const big = bodyOfExactly(180 * 1024);
    for (const pathName of ["/internal/machine/agents/00000000-0000-4000-8000-000000000000/stop", "/internal/machine/scope-attestation-other", "/api/auth/login"]) {
      const res = await post(app.baseUrl, pathName, big, apiKey);
      assert.equal(res.status, 413, `${pathName} must still reject a 180 KB body`);
    }
  });
});

test("machine auth runs BEFORE the 1 MiB parser: an unauthenticated large body is 401, never parsed", async () => {
  await withApp(async (app) => {
    await seed();
    for (const bytes of [180 * 1024, SCOPE_ATTESTATION_REQUEST_MAX_BYTES + 1]) {
      const res = await post(app.baseUrl, "/internal/machine/scope-attestation", bodyOfExactly(bytes), undefined);
      assert.equal(res.status, 401, `${bytes} bytes without auth`);
      const bad = await post(app.baseUrl, "/internal/machine/scope-attestation", bodyOfExactly(bytes), "sk_machine_not_a_real_key");
      assert.equal(bad.status, 401, `${bytes} bytes with a bad key`);
    }
  });
});

test("scope-attestation adds no rate limit: a burst of authenticated requests is all served", async () => {
  await withApp(async (app) => {
    const { apiKey } = await seed();
    const statuses: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      statuses.push((await post(app.baseUrl, "/internal/machine/scope-attestation", bodyOfExactly(512), apiKey)).status);
    }
    assert.deepEqual([...new Set(statuses)], [200]);
  });
});

test("the daemon classifies the server's 413 as 413, not as a JSON parse error", async () => {
  await withApp(async (app) => {
    const { apiKey } = await seed();
    await assert.rejects(
      requestDaemonScopeAttestation({
        serverUrl: app.baseUrl,
        apiKey,
        scope: "daemon-trace-bundle:create",
        metadata: { bundleId: "b", bundleSha256: "d".repeat(64), bundleSizeBytes: 1, padding: "x".repeat(SCOPE_ATTESTATION_REQUEST_MAX_BYTES) },
      }),
      (err: unknown) => {
        assert.match((err as Error).message, /\(413\)/);
        assert.doesNotMatch((err as Error).message, /Unexpected token|JSON/);
        return true;
      },
    );
  });
});
