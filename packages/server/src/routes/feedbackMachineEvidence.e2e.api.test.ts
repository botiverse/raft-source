// Cross-package chain for feedback diagnostics (real code on every hop; only
// the network hop to the worker and its R2 bucket are substituted):
//
//   daemon   collectFeedbackTranscriptAttachment (+ the real trace-tail /
//            observed-failure projections over SYNTHETIC trace files)
//   server   the real app (full middleware order, pglite DB) serving
//            POST /internal/machine/scope-attestation
//   worker   handleRequest (create + PUT) on a mock R2 bucket
//
// History: the three diagnostic fields used to ride INSIDE the transcript's
// signed attestation. A busy 15-minute trace window pushed the token past the
// worker's 16 KiB attestation gate (400) or the request past the server's
// 100 KB JSON parser (413), and the MAIN transcript was never stored.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  BasicTracer,
  MemoryTraceSink,
  SCOPE_ATTESTATION_MAX_CHARS,
  parseFeedbackMachineEvidence,
} from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import { collectFeedbackTranscriptAttachment, type FeedbackTranscriptCollectionResult } from "../../../daemon/src/feedbackTranscriptCollector";
import { collectFeedbackTranscriptAttachment as collectLegacyFeedbackTranscriptAttachment } from "../../../daemon/src/testing/legacyFeedbackTranscriptCollectorA8039c677";
import { collectFeedbackTraceTail, redactedOrNull } from "../../../daemon/src/feedbackMachineEvidence";
import { collectObservedFailureSummary } from "../../../daemon/src/observedFailureSummary";
import { handleRequest, type TraceUploadWorkerEnv } from "../../../trace-upload-worker/src/index";
import { legacyHandleRequest } from "../../../trace-upload-worker/src/testing/legacyTraceBundlesA8039c677";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const SECRET = "feedback-evidence-e2e-secret";
const WORKER_URL = "https://trace-worker.test";
const DIAGNOSTIC_KEYS = ["observedFailureSummary", "feedbackTraceTail", "feedbackMachineState"] as const;

class MockR2Bucket {
  puts: Array<{ key: string; body: ArrayBuffer | string; customMetadata?: Record<string, string> }> = [];
  async put(key: string, value: ArrayBuffer | string, options?: { customMetadata?: Record<string, string> }) {
    this.puts.push({ key, body: value, customMetadata: options?.customMetadata });
    return { etag: "mock-etag" };
  }
  async get() { return null; }
  objects(prefix: string) {
    return this.puts.filter((p) => p.key.startsWith(prefix));
  }
  /** Everything that is not a ledger record. */
  dataObjects() {
    return this.puts.filter((p) => !p.key.startsWith("trace-ledgers/") && !p.key.startsWith("feedback-report-ledgers/"));
  }
}

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "evidence-e2e-owner@slock.test",
    name: "evidence-e2e-owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Evidence E2E", "evidence-e2e", owner.id);
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "evidence-machine-a");
  const { machine: otherMachine } = await registerMachine(server.id, owner.id, "evidence-machine-b");
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "evidence-agent", machineId: machine.id }).returning();
  const [otherMachineAgent] = await db.insert(agents).values({ serverId: server.id, name: "evidence-agent-b", machineId: otherMachine.id }).returning();
  return { apiKey, machine, agentId: agent.id, otherMachineAgentId: otherMachineAgent.id };
}

const REAL_SPANS = ["daemon.runtime.process.exit", "daemon.connection.error", "daemon.agent.delivery.routed", "daemon.runtime.turn", "daemon.bundle.upload"];

/** One synthetic raw daemon-trace jsonl line, shaped as LocalRotatingTraceSink writes it. */
function rawRecord(index: number, at: Date, agentId: string): Record<string, unknown> {
  const failing = index % 7 === 0;
  return {
    type: "span",
    schema_version: 1,
    trace_id: randomUUID().replace(/-/g, ""),
    span_id: randomUUID().replace(/-/g, "").slice(0, 16),
    name: REAL_SPANS[index % REAL_SPANS.length],
    surface: "daemon",
    kind: "internal",
    status: failing ? "error" : "ok",
    start_time: at.toISOString(),
    end_time: new Date(at.getTime() + 37).toISOString(),
    duration_ms: 37,
    attrs: {
      agentId: index % 2 === 0 ? agentId : randomUUID(),
      launchId: randomUUID(),
      startDispatchId: randomUUID(),
      original_message: "free text never projected",
      ...(failing ? { error_class: "RuntimeError", error_reason: "unclassified_runtime_error" } : {}),
    },
  };
}

