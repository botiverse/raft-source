import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  BasicTracer,
  FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS,
  MemoryTraceSink,
  SCOPE_ATTESTATION_MAX_CHARS,
  type FeedbackTraceBundleTranscriptMetadataKey,
} from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { agents, users, computers } from "../db/schema";
import { eq } from "drizzle-orm";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import { attachComputer } from "../services/computerCredentialService";
import { verifyScopeAttestation } from "../lib/scopeAttestation";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { server, machine, apiKey } = await seed();
    const bundleSha256 = "a".repeat(64);
    const transcriptMetadata = {
      feedbackReportTimeSource: "web_report_bundle",
      feedbackTranscriptFirstEventAt: "2026-07-20T16:20:00.000Z",
      feedbackTranscriptLastEventAt: "2026-07-20T16:39:38.024Z",
      feedbackTranscriptTruncated: "true",
      feedbackTranscriptTruncationDirection: "tail",
      feedbackTranscriptWindowCoverage: "covered",
    } satisfies Record<FeedbackTraceBundleTranscriptMetadataKey, unknown>;

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
          feedbackReportWindowStartAt: "2026-07-20T16:25:04.797Z",
          ...transcriptMetadata,
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
    assert.equal(body.metadata.feedbackReportWindowStartAt, "2026-07-20T16:25:04.797Z");
    for (const key of Object.keys(FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS) as FeedbackTraceBundleTranscriptMetadataKey[]) {
      assert.equal(body.metadata[key], transcriptMetadata[key], `${key} should survive server derivation`);
    }
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
    assert.deepEqual(await audienceRes.json(), { code: "scope_attestation_invalid", errorCode: "scope_attestation_invalid", error: "audience is derived from scope" });

    const resourceRes = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "feedback-report:create",
        resource: "attacker-prefix",
      }),
    });
    assert.equal(resourceRes.status, 400);
    assert.deepEqual(await resourceRes.json(), { code: "scope_attestation_invalid", errorCode: "scope_attestation_invalid", error: "resource is derived from scope" });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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

/**
 * Tier-1 machine-side context (task #272). The field is optional and both sides
 * fail open on it: a feedback upload is the channel users report problems
 * through, so an optional diagnostic must never be able to reject it.
 */
function observedFailureSummaryFixture(): Record<string, unknown> {
  return {
    window: {
      requestedFrom: "2026-09-15T11:45:00.000Z",
      requestedTo: "2026-09-15T12:00:00.000Z",
      observedFrom: "2026-09-15T11:46:00.000Z",
      observedTo: "2026-09-15T11:59:00.000Z",
      recordsRead: 42,
      recordsInWindow: 40,
      failureRecords: 1,
      nonFailureRecords: 39,
      excluded: { unparseable: 0, undatable: 1, otherAgent: 1 },
      completeness: "unknown",
    },
    failures: [
      {
        span: "daemon.connection.error",
        count: 1,
        firstAt: "2026-09-15T11:50:00.000Z",
        lastAt: "2026-09-15T11:50:00.000Z",
        attribution: "machine-wide",
      },
    ],
  };
}

