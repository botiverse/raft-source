import { asAxSurfaceText, type AxSurfaceText } from "@botiverse/raft-shared";
// Regression tests for daemon session transcript diagnostic security.
//
// Covers the hardening requested in PR #3050 review (Hao):
//   - only the agent's own sessionId is ever read (no caller-supplied override)
//   - absolute sessionIds are not treated as file paths
//   - resolved paths are contained under approved runtime/session roots
//   - symlinks are rejected
//   - oversized files are bounded-read and marked truncated

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { gunzipSync } from "node:zlib";
import type { ChildProcess } from "node:child_process";
import type { AgentConfig, MachineToServerMessage } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index.js";
import { AgentProcessManager, resolveRuntimeSessionRef } from "./agentProcessManager.js";

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
  readonly session = { recovery: "resume_or_fresh" } as const;
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
    agentCredentialId: "cred-test",
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
    if ((manager as any).agentStartPumpTimer) clearTimeout((manager as any).agentStartPumpTimer);
    for (const ap of (manager as any).agents?.values?.() ?? []) {
      ap.notifications.clearTimer();
      if (ap.pendingTrajectory?.timer) clearTimeout(ap.pendingTrajectory.timer);
      if (ap.activityHeartbeat?.kind === "active") clearInterval(ap.activityHeartbeat.timer);
      if (ap.startup?.kind === "waiting" && ap.startup.timer) clearTimeout(ap.startup.timer);
      if (ap.exit?.kind === "live" && ap.exit.stalledRecoverySigtermTimer) clearTimeout(ap.exit.stalledRecoverySigtermTimer);
      if (ap.compaction?.kind === "active" && ap.compaction.watchdog) clearTimeout(ap.compaction.watchdog);
      if (ap.runtimeErrorDeliveryBackoff?.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
        clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
      }
    }
    (manager as any).agents?.clear?.();
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

    assert.equal(result.reachable, true);
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
      scopePayload = JSON.parse((init?.body as string) ?? "{}");
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
