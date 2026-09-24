import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { users, computers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createServer } from "../services/serverService.js";
import { registerMachine } from "../services/machineService.js";
import { attachComputer } from "../services/computerCredentialService.js";
import { verifyScopeAttestation } from "../lib/scopeAttestation.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seed() {
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({
      email: "daemon-scope-owner@slock.test",
      name: "daemon-scope-owner",
      displayName: "Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  const server = await createServer("Daemon Scope", "daemon-scope", owner.id);
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "daemon-scope-machine");
  return { server, machine, apiKey, owner };
}

function machineHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

test("POST /internal/machine/scope-attestation signs a short-lived machine capability", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { server, machine, apiKey } = await seed();

    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "feedback-report:create",
      }),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json() as {
      attestation: string;
      scope: string;
      audience: string;
      resource: string | null;
      expiresAt: string;
    };

    assert.equal(body.scope, "feedback-report:create");
    assert.equal(body.audience, "feedback-worker");
    assert.equal(body.resource, `servers/${server.id}/machines/${machine.id}/feedback-reports`);
    assert.ok(Date.parse(body.expiresAt) > Date.now());

    const claims = verifyScopeAttestation(body.attestation);
    assert.ok(claims, "attestation should verify");
    assert.equal(claims.sub, `machine:${machine.id}`);
    assert.equal(claims.actorType, "machine");
    assert.equal(claims.machineId, machine.id);
    assert.equal(claims.serverId, server.id);
    assert.equal(claims.serverSlug, server.slug);
    assert.equal(claims.scope, "feedback-report:create");
    assert.equal(claims.aud, "feedback-worker");
    assert.equal(claims.resource, `servers/${server.id}/machines/${machine.id}/feedback-reports`);
    assert.ok(claims.jti);
    assert.ok(claims.nonce);
    assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 120);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("POST /internal/machine/scope-attestation accepts a Computer attachment credential", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { server, owner } = await seed();
    const computer = await attachComputer({
      userId: owner.id,
      serverSlug: server.slug,
      name: "adopted-computer",
    });
    assert.ok(computer.ok, "computer attachment should succeed");

    const db = getDb();
    const [computerRow] = await db
      .select({ machineId: computers.machineId })
      .from(computers)
      .where(eq(computers.id, computer.serverMachineId));
    assert.ok(computerRow?.machineId, "computer should be linked to a machine");
    const linkedMachineId = computerRow.machineId!;

    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(computer.apiKey),
      body: JSON.stringify({
        scope: "daemon-trace-bundle:create",
        metadata: {
          bundleId: "bundle-from-computer",
          bundleSha256: "b".repeat(64),
          bundleSizeBytes: 5678,
        },
      }),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json() as {
      attestation: string;
      scope: string;
      resource: string | null;
    };

    assert.equal(body.scope, "daemon-trace-bundle:create");
    assert.equal(body.resource, `servers/${server.id}/machines/${linkedMachineId}/trace-bundles`);

    const claims = verifyScopeAttestation(body.attestation);
    assert.ok(claims, "attestation should verify");
    assert.equal(claims.sub, `machine:${linkedMachineId}`);
    assert.equal(claims.actorType, "machine");
    assert.equal(claims.machineId, linkedMachineId);
    assert.equal(claims.serverId, server.id);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("POST /internal/machine/scope-attestation records sanitized breakdown trace events", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const { apiKey } = await seed();

    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "feedback-report:create",
      }),
    });
    assert.equal(res.status, 200);

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/internal/machine/scope-attestation"
    );
    assert.ok(span, "expected machine scope-attestation root span");

    const eventNames = span.events
      .map((event) => event.name)
      .filter((name) => name !== "http.response.finished");
    assert.deepEqual(eventNames, [
      "scope_attestation.request.started",
      "scope_attestation.request.parsed",
      "scope_attestation.machine.loaded",
      "scope_attestation.server.loaded",
      "scope_attestation.signed",
      "response.ready",
    ]);

    const signed = span.events.find((event) => event.name === "scope_attestation.signed");
    assert.ok(signed);
    assert.equal(signed.attrs?.surface, "machine");
    assert.equal(signed.attrs?.scope, "feedback-report:create");
    assert.equal(signed.attrs?.audience, "feedback-worker");
    assert.equal(signed.attrs?.ttl_seconds, 120);
    assert.equal("machineId" in (signed.attrs ?? {}), false);
    assert.equal("serverId" in (signed.attrs ?? {}), false);
    assert.equal("attestation" in (signed.attrs ?? {}), false);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("POST /internal/machine/scope-attestation signs daemon trace bundle metadata", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  process.env.DEPLOYMENT_ENV = "staging";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { server, machine, apiKey } = await seed();
    const bundleSha256 = "a".repeat(64);

    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "daemon-trace-bundle:create",
        metadata: {
          bundleId: "bundle-1",
          bundleSha256,
          bundleSizeBytes: 1234,
          feedbackReportGeneratedAt: "2026-07-20T16:40:04.797Z",
          feedbackReportTimeSource: "web_report_bundle",
          feedbackReportWindowStartAt: "2026-07-20T16:25:04.797Z",
          feedbackTranscriptFirstEventAt: "2026-07-20T16:20:00.000Z",
          feedbackTranscriptLastEventAt: "2026-07-20T16:39:38.024Z",
          feedbackTranscriptWindowCoverage: "covered",
          feedbackTranscriptWindowToleranceMs: 900_000,
          rawTranscriptExcerpt: "must-not-pass-through",
        },
      }),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json() as {
      attestation: string;
      scope: string;
      audience: string;
      resource: string | null;
      metadata: Record<string, unknown>;
    };

    assert.equal(body.scope, "daemon-trace-bundle:create");
    assert.equal(body.audience, "trace-ingest-worker");
    assert.equal(body.resource, `servers/${server.id}/machines/${machine.id}/trace-bundles`);
    assert.equal(body.metadata.bundleId, "bundle-1");
    assert.equal(body.metadata.bundleSha256, bundleSha256);
    assert.equal(body.metadata.bundleSizeBytes, 1234);
    assert.equal(body.metadata.maxBytes, 50 * 1024 * 1024);
    assert.equal(body.metadata.bundleContentType, "application/x-ndjson");
    assert.equal(body.metadata.bundleContentEncoding, "gzip");
    assert.equal(body.metadata.deploymentEnvironment, "staging");
    assert.equal(body.metadata.feedbackReportGeneratedAt, "2026-07-20T16:40:04.797Z");
    assert.equal(body.metadata.feedbackReportTimeSource, "web_report_bundle");
    assert.equal(body.metadata.feedbackReportWindowStartAt, "2026-07-20T16:25:04.797Z");
    assert.equal(body.metadata.feedbackTranscriptFirstEventAt, "2026-07-20T16:20:00.000Z");
    assert.equal(body.metadata.feedbackTranscriptLastEventAt, "2026-07-20T16:39:38.024Z");
    assert.equal(body.metadata.feedbackTranscriptWindowCoverage, "covered");
    assert.equal(body.metadata.feedbackTranscriptWindowToleranceMs, 900_000);
    assert.equal("rawTranscriptExcerpt" in body.metadata, false);
    assert.match(String(body.metadata.objectKey), new RegExp(`^trace-bundles/${server.id}/${machine.id}/.+\\.jsonl\\.gz$`));

    const claims = verifyScopeAttestation(body.attestation);
    assert.ok(claims, "attestation should verify");
    assert.equal(claims.scope, "daemon-trace-bundle:create");
    assert.equal(claims.aud, "trace-ingest-worker");
    assert.equal(claims.resource, `servers/${server.id}/machines/${machine.id}/trace-bundles`);
    assert.deepEqual(claims.metadata, body.metadata);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    if (previousDeploymentEnv === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
    await app.close();
  }
});

