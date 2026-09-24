import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { signAccessToken } from "../middleware/auth.js";
import { verifyScopeAttestation } from "../lib/scopeAttestation.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedOwner() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "web-trace-owner@slock.test",
    name: "web-trace-owner",
    displayName: "Web Trace Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Web Trace Server", "web-trace-server", owner.id);
  return { owner, server };
}

test("POST /api/servers/:id/scope-attestation signs web trace batch capability for server members", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "web-trace-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { owner, server } = await seedOwner();
    const token = signAccessToken(owner.id);

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/scope-attestation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Server-Id": server.id,
      },
      body: JSON.stringify({ scope: "web-trace-batch:create" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as {
      attestation: string;
      scope: string;
      audience: string;
      resource: string;
      expiresAt: string;
    };
    assert.equal(body.scope, "web-trace-batch:create");
    assert.equal(body.audience, "trace-ingest-worker");
    assert.equal(body.resource, `servers/${server.id}/web-traces`);
    assert.ok(Date.parse(body.expiresAt) > Date.now());

    const claims = verifyScopeAttestation(body.attestation);
    assert.ok(claims);
    assert.equal(claims.scope, "web-trace-batch:create");
    assert.equal(claims.actorType, "user");
    assert.equal(claims.sub, owner.id);
    assert.equal(claims.serverId, server.id);
    assert.equal(claims.aud, "trace-ingest-worker");
    assert.equal(claims.resource, `servers/${server.id}/web-traces`);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("POST /api/servers/:id/scope-attestation signs feedback report capability for server owners", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "feedback-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { owner, server } = await seedOwner();
    const token = signAccessToken(owner.id);

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/scope-attestation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Server-Id": server.id,
      },
      body: JSON.stringify({ scope: "feedback-report:create" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as {
      attestation: string;
      scope: string;
      audience: string;
      resource: string;
      expiresAt: string;
    };
    assert.equal(body.scope, "feedback-report:create");
    assert.equal(body.audience, "feedback-worker");
    assert.equal(body.resource, `servers/${server.id}/feedback-reports`);
    assert.ok(Date.parse(body.expiresAt) > Date.now());

    const claims = verifyScopeAttestation(body.attestation);
    assert.ok(claims);
    assert.equal(claims.scope, "feedback-report:create");
    assert.equal(claims.actorType, "user");
    assert.equal(claims.sub, owner.id);
    assert.equal(claims.serverId, server.id);
    assert.equal(claims.aud, "feedback-worker");
    assert.equal(claims.resource, `servers/${server.id}/feedback-reports`);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});
