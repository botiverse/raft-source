import { asAxSurfaceText, type AxSurfaceText } from "@botiverse/raft-shared";
// Regression tests for daemon session transcript diagnostic security.
//
// Covers the hardening requested in PR #3050 review (Hao):
//   - only the agent's own sessionId is ever read: this daemon's, or the one
//     the server stores for the agent (a feedback request's sessionLookup);
//     never one a web caller supplies
//   - absolute sessionIds are not treated as file paths
//   - resolved paths are contained under approved runtime/session roots
//   - symlinks are rejected
//   - oversized files are bounded-read and marked truncated

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, link, mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, zstdCompressSync } from "node:zlib";
import type { ChildProcess } from "node:child_process";
import type { AgentConfig, MachineToServerMessage } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { AgentProcessManager, resolveRuntimeSessionRef } from "./agentProcessManager";
import { resolveRuntimeSessionRefDetailed } from "./drivers/index";
import { allowedTranscriptRootsForRuntime, runtimeTranscriptHomesForConfig } from "./drivers/runtimeArtifacts";
import { contextViewSessionPath, readContextViewSource } from "./agentContextView/contextViewSource";
import type { ContextViewAgentFacts } from "./agentContextView/agentContextViewService";
import { readAndRedactTranscriptDetailed, transcriptZstd, ZSTD_TRANSCRIPT_DECOMPRESSED_LIMIT_FACTOR } from "./sessionTranscriptReader";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import { withFifos } from "./testing/fifo";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
  };

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

class FakeClaudeDriver implements RuntimeDriver {
  readonly id = "claude";
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly supportsNativeStandingPrompt = true;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const proc = new FakeChildProcess();
    this.processes.push(proc);
    return { process: proc as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) || [];
  }

  encodeStdinMessage(text?: string, _sessionId?: string | null): string | null {
    if (!text) return null;
    return JSON.stringify({ text });
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("claude standing prompt");
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "claude-agent",
    displayName: "Claude Agent",
    description: "test agent",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    // No credential id by default: a stop would revoke it over the injected
    // fetch, and tests that do not fake the server must not send anything.
    agentCredentialId: null,
    ...overrides,
  };
}

const TRANSCRIPT_READ_LIMIT_BYTES = 10 * 1024 * 1024;

function makeTranscriptLines(input: {
  bytesAtLeast: number;
  marker: string;
  timestamp: string;
  nestedCreatedAt?: string;
}): string {
  const line = `${JSON.stringify({
    type: "user",
    timestamp: input.timestamp,
    marker: input.marker,
    content: {
      ...(input.nestedCreatedAt ? { createdAt: input.nestedCreatedAt } : {}),
      text: "x".repeat(4 * 1024),
    },
  })}\n`;
  return line.repeat(Math.ceil(input.bytesAtLeast / Buffer.byteLength(line)));
}

function makeTranscriptUploadCapture(): {
  fetchImpl: typeof fetch;
  readTranscript: () => string;
} {
  let uploadedBody: Buffer | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/internal/machine/scope-attestation")) {
      return new Response(
        JSON.stringify({
          attestation: "attestation-transcript-window",
          scope: "daemon-trace-bundle:create",
          audience: "https://worker.example.com",
          resource: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/trace-bundles")) {
      return new Response(
        JSON.stringify({
          id: "upload-session-transcript-window",
          upload: {
            method: "PUT",
            url: "https://upload.example/transcript-window",
            headers: {},
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://upload.example/transcript-window") {
      const body = init?.body;
      if (body instanceof Blob) {
        uploadedBody = Buffer.from(await body.arrayBuffer());
      }
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetchImpl,
    readTranscript: () => {
      assert.ok(uploadedBody, "expected the transcript upload body");
      return gunzipSync(uploadedBody).toString("utf8");
    },
  };
}

async function withManager(
  fn: (ctx: {
    driver: FakeClaudeDriver;
    manager: AgentProcessManager;
    sent: MachineToServerMessage[];
    dataDir: string;
    homeDir: string;
  }) => Promise<void>,
  options: { workerUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-session-transcript-test-"));
  // Use dataDir as the runtime session home so test files live under a temp tree
  // instead of the real home directory.
  const homeDir = dataDir;
  const sent: MachineToServerMessage[] = [];
  const driver = new FakeClaudeDriver();
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      workerUrl: options.workerUrl,
      fetchImpl: options.fetchImpl,
      driverResolver: () => driver,
      runtimeSessionHomeDir: homeDir,
    },
  );

  try {
    await fn({ driver, manager, sent, dataDir, homeDir });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("session transcript: reads the agent's own claude session file", async () => {
  await withManager(async ({ manager, homeDir }) => {
    const sessionId = "session-happy";
    await manager.startAgent("agent-1", makeConfig({ sessionId }));

    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    await mkdir(claudeProjectsDir, { recursive: true });
    const sessionFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);
    await writeFile(sessionFile, "{\"type\":\"test\"}\n");

    const result = await manager.getSessionTranscript("agent-1");

    assert.equal(result.reachable, true);
    assert.equal(result.sessionId, sessionId);
    assert.ok(result.path?.endsWith(`${sessionId}.jsonl`), `expected path to end with ${sessionId}.jsonl, got ${result.path}`);
    assert.equal(result.transcript?.includes('"type":"test"'), true);
    assert.equal(result.redacted, true);
    assert.equal(result.truncated, false);
    assert.ok(result.sizeBytes > 0);
  });
});

const lookupFor = (sessionId: string | null) => ({ runtime: "claude", model: "sonnet", sessionHomeEnv: null, sessionId });

test("session transcript: with nothing in this daemon's memory, the server's session lookup finds the agent's session file, and writes nothing", async () => {
  await withManager(async ({ manager, homeDir, dataDir }) => {
    // The agent was never started on this daemon (it restarted, or the agent failed for good).
    const sessionId = "session-after-restart";
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    await mkdir(claudeProjectsDir, { recursive: true });
    await writeFile(path.join(claudeProjectsDir, `${sessionId}.jsonl`), "{\"type\":\"kept-on-disk\"}\n");

    const without = await manager.getSessionTranscript("agent-1");
    assert.equal(without.reachable, false);
    assert.equal(without.reasonCode, "no_config_in_memory");

    const result = await manager.getSessionTranscript("agent-1", { serverLookup: lookupFor(sessionId) });
    assert.equal(result.reachable, true);
    assert.equal(result.runtime, "claude");
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.transcript?.includes('"type":"kept-on-disk"'), true);

    // The server's copy without a session id: nothing to read, and it says so.
    const noSession = await manager.getSessionTranscript("agent-1", { serverLookup: lookupFor(null) });
    assert.equal(noSession.reachable, false);
    assert.equal(noSession.reasonCode, "no_session_id");

    // A session the server names but this machine does not have: an honest miss,
    // and the report leaves no trace on disk (no workspace, no handoff marker).
    const missing = await manager.getSessionTranscript("agent-1", { serverLookup: lookupFor("session-not-here") });
    assert.equal(missing.reachable, false);
    assert.equal(missing.reasonCode, "native_session_file_not_found");
    assert.equal(missing.transcriptContent, "absent");
    assert.equal(await stat(path.join(dataDir, "agent-1")).then(() => true, () => false), false, "no workspace directory was created");
  });
});

test("session transcript: the server's session-home env var moves the lookup to the agent's own Codex home", async () => {
  await withManager(async ({ manager, homeDir }) => {
    const codexHome = path.join(homeDir, "custom-codex");
    const sessions = path.join(codexHome, "sessions", "2026", "11", "01");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, `rollout-2026-11-01T00-00-00-${CODEX_SESSION_ID}.jsonl`), "{\"type\":\"in-custom-home\"}\n");
    const lookup = { runtime: "codex", model: "gpt-5.6", sessionId: CODEX_SESSION_ID };
    const missed = await manager.getSessionTranscript("agent-1", { serverLookup: { ...lookup, sessionHomeEnv: null } });
    assert.equal(missed.reachable, false, "not under the default Codex home");
    const found = await manager.getSessionTranscript("agent-1", { serverLookup: { ...lookup, sessionHomeEnv: { CODEX_HOME: codexHome } } });
    assert.equal(found.reachable, true);
    assert.equal(found.transcript?.includes('"type":"in-custom-home"'), true);
  });
});

test("session transcript: what this daemon holds for the agent wins over the server's session lookup", async () => {
  await withManager(async ({ manager, homeDir }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-live" }));
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    await mkdir(claudeProjectsDir, { recursive: true });
    await writeFile(path.join(claudeProjectsDir, "session-live.jsonl"), "{\"which\":\"live\"}\n");
    await writeFile(path.join(claudeProjectsDir, "session-stale.jsonl"), "{\"which\":\"stale\"}\n");

    const result = await manager.getSessionTranscript("agent-1", { serverLookup: lookupFor("session-stale") });
    assert.equal(result.sessionId, "session-live");
    assert.equal(result.transcript?.includes('"which":"live"'), true);
    assert.ok(!result.transcript?.includes("stale"));
  });
});

test("session transcript: a session id from the server's lookup that resolves outside the runtime's directories is refused by the path check", async () => {
  await withManager(async ({ manager, homeDir }) => {
    // The legacy kimi lookup is the one that joins the session id into a path:
    // `<home>/.kimi/sessions/wd_<agent>_*/session_<id>`. This id walks out of `.kimi`.
    await mkdir(path.join(homeDir, ".kimi", "sessions", "wd_agent-1_x"), { recursive: true });
    await mkdir(path.join(homeDir, "outside"), { recursive: true });
    await writeFile(path.join(homeDir, "outside", "state.json"), "{\"secret\":true}\n");
    const result = await manager.getSessionTranscript("agent-1", {
      serverLookup: { runtime: "kimi", model: "kimi", sessionHomeEnv: null, sessionId: "../../../../../outside" },
    });
    assert.equal(result.reachable, false);
    assert.equal(result.reasonCode, "path_rejected");
    assert.ok(!result.transcript?.includes("secret"));
  });
});

test("session transcript: does not read a different session's file", async () => {
  await withManager(async ({ manager, homeDir }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-a" }));

    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    await mkdir(claudeProjectsDir, { recursive: true });
    await writeFile(path.join(claudeProjectsDir, "session-b.jsonl"), "{\"stolen\":true}\n");

    const result = await manager.getSessionTranscript("agent-1");

    assert.equal(result.sessionId, "session-a");
    // The daemon must never read session-b's file. It may fall back to the
    // daemon handoff, but the stolen content must never appear.
    assert.ok(!result.transcript?.includes("stolen"));
    assert.ok(!result.path?.includes("session-b"));
  });
});

test("session transcript: resolve-miss records searched paths as transcript_resolve_missing negative evidence (fruit#0 pt2)", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "slock-resolve-miss-home-"));
  const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "slock-resolve-miss-fb-"));
  try {
    // No claude transcript exists under homeDir/.claude/projects -> resolve miss.
    const missRef = resolveRuntimeSessionRef("claude", "no-such-session", homeDir, fallbackDir);

    // A miss still yields a reachable handoff whose reason names WHERE we looked.
    assert.equal(missRef.reachable, true);
    assert.match(missRef.reason ?? "", /searched=\[[^\]]*\.claude[^\]]*projects[^\]]*\]/);

    // The handoff marker records the miss as explicit negative evidence: the
    // structured resolveStatus + the directories checked make "looked in the
    // wrong place" distinguishable from "genuinely absent". ids/paths only.
    const markerPath = missRef.path;
    assert.ok(markerPath, "handoff ref must carry the marker file path");
    const marker = JSON.parse((await readFile(markerPath, "utf8")).trim());
    assert.equal(marker.type, "runtime_session_handoff");
    assert.equal(marker.resolveStatus, "transcript_resolve_missing");
    assert.equal(marker.lookupMethod, "claude_jsonl");
    assert.ok(
      Array.isArray(marker.searchedPaths) &&
        marker.searchedPaths.some((p: string) => p.includes(path.join(".claude", "projects"))),
    );
    assert.equal(marker.sessionId, "no-such-session");

    // Green side: when the transcript IS present it resolves directly (no marker).
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "proj");
    await mkdir(claudeProjectsDir, { recursive: true });
    await writeFile(path.join(claudeProjectsDir, "present-session.jsonl"), "{}\n");
    const hitRef = resolveRuntimeSessionRef("claude", "present-session", homeDir, fallbackDir);
    assert.equal(hitRef.reachable, true);
    assert.ok(hitRef.path?.endsWith("present-session.jsonl"));
    assert.equal(hitRef.reason, undefined);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(fallbackDir, { recursive: true, force: true });
  }
});

