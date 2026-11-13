// task #1228 deliverable ①: a daemon placeholder is never uploaded as a
// transcript; every lookup / upload outcome is a typed observation; the
// transcript_outcome object is best-effort and never recursive.
//
// Synthetic only: temp data/home dirs, a fake driver, a stubbed fetch. No real
// runtime home, no network, no real agent.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, BasicTracer, MemoryTraceSink, type AgentConfig, type AxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { AgentProcessManager, resolveRuntimeSessionRef } from "./agentProcessManager";
import { collectFeedbackTranscriptAttachment } from "./feedbackTranscriptCollector";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

// Loaded per test so a missing module fails the test that needs it, not the file.
const outcomeModule = () => import("./feedbackTranscriptOutcomeUpload") as Promise<any>;

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  kill(): boolean {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

class FakeDriver implements RuntimeDriver {
  readonly id = "claude";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly supportsNativeStandingPrompt = true;
  spawn(_ctx: SpawnContext): SpawnResult {
    return { process: new FakeChildProcess() as unknown as ChildProcess };
  }
  parseLine(_line: string): ParsedEvent[] {
    return [];
  }
  encodeStdinMessage(text?: string): string | null {
    return text ? JSON.stringify({ text }) : null;
  }
  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("standing prompt");
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent",
    displayName: "Agent",
    description: "test agent",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    agentCredentialId: null,
    ...overrides,
  };
}

interface FetchLog {
  attestations: Array<Record<string, unknown>>;
  creates: number;
  puts: number;
  bodies: Buffer[];
}

/** A server + worker stand-in that stores everything it is given. */
function recordingFetch(): { fetchImpl: typeof fetch; log: FetchLog } {
  const log: FetchLog = { attestations: [], creates: 0, puts: 0, bodies: [] };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/internal/machine/scope-attestation")) {
      const metadata = (JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> }).metadata;
      log.attestations.push(metadata);
      return json({ attestation: `att-${log.attestations.length}`, scope: "daemon-trace-bundle:create", audience: "trace-ingest-worker", resource: null, metadata, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.endsWith("/api/trace-bundles")) {
      log.creates += 1;
      const kind = log.attestations.at(-1)?.feedbackAttachmentKind;
      return json({ id: `upload-${log.creates}`, ...(kind ? { feedbackAttachmentKind: kind } : {}), upload: { method: "PUT", url: `https://worker.test/put/${log.creates}`, headers: {} } });
    }
    if (url.startsWith("https://worker.test/put/")) {
      log.puts += 1;
      log.bodies.push(Buffer.from(await (init?.body as Blob).arrayBuffer()));
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, log };
}