function decodeClaims(token: string): { metadata?: Record<string, unknown> } {
  return JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString("utf8")) as { metadata?: Record<string, unknown> };
}

interface ChainOptions {
  records: number;
  agentId: string;
  daemon?: "current" | "a8039c677";
  worker?: "current" | "a8039c677";
  /** Network fault on the evidence object's own requests only. */
  evidenceFault?: "put_500" | "hang";
  machineEvidenceWaitMs?: number;
}

interface ChainOutcome {
  result: FeedbackTranscriptCollectionResult;
  bucket: MockR2Bucket;
  attestationStatuses: number[];
  transcriptToken: string | null;
  evidenceToken: string | null;
  workerCreateStatuses: number[];
}

async function runChain(baseUrl: string, apiKey: string, options: ChainOptions): Promise<ChainOutcome> {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "evidence-e2e-"));
  try {
    const generatedAt = new Date();
    const lines: string[] = [];
    for (let i = 0; i < options.records; i += 1) {
      lines.push(JSON.stringify(rawRecord(i, new Date(generatedAt.getTime() - 10 * 60_000 + i * 1000), options.agentId)));
    }
    await mkdir(path.join(machineDir, "traces"), { recursive: true });
    await writeFile(path.join(machineDir, "traces", "daemon-trace-0001.jsonl"), `${lines.join("\n")}\n`);

    const bucket = new MockR2Bucket();
    const env = { SCOPE_ATTESTATION_SECRET: SECRET, TRACE_BUNDLES: bucket } as unknown as TraceUploadWorkerEnv;
    const worker = options.worker === "a8039c677" ? legacyHandleRequest : handleRequest;
    const outcome: Omit<ChainOutcome, "result"> = {
      bucket,
      attestationStatuses: [],
      transcriptToken: null,
      evidenceToken: null,
      workerCreateStatuses: [],
    };
    const evidenceUploadIds = new Set<string>();
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (!input.startsWith(WORKER_URL)) {
        if (input.endsWith("/internal/machine/scope-attestation")) {
          const kind = (JSON.parse(String(init?.body)) as { metadata?: { feedbackAttachmentKind?: string } }).metadata?.feedbackAttachmentKind;
          if (kind === "machine_evidence" && options.evidenceFault === "hang") return new Promise<Response>(() => {});
        }
        const res = await fetch(input, init);
        if (input.endsWith("/internal/machine/scope-attestation")) outcome.attestationStatuses.push(res.status);
        return res;
      }
      if (input === `${WORKER_URL}/api/trace-bundles`) {
        const token = (JSON.parse(String(init?.body)) as { attestation: string }).attestation;
        const isEvidence = decodeClaims(token).metadata?.feedbackAttachmentKind === "machine_evidence";
        if (isEvidence) outcome.evidenceToken = token;
        else outcome.transcriptToken = token;
        const res = await worker(new Request(input, init as RequestInit & { duplex?: "half" }), env);
        outcome.workerCreateStatuses.push(res.status);
        if (isEvidence && res.ok) evidenceUploadIds.add(((await res.clone().json()) as { id: string }).id);
        return res;
      }
      const putId = /\/api\/trace-bundles\/([^/]+)\/object/.exec(new URL(input).pathname)?.[1];
      if (putId && evidenceUploadIds.has(decodeURIComponent(putId)) && options.evidenceFault === "put_500") {
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      return worker(new Request(input, init as RequestInit & { duplex?: "half" }), env);
    };

    const transcript = JSON.stringify({ type: "message", time: new Date(generatedAt.getTime() - 60_000).toISOString(), text: "hello" });
    const common = {
      agentId: options.agentId,
      feedbackReportId: randomUUID(),
      reportWindow: { reportGeneratedAt: generatedAt.toISOString(), reportTimeSource: "server_request_received" as const },
      // transcriptContent: the reader classified the bytes as the runtime's own file (task #1228 ①).
      getSessionTranscript: async () => ({ runtime: "claude", sessionId: "session-1", reachable: true, transcript, sizeBytes: transcript.length, transcriptContent: "native_session_file" as const }),
      getObservedFailureSummary: (window: { from: string; to: string }) => collectObservedFailureSummary({ machineDir, agentId: options.agentId, from: window.from, to: window.to }),
      getMachineEvidence: async (window: { from: string; to: string }) => ({
        traceTail: redactedOrNull(await collectFeedbackTraceTail({ machineDir, window })),
        machineState: { daemonVersion: "1.0.40", computerServiceVersion: "1.0.40", kStableVersion: "1.0.40", hostLifecycleOwner: "cli" as const, dispatcherPathKind: "stable" as const },
      }),
      serverUrl: baseUrl,
      daemonApiKey: apiKey,
      workerUrl: WORKER_URL,
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
      fetchImpl: fetchImpl as never,
    };
    const result = options.daemon === "a8039c677"
      ? await collectLegacyFeedbackTranscriptAttachment(common)
      : await collectFeedbackTranscriptAttachment({
        ...common,
        ...(options.machineEvidenceWaitMs !== undefined ? { machineEvidenceWaitMs: options.machineEvidenceWaitMs } : {}),
      });
    return { ...outcome, result };
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
}