test("session transcript builtin: resolves a real .builtin-sessions transcript (no handoff)", async () => {
  const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "slock-builtin-fb-"));
  const wsDir = await mkdtemp(path.join(os.tmpdir(), "slock-builtin-ws-"));
  try {
    // Builtin (Pi SDK managed) writes session transcripts under .builtin-sessions
    // named <display>_<sessionId>.jsonl (findPiSessionFile convention).
    const sessionId = "SID-7f9c71a2bbea";
    const builtinDir = path.join(wsDir, ".builtin-sessions");
    await mkdir(builtinDir, { recursive: true });
    await writeFile(path.join(builtinDir, `showroom_${sessionId}.jsonl`), "{}\n");

    const ref = resolveRuntimeSessionRef("builtin", sessionId, wsDir, fallbackDir, {
      workingDirectory: wsDir,
    });

    // Tooth #1 (hit): must resolve to the real jsonl (reachable, not a handoff).
    assert.equal(ref.reachable, true);
    assert.ok(ref.path?.endsWith(`showroom_${sessionId}.jsonl`), "expected the real .jsonl path, got: " + ref.path);
    // A hit carries no handoff marker (no resolve_missing reason).
    assert.equal(ref.reason, undefined);
  } finally {
    await rm(fallbackDir, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
  }
});

test("session transcript builtin: a true miss records .builtin-sessions in searchedPaths (not confused with \"never looked\")", async () => {
  const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "slock-builtin-miss-fb-"));
  const wsDir = await mkdtemp(path.join(os.tmpdir(), "slock-builtin-miss-ws-"));
  try {
    const ref = resolveRuntimeSessionRef("builtin", "no-such-builtin-session", wsDir, fallbackDir, {
      workingDirectory: wsDir,
    });

    // Tooth #2 (miss attribution): fall back to handoff but record WHERE we
    // looked + the lookup method, so "genuinely absent" != "never looked".
    // The resolveResidence string lives on the marker (resolveStatus), not on
    // ref.reason; assert the marker fields below (substantive).
    assert.equal(ref.reachable, true);
    const markerPath = ref.path;
    assert.ok(markerPath, "handoff ref must carry marker path");
    const marker = JSON.parse((await readFile(markerPath, "utf8")).trim());
    assert.equal(marker.type, "runtime_session_handoff");
    assert.equal(marker.resolveStatus, "transcript_resolve_missing");
    assert.equal(marker.lookupMethod, "builtin_jsonl");
    assert.ok(
      Array.isArray(marker.searchedPaths) &&
        marker.searchedPaths.some((p: string) => p.includes(path.join(".builtin-sessions"))),
      "expected .builtin-sessions in searchedPaths",
    );
  } finally {
    await rm(fallbackDir, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
  }
});

test("session transcript builtin: picks the exact session among multiple .builtin-sessions files", async () => {
  const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "slock-builtin-pick-fb-"));
  const wsDir = await mkdtemp(path.join(os.tmpdir(), "slock-builtin-pick-ws-"));
  try {
    const wantId = "SID-4e5f-aaaa";
    // A decoy whose filename CONTAINS wantId as a substring but does NOT end
    // with _<wantId>.jsonl. A loose includes() match would return it; the
    // exact endsWith(_<sessionId>.jsonl) match must not.
    const decoyName = `decoy_${wantId}_clobber.jsonl`;
    const wantName = `beta_${wantId}.jsonl`;
    const builtinDir = path.join(wsDir, ".builtin-sessions");
    await mkdir(builtinDir, { recursive: true });
    await writeFile(path.join(builtinDir, decoyName), "{}\n");
    await writeFile(path.join(builtinDir, wantName), "{}\n");

    const ref = resolveRuntimeSessionRef("builtin", wantId, wsDir, fallbackDir, {
      workingDirectory: wsDir,
    });

    // Exact endsWith(_<sessionId>.jsonl): must pick the wanted session, not
    // the decoy that merely contains the sessionId as a substring.
    assert.equal(ref.reachable, true);
    assert.ok(ref.path?.endsWith(wantName), "expected the wanted session file, got: " + ref.path);
    assert.ok(!ref.path?.endsWith(decoyName), "must not match the substring decoy");
  } finally {
    await rm(fallbackDir, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
  }
});