async function withManager(
  fn: (ctx: { manager: AgentProcessManager; dataDir: string; homeDir: string }) => Promise<void>,
  options: { workerUrl?: string; fetchImpl?: typeof fetch; separateHome?: boolean } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-transcript-honesty-"));
  // separateHome: a custom dataDir OUTSIDE every home directory, so its paths stay absolute.
  const homeDir = options.separateHome ? path.join(dataDir, "runtime-home") : dataDir;
  const manager = new AgentProcessManager(() => undefined, "sk_machine_test", {
    dataDir,
    serverUrl: "https://daemon.example.com",
    workerUrl: options.workerUrl,
    fetchImpl: options.fetchImpl,
    driverResolver: () => new FakeDriver(),
    runtimeSessionHomeDir: homeDir,
  });
  try {
    await fn({ manager, dataDir, homeDir });
  } finally {
    await releaseAgentManagerForTests(manager);
    await chmod(dataDir, 0o700).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function writeClaudeSession(homeDir: string, sessionId: string, content: string): Promise<string> {
  const dir = path.join(homeDir, ".claude", "projects", "proj");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, content);
  return file;
}

const WINDOW = { reportGeneratedAt: "2026-10-04T08:00:00.000Z", reportTimeSource: "web_report_bundle" as const };

// ---------------------------------------------------------------------------
// A. Typed content kind, decided where the bytes are produced
// ---------------------------------------------------------------------------
describe("A: getSessionTranscript returns a typed content kind", () => {
  test("A1 native file missing → content=placeholder, NO bytes, not reachable, reason=native_session_file_not_found", async () => {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "missing-session" }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      assert.equal(result.transcriptContent, "placeholder");
      assert.equal(result.transcript, null, "the handoff text must never be returned as transcript bytes");
      assert.equal(result.reachable, false);
      assert.equal(result.reasonCode, "native_session_file_not_found");
      assert.equal(result.lookupMethod, "claude_jsonl");
      assert.ok(Array.isArray(result.searchedPaths) && result.searchedPaths.some((p: string) => p.includes(path.join(".claude", "projects"))));
    });
  });

  test("A2 runtime without a native lookup (gemini/cursor/copilot/opencode) → placeholder + runtime_has_no_native_lookup", async () => {
    for (const runtime of ["gemini", "cursor", "copilot", "opencode"]) {
      await withManager(async ({ manager }) => {
        await manager.startAgent("agent-1", makeConfig({ runtime, sessionId: `s-${runtime}` }));
        const result = await manager.getSessionTranscript("agent-1") as any;
        assert.equal(result.transcriptContent, "placeholder", runtime);
        assert.equal(result.transcript, null, runtime);
        assert.equal(result.reasonCode, "runtime_has_no_native_lookup", runtime);
        assert.equal(result.lookupMethod, "none", runtime);
      });
    }
  });

  test("A3 native file present → native_session_file with sourceBytes = on-disk size and transcriptBytes = uploaded bytes", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const content = '{"type":"user","text":"hi"}\n{"type":"assistant","text":"there"}\n';
      await writeClaudeSession(homeDir, "present", content);
      await manager.startAgent("agent-1", makeConfig({ sessionId: "present" }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      assert.equal(result.transcriptContent, "native_session_file");
      assert.equal(result.reachable, true);
      assert.equal(result.sourceBytes, Buffer.byteLength(content));
      assert.equal(result.transcriptBytes, Buffer.byteLength(result.transcript, "utf8"));
      assert.equal(result.reasonCode, undefined);
    });
  });

  test("A4 legacy kimi CLI session directory → native_state_file (the runtime's state file, not called a conversation transcript)", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const agentId = "d2bf1e2c-3648-4590-a0e2-46c6998b2c38";
      const sessionId = "kimi-s1";
      const sessionDir = path.join(homeDir, ".kimi", "sessions", `wd_${agentId}_abc`, `session_${sessionId}`);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(path.join(sessionDir, "state.json"), '{"state":1}');
      await manager.startAgent(agentId, makeConfig({ runtime: "kimi", sessionId }));
      const result = await manager.getSessionTranscript(agentId) as any;
      assert.equal(result.transcriptContent, "native_state_file");
      assert.equal(result.sourceBytes, Buffer.byteLength('{"state":1}'));
    });
  });

  test("A4b kimi-sdk session → its main agent's wire.jsonl, a conversation (native_session_file), never state.json", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const kimiHome = path.join(homeDir, "kimi-code-home");
      const sessionId = "session_kimi-s1";
      const sessionDir = path.join(kimiHome, "sessions", "wk_1", sessionId);
      await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
      await writeFile(path.join(sessionDir, "state.json"), '{"state":1}');
      await writeFile(path.join(sessionDir, "agents", "main", "wire.jsonl"), '{"type":"context.append_message"}\n');
      await manager.startAgent("agent-1", makeConfig({ runtime: "kimi-sdk", sessionId, envVars: { KIMI_CODE_HOME: kimiHome } }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      assert.equal(result.transcriptContent, "native_session_file");
      assert.equal(result.transcript, '{"type":"context.append_message"}\n');
    });
  });

  test("A5 the runtime-profile resolver still writes and returns the handoff file (callers of resolveRuntimeSessionRef unchanged)", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "slock-handoff-home-"));
    const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "slock-handoff-fb-"));
    try {
      const ref = resolveRuntimeSessionRef("claude", "nope", homeDir, fallbackDir);
      assert.equal(ref.reachable, true);
      const marker = JSON.parse((await readFile(String(ref.path), "utf8")).trim());
      assert.equal(marker.type, "runtime_session_handoff");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(fallbackDir, { recursive: true, force: true });
    }
  });

  test("A6 the feedback lookup still leaves the handoff marker for the runtime-profile join, but does not read it as a transcript", async () => {
    await withManager(async ({ manager, dataDir }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "missing-again" }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      const markerPath = path.join(dataDir, "agent-1", ".slock", "runtime-sessions", "claude-missing-again.jsonl");
      const marker = JSON.parse((await readFile(markerPath, "utf8")).trim().split("\n").at(-1)!);
      assert.equal(marker.type, "runtime_session_handoff");
      assert.equal(result.transcript, null);
    });
  });

  test("A7 runtime profile report still carries the handoff sessionRef (reachable) when the native file is missing", async () => {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "profile-miss" }));
      const report = manager.getAgentRuntimeProfileReport("agent-1") as any;
      assert.equal(report?.facts?.sessionRef?.reachable, true);
      assert.match(String(report?.facts?.sessionRef?.reason), /daemon handoff file/);
    });
  });
});