function assertTranscriptStored(o: ChainOutcome, label: string): void {
  assert.equal(o.result.error, undefined, `${label}: daemon reported ${o.result.error}`);
  assert.ok(o.result.traceBundleId, `${label}: traceBundleId`);
  assert.equal(o.bucket.objects("trace-bundles/").length, 1, `${label}: exactly the transcript object under trace-bundles/`);
  assert.ok(o.transcriptToken, `${label}: transcript attestation reached the worker`);
  const metadata = decodeClaims(o.transcriptToken).metadata ?? {};
  for (const key of DIAGNOSTIC_KEYS) assert.equal(key in metadata, false, `${label}: ${key} must not be signed into the transcript`);
  assert.ok(o.transcriptToken.length <= SCOPE_ATTESTATION_MAX_CHARS, `${label}: transcript token ${o.transcriptToken.length} chars`);
}

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>): Promise<T> {
  const previousSecret = process.env.SCOPE_ATTESTATION_SECRET;
  process.env.SCOPE_ATTESTATION_SECRET = SECRET;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    return await fn(app);
  } finally {
    if (previousSecret === undefined) delete process.env.SCOPE_ATTESTATION_SECRET;
    else process.env.SCOPE_ATTESTATION_SECRET = previousSecret;
    await app.close();
  }
}

test("busy window (500 records): the transcript is stored and the diagnostics land as a separate, strictly parsed machine_evidence object", async () => {
  await withApp(async (app) => {
    const { apiKey, machine, agentId } = await seed();
    const busy = await runChain(app.baseUrl, apiKey, { records: 500, agentId });
    assertTranscriptStored(busy, "n=500");
    assert.equal(busy.result.machineEvidence?.status, "uploaded", JSON.stringify(busy.result.machineEvidence));

    const evidence = busy.bucket.objects("feedback-machine-evidence/");
    assert.equal(evidence.length, 1, "one evidence object, outside the trace-bundles/ prefix");
    assert.equal(evidence[0]!.customMetadata?.feedbackAttachmentKind, "machine_evidence");
    const envelope = parseFeedbackMachineEvidence(JSON.parse(gunzipSync(Buffer.from(evidence[0]!.body as ArrayBuffer)).toString("utf8")));
    assert.equal(envelope.agentId, agentId);
    assert.equal(envelope.feedbackTraceTail?.records.length, 500, "500 projected records fit under 256 KiB");
    assert.equal(envelope.bounds.truncated, false);
    assert.ok(envelope.observedFailureSummary, "summary present");
    assert.deepEqual(envelope.feedbackMachineState?.daemonVersion, "1.0.40");

    // Its own attestation binds sha, report, agent, and the SERVER-derived machine.
    const evidenceClaims = decodeClaims(busy.evidenceToken!) as { machineId?: string; metadata: Record<string, unknown> };
    assert.equal(evidenceClaims.machineId, machine.id);
    assert.equal(evidenceClaims.metadata.agentId, agentId);
    assert.match(String(evidenceClaims.metadata.bundleSha256), /^[0-9a-f]{64}$/);
    for (const key of DIAGNOSTIC_KEYS) assert.equal(key in evidenceClaims.metadata, false);
  });
});