// pi session rotation: the transcript is the file the driver resumes, the
// newest-named <timestamp>_<id>.jsonl, even when an older one was written later.
for (const [runtime, dirName] of [["builtin", ".builtin-sessions"], ["pi", ".pi-sessions"]] as const) {
  test(`session transcript ${runtime}: after a rotation, the newest-named file of the session`, async () => {
    const wsDir = await mkdtemp(path.join(os.tmpdir(), "slock-rotated-ws-"));
    try {
      const sessionId = "SID-rotated";
      const dir = path.join(wsDir, dirName);
      await mkdir(dir, { recursive: true });
      const seed = path.join(dir, `2026-02-01T00-00-00-000Z_${sessionId}.jsonl`);
      const old = path.join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
      await writeFile(seed, "{}\n");
      await writeFile(path.join(dir, `2026-01-15T00-00-00-000Z_${sessionId}.jsonl.rotated`), "{}\n");
      // A crash before the old file was renamed: it is there too, and written last.
      await writeFile(old, "{}\n");
      await utimes(old, new Date("2099-01-01"), new Date("2099-01-01"));
      const ref = resolveRuntimeSessionRef(runtime, sessionId, wsDir, undefined, { workingDirectory: wsDir });
      assert.equal(ref.path, seed);
    } finally {
      await rm(wsDir, { recursive: true, force: true });
    }
  });
}

// pi session rotation, PR 3: a rotated session is a chain of files under one
// id. The transcript and the profile ref name the current file and follow its
// header's parentSession back (piSessionParentChain), oldest first.
const CHAIN_SESSION_ID = "SID-chain";

function chainName(day: number, rotated: boolean, sessionId = CHAIN_SESSION_ID): string {
  return `2026-01-${String(day).padStart(2, "0")}T00-00-00-000Z_${sessionId}.jsonl${rotated ? ".rotated" : ""}`;
}