// ---------------------------------------------------------------------------
// B. Reason codes describe only observations
// ---------------------------------------------------------------------------
describe("B: reason codes are observations, not conclusions", () => {
  test("B1 no config in memory, workspace directory absent → no_config_in_memory + local lookup info; never 'not on this machine'", async () => {
    await withManager(async ({ manager }) => {
      const result = await manager.getSessionTranscript("ghost-agent") as any;
      assert.equal(result.reasonCode, "no_config_in_memory");
      assert.equal(result.workspaceDirPresent, false);
      assert.equal(result.lookupMethod, "in_memory_agent_config");
      assert.ok(Array.isArray(result.searchedPaths) && result.searchedPaths.length === 1);
      assert.ok(!/not on this machine|never ran/i.test(JSON.stringify(result)));
      assert.equal(result.transcriptContent, "absent");
    });
  });

  test("B2 no config in memory, workspace directory present → same code, workspaceDirPresent=true", async () => {
    await withManager(async ({ manager, dataDir }) => {
      await mkdir(path.join(dataDir, "stopped-agent"), { recursive: true });
      const result = await manager.getSessionTranscript("stopped-agent") as any;
      assert.equal(result.reasonCode, "no_config_in_memory");
      assert.equal(result.workspaceDirPresent, true);
    });
  });

  test("B3 native file of 0 bytes → session_file_empty with sourceBytes 0", async () => {
    await withManager(async ({ manager, homeDir }) => {
      await writeClaudeSession(homeDir, "empty", "");
      await manager.startAgent("agent-1", makeConfig({ sessionId: "empty" }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      assert.equal(result.reasonCode, "session_file_empty");
      assert.equal(result.sourceBytes, 0);
      assert.equal(result.transcriptContent, "absent");
    });
  });

  test("B4 non-empty native file whose bounded window is empty → window_empty (distinct from an empty file)", async () => {
    await withManager(async ({ manager, homeDir }) => {
      // One record larger than the 10 MiB read bound and no newline: the
      // aligned window drops the partial record and nothing remains.
      const huge = `{"type":"user","text":"${"x".repeat(10 * 1024 * 1024 + 1024)}"`;
      await writeClaudeSession(homeDir, "window-empty", huge);
      await manager.startAgent("agent-1", makeConfig({ sessionId: "window-empty" }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      assert.equal(result.reasonCode, "window_empty");
      assert.equal(result.sourceBytes, Buffer.byteLength(huge));
      assert.equal(result.transcriptContent, "absent");
    });
  });

  test("B5a a symlinked session file inside the runtime root is never followed (lookup reports not found, nothing read)", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const outside = path.join(homeDir, "outside.jsonl");
      await writeFile(outside, '{"escaped":true}\n');
      const dir = path.join(homeDir, ".claude", "projects");
      await mkdir(dir, { recursive: true });
      await symlink(outside, path.join(dir, "linked.jsonl"));
      await manager.startAgent("agent-1", makeConfig({ sessionId: "linked" }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      assert.equal(result.reasonCode, "native_session_file_not_found");
      assert.equal(result.transcript, null);
    });
  });

  test("B5b a resolved native path outside the allowed roots (legacy kimi index pointing elsewhere) → path_rejected", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const agentId = "d2bf1e2c-3648-4590-a0e2-46c6998b2c38";
      const sessionDir = path.join(homeDir, "elsewhere", "session_k");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(path.join(sessionDir, "state.json"), '{"escaped":true}');
      await mkdir(path.join(homeDir, ".kimi"), { recursive: true });
      await writeFile(path.join(homeDir, ".kimi", "session_index.jsonl"), `${JSON.stringify({ sessionId: "k", sessionDir })}\n`);
      await manager.startAgent(agentId, makeConfig({ runtime: "kimi", sessionId: "k" }));
      const result = await manager.getSessionTranscript(agentId) as any;
      assert.equal(result.reasonCode, "path_rejected");
      assert.equal(result.transcript, null);
    });
  });

  test("B6 unreadable native file → read_failed (not 'empty', not 'missing')", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const file = await writeClaudeSession(homeDir, "unreadable", '{"a":1}\n');
      await chmod(file, 0o000);
      try {
        await manager.startAgent("agent-1", makeConfig({ sessionId: "unreadable" }));
        const result = await manager.getSessionTranscript("agent-1") as any;
        assert.equal(result.reasonCode, "read_failed");
      } finally {
        await chmod(file, 0o600);
      }
    });
  });

  test("B7 config but no session id → no_session_id", async () => {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: null }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      if (result.sessionId !== "unknown") return; // driver assigned one; nothing to assert
      assert.equal(result.reasonCode, "no_session_id");
    });
  });

  test("B8 searched paths leave the machine with the home directory folded to ~", async () => {
    await withManager(async ({ manager, homeDir }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "fold" }));
      const result = await manager.getSessionTranscript("agent-1") as any;
      for (const p of result.searchedPaths as string[]) assert.ok(!p.startsWith(homeDir), p);
      assert.ok((result.searchedPaths as string[]).some((p) => p.startsWith("~")));
    });
  });
});

