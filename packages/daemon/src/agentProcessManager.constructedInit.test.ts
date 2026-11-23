import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { AgentConfig, MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { LastSessionStore } from "./lastSessionStore";
import { agentStateFile } from "./agentStateFiles";
import { emptySessionSummary, SessionSummaryStore, sessionSummaryDir, type SessionSummary } from "./agentHost/oarSessionSummary";
import { applyFreshConstructedInit, buildFreshConstructedInit } from "./wakeSessionRecycle";
import { harness, makeConfig as oarMakeConfig, request as oarRequest, until } from "./testing/oarAgentHostHarness";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./drivers/index";
import type { AxSurfaceText } from "@botiverse/raft-shared";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent-ci-1",
    displayName: "Agent CI",
    description: "",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://127.0.0.1:0",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    agentCredentialId: null,
    ...overrides,
  };
}

function writeClaudeTranscript(homeDir: string, sessionId: string, opts: { timestampIso: string; noteText: string; msgText: string }): string {
  const projectDir = path.join(homeDir, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const raftTime = opts.timestampIso.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: opts.timestampIso,
      message: {
        role: "user",
        content: `[target=#proj-runtime msg=11112222 time=${raftTime} type=human] @alice: ${opts.msgText}`,
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: opts.timestampIso,
      message: {
        role: "assistant",
        content: [{ type: "text", text: opts.noteText }],
        usage: { input_tokens: 1200, output_tokens: 80 },
      },
    }),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

function makeRichSummary(opts: { sessionId: string; runtime?: string; lastActivityAt: string; note: string; msg: string }): SessionSummary {
  const summary = emptySessionSummary(opts.runtime ?? "codex", opts.sessionId, Date.parse(opts.lastActivityAt));
  summary.lastActivityAt = opts.lastActivityAt;
  summary.turns.count = 1;
  summary.turns.lastEndedAt = opts.lastActivityAt;
  summary.context = { tokens: 24_000, window: 200_000, at: opts.lastActivityAt };
  summary.messages = [{
    sessionId: opts.sessionId,
    direction: "received",
    at: opts.lastActivityAt,
    target: "#proj-runtime",
    msgId: "aaaa1111",
    raw: `[target=#proj-runtime msg=aaaa1111 time=${opts.lastActivityAt} type=human] @alice: ${opts.msg}`,
  }];
  summary.lastNote = { sessionId: opts.sessionId, at: opts.lastActivityAt, text: opts.note };
  summary.notes = [{ sessionId: opts.sessionId, at: opts.lastActivityAt, text: opts.note }];
  summary.todos = { sessionId: opts.sessionId, at: opts.lastActivityAt, items: [{ text: "Finish PR 2 verification", status: "in_progress" }] };
  return summary;
}

test("LastSessionStore writes outside workspace, reads back, deletes cleanly, and refuses symlinks", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "last-session-store-"));
  try {
    let now = 1_700_000_000_000;
    const store = new LastSessionStore(agentsDir, () => now);
    assert.equal(store.read("agent-1"), null);

    store.write("agent-1", "claude", "sess-abc");
    assert.deepEqual(store.read("agent-1"), {
      runtime: "claude",
      sessionId: "sess-abc",
      updatedAtMs: now,
    });
    // Stored under .agent-state, never inside the agent workspace directory.
    assert.equal(existsSync(path.join(agentsDir, "agent-1")), false);
    assert.equal(existsSync(agentStateFile(agentsDir, "agent-1", "last-session.json")), true);

    now += 5000;
    store.delete("agent-1");
    assert.equal(store.read("agent-1"), null);

    // Symlink in place of state file must be refused by readPlainSmallFile.
    const decoy = path.join(agentsDir, "decoy.json");
    writeFileSync(decoy, JSON.stringify({ runtime: "claude", sessionId: "evil", updatedAtMs: 1 }), "utf8");
    const targetFile = agentStateFile(agentsDir, "agent-sym", "last-session.json");
    mkdirSync(path.dirname(targetFile), { recursive: true });
    symlinkSync(decoy, targetFile);
    assert.equal(store.read("agent-sym"), null);
  } finally {
    rmSync(agentsDir, { recursive: true, force: true });
  }
});