/** A session file: its header (with `parentSession` when given) and one marker record. */
async function writeSessionFile(file: string, marker: string, parentSession?: string, body = ""): Promise<void> {
  const header = { type: "session", version: 3, id: CHAIN_SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w", ...(parentSession ? { parentSession } : {}) };
  await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify({ type: "message", marker })}\n${body}`);
}

/**
 * `count` files, oldest first: each later one's parentSession is the one
 * before it; all but the last are `.rotated`. Returns their paths, oldest first.
 */
async function writeChain(dir: string, count: number): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const file = path.join(dir, chainName(i + 1, i < count - 1));
    await writeSessionFile(file, `m${i}`, files.at(-1));
    files.push(file);
  }
  return files;
}

function markers(transcript: string | null): string[] {
  return (transcript ?? "").trim().split("\n").map((line) => JSON.parse(line) as { marker?: string })
    .flatMap((record) => (record.marker ? [record.marker] : []));
}

async function withPiAgent(fn: (ctx: { manager: AgentProcessManager; sessionDir: string }) => Promise<void>): Promise<void> {
  await withManager(async ({ manager, dataDir }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "pi", sessionId: CHAIN_SESSION_ID }));
    await fn({ manager, sessionDir: path.join(dataDir, "agent-1", ".pi-sessions") });
  });
}

test("rotated pi session: the transcript and the profile ref include the whole chain, oldest first", async () => {
  await withPiAgent(async ({ manager, sessionDir }) => {
    const files = await writeChain(sessionDir, 4);
    const current = files.at(-1)!;

    const result = await manager.getSessionTranscript("agent-1");
    assert.equal(result.reachable, true);
    assert.equal(result.path, current, "the path is the current file");
    assert.deepEqual(markers(result.transcript), ["m0", "m1", "m2", "m3"]);
    // Each file is whole, header line included: a reader splits at the headers.
    const lines = result.transcript!.trim().split("\n").map((line) => JSON.parse(line) as { type: string; parentSession?: string });
    assert.deepEqual(lines.map((line) => line.type), ["session", "message", "session", "message", "session", "message", "session", "message"]);
    assert.equal(lines[6]!.parentSession, files[2]);
    assert.equal(result.truncated, false);
    let sourceBytes = 0;
    for (const file of files) sourceBytes += (await readFile(file)).length;
    assert.equal(result.sourceBytes, sourceBytes);

    const ref = manager.getAgentRuntimeProfileReport("agent-1")?.facts.sessionRef;
    assert.ok(ref && typeof ref === "object");
    assert.equal(ref.path, current);
    assert.equal(ref.reason, `rotated session: continues 3 earlier file(s), oldest first: [${files.slice(0, 3).map((file) => path.basename(file)).join(", ")}]; chain_end=root`);
  });
});

for (const [runtime, dirName] of [["builtin", ".builtin-sessions"], ["pi", ".pi-sessions"]] as const) {
  test(`rotated ${runtime} session: the resolver walks the chain from the current file`, async () => {
    const wsDir = await mkdtemp(path.join(os.tmpdir(), "slock-chain-ws-"));
    try {
      const files = await writeChain(path.join(wsDir, dirName), 3);
      const resolved = resolveRuntimeSessionRefDetailed(runtime, CHAIN_SESSION_ID, wsDir, undefined, { workingDirectory: wsDir });
      assert.equal(resolved.ref.path, files[2]);
      assert.deepEqual(resolved.sessionChain, { earlier: files.slice(0, 2), end: "root" });
    } finally {
      await rm(wsDir, { recursive: true, force: true });
    }
  });
}

test("rotated pi session: an unrotated session keeps the plain ref, and other runtimes never walk", async () => {
  const wsDir = await mkdtemp(path.join(os.tmpdir(), "slock-chain-plain-"));
  try {
    const [only] = await writeChain(path.join(wsDir, ".pi-sessions"), 1);
    const resolved = resolveRuntimeSessionRefDetailed("pi", CHAIN_SESSION_ID, wsDir, undefined, { workingDirectory: wsDir });
    assert.equal(resolved.ref.path, only);
    assert.equal(resolved.ref.reason, undefined);
    assert.deepEqual(resolved.sessionChain, { earlier: [], end: "root" });

    const claudeDir = path.join(wsDir, ".claude", "projects");
    await mkdir(claudeDir, { recursive: true });
    await writeSessionFile(path.join(claudeDir, `${CHAIN_SESSION_ID}.jsonl`), "c", path.join(claudeDir, "x.jsonl"));
    assert.equal(resolveRuntimeSessionRefDetailed("claude", CHAIN_SESSION_ID, wsDir).sessionChain, undefined);
  } finally {
    await rm(wsDir, { recursive: true, force: true });
  }
});

test("rotated pi session: the walk stops after 5 earlier files and says so", async () => {
  await withPiAgent(async ({ manager, sessionDir }) => {
    const files = await writeChain(sessionDir, 8);
    const result = await manager.getSessionTranscript("agent-1");
    assert.deepEqual(markers(result.transcript), ["m2", "m3", "m4", "m5", "m6", "m7"]);
    assert.equal(result.truncated, true, "known older history is left out");
    assert.equal(result.truncationDirection, "head");
    const resolved = resolveRuntimeSessionRefDetailed("pi", CHAIN_SESSION_ID, sessionDir, undefined, { workingDirectory: path.dirname(sessionDir) });
    assert.deepEqual(resolved.sessionChain, { earlier: files.slice(2, 7), end: "depth_limit" });
  });
});

test("rotated pi session: a chain of exactly 5 earlier files is whole", async () => {
  await withPiAgent(async ({ manager, sessionDir }) => {
    await writeChain(sessionDir, 6);
    const result = await manager.getSessionTranscript("agent-1");
    assert.deepEqual(markers(result.transcript), ["m0", "m1", "m2", "m3", "m4", "m5"]);
    assert.equal(result.truncated, false);
  });
});

/** The current file's parent is set by the test; returns the resolver's chain and the transcript markers. */
async function chainWithParent(parentOf: (ctx: { sessionDir: string; outsideDir: string }) => Promise<string>) {
  let outcome: { chain: unknown; markers: string[]; reason: string | null | undefined } | undefined;
  await withPiAgent(async ({ manager, sessionDir }) => {
    await mkdir(sessionDir, { recursive: true });
    const outsideDir = path.join(path.dirname(sessionDir), "elsewhere");
    await mkdir(outsideDir, { recursive: true });
    const parent = await parentOf({ sessionDir, outsideDir });
    await writeSessionFile(path.join(sessionDir, chainName(20, false)), "current", parent);
    const result = await manager.getSessionTranscript("agent-1");
    const ref = manager.getAgentRuntimeProfileReport("agent-1")?.facts.sessionRef;
    const resolved = resolveRuntimeSessionRefDetailed("pi", CHAIN_SESSION_ID, sessionDir, undefined, { workingDirectory: path.dirname(sessionDir) });
    outcome = { chain: resolved.sessionChain, markers: markers(result.transcript), reason: typeof ref === "object" ? ref?.reason : undefined };
  });
  return outcome!;
}

test("rotated pi session: a missing parent ends the chain; the current file is still read", async () => {
  const outcome = await chainWithParent(async ({ sessionDir }) => path.join(sessionDir, chainName(1, true)));
  assert.deepEqual(outcome.chain, { earlier: [], end: "missing" });
  assert.deepEqual(outcome.markers, ["current"]);
  assert.match(outcome.reason ?? "", /continues 0 earlier file\(s\).*chain_end=missing/);
});

test("rotated pi session: a parent outside the session directory is not followed", async () => {
  for (const parentOf of [
    // An absolute path elsewhere, to a file with a matching name.
    async ({ outsideDir }: { outsideDir: string }) => {
      const file = path.join(outsideDir, chainName(1, true));
      await writeSessionFile(file, "outside");
      return file;
    },
    // A relative path that climbs out.
    async ({ outsideDir }: { outsideDir: string }) => {
      await writeSessionFile(path.join(outsideDir, chainName(1, true)), "outside");
      return `../elsewhere/${chainName(1, true)}`;
    },
    // A subdirectory of the session directory is not the session directory.
    async ({ sessionDir }: { sessionDir: string }) => {
      await mkdir(path.join(sessionDir, "sub"), { recursive: true });
      await writeSessionFile(path.join(sessionDir, "sub", chainName(1, true)), "outside");
      return path.join(sessionDir, "sub", chainName(1, true));
    },
  ]) {
    const outcome = await chainWithParent(parentOf);
    assert.deepEqual(outcome.chain, { earlier: [], end: "outside_session_dir" });
    assert.deepEqual(outcome.markers, ["current"]);
  }
});

test("rotated pi session: a parent whose name is not a file of this session is not followed", async () => {
  for (const name of [
    "notes.jsonl",
    `2026-01-01T00-00-00-000Z_other-session.jsonl.rotated`,
    `2026-01-01T00-00-00-000Z_${CHAIN_SESSION_ID}.jsonl.tmp`,
    `_${CHAIN_SESSION_ID}.jsonl.rotated`.slice(1),
  ]) {
    const outcome = await chainWithParent(async ({ sessionDir }) => {
      await writeSessionFile(path.join(sessionDir, name), "foreign");
      return path.join(sessionDir, name);
    });
    assert.deepEqual(outcome.chain, { earlier: [], end: "unexpected_name" }, name);
    assert.deepEqual(outcome.markers, ["current"], name);
  }
});

test("rotated pi session: a symlinked parent is not followed", async () => {
  const outcome = await chainWithParent(async ({ sessionDir, outsideDir }) => {
    const target = path.join(outsideDir, "target.jsonl");
    await writeSessionFile(target, "outside");
    await symlink(target, path.join(sessionDir, chainName(1, true)));
    return path.join(sessionDir, chainName(1, true));
  });
  assert.deepEqual(outcome.chain, { earlier: [], end: "not_a_file" });
  assert.deepEqual(outcome.markers, ["current"]);
});

test("rotated pi session: a cycle ends the chain; each file is read once", async () => {
  // current -> b -> a -> b
  const outcome = await chainWithParent(async ({ sessionDir }) => {
    const a = path.join(sessionDir, chainName(1, true));
    const b = path.join(sessionDir, chainName(2, true));
    await writeSessionFile(a, "a", b);
    await writeSessionFile(b, "b", a);
    return b;
  });
  assert.deepEqual(outcome.markers, ["a", "b", "current"]);
  assert.equal((outcome.chain as { end: string }).end, "cycle");

  // A file that names itself.
  await withPiAgent(async ({ manager, sessionDir }) => {
    await mkdir(sessionDir, { recursive: true });
    const self = path.join(sessionDir, chainName(20, false));
    await writeSessionFile(self, "self", self);
    assert.deepEqual(markers((await manager.getSessionTranscript("agent-1")).transcript), ["self"]);
  });
});

test("rotated pi session: the total stays within the transcript limit, the oldest history is what it drops", async () => {
  await withPiAgent(async ({ manager, sessionDir }) => {
    await mkdir(sessionDir, { recursive: true });
    const oldest = path.join(sessionDir, chainName(1, true));
    const big = path.join(sessionDir, chainName(2, true));
    const current = path.join(sessionDir, chainName(3, false));
    await writeSessionFile(oldest, "oldest");
    // The parent alone is over the limit.
    await writeSessionFile(big, "big-head", oldest, makeTranscriptLines({ bytesAtLeast: TRANSCRIPT_READ_LIMIT_BYTES, marker: "big-tail", timestamp: "2026-01-02T00:00:00.000Z" }));
    // Big enough that a parent read with the whole limit would not fit beside it.
    await writeSessionFile(current, "current", big, makeTranscriptLines({ bytesAtLeast: 64 * 1024, marker: "current-tail", timestamp: "2026-01-03T00:00:00.000Z" }));

    const result = await manager.getSessionTranscript("agent-1");
    assert.ok(result.sizeBytes <= TRANSCRIPT_READ_LIMIT_BYTES, `${result.sizeBytes} bytes`);
    assert.equal(result.truncated, true);
    assert.equal(result.truncationDirection, "head");
    const kept = markers(result.transcript);
    assert.equal(kept.at(-1), "current-tail");
    assert.ok(kept.includes("current"), "the current file is whole");
    assert.ok(kept.includes("big-tail"), "the parent's tail is kept");
    assert.ok(!kept.includes("big-head") && !kept.includes("oldest"), "older history is dropped");
  });
});

test("rotated pi session: a current file that lost its head to the limit is returned alone, never behind an earlier file", async () => {
  await withPiAgent(async ({ manager, sessionDir }) => {
    await mkdir(sessionDir, { recursive: true });
    const parent = path.join(sessionDir, chainName(1, true));
    await writeSessionFile(parent, "parent");
    // Over the limit on disk; record trimming and URL redaction leave room under it.
    const urlLine = `${JSON.stringify({ type: "message", marker: "cur-body", text: "see https://example.com/".concat("a".repeat(2000)) })}\n`;
    await writeSessionFile(path.join(sessionDir, chainName(2, false)), "cur-head", parent, urlLine.repeat(Math.ceil((11 * 1024 * 1024) / urlLine.length)));

    const result = await manager.getSessionTranscript("agent-1");
    assert.equal(result.reachable, true);
    assert.ok(result.sizeBytes < TRANSCRIPT_READ_LIMIT_BYTES, "there would be room for the parent");
    const kept = markers(result.transcript);
    assert.ok(!kept.includes("parent"), "no earlier file in front of the current file's tail");
    assert.ok(!kept.includes("cur-head"));
    assert.equal(kept[0], "cur-body");
    assert.equal(result.truncated, true);
    assert.equal(result.truncationDirection, "head");
  });
});

test("rotated pi session: an earlier file that cannot be read is reported as dropped history", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  await withPiAgent(async ({ manager, sessionDir }) => {
    await mkdir(sessionDir, { recursive: true });
    const parent = path.join(sessionDir, chainName(1, true));
    await writeSessionFile(parent, "parent");
    await writeSessionFile(path.join(sessionDir, chainName(2, false)), "current", parent);
    await chmod(parent, 0o000);
    try {
      const result = await manager.getSessionTranscript("agent-1");
      assert.deepEqual(markers(result.transcript), ["current"]);
      assert.equal(result.truncated, true);
      assert.equal(result.truncationDirection, "head");
    } finally {
      await chmod(parent, 0o600);
    }
  });
});

test("rotated pi session: a FIFO named like a session file is never opened", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const wsDir = await mkdtemp(path.join(os.tmpdir(), "slock-chain-fifo-"));
  try {
    const dir = path.join(wsDir, ".pi-sessions");
    const [parent, current] = await writeChain(dir, 2);
    const resolve = () => resolveRuntimeSessionRefDetailed("pi", CHAIN_SESSION_ID, wsDir, undefined, { workingDirectory: wsDir });
    // A newer "current" file that is a FIFO: opening it for reading would
    // block the daemon until a writer appears.
    const newer = await withFifos([path.join(dir, chainName(28, false))], resolve);
    assert.equal(newer.waitedForUnblock, false, `the lookup waited on the FIFO (${Math.round(newer.elapsedMs)} ms)`);
    assert.equal(newer.result.ref.path, current, "the newest regular file");
    assert.deepEqual(newer.result.sessionChain, { earlier: [parent], end: "root" });

    // A parent that is a FIFO.
    await rm(parent!);
    const fifoParent = await withFifos([parent!], resolve);
    assert.equal(fifoParent.waitedForUnblock, false, `the walk waited on the FIFO (${Math.round(fifoParent.elapsedMs)} ms)`);
    assert.deepEqual(fifoParent.result.sessionChain, { earlier: [], end: "not_a_file" });
  } finally {
    await rm(wsDir, { recursive: true, force: true });
  }
});

test("session transcript builtin: pi lookup is not redirected to .builtin-sessions (no pi regression)", async () => {
  const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "slock-pi-fb-"));
  const wsDir = await mkdtemp(path.join(os.tmpdir(), "slock-pi-ws-"));
  try {
    // Put a session file ONLY under .pi-sessions (the pi convention).
    const piDir = path.join(wsDir, ".pi-sessions");
    await mkdir(piDir, { recursive: true });
    await writeFile(path.join(piDir, "pi_builtin_X.jsonl"), "{}\n");

    // Tooth #3 (pi unchanged): pi must find its own .pi-sessions file.
    const piRef = resolveRuntimeSessionRef("pi", "pi_builtin_X", wsDir, fallbackDir, {
      workingDirectory: wsDir,
    });
    assert.equal(piRef.reachable, true, "pi should resolve its .pi-sessions file");
    assert.ok(piRef.path?.includes(".pi-sessions"), "pi must search .pi-sessions, got " + piRef.path);
  } finally {
    await rm(fallbackDir, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
  }
});

test("session transcript: absolute sessionId is not treated as a file path", async () => {
  await withManager(async ({ manager, homeDir }) => {
    // Drop a file outside the approved runtime roots.
    const evilFile = path.join(homeDir, "evil-absolute.jsonl");
    await writeFile(evilFile, "{\"leak\":true}\n");

    // Pretend the agent's bound sessionId is an absolute path. The daemon must
    // never treat it as a direct path; it should be looked up only under the
    // runtime-specific roots.
    await manager.startAgent("agent-1", makeConfig({ sessionId: evilFile }));

    const result = await manager.getSessionTranscript("agent-1");

    assert.equal(result.sessionId, evilFile);
    // The evil file outside the approved roots must not be read.
    assert.ok(!result.transcript?.includes("leak"));
    assert.notEqual(result.path, evilFile);
  });
});

test("session transcript: rejects symlink escape", async () => {
  await withManager(async ({ manager, homeDir }) => {
    const sessionId = "session-symlink";
    await manager.startAgent("agent-1", makeConfig({ sessionId }));

    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    await mkdir(claudeProjectsDir, { recursive: true });

    // A file outside the approved claude root.
    const outsideFile = path.join(homeDir, "outside.jsonl");
    await writeFile(outsideFile, "{\"escaped\":true}\n");

    // Symlink inside the approved root pointing outside.
    const symlinkFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);
    await symlink(outsideFile, symlinkFile);

    const result = await manager.getSessionTranscript("agent-1");

    // The symlink inside the approved root must not allow reading the escaped
    // file content. The daemon either ignores the symlink or rejects it.
    assert.ok(!result.transcript?.includes("escaped"));
  });
});

test("session transcript: bounds oversized files and marks truncated", async () => {
  await withManager(async ({ manager, homeDir }) => {
    const sessionId = "session-big";
    await manager.startAgent("agent-1", makeConfig({ sessionId }));

    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    await mkdir(claudeProjectsDir, { recursive: true });
    const sessionFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);

    // 10 MB + 1 byte — bigger than the daemon's max read bound.
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, "x");
    await writeFile(sessionFile, big);

    const result = await manager.getSessionTranscript("agent-1");

    // One 10 MB+1 record with no newline: the aligned window keeps nothing.
    // task #1228 ①: that is an observed empty window, not a transcript.
    assert.equal(result.reachable, false);
    assert.equal(result.reasonCode, "window_empty");
    assert.equal(result.sourceBytes, 10 * 1024 * 1024 + 1);
    assert.equal(result.truncated, true);
    // TOOTH-2 F3 direction-truth-value tooth: un-anchored JSONL oversized read
    // keeps the TAIL-window (reads [size-maxBytes, size)) ⇒ the HEAD was dropped.
    // A stale or guessed direction (e.g. always "tail") that doesn't match the
    // actually-dropped side must RED.
    assert.equal(result.truncationDirection, "head");
    assert.ok((result.sizeBytes ?? 0) <= 10 * 1024 * 1024);
    assert.ok((result.transcript?.length ?? 0) <= 10 * 1024 * 1024);
  });
});

test("session transcript: bounded read keeps the tail and reports direction head", async () => {
  await withManager(async ({ manager, homeDir }) => {
    const sessionId = "session-anchored-tail";
    await manager.startAgent("agent-1", makeConfig({ sessionId }));

    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    await mkdir(claudeProjectsDir, { recursive: true });
    const sessionFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);

    // A JSONL file clearly bigger than the bound (each line ~40 bytes; ~350k
    // lines ≈ 14 MiB). Anchoring near the END makes the bounded reader start
    // mid-file (readStart>0) and keep the tail ⇒ the HEAD is dropped.
    const count = 350_000;
    const lines = Array.from({ length: count }, (_, i) =>
      JSON.stringify({ id: i, ts: new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + i * 1000).toISOString(), seq: i }),
    );
    await writeFile(sessionFile, lines.join("\n") + "\n");
    const result = await manager.getSessionTranscript("agent-1", {
      anchorAt: new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + (count - 1) * 1000).toISOString(),
    });

    assert.equal(result.reachable, true);
    assert.equal(result.truncated, true);
    // Keeping the tail ⇒ the HEAD was dropped. A stale hardcoded "tail" must RED.
    assert.equal(result.truncationDirection, "head");
  });
});

test("feedback transcript: keeps the reported turn near the tail of an oversized session", async () => {
  const upload = makeTranscriptUploadCapture();
  await withManager(
    async ({ manager, homeDir }) => {
      const sessionId = "session-feedback-tail-turn";
      await manager.startAgent("agent-1", makeConfig({ sessionId }));

      const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
      await mkdir(claudeProjectsDir, { recursive: true });
      const sessionFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);
      const transcript = [
        makeTranscriptLines({
          bytesAtLeast: TRANSCRIPT_READ_LIMIT_BYTES + 64 * 1024,
          marker: "old-head",
          timestamp: "2026-08-03T05:23:32.871Z",
        }),
        `${JSON.stringify({
          type: "user",
          timestamp: "2026-08-06T21:36:00.000Z",
          marker: "reported-turn-near-tail",
        })}\n`,
      ].join("");
      await writeFile(sessionFile, transcript);

      const result = await manager.collectFeedbackTranscript("agent-1", "report-tail-turn", {
        reportGeneratedAt: "2026-08-06T21:37:00.000Z",
        reportTimeSource: "web_report_bundle",
      });

      assert.equal(result.reachable, true);
      const uploadedTranscript = upload.readTranscript();
      assert.match(uploadedTranscript, /reported-turn-near-tail/);
      for (const line of uploadedTranscript.trim().split("\n")) {
        assert.doesNotThrow(() => JSON.parse(line), "uploaded JSONL must contain only complete records");
      }
    },
    { workerUrl: "https://worker.example.com", fetchImpl: upload.fetchImpl },
  );
});

test("feedback transcript: anchors an oversized window instead of blindly reading the file tail", async () => {
  const upload = makeTranscriptUploadCapture();
  await withManager(
    async ({ manager, homeDir }) => {
      const sessionId = "session-feedback-middle-turn";
      await manager.startAgent("agent-1", makeConfig({ sessionId }));

      const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
      await mkdir(claudeProjectsDir, { recursive: true });
      const sessionFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);
      const transcript = [
        makeTranscriptLines({
          bytesAtLeast: TRANSCRIPT_READ_LIMIT_BYTES + 64 * 1024,
          marker: "old-head-before-report",
          timestamp: "2026-08-05T12:00:00.000Z",
        }),
        `${JSON.stringify({
          type: "user",
          timestamp: "2026-08-06T21:36:00.000Z",
          marker: "reported-turn-in-middle",
        })}\n`,
        makeTranscriptLines({
          bytesAtLeast: TRANSCRIPT_READ_LIMIT_BYTES + 64 * 1024,
          marker: "new-tail-after-report",
          timestamp: "2026-08-07T03:08:38.528Z",
          // This content clock is closer to the report than the target turn,
          // but it is not when the model read this later transcript record.
          nestedCreatedAt: "2026-08-06T21:36:30.000Z",
        }),
        `${JSON.stringify({
          type: "user",
          marker: "nested-clock-without-model-read-time",
          content: {
            createdAt: "2026-08-06T21:36:45.000Z",
            text: "nested content clocks cannot move the report window",
          },
        })}\n`,
      ].join("");
      await writeFile(sessionFile, transcript);

      const result = await manager.collectFeedbackTranscript("agent-1", "report-middle-turn", {
        reportGeneratedAt: "2026-08-06T21:37:00.000Z",
        reportTimeSource: "web_report_bundle",
      });

      assert.equal(result.reachable, true);
      const uploadedTranscript = upload.readTranscript();
      assert.match(uploadedTranscript, /reported-turn-in-middle/);
      assert.doesNotMatch(uploadedTranscript, /new-tail-after-report/);
      assert.doesNotMatch(uploadedTranscript, /nested-clock-without-model-read-time/);
      for (const line of uploadedTranscript.trim().split("\n")) {
        assert.doesNotThrow(() => JSON.parse(line), "uploaded JSONL must contain only complete records");
      }
    },
    { workerUrl: "https://worker.example.com", fetchImpl: upload.fetchImpl },
  );
});


test("collectFeedbackTranscript returns fallback when worker URL is not configured", async () => {
  await withManager(async ({ manager, homeDir }) => {
    const sessionId = "session-feedback-no-worker";
    await manager.startAgent("agent-1", makeConfig({ sessionId }));

    const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
    await mkdir(claudeProjectsDir, { recursive: true });
    const sessionFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);
    await writeFile(sessionFile, '{"type":"feedback"}\n');

    const reportId = "report-no-worker";
    const result = await manager.collectFeedbackTranscript("agent-1", reportId);

    assert.equal(result.reachable, true);
    assert.equal(result.traceBundleId, undefined);
    assert.ok(result.fallbackReason?.includes("worker URL") || result.fallbackReason?.includes("not configured"));
  });
});

test("collectFeedbackTranscript uploads gzipped transcript linked to feedback report", async () => {
  let uploadedBody: Buffer | null = null;
  let createPayload: Record<string, unknown> | null = null;
  let scopePayload: Record<string, unknown> | null = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/internal/machine/scope-attestation")) {
      const payload = JSON.parse((init?.body as string) ?? "{}") as { metadata?: Record<string, unknown> };
      // The machine_evidence attachment signs separately; this test pins the transcript's claims.
      if (payload.metadata?.feedbackAttachmentKind !== "machine_evidence") scopePayload = payload;
      return new Response(
        JSON.stringify({
          attestation: "attestation-123",
          scope: "daemon-trace-bundle:create",
          audience: "https://worker.example.com",
          resource: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/trace-bundles")) {
      createPayload = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          id: "upload-session-123",
          upload: {
            method: "PUT",
            url: "https://upload.example/put-here",
            headers: {},
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://upload.example/put-here") {
      const body = init?.body;
      if (body instanceof Blob) {
        uploadedBody = Buffer.from(await body.arrayBuffer());
      } else if (ArrayBuffer.isView(body)) {
        uploadedBody = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      } else if (typeof body === "string") {
        uploadedBody = Buffer.from(body, "utf8");
      }
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  await withManager(
    async ({ manager, homeDir }) => {
      const sessionId = "session-feedback-upload";
      await manager.startAgent("agent-1", makeConfig({ sessionId }));

      const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
      await mkdir(claudeProjectsDir, { recursive: true });
      const sessionFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);
      const transcript = '{"type":"feedback"}\n{"type":"done"}\n';
      await writeFile(sessionFile, transcript);

      const reportId = "report-upload-123";
      const result = await manager.collectFeedbackTranscript("agent-1", reportId, {
        reportGeneratedAt: "2026-07-20T16:40:04.797Z",
        reportTimeSource: "web_report_bundle",
      });

      assert.equal(result.reachable, true);
      assert.equal(result.traceBundleId, "upload-session-123");
      assert.equal(result.error, undefined);
      assert.ok(uploadedBody, "upload body should be sent");

      // Verify the uploaded body is gzipped and round-trips to the transcript.
      const roundTripped = gunzipSync(uploadedBody!).toString("utf8");
      assert.equal(roundTripped, transcript);

      // Verify the attestation metadata links the bundle to the feedback report.
      const metadata = scopePayload?.metadata as Record<string, unknown> | undefined;
      assert.equal(metadata?.feedbackReportId, reportId);
      assert.equal(metadata?.agentId, "agent-1");
      assert.equal(metadata?.bundleContentType, "application/json");
      assert.equal(metadata?.bundleContentEncoding, "gzip");
      assert.equal(metadata?.feedbackReportGeneratedAt, "2026-07-20T16:40:04.797Z");
      assert.equal(metadata?.feedbackReportTimeSource, "web_report_bundle");
      assert.equal(metadata?.feedbackTranscriptWindowCoverage, "timestamps_unavailable");
      assert.equal(metadata?.feedbackTranscriptWindowToleranceMs, 900_000);
      assert.equal(typeof metadata?.bundleSha256, "string");
      assert.equal(typeof createPayload?.bundleSha256, "string");
      assert.equal(typeof createPayload?.bundleSizeBytes, "number");
    },
    { workerUrl: "https://worker.example.com", fetchImpl },
  );
});

test("collectFeedbackTranscript returns error when upload fails", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/internal/machine/scope-attestation")) {
      return new Response(
        JSON.stringify({
          attestation: "attestation-123",
          scope: "daemon-trace-bundle:create",
          audience: "https://worker.example.com",
          resource: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/api/trace-bundles")) {
      return new Response(JSON.stringify({ error: "worker unavailable" }), { status: 503 });
    }
    return new Response("not found", { status: 404 });
  };

  await withManager(
    async ({ manager, homeDir }) => {
      const sessionId = "session-feedback-fail";
      await manager.startAgent("agent-1", makeConfig({ sessionId }));

      const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
      await mkdir(claudeProjectsDir, { recursive: true });
      const sessionFile = path.join(claudeProjectsDir, `${sessionId}.jsonl`);
      await writeFile(sessionFile, '{"type":"feedback"}\n');

      const result = await manager.collectFeedbackTranscript("agent-1", "report-fail");

      assert.equal(result.reachable, true);
      assert.equal(result.traceBundleId, undefined);
      assert.ok(result.error);
    },
    { workerUrl: "https://worker.example.com", fetchImpl },
  );
});

// ---------------------------------------------------------------------------
// Codex compressed rollouts (codex 0.16x: cold rollouts -> `.jsonl.zst`) and
// the kimi-sdk session home (KIMI_CODE_HOME / ~/.kimi-code, not ~/.kimi).
// ---------------------------------------------------------------------------

const CODEX_SESSION_ID = "019d9fcb-9b2d-7220-b19e-e0282e05zst1";

async function writeCodexRollout(homeDir: string, name: string, content: Buffer | string): Promise<string> {
  const dir = path.join(homeDir, ".codex", "sessions", "2026", "11", "01");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, content);
  return file;
}

/** The daemon's own KIMI_CODE_HOME, cleared for the test (restored after). */
async function withoutAmbientKimiHome(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.KIMI_CODE_HOME;
  delete process.env.KIMI_CODE_HOME;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
  }
}

/** A Kimi Code SDK session: `<home>/sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl`. */
async function writeKimiSdkSession(kimiHome: string, sessionId: string, wire: string, opts: { index?: boolean } = {}): Promise<{ sessionDir: string; wireFile: string }> {
  const sessionDir = path.join(kimiHome, "sessions", "wk_0123abcd", sessionId);
  const wireFile = path.join(sessionDir, "agents", "main", "wire.jsonl");
  await mkdir(path.dirname(wireFile), { recursive: true });
  await writeFile(wireFile, wire);
  // A sub-agent's log beside it must not be what is read.
  await mkdir(path.join(sessionDir, "agents", "sub-1"), { recursive: true });
  await writeFile(path.join(sessionDir, "agents", "sub-1", "wire.jsonl"), '{"type":"subagent"}\n');
  await writeFile(path.join(sessionDir, "state.json"), '{"state":"not-a-transcript"}');
  if (opts.index) {
    await writeFile(
      path.join(kimiHome, "session_index.jsonl"),
      `${JSON.stringify({ sessionId, sessionDir, workDir: "/tmp/ws" })}\n`,
    );
  }
  return { sessionDir, wireFile };
}

describe("codex context view roots", () => {
  const factsOf = (manager: AgentProcessManager, agentId: string) =>
    (manager as unknown as { contextViewAgentFacts(id: string): ContextViewAgentFacts }).contextViewAgentFacts(agentId);

  test("only the Codex home's sessions/: another .jsonl in the Codex home is refused, by path and by root", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const rollout = await writeCodexRollout(homeDir, `rollout-2026-11-01T00-00-00-${CODEX_SESSION_ID}.jsonl`, "{}\n");
      const history = path.join(homeDir, ".codex", "history.jsonl");
      await writeFile(history, '{"text":"a prompt the agent was never shown"}\n');
      await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: CODEX_SESSION_ID }));
      const facts = factsOf(manager, "agent-1");
      const sessions = path.join(homeDir, ".codex", "sessions");
      assert.equal(facts.sessionRoot, sessions);
      assert.deepEqual(facts.allowedRoots, [sessions]);
      assert.equal(contextViewSessionPath(facts.sessionRoot!, "../history.jsonl"), null, "an index line can't name a file beside sessions/");
      assert.deepEqual(await readContextViewSource(history, facts.allowedRoots), { ok: false, failure: "rejected" });
      assert.equal((await readContextViewSource(rollout, facts.allowedRoots)).ok, true);
    });
  });

  test("CODEX_HOME moves the root to its sessions/", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const codexHome = path.join(homeDir, "custom-codex");
      await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: CODEX_SESSION_ID, envVars: { CODEX_HOME: codexHome } }));
      const facts = factsOf(manager, "agent-1");
      assert.equal(facts.sessionRoot, path.join(codexHome, "sessions"));
      assert.deepEqual(facts.allowedRoots, [path.join(codexHome, "sessions")]);
    });
  });

  test("feedback reads of a Codex agent are limited to rollouts too", () => {
    assert.deepEqual(allowedTranscriptRootsForRuntime("codex", "/h/.codex", "/ws"), ["/ws", "/h/.codex/sessions", "/h/.codex/.codex/sessions"]);
  });
});

describe("codex compressed rollouts", () => {
  test("resolver: the plain .jsonl wins over a .jsonl.zst of the same rollout", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-zst-ref-"));
    try {
      const name = `rollout-2026-11-01T00-00-00-${CODEX_SESSION_ID}.jsonl`;
      const plain = await writeCodexRollout(homeDir, name, '{"plain":true}\n');
      await writeCodexRollout(homeDir, `${name}.zst`, zstdCompressSync(Buffer.from('{"compressed":true}\n')));
      const resolved = resolveRuntimeSessionRefDetailed("codex", CODEX_SESSION_ID, path.join(homeDir, ".codex"));
      assert.equal(resolved.resolution, "native");
      assert.equal(resolved.ref.path, plain);
      assert.equal(resolved.lookupMethod, "codex_jsonl");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("resolver: a compressed-only rollout resolves to its .jsonl.zst", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-zst-ref-"));
    try {
      const zst = await writeCodexRollout(homeDir, `rollout-2026-11-01T00-00-00-${CODEX_SESSION_ID}.jsonl.zst`, zstdCompressSync(Buffer.from("{}\n")));
      const resolved = resolveRuntimeSessionRefDetailed("codex", CODEX_SESSION_ID, path.join(homeDir, ".codex"));
      assert.equal(resolved.resolution, "native");
      assert.equal(resolved.ref.path, zst);
      assert.equal(resolved.lookupMethod, "codex_jsonl");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("resolver: .jsonl.tmp, .jsonl.zst.tmp and lock files are never a rollout", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-zst-ref-"));
    try {
      const base = `rollout-2026-11-01T00-00-00-${CODEX_SESSION_ID}`;
      for (const name of [`${base}.jsonl.tmp`, `${base}.jsonl.zst.tmp`, `${base}.jsonl.lock`, `${base}.jsonl.zst.lock`]) {
        await writeCodexRollout(homeDir, name, "{}\n");
      }
      const resolved = resolveRuntimeSessionRefDetailed("codex", CODEX_SESSION_ID, path.join(homeDir, ".codex"));
      assert.equal(resolved.resolution, "not_found");
      assert.equal(resolved.ref.reachable, false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("feedback read: a .jsonl.zst rollout is read as its decompressed text", async () => {
    await withManager(async ({ manager, homeDir }) => {
      const text = `${JSON.stringify({ type: "response_item", payload: { text: "compressed rollout marker" } })}\n`;
      await writeCodexRollout(homeDir, `rollout-2026-11-01T00-00-00-${CODEX_SESSION_ID}.jsonl.zst`, zstdCompressSync(Buffer.from(text)));
      await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: CODEX_SESSION_ID }));
      const result = await manager.getSessionTranscript("agent-1");
      assert.equal(result.reachable, true);
      assert.equal(result.transcriptContent, "native_session_file");
      assert.equal(result.lookupMethod, "codex_jsonl");
      assert.equal(result.transcript, text);
      assert.equal(result.sourceBytes, Buffer.byteLength(text));
      assert.equal(result.truncated, false);
    });
  });

  test("feedback read: without zstd in this Node, the file is found but not read (read_failed, compressed_unsupported), never raw bytes", async () => {
    const original = transcriptZstd.decompress;
    transcriptZstd.decompress = undefined;
    try {
      await withManager(async ({ manager, homeDir }) => {
        await writeCodexRollout(homeDir, `rollout-2026-11-01T00-00-00-${CODEX_SESSION_ID}.jsonl.zst`, zstdCompressSync(Buffer.from('{"a":1}\n')));
        await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: CODEX_SESSION_ID }));
        const result = await manager.getSessionTranscript("agent-1");
        assert.equal(result.reachable, false);
        assert.equal(result.transcript, null);
        assert.equal(result.reasonCode, "read_failed");
        assert.match(result.fallbackReason ?? "", /compressed_unsupported/);
        assert.ok(result.path?.endsWith(".jsonl.zst"));
      });
    } finally {
      transcriptZstd.decompress = original;
    }
  });

  test("reader: decompressed output is bounded (over the limit -> compressed_too_large; under it -> the tail window)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-zst-cap-"));
    try {
      const maxBytes = 64 * 1024;
      const line = `${JSON.stringify({ pad: "y".repeat(1000) })}\n`;
      const lines = (bytes: number) => line.repeat(Math.ceil(bytes / line.length));
      // A highly compressible stream far over the limit (a small "bomb").
      const bomb = path.join(dir, "bomb.jsonl.zst");
      const bombPlain = Buffer.from(lines(ZSTD_TRANSCRIPT_DECOMPRESSED_LIMIT_FACTOR * maxBytes + 4096));
      await writeFile(bomb, zstdCompressSync(bombPlain));
      const refused = await readAndRedactTranscriptDetailed(bomb, maxBytes);
      assert.equal(refused.ok, false);
      assert.ok(!refused.ok && refused.failure === "read_failed" && refused.detail === "compressed_too_large");

      // Over the read limit but under the decompression limit: like a plain file, the tail.
      const big = path.join(dir, "big.jsonl.zst");
      const bigPlain = Buffer.from(lines(2 * maxBytes));
      await writeFile(big, zstdCompressSync(bigPlain));
      const read = await readAndRedactTranscriptDetailed(big, maxBytes);
      assert.ok(read.ok);
      assert.equal(read.sourceBytes, bigPlain.length);
      assert.equal(read.truncated, true);
      assert.equal(read.truncationDirection, "head");
      assert.ok(Buffer.byteLength(read.text) <= maxBytes);
      assert.ok(read.text.length > 0 && read.text.endsWith("\n"));

      // Not zstd at all.
      const corrupt = path.join(dir, "corrupt.jsonl.zst");
      await writeFile(corrupt, '{"not":"zstd"}\n');
      const bad = await readAndRedactTranscriptDetailed(corrupt, maxBytes);
      assert.ok(!bad.ok && bad.failure === "read_failed" && bad.detail === "compressed_corrupt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reader: a symlinked .jsonl.zst is rejected like a plain file", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-zst-link-"));
    try {
      const target = path.join(dir, "target.jsonl.zst");
      await writeFile(target, zstdCompressSync(Buffer.from("{}\n")));
      const link = path.join(dir, "link.jsonl.zst");
      await symlink(target, link);
      const read = await readAndRedactTranscriptDetailed(link, 1024);
      assert.ok(!read.ok && read.failure === "path_rejected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reader: a hard-linked session file is rejected", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "transcript-hardlink-"));
    try {
      const target = path.join(dir, "runner.state.json");
      await writeFile(target, "{\"computerKey\":\"sk-outside\"}\n");
      const hard = path.join(dir, "session.jsonl");
      await link(target, hard);
      const read = await readAndRedactTranscriptDetailed(hard, 1024);
      assert.ok(!read.ok && read.failure === "path_rejected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("kimi-sdk session home", () => {
  test("resolver: KIMI_CODE_HOME from the agent's env vars, found through the SDK's session index, resolves the main agent's wire.jsonl", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-sdk-ref-"));
    try {
      const osHome = path.join(root, "home");
      const kimiHome = path.join(root, "custom-kimi-home");
      const sessionId = "session_93b650c7-6883-4fa3-9605-f122b1523ebc";
      const { wireFile } = await writeKimiSdkSession(kimiHome, sessionId, '{"type":"context.append_message"}\n', { index: true });
      const config = makeConfig({ runtime: "kimi-sdk", envVars: { KIMI_CODE_HOME: kimiHome } });
      const homes = runtimeTranscriptHomesForConfig(config, osHome, { KIMI_CODE_HOME: path.join(root, "ambient") });
      assert.deepEqual(homes, { kimiCodeHome: kimiHome });
      const resolved = resolveRuntimeSessionRefDetailed("kimi-sdk", sessionId, osHome, undefined, homes);
      assert.equal(resolved.resolution, "native");
      assert.equal(resolved.ref.path, wireFile);
      assert.equal(resolved.lookupMethod, "kimi_sdk_index");
      assert.ok(allowedTranscriptRootsForRuntime("kimi-sdk", osHome, path.join(root, "ws"), homes).includes(kimiHome));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolver: the daemon's own KIMI_CODE_HOME is used when the agent sets none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-sdk-ref-"));
    try {
      const ambient = path.join(root, "ambient-kimi-home");
      const config = makeConfig({ runtime: "kimi-sdk" });
      assert.deepEqual(runtimeTranscriptHomesForConfig(config, path.join(root, "home"), { KIMI_CODE_HOME: ambient }), { kimiCodeHome: ambient });
      assert.deepEqual(runtimeTranscriptHomesForConfig(makeConfig({ runtime: "claude" }), path.join(root, "home"), { KIMI_CODE_HOME: ambient }), {});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolver: default ~/.kimi-code, no index: the session directory is found by scanning <home>/sessions/*/<id>", async () => {
    await withoutAmbientKimiHome(async () => {
      const osHome = await mkdtemp(path.join(os.tmpdir(), "kimi-sdk-home-"));
      try {
        const sessionId = "session_0b7d2f0e-1111-4222-8333-944455556666";
        const { wireFile } = await writeKimiSdkSession(path.join(osHome, ".kimi-code"), sessionId, '{"type":"x"}\n');
        // No kimiCodeHome passed: the resolver's own default (ambient env, else <home>/.kimi-code).
        const resolved = resolveRuntimeSessionRefDetailed("kimi-sdk", sessionId, osHome);
        assert.equal(resolved.resolution, "native");
        assert.equal(resolved.ref.path, wireFile);
        assert.deepEqual(resolved.searchedPaths, [path.join(osHome, ".kimi-code", "sessions")]);
        assert.deepEqual(runtimeTranscriptHomesForConfig(makeConfig({ runtime: "kimi-sdk" }), osHome), { kimiCodeHome: path.join(osHome, ".kimi-code") });
      } finally {
        await rm(osHome, { recursive: true, force: true });
      }
    });
  });

  test("resolver: a session deleted from the index, or without a wire log, is not found", async () => {
    await withoutAmbientKimiHome(async () => {
      const osHome = await mkdtemp(path.join(os.tmpdir(), "kimi-sdk-home-"));
      try {
        const kimiHome = path.join(osHome, ".kimi-code");
        const sessionId = "session_deleted";
        const { sessionDir, wireFile } = await writeKimiSdkSession(kimiHome, sessionId, "{}\n", { index: true });
        await writeFile(path.join(kimiHome, "session_index.jsonl"), `${JSON.stringify({ sessionId, deleted: true })}\n`, { flag: "a" });
        // Deleted in the index: only a leftover directory found by the scan remains.
        assert.equal(resolveRuntimeSessionRefDetailed("kimi-sdk", sessionId, osHome).ref.path, wireFile);
        await rm(path.join(sessionDir, "agents"), { recursive: true, force: true });
        // state.json alone is not a conversation; the kimi-sdk lookup does not offer it.
        assert.equal(resolveRuntimeSessionRefDetailed("kimi-sdk", sessionId, osHome).resolution, "not_found");
        assert.equal(resolveRuntimeSessionRefDetailed("kimi-sdk", "../escape", osHome).resolution, "not_found");
      } finally {
        await rm(osHome, { recursive: true, force: true });
      }
    });
  });

  test("resolver: the legacy kimi CLI layout (~/.kimi) still resolves for runtime kimi, and is not where kimi-sdk looks", async () => {
    await withoutAmbientKimiHome(async () => {
      const osHome = await mkdtemp(path.join(os.tmpdir(), "kimi-legacy-home-"));
      try {
        const agentId = "d2bf1e2c-3648-4590-a0e2-46c6998b2c38";
        const sessionId = "legacy-s1";
        const sessionDir = path.join(osHome, ".kimi", "sessions", `wd_${agentId}_abc`, `session_${sessionId}`);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(path.join(sessionDir, "state.json"), "{}");
        const legacy = resolveRuntimeSessionRefDetailed("kimi", sessionId, osHome, undefined, { agentId });
        assert.equal(legacy.resolution, "native");
        assert.equal(legacy.ref.path, sessionDir);
        assert.deepEqual(allowedTranscriptRootsForRuntime("kimi", osHome, "/ws"), ["/ws", path.join(osHome, ".kimi")]);
        assert.equal(resolveRuntimeSessionRefDetailed("kimi-sdk", sessionId, osHome, undefined, { agentId }).resolution, "not_found");
      } finally {
        await rm(osHome, { recursive: true, force: true });
      }
    });
  });

  test("feedback read: the wire.jsonl under the agent's KIMI_CODE_HOME is read as a conversation (native_session_file)", async () => {
    await withManager(async ({ manager, dataDir }) => {
      // A KIMI_CODE_HOME outside every other allowed root (the workspace, ~/.kimi).
      const kimiHome = path.join(dataDir, "elsewhere", "kimi-home");
      const sessionId = "session_wire-read";
      const wire = `${JSON.stringify({ type: "context.append_message", message: "kimi wire marker" })}\n`;
      await writeKimiSdkSession(kimiHome, sessionId, wire, { index: true });
      await manager.startAgent("agent-1", makeConfig({ runtime: "kimi-sdk", sessionId, envVars: { KIMI_CODE_HOME: kimiHome } }));
      const result = await manager.getSessionTranscript("agent-1");
      assert.equal(result.reachable, true);
      assert.equal(result.transcriptContent, "native_session_file");
      assert.equal(result.lookupMethod, "kimi_sdk_index");
      assert.equal(result.transcript, wire);
      assert.ok(result.path?.endsWith(path.join("agents", "main", "wire.jsonl")));
    });
  });

  test("feedback read: an index entry pointing outside the SDK home is rejected", async () => {
    await withManager(async ({ manager, dataDir }) => {
      const kimiHome = path.join(dataDir, "kimi-home");
      const outside = path.join(dataDir, "outside");
      const sessionId = "session_escape";
      await writeKimiSdkSession(outside, sessionId, '{"escaped":true}\n');
      await mkdir(kimiHome, { recursive: true });
      await writeFile(
        path.join(kimiHome, "session_index.jsonl"),
        `${JSON.stringify({ sessionId, sessionDir: path.join(outside, "sessions", "wk_0123abcd", sessionId) })}\n`,
      );
      await manager.startAgent("agent-1", makeConfig({ runtime: "kimi-sdk", sessionId, envVars: { KIMI_CODE_HOME: kimiHome } }));
      const result = await manager.getSessionTranscript("agent-1");
      assert.equal(result.reasonCode, "path_rejected");
      assert.equal(result.transcript, null);
    });
  });
});