// ---------------------------------------------------------------------------
// A + B through the feedback path: nothing placeholder-shaped is uploaded
// ---------------------------------------------------------------------------
describe("A/B via collectFeedbackTranscript", () => {
  test("AB1 native miss: zero transcript attestations; lookup + upload outcomes are typed", async () => {
    const { fetchImpl, log } = recordingFetch();
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "missing" }));
      const result = await manager.collectFeedbackTranscript("agent-1", "report-1", WINDOW, { requestId: "req-1" } as any) as any;
      assert.equal(log.attestations.filter((m) => m.feedbackAttachmentKind === undefined || m.feedbackAttachmentKind === "session_transcript").length, 0);
      assert.equal(result.reachable, false);
      assert.equal(result.outcomeVersion, 1);
      assert.equal(result.lookup.content, "placeholder");
      assert.equal(result.lookup.reasonCode, "native_session_file_not_found");
      assert.equal(result.lookup.selectionBasis, "lookup_time");
      assert.deepEqual(
        { status: result.upload.status, reason: result.upload.reason },
        { status: "not_attempted", reason: "lookup_failed" },
      );
    }, { workerUrl: "https://worker.test", fetchImpl });
  });

  test("AB2 native hit: transcript signed with content label, byte counts and the request id", async () => {
    const { fetchImpl, log } = recordingFetch();
    await withManager(async ({ manager, homeDir }) => {
      const content = '{"type":"user","timestamp":"2026-10-04T07:59:00.000Z"}\n';
      await writeClaudeSession(homeDir, "hit", content);
      await manager.startAgent("agent-1", makeConfig({ sessionId: "hit" }));
      const result = await manager.collectFeedbackTranscript("agent-1", "report-1", WINDOW, { requestId: "req-1" } as any) as any;
      const transcript = log.attestations.find((m) => m.feedbackAttachmentKind === undefined);
      assert.ok(transcript, "transcript attestation requested");
      assert.equal(transcript.feedbackTranscriptContent, "native_session_file");
      assert.equal(transcript.feedbackTranscriptSourceBytes, Buffer.byteLength(content));
      assert.equal(transcript.feedbackTranscriptBytes, Buffer.byteLength(content));
      assert.equal(transcript.feedbackTranscriptRequestId, "req-1");
      assert.equal(result.upload.status, "stored");
      assert.equal(result.upload.uploadId, "upload-1");
      assert.equal(result.upload.contentLabel, "signed");
      assert.equal(result.lookup.content, "native_session_file");
    }, { workerUrl: "https://worker.test", fetchImpl });
  });

  test("a report about an agent this daemon holds nothing for is stored with the request's session lookup (after a restart, or the agent's failure)", async () => {
    const { fetchImpl, log } = recordingFetch();
    await withManager(async ({ manager, homeDir }) => {
      const content = '{"type":"user","timestamp":"2026-10-04T07:59:00.000Z"}\n';
      await writeClaudeSession(homeDir, "hit", content);
      // Never started here: without the lookup this is no_config_in_memory.
      const without = await manager.collectFeedbackTranscript("agent-1", "report-0", WINDOW, { requestId: "req-0" } as any) as any;
      assert.equal(without.lookup.reasonCode, "no_config_in_memory");
      const result = await manager.collectFeedbackTranscript("agent-1", "report-1", WINDOW, {
        requestId: "req-1",
        serverLookup: { runtime: "claude", model: "sonnet", sessionHomeEnv: null, sessionId: "hit" },
      } as any) as any;
      const transcript = log.attestations.find((m) => m.feedbackAttachmentKind === undefined);
      assert.ok(transcript, "transcript attestation requested");
      assert.equal(transcript.feedbackTranscriptContent, "native_session_file");
      assert.equal(transcript.feedbackTranscriptSourceBytes, Buffer.byteLength(content));
      assert.equal(transcript.feedbackTranscriptBytes, Buffer.byteLength(content));
      assert.equal(transcript.feedbackTranscriptRequestId, "req-1");
      assert.equal(result.upload.status, "stored");
      assert.equal(result.upload.uploadId, "upload-1");
      assert.equal(result.upload.contentLabel, "signed");
      assert.equal(result.lookup.content, "native_session_file");
    }, { workerUrl: "https://worker.test", fetchImpl });
  });

  test("AB3 collector refuses a non-native content kind even when bytes are present (defence in depth)", async () => {
    const { fetchImpl, log } = recordingFetch();
    const result = await collectFeedbackTranscriptAttachment({
      agentId: "agent-1",
      feedbackReportId: "report-1",
      reportWindow: WINDOW,
      getSessionTranscript: async () => ({
        runtime: "claude", sessionId: "s", reachable: true, transcript: '{"type":"runtime_session_handoff"}', sizeBytes: 34,
        transcriptContent: "placeholder",
      } as any),
      getObservedFailureSummary: async () => null,
      getMachineEvidence: async () => ({ traceTail: null, machineState: null }),
      serverUrl: "https://server.test",
      daemonApiKey: "k",
      workerUrl: "https://worker.test",
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
      fetchImpl: fetchImpl as never,
    }) as any;
    assert.equal(log.puts, 0, "no bytes of a placeholder are ever PUT");
    assert.equal(result.upload?.status, "not_attempted");
  });

  test("AB4 collector refuses bytes whose content kind is unknown (e.g. a caller that forgot to classify)", async () => {
    const { fetchImpl, log } = recordingFetch();
    await collectFeedbackTranscriptAttachment({
      agentId: "agent-1",
      feedbackReportId: "report-1",
      reportWindow: WINDOW,
      getSessionTranscript: async () => ({ runtime: "claude", sessionId: "s", reachable: true, transcript: "{}", sizeBytes: 2 }),
      getObservedFailureSummary: async () => null,
      getMachineEvidence: async () => ({ traceTail: null, machineState: null }),
      serverUrl: "https://server.test",
      daemonApiKey: "k",
      workerUrl: "https://worker.test",
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
      fetchImpl: fetchImpl as never,
    });
    assert.equal(log.puts, 0);
  });
});

