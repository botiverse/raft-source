// task #1228 ①, cross-version chain (real code on every hop; only the network
// hop to the worker and its R2 bucket are substituted):
//
//   daemon   collectFeedbackTranscriptAttachment + uploadFeedbackTranscriptOutcome
//            (current) | frozen 1bceea852 collector (old daemon)
//   server   the real app (pglite) serving /internal/machine/scope-attestation
//            | frozen 1bceea852 signer (old server)
//   worker   handleRequest (current) | frozen 1bceea852 bundles handler (old worker)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as shared from "@botiverse/raft-shared";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import { createScopeAttestation } from "../lib/scopeAttestation";
import { legacyDeriveDaemonTraceBundleMetadata1bceea852 } from "../test/legacyDaemonTraceBundleMetadata1bceea852";
import { collectFeedbackTranscriptAttachment } from "../../../daemon/src/feedbackTranscriptCollector";
import { collectFeedbackTranscriptAttachment as collectLegacy1bceea852 } from "../../../daemon/src/testing/legacyFeedbackTranscriptCollector1bceea852";
import { handleRequest, type TraceUploadWorkerEnv } from "../../../trace-upload-worker/src/index";
import { legacyHandleRequest1bceea852 } from "../../../trace-upload-worker/src/testing/legacyTraceBundles1bceea852";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const SECRET = "transcript-outcome-e2e-secret";
const WORKER_URL = "https://trace-worker.test";
const outcomeModule = () => import("../../../daemon/src/feedbackTranscriptOutcomeUpload") as Promise<any>;

class MockR2Bucket {
  puts: Array<{ key: string; body: ArrayBuffer | string }> = [];
  async put(key: string, value: ArrayBuffer | string) {
    this.puts.push({ key, body: value });
    return { etag: "e" };
  }
  async get() { return null; }
  /** The report's ledger entries, without the (unrelated) machine_evidence one. */
  reportLedger(reportId: string): Array<Record<string, unknown>> {
    const latest = new Map<string, Record<string, unknown>>();
    for (const p of this.puts) {
      if (p.key.includes(`/${reportId}/trace-`)) latest.set(p.key, JSON.parse(String(p.body)) as Record<string, unknown>);
    }
    return [...latest.values()].filter((e) => e.feedback_attachment_kind !== "machine_evidence");
  }
}

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "outcome-e2e-owner@slock.test", name: "outcome-e2e-owner", displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true,
  }).returning();
  const server = await createServer("Outcome E2E", "outcome-e2e", owner.id);
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "outcome-e2e-machine");
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "outcome-e2e-agent", machineId: machine.id }).returning();
  return { serverId: server.id, machineId: machine.id, apiKey, agentId: agent.id };
}

interface Chain {
  daemon: "current" | "1bceea852";
  server: "current" | "1bceea852";
  worker: "current" | "1bceea852";
}

async function runChain(baseUrl: string, ids: Awaited<ReturnType<typeof seed>>, chain: Chain, sessionText: string) {
  const bucket = new MockR2Bucket();
  const env = { SCOPE_ATTESTATION_SECRET: SECRET, TRACE_BUNDLES: bucket } as unknown as TraceUploadWorkerEnv;
  const worker = chain.worker === "1bceea852" ? legacyHandleRequest1bceea852 : handleRequest;
  const workerStatuses: number[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith("/internal/machine/scope-attestation") && chain.server === "1bceea852") {
      const body = JSON.parse(String(init?.body)) as { scope: string; metadata: Record<string, unknown> };
      const metadata = legacyDeriveDaemonTraceBundleMetadata1bceea852({ serverId: ids.serverId, machineId: ids.machineId }, body.metadata);
      const attestation = createScopeAttestation({
        v: 1, typ: "scope-attestation", scope: body.scope, sub: `machine:${ids.machineId}`, actorType: "machine",
        machineId: ids.machineId, serverId: ids.serverId, aud: "trace-ingest-worker",
        resource: `servers/${ids.serverId}/machines/${ids.machineId}/trace-bundles`, metadata, nonce: randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 120,
      });
      return new Response(JSON.stringify({ attestation, scope: body.scope, audience: "trace-ingest-worker", resource: null, metadata, expiresAt: new Date(Date.now() + 120_000).toISOString() }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (!input.startsWith(WORKER_URL)) return fetch(input, init);
    const res = await worker(new Request(input, init as RequestInit & { duplex?: "half" }), env);
    workerStatuses.push(res.status);
    return res;
  };
  const reportId = randomUUID();
  const requestId = `req-${randomUUID()}`;
  const common = {
    agentId: ids.agentId,
    feedbackReportId: reportId,
    reportWindow: { reportGeneratedAt: new Date().toISOString(), reportTimeSource: "server_request_received" as const },
    getObservedFailureSummary: async () => null,
    getMachineEvidence: async () => ({ traceTail: null, machineState: null }),
    serverUrl: baseUrl,
    daemonApiKey: ids.apiKey,
    workerUrl: WORKER_URL,
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
    fetchImpl: fetchImpl as never,
    machineEvidenceWaitMs: 2_000,
  };
  const bytes = Buffer.byteLength(sessionText);
  if (chain.daemon === "1bceea852") {
    const result = await collectLegacy1bceea852({
      ...common,
      getSessionTranscript: async () => ({ runtime: "claude", sessionId: "s", reachable: true, transcript: sessionText, sizeBytes: bytes }),
    });
    return { bucket, reportId, requestId, result: result as Record<string, any>, outcomeStatus: null, workerStatuses };
  }
  const result = await collectFeedbackTranscriptAttachment({
    ...common,
    requestId,
    getSessionTranscript: async () => ({ runtime: "claude", sessionId: "s", reachable: true, transcript: sessionText, sizeBytes: bytes, transcriptContent: "native_session_file", sourceBytes: bytes + 10, transcriptBytes: bytes }),
  } as never) as Record<string, any>;
  const { uploadFeedbackTranscriptOutcome } = await outcomeModule();
  const outcomeStatus = await uploadFeedbackTranscriptOutcome({
    agentId: ids.agentId, feedbackReportId: reportId, requestId, daemonVersion: "1.0.43",
    serverUrl: baseUrl, daemonApiKey: ids.apiKey, workerUrl: WORKER_URL,
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }), fetchImpl, result,
  });
  return { bucket, reportId, requestId, result, outcomeStatus, workerStatuses };
}