test("POST /internal/machine/scope-attestation rejects non-machine auth", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "feedback-report:create",
      }),
    });
    assert.equal(res.status, 401);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("POST /internal/machine/scope-attestation fails closed when signing is not configured", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  delete process.env.SCOPE_ATTESTATION_SECRET;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { apiKey } = await seed();
    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "feedback-report:create",
      }),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /not configured/);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("POST /internal/machine/scope-attestation rejects unsupported scopes", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { apiKey } = await seed();
    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "admin-machine:delete",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error?: string };
    assert.equal(body.error, "Unsupported scope: admin-machine:delete");
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("POST /internal/machine/scope-attestation rejects caller-provided audience/resource", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { apiKey } = await seed();

    const audienceRes = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "feedback-report:create",
        audience: "attacker-worker",
      }),
    });
    assert.equal(audienceRes.status, 400);
    assert.deepEqual(await audienceRes.json(), { error: "audience is derived from scope" });

    const resourceRes = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "feedback-report:create",
        resource: "attacker-prefix",
      }),
    });
    assert.equal(resourceRes.status, 400);
    assert.deepEqual(await resourceRes.json(), { error: "resource is derived from scope" });
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("daemon trace bundle attestation accepts producer-claimed dev environment on a staging server", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  process.env.DEPLOYMENT_ENV = "staging";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { apiKey } = await seed();
    const bundleSha256 = "b".repeat(64);

    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "daemon-trace-bundle:create",
        metadata: {
          bundleId: "bundle-dev-1",
          bundleSha256,
          bundleSizeBytes: 256,
          deploymentEnvironment: "dev",
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { metadata: { deploymentEnvironment: string } };
    assert.equal(body.metadata.deploymentEnvironment, "dev");
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    if (previousDeploymentEnv === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
    await app.close();
  }
});

test("daemon trace bundle attestation rejects producer-claimed dev environment on a production server", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  process.env.DEPLOYMENT_ENV = "production";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { apiKey } = await seed();
    const bundleSha256 = "c".repeat(64);

    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "daemon-trace-bundle:create",
        metadata: {
          bundleId: "bundle-dev-2",
          bundleSha256,
          bundleSizeBytes: 256,
          deploymentEnvironment: "dev",
        },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error?: string };
    assert.match(String(body.error), /inconsistent with server deployment "production"/);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    if (previousDeploymentEnv === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
    await app.close();
  }
});

test("daemon trace bundle attestation rejects unknown producer-claimed deployment environment", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  process.env.DEPLOYMENT_ENV = "staging";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { apiKey } = await seed();
    const bundleSha256 = "d".repeat(64);

    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "daemon-trace-bundle:create",
        metadata: {
          bundleId: "bundle-bogus",
          bundleSha256,
          bundleSizeBytes: 256,
          deploymentEnvironment: "attacker-env",
        },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error?: string };
    assert.match(String(body.error), /not in the allowed producer set/);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    if (previousDeploymentEnv === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
    await app.close();
  }
});

test("daemon trace bundle attestation falls back to server deployment when producer omits the claim", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  process.env.DEPLOYMENT_ENV = "staging";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { apiKey } = await seed();
    const bundleSha256 = "e".repeat(64);

    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "daemon-trace-bundle:create",
        metadata: {
          bundleId: "bundle-omit",
          bundleSha256,
          bundleSizeBytes: 256,
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { metadata: { deploymentEnvironment: string } };
    assert.equal(body.metadata.deploymentEnvironment, "staging");
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    if (previousDeploymentEnv === undefined) delete process.env.DEPLOYMENT_ENV;
    else process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
    await app.close();
  }
});