// ---------------------------------------------------------------------------
// Upload failures are typed by stage and HTTP class
// ---------------------------------------------------------------------------
describe("upload outcome is typed: stage + HTTP class", () => {
  const cases: Array<{ name: string; fault: "attestation_403" | "create_400" | "put_503" | "timeout" | "network"; stage: string; httpStatus: number | null; httpClass: string }> = [
    { name: "attestation 403", fault: "attestation_403", stage: "attestation", httpStatus: 403, httpClass: "4xx" },
    { name: "create 400", fault: "create_400", stage: "create", httpStatus: 400, httpClass: "4xx" },
    { name: "PUT 503", fault: "put_503", stage: "put", httpStatus: 503, httpClass: "5xx" },
    { name: "create timeout", fault: "timeout", stage: "create", httpStatus: null, httpClass: "timeout" },
    { name: "PUT network error", fault: "network", stage: "put", httpStatus: null, httpClass: "network" },
  ];
  for (const c of cases) {
    test(`U ${c.name} → failed/upload_failed at stage=${c.stage}, class=${c.httpClass}`, async () => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      const fetchImpl = (async (input: string, init?: RequestInit) => {
        if (input.endsWith("/internal/machine/scope-attestation")) {
          if (c.fault === "attestation_403") return json({ error: "forbidden" }, 403);
          const metadata = (JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> }).metadata;
          return json({ attestation: "a", scope: "s", audience: "trace-ingest-worker", resource: null, metadata, expiresAt: new Date(Date.now() + 60_000).toISOString() });
        }
        if (input.endsWith("/api/trace-bundles")) {
          if (c.fault === "create_400") return json({ error: "bad" }, 400);
          if (c.fault === "timeout") {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
              setTimeout(() => reject(new Error("test fallback: no timeout option honoured")), 2_000).unref?.();
            });
          }
          return json({ id: "u1", upload: { method: "PUT", url: "https://worker.test/put/1", headers: {} } });
        }
        if (c.fault === "put_503") return new Response("", { status: 503 });
        if (c.fault === "network") throw new TypeError("fetch failed");
        return new Response("", { status: 200 });
      }) as never;
      const result = await collectFeedbackTranscriptAttachment({
        agentId: "agent-1",
        feedbackReportId: "report-1",
        reportWindow: WINDOW,
        getSessionTranscript: async () => ({ runtime: "claude", sessionId: "s", reachable: true, transcript: "{}\n", sizeBytes: 3, transcriptContent: "native_session_file", sourceBytes: 3, transcriptBytes: 3 } as any),
        getObservedFailureSummary: async () => null,
        getMachineEvidence: async () => ({ traceTail: null, machineState: null }),
        machineEvidenceWaitMs: 50,
        uploadTimeoutMs: 100,
        serverUrl: "https://server.test",
        daemonApiKey: "k",
        workerUrl: "https://worker.test",
        tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
        fetchImpl,
      } as any) as any;
      assert.equal(result.upload?.status, "failed");
      assert.equal(result.upload?.reason, "upload_failed");
      assert.equal(result.upload?.stage, c.stage);
      assert.equal(result.upload?.httpStatus, c.httpStatus);
      assert.equal(result.upload?.httpClass, c.httpClass);
      assert.equal(typeof result.error, "string", "legacy free-text error is kept for older servers");
    });
  }

  test("U older server (does not echo the content label): transcript is STILL uploaded, labelled unsigned", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    let puts = 0;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      if (input.endsWith("/internal/machine/scope-attestation")) {
        const metadata = { ...(JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> }).metadata };
        delete metadata.feedbackTranscriptContent;
        delete metadata.feedbackTranscriptSourceBytes;
        delete metadata.feedbackTranscriptBytes;
        delete metadata.feedbackTranscriptRequestId;
        return json({ attestation: "a", scope: "s", audience: "trace-ingest-worker", resource: null, metadata, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      if (input.endsWith("/api/trace-bundles")) return json({ id: "u1", upload: { method: "PUT", url: "https://worker.test/put/1", headers: {} } });
      puts += 1;
      return new Response("", { status: 200 });
    }) as never;
    const result = await collectFeedbackTranscriptAttachment({
      agentId: "agent-1",
      feedbackReportId: "report-1",
      reportWindow: WINDOW,
      getSessionTranscript: async () => ({ runtime: "claude", sessionId: "s", reachable: true, transcript: "{}\n", sizeBytes: 3, transcriptContent: "native_session_file", sourceBytes: 3, transcriptBytes: 3 } as any),
      getObservedFailureSummary: async () => null,
      getMachineEvidence: async () => ({ traceTail: null, machineState: null }),
      machineEvidenceWaitMs: 50,
      serverUrl: "https://server.test",
      daemonApiKey: "k",
      workerUrl: "https://worker.test",
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
      fetchImpl,
    }) as any;
    assert.ok(puts >= 1, "the transcript is not regressed by an older server");
    assert.equal(result.traceBundleId, "u1");
    assert.equal(result.upload?.status, "stored");
    assert.equal(result.upload?.contentLabel, "unsigned");
  });

  test("U worker URL not configured → upload not_attempted / worker_not_configured", async () => {
    const result = await collectFeedbackTranscriptAttachment({
      agentId: "agent-1",
      feedbackReportId: "report-1",
      reportWindow: WINDOW,
      getSessionTranscript: async () => ({ runtime: "claude", sessionId: "s", reachable: true, transcript: "{}\n", sizeBytes: 3, transcriptContent: "native_session_file", sourceBytes: 3, transcriptBytes: 3 } as any),
      getObservedFailureSummary: async () => null,
      getMachineEvidence: async () => ({ traceTail: null, machineState: null }),
      serverUrl: "https://server.test",
      daemonApiKey: "k",
      workerUrl: null,
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
      fetchImpl: (async () => { throw new Error("no network expected"); }) as never,
    }) as any;
    assert.deepEqual({ status: result.upload?.status, reason: result.upload?.reason }, { status: "not_attempted", reason: "worker_not_configured" });
  });
});

