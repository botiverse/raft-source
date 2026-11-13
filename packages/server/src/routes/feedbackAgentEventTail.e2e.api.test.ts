// task #1230: the agent_event_tail kind on the real server signer, and the
// cross-version chain (real code on every hop; only the worker's network hop
// and its R2 bucket are substituted):
//
//   daemon   startFeedbackAgentEventTail (current)
//   server   the real app (pglite) | frozen 1bceea852 signer (old server)
//   worker   handleRequest (current) | frozen 1bceea852 handler (old worker)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { BasicTracer, MemoryTraceSink, readAgentEventTailAttachment } from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import { createScopeAttestation } from "../lib/scopeAttestation";
import { legacyDeriveDaemonTraceBundleMetadata1bceea852 } from "../test/legacyDaemonTraceBundleMetadata1bceea852";
import { startFeedbackAgentEventTail } from "../../../daemon/src/feedbackAgentEventTail";
import { handleRequest, type TraceUploadWorkerEnv } from "../../../trace-upload-worker/src/index";
import { legacyHandleRequest1bceea852 } from "../../../trace-upload-worker/src/testing/legacyTraceBundles1bceea852";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const SECRET = "agent-event-tail-e2e-secret";
const WORKER_URL = "https://trace-worker.test";

class MockR2Bucket {
  puts: Array<{ key: string; body: ArrayBuffer | string }> = [];
  async put(key: string, value: ArrayBuffer | string) {
    this.puts.push({ key, body: value });
    return { etag: "e" };
  }
  async get() { return null; }
}

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "aet-owner@slock.test", name: "aet-owner", displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true,
  }).returning();
  const server = await createServer("Agent Event Tail", "agent-event-tail", owner.id);
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "aet-machine");
  const { machine: otherMachine } = await registerMachine(server.id, owner.id, "aet-machine-2");
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "aet-agent", machineId: machine.id }).returning();
  const [elsewhere] = await db.insert(agents).values({ serverId: server.id, name: "aet-agent-2", machineId: otherMachine.id }).returning();
  return { serverId: server.id, machineId: machine.id, apiKey, agentId: agent.id, elsewhereAgentId: elsewhere.id };
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