async function withApp(fn: (baseUrl: string, ids: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  const previous = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = SECRET;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    await fn(app.baseUrl, await seed());
  } finally {
    if (previous === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previous;
    await app.close();
  }
}

const TRANSCRIPT = '{"type":"user","timestamp":"2026-10-04T07:59:00.000Z"}\n';

test("F1 new daemon → new server → new worker: labelled transcript and outcome both filed, matched by request id and upload id", async () => {
  await withApp(async (baseUrl, ids) => {
    const run = await runChain(baseUrl, ids, { daemon: "current", server: "current", worker: "current" }, TRANSCRIPT);
    assert.equal(run.result.upload?.status, "stored");
    assert.equal(run.result.upload?.contentLabel, "signed");
    assert.equal(run.outcomeStatus, "stored");
    const ledger = run.bucket.reportLedger(run.reportId);
    const transcript = ledger.find((e) => String(e.object_key).startsWith("trace-bundles/"));
    const outcome = ledger.find((e) => e.feedback_attachment_kind === "transcript_outcome");
    assert.equal(transcript?.transcript_content, "native_session_file");
    assert.equal(transcript?.transcript_bytes, Buffer.byteLength(TRANSCRIPT));
    assert.equal(transcript?.transcript_source_bytes, Buffer.byteLength(TRANSCRIPT) + 10);
    assert.equal(transcript?.request_id, run.requestId);
    assert.equal(outcome?.request_id, run.requestId);
    assert.match(String(outcome?.object_key), new RegExp(`^feedback-transcript-outcomes/${ids.serverId}/${ids.machineId}/`));
    assert.equal(run.result.upload?.uploadId, transcript?.upload_id, "outcome.upload.uploadId points at the stored transcript");
  });
});

test("F2 new daemon → new server → OLD worker (1bceea852): the transcript is still stored; the outcome is not (and nothing claims it was)", async () => {
  await withApp(async (baseUrl, ids) => {
    const run = await runChain(baseUrl, ids, { daemon: "current", server: "current", worker: "1bceea852" }, TRANSCRIPT);
    assert.equal(run.result.upload?.status, "stored");
    assert.ok(["failed", "unsupported"].includes(String(run.outcomeStatus)), String(run.outcomeStatus));
    const ledger = run.bucket.reportLedger(run.reportId);
    assert.equal(ledger.length, 1, "only the transcript");
    assert.equal("transcript_content" in ledger[0]!, false, "old worker carries no label → readers say unverified");
    assert.ok(!run.bucket.puts.some((p) => p.key.startsWith("feedback-transcript-outcomes/")));
  });
});

test("F3 new daemon → OLD server (1bceea852 signer) → new worker: transcript stored with contentLabel=unsigned; outcome never handed to the worker", async () => {
  await withApp(async (baseUrl, ids) => {
    const run = await runChain(baseUrl, ids, { daemon: "current", server: "1bceea852", worker: "current" }, TRANSCRIPT);
    assert.equal(run.result.upload?.status, "stored");
    assert.equal(run.result.upload?.contentLabel, "unsigned");
    assert.equal(run.outcomeStatus, "unsupported");
    const ledger = run.bucket.reportLedger(run.reportId);
    assert.equal(ledger.length, 1);
    assert.equal("transcript_content" in ledger[0]!, false);
  });
});

test("F4 OLD daemon (1bceea852, uploads a placeholder as a transcript) → new server → new worker: stored untagged, classified source_unverified, never native", async () => {
  await withApp(async (baseUrl, ids) => {
    const placeholder = `${JSON.stringify({ type: "runtime_session_handoff", resolveStatus: "transcript_resolve_missing", createdAt: new Date().toISOString() })}\n`;
    const run = await runChain(baseUrl, ids, { daemon: "1bceea852", server: "current", worker: "current" }, placeholder);
    assert.ok(run.result.traceBundleId, "old daemon still uploads (unchanged behaviour)");
    const [entry] = run.bucket.reportLedger(run.reportId);
    assert.ok(entry);
    assert.equal("transcript_content" in entry, false);
    assert.equal("request_id" in entry, false);
    const classify = (shared as Record<string, unknown>).classifyFeedbackReportLedgerEntry as (r: Record<string, unknown>) => Record<string, unknown>;
    assert.equal(typeof classify, "function");
    assert.deepEqual(classify(entry), { attachment: "transcript", source: "source_unverified", requestAssociation: "unknown" });
  });
});