// ---------------------------------------------------------------------------
// C. transcript_outcome is best-effort, after the result, never recursive
// ---------------------------------------------------------------------------
function lookupFailedResult(): Record<string, unknown> {
  return {
    reachable: false,
    fallbackReason: "native session file not found",
    outcomeVersion: 1,
    lookup: {
      reachable: false, content: "placeholder", reasonCode: "native_session_file_not_found", runtime: "claude",
      lookupMethod: "claude_jsonl", workspaceDirPresent: null,
      sourceBytes: null, transcriptBytes: null, selectionBasis: "lookup_time",
    },
    upload: { status: "not_attempted", reason: "lookup_failed", stage: null, httpStatus: null, httpClass: null, uploadId: null, contentLabel: null },
  };
}

function outcomeInput(fetchImpl: unknown, overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-1",
    feedbackReportId: "report-1",
    requestId: "req-1",
    daemonVersion: "1.0.43",
    serverUrl: "https://server.test",
    daemonApiKey: "k",
    workerUrl: "https://worker.test",
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
    fetchImpl,
    ...overrides,
  };
}

describe("C: transcript_outcome delivery", () => {
  test("C1 the result frame is sent BEFORE the outcome upload starts; a hanging outcome upload never delays it", async () => {
    const { runFeedbackTranscriptRequest } = await outcomeModule();
    const order: string[] = [];
    let sentFrame: any = null;
    const run = await runFeedbackTranscriptRequest({
      collect: async () => lookupFailedResult(),
      send: (frame: unknown) => { order.push("send"); sentFrame = frame; },
      uploadOutcome: () => { order.push("upload"); return new Promise(() => {}); },
      workerConfigured: true,
      tag: "t",
    });
    assert.deepEqual(order, ["send", "upload"]);
    assert.equal(sentFrame.outcomeObject, "attempt_after_result", "the frame says the outcome object's fate is unknown to it");
    assert.ok(run.outcome instanceof Promise);
  });

  test("C2 an outcome upload failure never triggers another outcome upload (no recursion), and never rejects", async () => {
    const { uploadFeedbackTranscriptOutcome } = await outcomeModule();
    let outcomeAttestations = 0;
    const fetchImpl = async (input: string, init?: RequestInit) => {
      if (input.endsWith("/internal/machine/scope-attestation")) {
        const kind = (JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> }).metadata.feedbackAttachmentKind;
        if (kind === "transcript_outcome") outcomeAttestations += 1;
        return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 500 });
    };
    const status = await uploadFeedbackTranscriptOutcome({ ...outcomeInput(fetchImpl), result: lookupFailedResult() });
    assert.equal(status, "failed");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(outcomeAttestations, 1);
  });

  test("C3 a collector that throws still sends a typed collector_error frame and attempts ONE outcome upload", async () => {
    const { runFeedbackTranscriptRequest } = await outcomeModule();
    let frame: any = null;
    let uploads = 0;
    const run = await runFeedbackTranscriptRequest({
      collect: async () => { throw new Error("boom"); },
      send: (f: unknown) => { frame = f; },
      uploadOutcome: async () => { uploads += 1; return "failed"; },
      workerConfigured: true,
      tag: "t",
    });
    await run.outcome;
    assert.equal(frame.reachable, false);
    assert.equal(frame.error, "boom");
    assert.equal(frame.lookup.reasonCode, "collector_error");
    assert.equal(uploads, 1);
  });

  test("C4 worker not configured → no outcome upload; the frame says not_attempted_worker_not_configured", async () => {
    const { runFeedbackTranscriptRequest } = await outcomeModule();
    let frame: any = null;
    let uploads = 0;
    const run = await runFeedbackTranscriptRequest({
      collect: async () => lookupFailedResult(),
      send: (f: unknown) => { frame = f; },
      uploadOutcome: async () => { uploads += 1; return "stored"; },
      workerConfigured: false,
      tag: "t",
    });
    await run.outcome;
    assert.equal(uploads, 0);
    assert.equal(frame.outcomeObject, "not_attempted_worker_not_configured");
  });

  test("C5 a send that throws (connection gone) does not prevent the outcome upload nor reject", async () => {
    const { runFeedbackTranscriptRequest } = await outcomeModule();
    let uploads = 0;
    const run = await runFeedbackTranscriptRequest({
      collect: async () => lookupFailedResult(),
      send: () => { throw new Error("socket closed"); },
      uploadOutcome: async () => { uploads += 1; return "stored"; },
      workerConfigured: true,
      tag: "t",
    });
    await run.outcome;
    assert.equal(uploads, 1);
  });

  test("C6 outcome object: strict schema, ≤ 2 KiB, no session id, carries the lookup code and request id, never self-attests storage", async () => {
    const { uploadFeedbackTranscriptOutcome } = await outcomeModule();
    const { fetchImpl, log } = recordingFetch();
    const status = await uploadFeedbackTranscriptOutcome({ ...outcomeInput(fetchImpl), result: lookupFailedResult() });
    assert.equal(status, "stored");
    const att = log.attestations[0]!;
    assert.equal(att.feedbackAttachmentKind, "transcript_outcome");
    assert.equal(att.feedbackTranscriptRequestId, "req-1");
    const raw = gunzipSync(log.bodies[0]!);
    assert.ok(raw.byteLength <= 2048, `outcome is ${raw.byteLength} bytes`);
    const body = JSON.parse(raw.toString("utf8"));
    assert.equal(body.type, "feedback_transcript_outcome");
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.requestId, "req-1");
    assert.equal(body.feedbackReportId, "report-1");
    assert.equal(body.agentId, "agent-1");
    assert.equal(body.daemonVersion, "1.0.43");
    assert.equal(body.lookup.reasonCode, "native_session_file_not_found");
    assert.equal(body.upload.status, "not_attempted");
    assert.equal(body.selfStorage, "not_self_attested");
    assert.ok(!raw.toString("utf8").includes("sessionId"));
  });

  test("C7 older server (drops the transcript_outcome kind) → not handed to the worker; older worker (no kind echo) → never PUT", async () => {
    const { uploadFeedbackTranscriptOutcome } = await outcomeModule();
    for (const mode of ["server", "worker"] as const) {
      let creates = 0;
      let puts = 0;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      const fetchImpl = async (input: string, init?: RequestInit) => {
        if (input.endsWith("/internal/machine/scope-attestation")) {
          const metadata = { ...(JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> }).metadata };
          if (mode === "server") delete metadata.feedbackAttachmentKind;
          return json({ attestation: "a", scope: "s", audience: "w", resource: null, metadata, expiresAt: new Date(Date.now() + 60_000).toISOString() });
        }
        if (input.endsWith("/api/trace-bundles")) {
          creates += 1;
          return json({ id: "u", upload: { method: "PUT", url: "https://worker.test/put/x", headers: {} } });
        }
        puts += 1;
        return new Response("", { status: 200 });
      };
      const status = await uploadFeedbackTranscriptOutcome({ ...outcomeInput(fetchImpl), result: lookupFailedResult() });
      assert.equal(status, "unsupported", mode);
      assert.equal(puts, 0, mode);
      if (mode === "server") assert.equal(creates, 0);
    }
  });

  test("C8 a hanging outcome upload is bounded by its own timeout and resolves (unknown to the server either way)", async () => {
    const { uploadFeedbackTranscriptOutcome } = await outcomeModule();
    const fetchImpl = (_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const status = await uploadFeedbackTranscriptOutcome({ ...outcomeInput(fetchImpl, { timeoutMs: 50 }), result: lookupFailedResult() });
    assert.equal(status, "failed");
  });
});

