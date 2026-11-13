// task #1228 ①: the server signer for the transcript content label, byte
// counts, request id, and the new transcript_outcome attachment kind.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SCOPE_ATTESTATION_MAX_CHARS } from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "transcript-outcome-owner@slock.test",
    name: "transcript-outcome-owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Transcript Outcome", "transcript-outcome", owner.id);
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "outcome-machine");
  const { machine: otherMachine } = await registerMachine(server.id, owner.id, "outcome-machine-2");
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "outcome-agent", machineId: machine.id }).returning();
  const [elsewhere] = await db.insert(agents).values({ serverId: server.id, name: "outcome-agent-2", machineId: otherMachine.id }).returning();
  return { server, machine, apiKey, agentId: agent.id, elsewhereAgentId: elsewhere.id };
}

async function withSigningApp(fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<void>): Promise<void> {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = "transcript-outcome-test-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    await fn(app);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
}

async function sign(baseUrl: string, apiKey: string, extra: Record<string, unknown>): Promise<{ status: number; metadata: Record<string, unknown>; attestation: string }> {
  const metadata: Record<string, unknown> = { bundleId: "bundle-1", bundleSha256: "b".repeat(64), bundleSizeBytes: 512, ...extra };
  for (const key of Object.keys(metadata)) if (metadata[key] === undefined) delete metadata[key];
  const res = await fetch(`${baseUrl}/internal/machine/scope-attestation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "daemon-trace-bundle:create", metadata }),
  });
  const body = res.status === 200 ? (await res.json() as { metadata: Record<string, unknown>; attestation: string }) : { metadata: {}, attestation: "" };
  return { status: res.status, metadata: body.metadata, attestation: body.attestation };
}

test("S1 transcript content label, byte counts and request id are signed; out-of-enum or malformed values are dropped, never coerced", async () => {
  await withSigningApp(async (app) => {
    const { apiKey } = await seed();
    const ok = await sign(app.baseUrl, apiKey, {
      feedbackReportId: "6f1c2a52-0d4e-4c8b-9a51-3e2f7b9d1c40",
      agentId: "0b7e4f9a-5c21-4d36-8e1f-a2c94d7b6e15",
      feedbackTranscriptContent: "native_session_file",
      feedbackTranscriptSourceBytes: 4096,
      feedbackTranscriptBytes: 1024,
      feedbackTranscriptRequestId: "req-1",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.metadata.feedbackTranscriptContent, "native_session_file");
    assert.equal(ok.metadata.feedbackTranscriptSourceBytes, 4096);
    assert.equal(ok.metadata.feedbackTranscriptBytes, 1024);
    assert.equal(ok.metadata.feedbackTranscriptRequestId, "req-1");

    const state = await sign(app.baseUrl, apiKey, { feedbackTranscriptContent: "native_state_file" });
    assert.equal(state.metadata.feedbackTranscriptContent, "native_state_file");

    for (const bad of ["placeholder", "absent", "x", 1, null]) {
      const res = await sign(app.baseUrl, apiKey, { feedbackTranscriptContent: bad });
      assert.equal(res.status, 200);
      assert.equal("feedbackTranscriptContent" in res.metadata, false, `signed ${JSON.stringify(bad)}`);
    }
    for (const bad of [-1, 1.5, "12", Number.MAX_SAFE_INTEGER + 2]) {
      const res = await sign(app.baseUrl, apiKey, { feedbackTranscriptSourceBytes: bad, feedbackTranscriptBytes: bad });
      assert.equal(res.status, 200);
      assert.equal("feedbackTranscriptSourceBytes" in res.metadata, false, `signed source ${bad}`);
      assert.equal("feedbackTranscriptBytes" in res.metadata, false, `signed bytes ${bad}`);
    }
    for (const bad of ["", "r".repeat(129), "has space", 7]) {
      const res = await sign(app.baseUrl, apiKey, { feedbackTranscriptRequestId: bad });
      assert.equal("feedbackTranscriptRequestId" in res.metadata, false, `signed request id ${JSON.stringify(bad)}`);
    }
  });
});

test("S2 transcript_outcome kind: own key prefix (never trace-bundles/), JSON+gzip, 2 KiB-bounded, request id required, agent on THIS machine", async () => {
  await withSigningApp(async (app) => {
    const { server, machine, apiKey, agentId, elsewhereAgentId } = await seed();
    const outcome = (extra: Record<string, unknown>) => sign(app.baseUrl, apiKey, {
      feedbackAttachmentKind: "transcript_outcome",
      feedbackReportId: "6f1c2a52-0d4e-4c8b-9a51-3e2f7b9d1c40",
      agentId,
      feedbackTranscriptRequestId: "req-1",
      bundleContentType: "text/html",
      bundleContentEncoding: "br",
      // A label never belongs on the outcome object.
      feedbackTranscriptContent: "native_session_file",
      ...extra,
    });
    const ok = await outcome({});
    assert.equal(ok.status, 200);
    assert.equal(ok.metadata.feedbackAttachmentKind, "transcript_outcome");
    assert.match(String(ok.metadata.objectKey), new RegExp(`^feedback-transcript-outcomes/${server.id}/${machine.id}/[0-9a-f-]+\\.json\\.gz$`));
    assert.equal(ok.metadata.bundleContentType, "application/json");
    assert.equal(ok.metadata.bundleContentEncoding, "gzip");
    assert.ok(Number(ok.metadata.maxBytes) <= 2048 + 1024, `maxBytes ${ok.metadata.maxBytes}`);
    assert.equal(ok.metadata.feedbackTranscriptRequestId, "req-1");
    assert.equal("feedbackTranscriptContent" in ok.metadata, false, "the outcome object carries no transcript label");

    assert.equal((await outcome({ bundleSizeBytes: 64 * 1024 })).status, 400, "size bounded at signing");
    assert.equal((await outcome({ feedbackTranscriptRequestId: undefined })).status, 400, "request id required");
    assert.equal((await outcome({ feedbackReportId: undefined })).status, 400, "report required");
    assert.equal((await outcome({ agentId: undefined })).status, 400, "agent required");
    assert.equal((await outcome({ agentId: elsewhereAgentId })).status, 403, "agent on another machine");
    assert.equal((await outcome({ agentId: randomUUID() })).status, 403, "unknown agent");
  });
});

test("S3 every new optional key at its maximum still signs within SCOPE_ATTESTATION_MAX_CHARS (the #8848 budget)", async () => {
  await withSigningApp(async (app) => {
    const { apiKey } = await seed();
    const res = await sign(app.baseUrl, apiKey, {
      bundleId: "b".repeat(128),
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
      feedbackTranscriptContent: "native_session_file",
      feedbackTranscriptSourceBytes: Number.MAX_SAFE_INTEGER,
      feedbackTranscriptBytes: Number.MAX_SAFE_INTEGER,
      feedbackTranscriptRequestId: "q".repeat(128),
    });
    assert.equal(res.status, 200);
    assert.equal(res.metadata.feedbackTranscriptRequestId, "q".repeat(128));
    assert.ok(res.attestation.length <= SCOPE_ATTESTATION_MAX_CHARS, `${res.attestation.length} > ${SCOPE_ATTESTATION_MAX_CHARS}`);
  });
});