async function postTraceBundleAttestation(
  baseUrl: string,
  apiKey: string,
  extraMetadata: Record<string, unknown>,
): Promise<{ status: number; metadata: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/internal/machine/scope-attestation`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({
      scope: "daemon-trace-bundle:create",
      metadata: {
        bundleId: "bundle-observed",
        bundleSha256: "b".repeat(64),
        bundleSizeBytes: 2048,
        ...extraMetadata,
      },
    }),
  });
  const body = res.status === 200
    ? (await res.json() as { metadata: Record<string, unknown> })
    : { metadata: {} };
  return { status: res.status, metadata: body.metadata };
}

// Feedback diagnostics no longer ride in ANY signed attestation: they travel
// as their own machine_evidence object. An old daemon (<= a8039c677) still
// sends them in transcript metadata; the server strips them (nothing is lost:
// the worker never read them), warns, and emits a trace event.
test("daemon trace bundle attestation strips the three feedback diagnostic fields (valid or malformed) with a warning and a trace event", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const { apiKey } = await seed();
    const credential = "sk_agent_LIVE_TOKEN_abcdef123456";
    const tainted = observedFailureSummaryFixture();
    (tainted.failures as Record<string, unknown>[])[0].span = `daemon.connection.error?token=${credential}`;
    const cases: Record<string, unknown>[] = [
      { observedFailureSummary: observedFailureSummaryFixture(), feedbackTraceTail: traceTailFixture(), feedbackMachineState: machineStateFixture() },
      { observedFailureSummary: "not-an-object", feedbackTraceTail: { records: "nope" }, feedbackMachineState: 42 },
      { observedFailureSummary: tainted },
    ];
    for (const extra of cases) {
      const { status, metadata } = await postTraceBundleAttestation(app.baseUrl, apiKey, extra);
      assert.equal(status, 200, "the main payload still signs");
      for (const key of ["observedFailureSummary", "feedbackTraceTail", "feedbackMachineState"]) {
        assert.equal(key in metadata, false, `${key} must not be signed`);
      }
      assert.ok(!JSON.stringify(metadata).includes(credential));
      assert.equal(metadata.bundleId, "bundle-observed");
      assert.equal(metadata.bundleSizeBytes, 2048);
    }
    assert.equal(warnings.filter((w) => /stripping unsigned feedback diagnostics/.test(w)).length, 3);
    const events = sink.getAllSpans().flatMap((span) => span.events).filter((e) => e.name === "machine.trace_bundle.evidence_unsigned");
    assert.equal(events.length, 3);
    assert.equal(events[0]!.attrs?.fields, "feedbackMachineState,feedbackTraceTail,observedFailureSummary");
    assert.equal(events[2]!.attrs?.fields, "observedFailureSummary");
  } finally {
    warn.mockRestore();
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

test("daemon trace bundle attestation still works for an older daemon that sends no observedFailureSummary", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { apiKey } = await seed();
    const { status, metadata } = await postTraceBundleAttestation(app.baseUrl, apiKey, {});
    assert.equal(status, 200);
    assert.equal("observedFailureSummary" in metadata, false);
    assert.equal(metadata.bundleId, "bundle-observed");
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});

// task #272 tier 2: the machine log tail is a distinct attachment kind on the
// same bundle path; its counters are bounded and dropped-with-warn when
// malformed, never rejecting the upload.
test("daemon trace bundle attestation carries machine_log_tail kind and bounded tail counters, dropping malformed ones", async () => {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { apiKey } = await seed();
    const valid = await postTraceBundleAttestation(app.baseUrl, apiKey, {
      feedbackAttachmentKind: "machine_log_tail",
      feedbackMachineLogTailLineCount: 120,
      feedbackMachineLogTailSourceLineCount: 4000,
      feedbackMachineLogTailLinesOutsideWindow: 3800,
      feedbackMachineLogTailUndatedLines: 2,
      feedbackMachineLogTailTruncated: "true",
      feedbackMachineLogTailIncludesOtherAgents: "true",
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.metadata.feedbackMachineLogTailLinesOutsideWindow, 3800);
    assert.equal(valid.metadata.feedbackMachineLogTailUndatedLines, 2);
    assert.equal(valid.metadata.feedbackAttachmentKind, "machine_log_tail");
    assert.equal(valid.metadata.feedbackMachineLogTailLineCount, 120);
    assert.equal(valid.metadata.feedbackMachineLogTailSourceLineCount, 4000);
    assert.equal(valid.metadata.feedbackMachineLogTailTruncated, "true");
    assert.equal(valid.metadata.feedbackMachineLogTailIncludesOtherAgents, "true");

    const malformed = await postTraceBundleAttestation(app.baseUrl, apiKey, {
      feedbackAttachmentKind: "shell_history",
      feedbackMachineLogTailLineCount: -1,
      feedbackMachineLogTailTruncated: "yes",
    });
    assert.equal(malformed.status, 200, "an unknown kind must not reject the upload");
    assert.equal("feedbackAttachmentKind" in malformed.metadata, false);
    assert.equal("feedbackMachineLogTailLineCount" in malformed.metadata, false);
    assert.equal("feedbackMachineLogTailTruncated" in malformed.metadata, false);

    const wrongKind = await postTraceBundleAttestation(app.baseUrl, apiKey, {
      feedbackAttachmentKind: "session_transcript",
      feedbackMachineLogTailLineCount: 5,
    });
    assert.equal(wrongKind.status, 200);
    assert.equal(wrongKind.metadata.feedbackAttachmentKind, "session_transcript");
    assert.equal("feedbackMachineLogTailLineCount" in wrongKind.metadata, false, "tail counters only travel with the tail kind");
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
});



function traceTailFixture(records = 1): Record<string, unknown> {
  const at = (i: number) => new Date(Date.parse("2026-09-15T11:46:00.000Z") + i * 1000).toISOString();
  return {
    window: { requestedFrom: "2026-09-15T11:45:00.000Z", requestedTo: "2026-09-15T12:00:00.000Z", observedFrom: at(0), observedTo: at(records - 1), recordsRead: records, recordsEmitted: records, dropped: { unparseable: 0, undatable: 0, outsideWindow: 0, overCap: 0 }, completeness: "unknown" },
    records: Array.from({ length: records }, (_, i) => ({
      span: "daemon.runtime.process.exit", status: i % 7 === 0 ? "error" : "ok", startedAt: at(i), endedAt: at(i), durationMs: 37,
      agentId: randomUUID(), launchId: randomUUID(), dispatchId: randomUUID(), errorClass: null, errorReason: null, spawnFailureReason: null,
    })),
  };
}

function machineStateFixture(): Record<string, unknown> {
  return { daemonVersion: "1.0.27", computerServiceVersion: "1.0.33", kStableVersion: "1.0.33", hostLifecycleOwner: "cli", dispatcherPathKind: "temp" };
}

async function withSigningApp(fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<void>): Promise<void> {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "daemon-scope-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    await fn(app);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
}

test("maximal old-daemon metadata (500 records, 64 failure classes, every optional field at its max) signs within SCOPE_ATTESTATION_MAX_CHARS", async () => {
  await withSigningApp(async (app) => {
    const { apiKey } = await seed();
    const summary = observedFailureSummaryFixture();
    summary.failures = Array.from({ length: 64 }, (_, i) => ({
      span: "daemon.connection.error", count: i + 1, firstAt: "2026-09-15T11:50:00.000Z", lastAt: "2026-09-15T11:50:00.000Z", attribution: i % 2 ? "machine-wide" : "this-agent",
    }));
    const res = await fetch(`${app.baseUrl}/internal/machine/scope-attestation`, {
      method: "POST",
      headers: machineHeaders(apiKey),
      body: JSON.stringify({
        scope: "daemon-trace-bundle:create",
        metadata: {
          bundleId: "b".repeat(128),
          bundleSha256: "e".repeat(64),
          bundleSizeBytes: 50 * 1024 * 1024,
          bundleContentType: "t".repeat(128),
          bundleContentEncoding: "g".repeat(64),
          feedbackReportId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
          agentId: "ffffffff-ffff-4fff-bfff-fffffffffffe",
          feedbackAttachmentKind: "session_transcript",
          feedbackReportGeneratedAt: "2026-09-15T12:00:00.000Z",
          feedbackReportTimeSource: "web_report_bundle",
          feedbackReportWindowStartAt: "2026-09-15T11:45:00.000Z",
          feedbackTranscriptWindowToleranceMs: 3_600_000,
          feedbackTranscriptWindowCoverage: "timestamps_unavailable",
          feedbackTranscriptTruncated: "true",
          feedbackTranscriptTruncationDirection: "window",
          feedbackTranscriptFirstEventAt: "2026-09-15T11:45:00.000Z",
          feedbackTranscriptLastEventAt: "2026-09-15T12:00:00.000Z",
          observedFailureSummary: summary,
          feedbackTraceTail: traceTailFixture(500),
          feedbackMachineState: machineStateFixture(),
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { attestation: string };
    assert.ok(body.attestation.length <= SCOPE_ATTESTATION_MAX_CHARS, `attestation ${body.attestation.length} chars > ${SCOPE_ATTESTATION_MAX_CHARS}`);
  });
});

test("daemon-supplied strings that the worker would refuse are refused at signing time (400), never signed oversize", async () => {
  await withSigningApp(async (app) => {
    const { apiKey } = await seed();
    for (const extra of [
      { bundleContentType: "t".repeat(129) },
      { bundleContentEncoding: "g".repeat(65) },
    ]) {
      const { status } = await postTraceBundleAttestation(app.baseUrl, apiKey, extra);
      assert.equal(status, 400, JSON.stringify(Object.keys(extra)));
    }
  });
});

test("report and agent ids are signed only as canonical UUIDs (they become worker object-key segments)", async () => {
  await withSigningApp(async (app) => {
    const { apiKey } = await seed();
    const reportId = randomUUID();
    const ok = await postTraceBundleAttestation(app.baseUrl, apiKey, { feedbackReportId: reportId, agentId: reportId });
    assert.equal(ok.status, 200);
    assert.equal(ok.metadata.feedbackReportId, reportId);
    for (const bad of ["../x", `${reportId}/../x`, "..", "report-1", "r".repeat(129), `${reportId} `, 7]) {
      for (const field of ["feedbackReportId", "agentId"]) {
        const { status } = await postTraceBundleAttestation(app.baseUrl, apiKey, { [field]: bad });
        assert.equal(status, 400, `${field}=${JSON.stringify(bad)}`);
      }
    }
  });
});

test("machine_evidence kind: signed with its own key, JSON+gzip, bounded size, and bound to an agent on THIS machine", async () => {
  await withSigningApp(async (app) => {
    const { server, machine, apiKey, owner } = await seed();
    const db = getDb();
    const { machine: otherMachine } = await registerMachine(server.id, owner.id, "daemon-scope-machine-2");
    const otherServer = await createServer("Other Scope", "other-scope", owner.id);
    const [agent] = await db.insert(agents).values({ serverId: server.id, name: "ev-agent", machineId: machine.id }).returning();
    const [elsewhere] = await db.insert(agents).values({ serverId: server.id, name: "ev-agent-2", machineId: otherMachine.id }).returning();
    const [foreign] = await db.insert(agents).values({ serverId: otherServer.id, name: "ev-agent-3", machineId: machine.id }).returning();

    const reportId = randomUUID();
    const evidence = (extra: Record<string, unknown>) => postTraceBundleAttestation(app.baseUrl, apiKey, {
      feedbackAttachmentKind: "machine_evidence",
      feedbackReportId: reportId,
      agentId: agent.id,
      bundleContentType: "text/html",
      bundleContentEncoding: "br",
      // Identity is derived from the credential; these must not override it.
      machineId: otherMachine.id,
      serverId: otherServer.id,
      ...extra,
    });

    const ok = await evidence({});
    assert.equal(ok.status, 200);
    assert.equal(ok.metadata.feedbackAttachmentKind, "machine_evidence");
    assert.equal(ok.metadata.agentId, agent.id);
    assert.equal(ok.metadata.feedbackReportId, reportId);
    assert.equal(ok.metadata.bundleContentType, "application/json");
    assert.equal(ok.metadata.bundleContentEncoding, "gzip");
    assert.match(String(ok.metadata.objectKey), new RegExp(`^feedback-machine-evidence/${server.id}/${machine.id}/[0-9a-f-]+\\.json\\.gz$`));
    assert.ok(Number(ok.metadata.maxBytes) <= 256 * 1024 + 4096);
    assert.equal("machineId" in ok.metadata, false);
    assert.equal("serverId" in ok.metadata, false);

    assert.equal((await evidence({ bundleSizeBytes: 50 * 1024 * 1024 })).status, 400, "evidence size is bounded at signing");
    assert.equal((await evidence({ agentId: undefined })).status, 400, "agent binding is required");
    assert.equal((await evidence({ feedbackReportId: undefined })).status, 400, "report binding is required");
    assert.equal((await evidence({ agentId: elsewhere.id })).status, 403, "agent on another machine");
    assert.equal((await evidence({ agentId: foreign.id })).status, 403, "agent on another server");
    assert.equal((await evidence({ agentId: randomUUID() })).status, 403, "unknown agent");
  });
});