// ---------------------------------------------------------------------------
// D. Searched paths never leave the machine (reviewer ruling: the uploaded
// transcript_outcome and the result frame carry NO paths; only the local
// lookup diagnostic keeps them). The WHOLE serialized JSON is grepped.
// ---------------------------------------------------------------------------
const CUSTOM_DATA_DIR_PATH = "/srv/custom-private-workspace/agent/agent-1";
const HOME_FOLDED_PATH = "~/.claude/projects/-srv-custom-private-workspace";

function assertNoPath(json: string, label: string): void {
  assert.ok(!json.includes("/srv/"), `${label} carries /srv/: ${json}`);
  assert.ok(!json.includes("custom-private-workspace"), `${label} carries a path segment: ${json}`);
  assert.ok(!json.includes("~"), `${label} carries a home-folded path: ${json}`);
  assert.ok(!json.includes("/"), `${label} carries a path separator: ${json}`);
  assert.ok(!json.includes("\\"), `${label} carries a path separator: ${json}`);
  assert.ok(!json.includes("searchedPaths"), `${label} carries searchedPaths: ${json}`);
}

function collectWithSearched(searchedPaths: string[], fetchImpl: unknown) {
  return collectFeedbackTranscriptAttachment({
    agentId: "agent-1",
    feedbackReportId: "report-1",
    reportWindow: WINDOW,
    getSessionTranscript: async () => ({
      runtime: "claude", sessionId: "s", reachable: false, transcript: null, sizeBytes: 0,
      transcriptContent: "absent", reasonCode: "native_session_file_not_found", lookupMethod: "claude_jsonl",
      searchedPaths, workspaceDirPresent: true,
    } as any),
    getObservedFailureSummary: async () => null,
    getMachineEvidence: async () => ({ traceTail: null, machineState: null }),
    serverUrl: "https://server.test",
    daemonApiKey: "k",
    workerUrl: "https://worker.test",
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
    fetchImpl: fetchImpl as never,
  });
}