async function sign(baseUrl: string, apiKey: string, extra: Record<string, unknown>) {
  const metadata: Record<string, unknown> = { bundleId: "bundle-1", bundleSha256: "b".repeat(64), bundleSizeBytes: 512, ...extra };
  for (const key of Object.keys(metadata)) if (metadata[key] === undefined) delete metadata[key];
  const res = await fetch(`${baseUrl}/internal/machine/scope-attestation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "daemon-trace-bundle:create", metadata }),
  });
  const body = res.status === 200 ? (await res.json() as { metadata: Record<string, unknown> }) : { metadata: {} };
  return { status: res.status, metadata: body.metadata };
}

test("S1 agent_event_tail is signed with its own prefix, JSON+gzip, ≤ 36 KiB, request id required, agent on THIS machine; content keys are never signed", async () => {
  await withApp(async (baseUrl, ids) => {
    const tail = (extra: Record<string, unknown>) => sign(baseUrl, ids.apiKey, {
      feedbackAttachmentKind: "agent_event_tail",
      feedbackReportId: randomUUID(),
      agentId: ids.agentId,
      feedbackTranscriptRequestId: "req-1",
      bundleContentType: "text/html",
      bundleContentEncoding: "br",
      feedbackTranscriptContent: "native_session_file",
      // A daemon that tried to sign content: none of it may appear.
      events: [{ name: "x" }], counts: { matched: 1 }, scan: { status: "complete" }, coverage: { status: "unknown" },
      ...extra,
    });
    const ok = await tail({});
    assert.equal(ok.status, 200);
    assert.equal(ok.metadata.feedbackAttachmentKind, "agent_event_tail");
    assert.match(String(ok.metadata.objectKey), new RegExp(`^feedback-agent-event-tails/${ids.serverId}/${ids.machineId}/[0-9a-f-]+\\.json\\.gz$`));
    assert.equal(ok.metadata.bundleContentType, "application/json");
    assert.equal(ok.metadata.bundleContentEncoding, "gzip");
    assert.equal(ok.metadata.maxBytes, 32 * 1024 + 4096);
    assert.equal(ok.metadata.feedbackTranscriptRequestId, "req-1");
    for (const key of ["events", "counts", "scan", "coverage", "feedbackTranscriptContent"]) assert.equal(key in ok.metadata, false, `${key} was signed`);

    assert.equal((await tail({ bundleSizeBytes: 64 * 1024 })).status, 400, "size bounded at signing");
    assert.equal((await tail({ feedbackTranscriptRequestId: undefined })).status, 400, "request id required");
    assert.equal((await tail({ feedbackReportId: undefined })).status, 400, "report required");
    assert.equal((await tail({ agentId: undefined })).status, 400, "agent required");
    assert.equal((await tail({ agentId: ids.elsewhereAgentId })).status, 403, "agent on another machine");
    assert.equal((await tail({ agentId: randomUUID() })).status, 403, "unknown agent");
  });
});

async function runChain(baseUrl: string, ids: Awaited<ReturnType<typeof seed>>, chain: { server: "current" | "1bceea852"; worker: "current" | "1bceea852" }) {
  const bucket = new MockR2Bucket();
  const env = { SCOPE_ATTESTATION_SECRET: SECRET, TRACE_BUNDLES: bucket } as unknown as TraceUploadWorkerEnv;
  const worker = chain.worker === "1bceea852" ? legacyHandleRequest1bceea852 : handleRequest;
  const workerCalls: string[] = [];
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
    workerCalls.push(new URL(input).pathname);
    return worker(new Request(input, init as RequestInit & { duplex?: "half" }), env);
  };
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "aet-e2e-"));
  try {
    await mkdir(path.join(machineDir, "traces"));
    await writeFile(path.join(machineDir, "traces", "daemon-trace-2026-10-08T03-00-00-000Z-1-0000.jsonl"), `${JSON.stringify({
      type: "event", name: "daemon.agent.inbox.dropped_on_exit", time: new Date().toISOString(),
      attrs: { agentId: ids.agentId, exit_reason: "silent_stop", dropped_count: 2, expected: true },
    })}\n`);
    const reportId = randomUUID();
    const outcome = await startFeedbackAgentEventTail({
      agentId: ids.agentId, feedbackReportId: reportId, requestId: "req-1", reportGeneratedAt: new Date(Date.now() + 1000).toISOString(),
      machineDir, serverUrl: baseUrl, daemonApiKey: ids.apiKey, workerUrl: WORKER_URL,
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }), fetchImpl,
    });
    return { bucket, reportId, outcome, workerCalls };
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
}

test("E1 new daemon → new server → new worker: stored, filed in the report ledger, and readable through the shared reader", async () => {
  await withApp(async (baseUrl, ids) => {
    const run = await runChain(baseUrl, ids, { server: "current", worker: "current" });
    assert.equal(run.outcome.status, "uploaded");
    const ledgerPut = [...run.bucket.puts].reverse().find((p) => p.key.startsWith(`feedback-report-ledgers/${ids.serverId}/${run.reportId}/trace-`));
    assert.ok(ledgerPut);
    const ledger = JSON.parse(String(ledgerPut.body)) as Record<string, unknown>;
    const object = run.bucket.puts.find((p) => p.key === ledger.object_key)!;
    const text = gunzipSync(Buffer.from(object.body as ArrayBuffer)).toString("utf8");
    const read = readAgentEventTailAttachment({ report: { feedbackReportId: run.reportId, agentId: ids.agentId, serverId: ids.serverId }, ledger, object: { status: "ok", text } });
    assert.equal(read.state, "readable");
    if (read.state === "readable") {
      assert.deepEqual(read.requestAssociation, { status: "verified", requestId: "req-1" });
      assert.equal(read.events.kind, "shown");
    }
  });
});

test("E2 new daemon → new server → OLD worker (1bceea852): unsupported at create on the exact string, one create, no PUT, nothing stored", async () => {
  await withApp(async (baseUrl, ids) => {
    const run = await runChain(baseUrl, ids, { server: "current", worker: "1bceea852" });
    assert.deepEqual([run.outcome.status, (run.outcome as { stage?: string }).stage], ["unsupported", "create"]);
    assert.deepEqual(run.workerCalls, ["/api/trace-bundles"]);
    assert.equal(run.bucket.puts.length, 0);
  });
});

test("E3 new daemon → OLD server (1bceea852 signer drops the kind) → new worker: unsupported at attestation, zero worker contact", async () => {
  await withApp(async (baseUrl, ids) => {
    const run = await runChain(baseUrl, ids, { server: "1bceea852", worker: "current" });
    assert.deepEqual([run.outcome.status, (run.outcome as { stage?: string }).stage], ["unsupported", "attestation"]);
    assert.deepEqual(run.workerCalls, []);
    assert.equal(run.bucket.puts.length, 0);
  });
});