test("every former failure boundary stores the transcript (worker 16 KiB gate at n=28/60, server 100 KB parser at n=300)", async () => {
  await withApp(async (app) => {
    const { apiKey, agentId } = await seed();
    for (const records of [0, 28, 60, 300]) {
      const o = await runChain(app.baseUrl, apiKey, { records, agentId });
      assertTranscriptStored(o, `n=${records}`);
      assert.deepEqual(o.attestationStatuses, [200, 200], `n=${records}: both attestations signed`);
      assert.equal(o.result.machineEvidence?.status, "uploaded", `n=${records}`);
    }
  });
});

test("old daemon (a8039c677 collector) sending the diagnostics inside transcript metadata: 200, transcript stored, fields stripped with a warning", async () => {
  await withApp(async (app) => {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const { apiKey, agentId } = await seed();
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    try {
      const o = await runChain(app.baseUrl, apiKey, { records: 500, agentId, daemon: "a8039c677" });
      assert.deepEqual(o.attestationStatuses, [200], "the ~178 KB legacy request is accepted, not 413");
      assertTranscriptStored(o, "legacy daemon");
    } finally {
      warn.mockRestore();
    }
    assert.ok(warnings.some((w) => /stripping unsigned feedback diagnostics/.test(w)), `warning emitted: ${warnings.join(" | ")}`);
    const event = sink.getAllSpans().flatMap((span) => span.events).find((e) => e.name === "machine.trace_bundle.evidence_unsigned");
    assert.ok(event, "trace event emitted");
    assert.equal(event.attrs?.fields, "feedbackMachineState,feedbackTraceTail,observedFailureSummary");
  });
});

test("new daemon against the OLD worker (a8039c677 handler): transcript stored, evidence explicitly unsupported, nothing stored as an untyped trace", async () => {
  await withApp(async (app) => {
    const { apiKey, agentId } = await seed();
    const o = await runChain(app.baseUrl, apiKey, { records: 60, agentId, worker: "a8039c677" });
    assertTranscriptStored(o, "old worker");
    assert.equal(o.result.machineEvidence?.status, "unsupported", JSON.stringify(o.result.machineEvidence));
    assert.match(o.result.machineEvidence?.error ?? "", /machine_evidence/);
    assert.equal(o.bucket.dataObjects().length, 1, "only the transcript object exists; no evidence counted as success");
  });
});

test("evidence PUT failure and evidence hang never block the transcript; each outcome is reported", async () => {
  await withApp(async (app) => {
    const { apiKey, agentId } = await seed();
    const failed = await runChain(app.baseUrl, apiKey, { records: 60, agentId, evidenceFault: "put_500" });
    assertTranscriptStored(failed, "evidence put 500");
    assert.equal(failed.result.machineEvidence?.status, "failed");
    assert.match(failed.result.machineEvidence?.error ?? "", /500/);
    assert.equal(failed.bucket.objects("feedback-machine-evidence/").length, 0);

    const started = Date.now();
    const hung = await runChain(app.baseUrl, apiKey, { records: 60, agentId, evidenceFault: "hang", machineEvidenceWaitMs: 200 });
    assert.ok(Date.now() - started < 20_000, "bounded");
    assertTranscriptStored(hung, "evidence hang");
    assert.equal(hung.result.machineEvidence?.status, "timeout");
  });
});

test("identity mismatch: evidence for an agent bound to ANOTHER machine is refused by the server; the transcript still lands", async () => {
  await withApp(async (app) => {
    const { apiKey, otherMachineAgentId } = await seed();
    const o = await runChain(app.baseUrl, apiKey, { records: 10, agentId: otherMachineAgentId });
    assertTranscriptStored(o, "foreign agent");
    assert.equal(o.result.machineEvidence?.status, "failed");
    assert.match(o.result.machineEvidence?.error ?? "", /403/);
    assert.equal(o.bucket.objects("feedback-machine-evidence/").length, 0);
  });
});