describe("D: searched paths stay local", () => {
  for (const [name, searched] of [
    ["D1 absolute path under a custom dataDir", [CUSTOM_DATA_DIR_PATH]],
    ["D2 home-folded path", [HOME_FOLDED_PATH]],
  ] as const) {
    test(`${name}: absent from the result frame AND the uploaded outcome object`, async () => {
      const { uploadFeedbackTranscriptOutcome } = await outcomeModule();
      const { fetchImpl, log } = recordingFetch();
      const result = await collectWithSearched([...searched], fetchImpl);
      assertNoPath(JSON.stringify(result.lookup), "result frame lookup");
      const status = await uploadFeedbackTranscriptOutcome({ ...outcomeInput(fetchImpl), result });
      assert.equal(status, "stored");
      assertNoPath(gunzipSync(log.bodies.at(-1)!).toString("utf8"), "uploaded outcome");
    });
  }

  test("D3 a stray searchedPaths on the frame's lookup (older in-process shape) is still never uploaded", async () => {
    const { uploadFeedbackTranscriptOutcome } = await outcomeModule();
    const { fetchImpl, log } = recordingFetch();
    const result = lookupFailedResult() as any;
    result.lookup = { ...result.lookup, searchedPaths: [CUSTOM_DATA_DIR_PATH, HOME_FOLDED_PATH] };
    const status = await uploadFeedbackTranscriptOutcome({ ...outcomeInput(fetchImpl), result });
    assert.equal(status, "stored");
    assertNoPath(gunzipSync(log.bodies.at(-1)!).toString("utf8"), "uploaded outcome");
  });

  test("D4 real manager, agent unknown to this daemon: the local diagnostic keeps the absolute dataDir path; the frame and outcome do not", async () => {
    const { uploadFeedbackTranscriptOutcome } = await outcomeModule();
    const { fetchImpl, log } = recordingFetch();
    await withManager(async ({ manager, dataDir }) => {
      assert.ok(!dataDir.startsWith(os.homedir()), "positive control needs a dataDir outside the home directory");
      const local = await manager.getSessionTranscript("ghost-agent") as any;
      assert.equal(local.reasonCode, "no_config_in_memory");
      assert.ok(local.searchedPaths.some((p: string) => p.startsWith(dataDir)), "local diagnostic keeps the searched path for debugging");
      const result = await manager.collectFeedbackTranscript("ghost-agent", "report-1", WINDOW, { requestId: "req-1" }) as any;
      const frameJson = JSON.stringify(result);
      assert.ok(!frameJson.includes(dataDir), `result frame carries the dataDir: ${frameJson}`);
      assert.ok(!frameJson.includes("searchedPaths"), frameJson);
      await uploadFeedbackTranscriptOutcome({ ...outcomeInput(fetchImpl, { agentId: "ghost-agent" }), result });
      assertNoPath(gunzipSync(log.bodies.at(-1)!).toString("utf8"), "uploaded outcome");
    }, { workerUrl: "https://worker.test", fetchImpl, separateHome: true });
  });

  test("D5 real manager, claude miss: the local diagnostic keeps the home-folded searched paths", async () => {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "missing-local" }));
      const local = await manager.getSessionTranscript("agent-1") as any;
      assert.ok(local.searchedPaths.some((p: string) => p.startsWith("~")), JSON.stringify(local.searchedPaths));
      const result = await manager.collectFeedbackTranscript("agent-1", "report-1", WINDOW, { requestId: "req-1" }) as any;
      assertNoPath(JSON.stringify(result.lookup), "result frame lookup");
    });
  });
});