test("buildFreshConstructedInit keeps brand-new agents short, injects warm panel from prior summary or transcript, and prefers the fresher source", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "constructed-init-unit-"));
  try {
    const workspacePath = path.join(root, "workspace");
    const homeDir = path.join(root, "home");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    // 1. Brand-new agent (no MEMORY.md, no prior session) -> completely empty.
    const brandNew = await buildFreshConstructedInit({
      config: makeAgentConfig(),
      workspacePath,
      homeDir,
      processEnv: {},
      priorSession: null,
      readSessionSummary: () => null,
    });
    assert.equal(brandNew.briefing, null);
    assert.equal(brandNew.memoryBlock, null);
    assert.equal(brandNew.hasMemory, false);
    assert.equal(brandNew.hasPanel, false);
    assert.equal(brandNew.panelSource, "none");

    // 2. MEMORY.md only -> standalone memoryBlock, no panel.
    writeFileSync(path.join(workspacePath, "MEMORY.md"), "# Agent CI\n\n## Active Context\n- Testing unified init\n", "utf8");
    const memOnly = await buildFreshConstructedInit({
      config: makeAgentConfig(),
      workspacePath,
      homeDir,
      processEnv: {},
      priorSession: null,
      readSessionSummary: () => null,
    });
    assert.equal(memOnly.briefing, null);
    assert.ok(memOnly.memoryBlock && /<memory-index\b/.test(String(memOnly.memoryBlock)));
    assert.equal(memOnly.hasMemory, true);
    assert.equal(memOnly.hasPanel, false);

    // 3. Prior OAR SessionSummary -> briefing contains <memory-index> + warm panel (no chrome header).
    const summaryOlder = makeRichSummary({
      sessionId: "oar-sess-1",
      lastActivityAt: "2026-11-19T12:00:00.000Z",
      note: "SUMMARY_NOTE_MARKER",
      msg: "SUMMARY_MSG_MARKER",
    });
    const fromSummary = await buildFreshConstructedInit({
      config: makeAgentConfig(),
      workspacePath,
      homeDir,
      processEnv: {},
      priorSession: null,
      readSessionSummary: () => summaryOlder,
    });
    assert.equal(fromSummary.hasPanel, true);
    assert.equal(fromSummary.hasMemory, true);
    assert.equal(fromSummary.panelSource, "summary");
    const summaryText = String(fromSummary.briefing);
    assert.match(summaryText, /<memory-index\b/);
    assert.match(summaryText, /SUMMARY_NOTE_MARKER/);
    assert.match(summaryText, /SUMMARY_MSG_MARKER/);
    assert.match(summaryText, /Finish PR 2 verification/);
    assert.doesNotMatch(summaryText, /Fresh session\. Working state/i, "no announcement chrome (matches v2 buildRecycleBriefing)");

    // 4. Both Claude transcript (NEWER) and OAR summary (OLDER) -> picks transcript.
    const claudeSid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeClaudeTranscript(homeDir, claudeSid, {
      timestampIso: "2026-11-19T13:00:00.000Z",
      noteText: "TRANSCRIPT_NEWER_NOTE",
      msgText: "TRANSCRIPT_NEWER_MSG",
    });
    const preferTranscript = await buildFreshConstructedInit({
      config: makeAgentConfig(),
      workspacePath,
      homeDir,
      processEnv: {},
      priorSession: { runtime: "claude", sessionId: claudeSid, updatedAtMs: Date.parse("2026-11-19T13:00:00.000Z") },
      readSessionSummary: () => summaryOlder,
    });
    assert.equal(preferTranscript.panelSource, "transcript");
    assert.match(String(preferTranscript.briefing), /TRANSCRIPT_NEWER_NOTE/);
    assert.doesNotMatch(String(preferTranscript.briefing), /SUMMARY_NOTE_MARKER/);

    // 5. Both Claude transcript (OLDER) and OAR summary (NEWER) -> picks summary.
    const summaryNewer = makeRichSummary({
      sessionId: "oar-sess-2",
      lastActivityAt: "2026-11-19T14:00:00.000Z",
      note: "SUMMARY_NEWER_NOTE",
      msg: "SUMMARY_NEWER_MSG",
    });
    const preferSummary = await buildFreshConstructedInit({
      config: makeAgentConfig(),
      workspacePath,
      homeDir,
      processEnv: {},
      priorSession: { runtime: "claude", sessionId: claudeSid, updatedAtMs: Date.parse("2026-11-19T13:00:00.000Z") },
      readSessionSummary: () => summaryNewer,
    });
    assert.equal(preferSummary.panelSource, "summary");
    assert.match(String(preferSummary.briefing), /SUMMARY_NEWER_NOTE/);
    assert.doesNotMatch(String(preferSummary.briefing), /TRANSCRIPT_NEWER_NOTE/);

    // 6. RAFT_WAKE_RECYCLE_PANEL_TOKENS=0 disables panel while keeping <memory-index>.
    const disabled = await buildFreshConstructedInit({
      config: makeAgentConfig({ envVars: { RAFT_WAKE_RECYCLE_PANEL_TOKENS: "0" } }),
      workspacePath,
      homeDir,
      processEnv: {},
      priorSession: { runtime: "claude", sessionId: claudeSid },
      readSessionSummary: () => summaryNewer,
    });
    assert.equal(disabled.hasPanel, false);
    assert.equal(disabled.hasMemory, true);
    assert.ok(disabled.memoryBlock);

    // 7. applyFreshConstructedInit prefixes prompt and marks source.
    const applied = applyFreshConstructedInit(preferSummary, "wake body" as AxSurfaceText, "wake_inbox_update");
    assert.equal(applied.promptSource, "constructed_wake_inbox_update");
    assert.match(String(applied.prompt), /SUMMARY_NEWER_NOTE[\s\S]*wake body/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OarAgentHost: fresh start after model switch, manual session reset, or Legacy Claude switch injects constructed panel", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "constructed-init-oar-home-"));
  const h = await harness({ deps: { runtimeSessionHomeDir: homeDir } });
  try {
    // Seed an OAR session summary on disk (as left behind by a prior OAR session).
    const summaryStore = new SessionSummaryStore(path.join(h.dataDir, ".daemon-state", "agent-session-summaries"));
    summaryStore.write("agent-1", makeRichSummary({
      sessionId: "prev-oar-session",
      runtime: "grok",
      lastActivityAt: "2026-11-19T15:00:00.000Z",
      note: "OAR_PRIOR_WORK_NOTE",
      msg: "OAR_PRIOR_MSG",
    }));

    // Fresh start (e.g. manual session reset or post-model-switch start with sessionId: null)
    // must receive the warm constructed panel from the prior OAR SessionSummary.
    assert.deepEqual(await h.host.start(oarRequest({ config: oarMakeConfig({ sessionId: null, model: "grok-4" }) })), { kind: "started" });
    await until(() => h.inputs.length === 1, "first input delivered");
    assert.match(h.inputs[0]!, /OAR_PRIOR_WORK_NOTE/);
    assert.match(h.inputs[0]!, /OAR_PRIOR_MSG/);
    assert.ok(
      h.events.some((e) => e.name === "daemon.agent.constructed_init" && e.attrs.panel_source === "summary" && e.attrs.host === "oar"),
      "emits daemon.agent.constructed_init trace event",
    );

    // Cross-host continuity: Legacy Claude transcript (newer than OAR summary) -> fresh OAR start reads Claude transcript!
    const claudeSid = "12345678-1234-4321-abcd-1234567890ab";
    writeClaudeTranscript(homeDir, claudeSid, {
      timestampIso: "2026-11-19T16:00:00.000Z",
      noteText: "CLAUDE_TO_OAR_NOTE",
      msgText: "CLAUDE_TO_OAR_MSG",
    });
    const lastSessions = new LastSessionStore(h.dataDir);
    lastSessions.write("agent-2", "claude", claudeSid);
    assert.deepEqual(
      await h.host.start(oarRequest({ agentId: "agent-2", launchId: "launch-a2", config: oarMakeConfig({ name: "agent-2", sessionId: null }) })),
      { kind: "started" },
    );
    await until(() => h.inputs.length === 2, "agent-2 first input delivered");
    assert.match(h.inputs[1]!, /CLAUDE_TO_OAR_NOTE/);
    assert.match(h.inputs[1]!, /CLAUDE_TO_OAR_MSG/);
    assert.ok(
      h.events.some((e) => e.name === "daemon.agent.constructed_init" && e.attrs.agentId === "agent-2" && e.attrs.panel_source === "transcript" && e.attrs.host === "oar"),
      "emits daemon.agent.constructed_init with transcript source on cross-host switch",
    );
  } finally {
    await h.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("AgentProcessManager: model switch and cross-host switch inject constructed panel; Full Reset wipes prior continuity state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "constructed-init-apm-"));
  const dataDir = path.join(root, "agents");
  const slockHome = path.join(root, "raft-home");
  const homeDir = path.join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(slockHome, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const spawnPrompts: Array<{ sessionId: string | null | undefined; model: string; prompt: string }> = [];
  const sent: MachineToServerMessage[] = [];
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];

  class FakeChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = { write: () => true };
    kill(): boolean {
      this.emit("exit", 0, "SIGTERM");
      this.emit("close", 0, "SIGTERM");
      return true;
    }
  }

  const children: FakeChildProcess[] = [];
  const parsedLines = new Map<string, ParsedEvent[]>();
  const driver: RuntimeDriver = {
    acceptsStdinDuringCompaction: true,
    id: "claude",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" },
    model: { detectedModelsVerifiedAs: "launchable" },
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    liveSessionReadyAt: "turn_end",
    supportsNativeStandingPrompt: true,
    terminateProcessOnTurnEnd: false,
    buildSystemPrompt: () => "standing prompt" as AxSurfaceText,
    spawn: (ctx: SpawnContext): SpawnResult => {
      spawnPrompts.push({ sessionId: ctx.config.sessionId, model: ctx.config.model, prompt: String(ctx.prompt ?? "") });
      const child = new FakeChildProcess();
      children.push(child);
      return { process: child as unknown as ChildProcess };
    },
    parseLine: (line: string): ParsedEvent[] => parsedLines.get(line) ?? [],
  } as unknown as RuntimeDriver;

  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "daemon-key",
    {
      dataDir,
      slockHome,
      runtimeSessionHomeDir: homeDir,
      serverUrl: "http://127.0.0.1:0",
      driverResolver: () => driver,
      tracer: {
        startSpan: () => ({
          addEvent: () => {},
          setAttr: () => {},
          setAttrs: () => {},
          end: () => {},
          context: { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", parentSpanId: null, traceFlags: "01" },
        }),
        emitEvent: (name: string, opts?: { attrs?: Record<string, unknown> }) => { events.push({ name, attrs: opts?.attrs ?? {} }); },
      } as never,
    },
  );

  try {
    const agentId = "agent-legacy-1";
    const ws = path.join(dataDir, agentId);
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "MEMORY.md"), "# Legacy Agent\n- Keep tracking rollout\n", "utf8");

    // 1. Start session 1 on sonnet and commit its Claude session id + write its transcript.
    const sid1 = "99999999-1111-2222-3333-444444444444";
    writeClaudeTranscript(homeDir, sid1, {
      timestampIso: "2026-11-19T15:00:00.000Z",
      noteText: "LEGACY_SONNET_NOTE",
      msgText: "LEGACY_SONNET_MSG",
    });
    await manager.startAgent(agentId, makeAgentConfig({ name: agentId, model: "sonnet", sessionId: null, agentCredentialKey: "sk_test" }));
    parsedLines.set("init-1", [{ kind: "session_init", sessionId: sid1 }]);
    parsedLines.set("end-1", [{ kind: "turn_end", sessionId: sid1 }]);
    children[0]!.stdout.emit("data", Buffer.from("init-1\nend-1\n"));
    await manager.stopAgent(agentId, { silent: true });

    // 2. Switch model sonnet -> opus (even if server still named sid1, daemon drops it for model_changed
    //    AND injects constructed panel from sid1's transcript!).
    await manager.startAgent(agentId, makeAgentConfig({ name: agentId, model: "opus", sessionId: sid1, agentCredentialKey: "sk_test" }));
    assert.equal(spawnPrompts.length, 2);
    assert.equal(spawnPrompts[1]!.sessionId, null, "model switch opens a fresh session");
    assert.match(spawnPrompts[1]!.prompt, /<memory-index\b/);
    assert.match(spawnPrompts[1]!.prompt, /LEGACY_SONNET_NOTE/);
    assert.match(spawnPrompts[1]!.prompt, /LEGACY_SONNET_MSG/);
    assert.ok(
      events.some((e) => e.name === "daemon.agent.constructed_init" && e.attrs.panel_source === "transcript" && e.attrs.host === "legacy"),
      "emits constructed_init on legacy model switch",
    );
    await manager.stopAgent(agentId, { silent: true });

    // 3. Cross-host OAR -> Legacy: write a newer OAR SessionSummary -> fresh Legacy start picks summary!
    const summaryStore = new SessionSummaryStore(sessionSummaryDir(slockHome));
    summaryStore.write(agentId, makeRichSummary({
      sessionId: "oar-codex-session",
      runtime: "codex",
      lastActivityAt: "2026-11-19T16:30:00.000Z",
      note: "OAR_TO_LEGACY_NOTE",
      msg: "OAR_TO_LEGACY_MSG",
    }));
    await manager.startAgent(agentId, makeAgentConfig({ name: agentId, model: "opus", sessionId: null, agentCredentialKey: "sk_test" }));
    assert.equal(spawnPrompts.length, 3);
    assert.match(spawnPrompts[2]!.prompt, /OAR_TO_LEGACY_NOTE/);
    assert.ok(
      events.some((e) => e.name === "daemon.agent.constructed_init" && e.attrs.panel_source === "summary" && e.attrs.host === "legacy"),
      "emits constructed_init with summary source on OAR->Legacy switch",
    );
    await manager.stopAgent(agentId, { silent: true });

    // 4. Full Reset (`resetWorkspace`): clears workspace, LastSessionStore, SessionSummaryStore, and SessionSpecMemory!
    await manager.resetWorkspace(agentId);
    assert.equal(manager.lastSessions.read(agentId), null);
    assert.equal(summaryStore.read(agentId), null);
    assert.equal(manager.sessionSpecs.sessionOf(agentId), null);

    await manager.startAgent(agentId, makeAgentConfig({ name: agentId, model: "opus", sessionId: null, agentCredentialKey: "sk_test" }));
    assert.equal(spawnPrompts.length, 4);
    assert.doesNotMatch(spawnPrompts[3]!.prompt, /Keep tracking rollout/);
    assert.doesNotMatch(spawnPrompts[3]!.prompt, /LEGACY_SONNET_NOTE|OAR_TO_LEGACY_NOTE/);
    assert.doesNotMatch(spawnPrompts[3]!.prompt, /<last-notes|<recent-messages|<objects-in-play/);
  } finally {
    await manager.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
