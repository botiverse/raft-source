import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRecycleBriefing,
  buildWarmRecycleNotice,
  wakeRecycleKindTraceAttrs,
  type WarmRecycleStop,
  cacheTierFromUsage,
  coldIdleGate,
  describeAppliedWakeRecycle,
  describeRecycledWakeLogLine,
  recycleThresholds,
  resolveAgentWakeRecycleConfig,
  decideColdIdle,
  decideWakeRecycle,
  planWakeSessionRecycle,
  readClaudeSessionResumeFacts,
  readRuntimeSessionResumeFacts,
  resolveWakeRecycleConfig,
  WAKE_RECYCLE_SUMMARY_FACTS_RUNTIMES,
  summaryFactsRuntimesFor,
  type SessionResumeFacts,
  type WakeRecycleConfig,
} from "./wakeSessionRecycle";
import type { AgentConfig } from "@botiverse/raft-shared";
import { emptySessionSummary, type SessionSummary } from "./agentHost/oarSessionSummary";

const HOUR_MS = 3_600_000;

function enabledConfig(overrides: Partial<WakeRecycleConfig> = {}): WakeRecycleConfig {
  return { enabled: true, minContextTokens: 128_000, minColdGapMs: HOUR_MS, tierGate: false, minColdGap5mTierMs: 12 * 60_000, minContextTokensPastTier: 64_000, ...overrides };
}

function facts(overrides: Partial<SessionResumeFacts> = {}): SessionResumeFacts {
  return { transcriptPath: "/tmp/x.jsonl", lastActivityAtMs: 0, lastContextTokens: 500_000, ...overrides };
}

function decisionInput(overrides: Record<string, unknown> = {}) {
  return {
    config: enabledConfig(),
    runtime: "claude",
    sessionId: "session-1",
    hasResumePrompt: false,
    hasRuntimeProfileControl: false,
    facts: facts(),
    nowMs: 2 * HOUR_MS,
    ...overrides,
  } as Parameters<typeof decideWakeRecycle>[0];
}

test("recycling is on by default, independent of the retired server field; =0 is the local off switch", () => {
  const config = resolveWakeRecycleConfig(null, {});
  assert.equal(config.enabled, true, "no env: on");
  assert.equal(resolveWakeRecycleConfig(null, { RAFT_WAKE_RECYCLE: "0" }).enabled, false, "daemon process env =0 turns it off");
  assert.equal(resolveWakeRecycleConfig({ RAFT_WAKE_RECYCLE: "0" }, {}).enabled, false, "per-agent env =0 turns it off");
  assert.equal(resolveWakeRecycleConfig(null, { RAFT_WAKE_RECYCLE: "off" }).enabled, false);
  assert.equal(resolveWakeRecycleConfig(null, { RAFT_WAKE_RECYCLE: "1" }).enabled, true);
  assert.equal(config.minContextTokens, 128_000);
  assert.equal(config.minColdGapMs, HOUR_MS);
});

test("per-agent env_vars override daemon process env", () => {
  const config = resolveWakeRecycleConfig(
    { RAFT_WAKE_RECYCLE: "1", RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "96000" },
    { RAFT_WAKE_RECYCLE: "0", RAFT_WAKE_RECYCLE_MIN_COLD_GAP_MS: "7200000" },
  );
  assert.equal(config.enabled, true);
  assert.equal(config.minContextTokens, 96_000);
  assert.equal(config.minColdGapMs, 7_200_000);
});

test("cold gap with large context recycles; the plan carries facts and briefing", () => {
  const plan = decideWakeRecycle(decisionInput());
  assert.equal(plan.action, "recycle");
  if (plan.action !== "recycle") return;
  assert.equal(plan.priorSessionId, "session-1");
  assert.equal(plan.idleMs, 2 * HOUR_MS);
  assert.equal(plan.priorContextTokens, 500_000);
  assert.equal(String(plan.briefing), ""); // v3: no announcement line at all
  assert.doesNotMatch(plan.briefing, /consult MEMORY|re-establish/); // v2: no instructions at decision time
});

test("every failed gate resolves to resume with its own reason", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ config: enabledConfig({ enabled: false }) }, "disabled"],
    [{ runtime: "cursor" }, "unsupported_runtime"],
    [{ runtime: "codex", facts: facts({ lastContextTokens: null }) }, "session_facts_unavailable"],
    [{ sessionId: null }, "no_prior_session"],
    [{ hasResumePrompt: true }, "explicit_resume_prompt"],
    [{ hasRuntimeProfileControl: true }, "runtime_profile_control"],
    [{ facts: facts({ lastActivityAtMs: null }) }, "session_facts_unavailable"],
    [{ facts: facts({ lastContextTokens: null }) }, "session_facts_unavailable"],
    [{ nowMs: HOUR_MS - 1 }, "cache_possibly_warm"],
    [{ facts: facts({ lastContextTokens: 128_000 }) }, "context_below_threshold"],
  ];
  for (const [overrides, reason] of cases) {
    const plan = decideWakeRecycle(decisionInput(overrides));
    assert.equal(plan.action, "resume", reason);
    if (plan.action === "resume") assert.equal(plan.reason, reason);
  }
});

test("briefing is empty: no announcement, no recap, no instructions", () => {
  const briefing = buildRecycleBriefing({ idleMs: 5 * 3_600_000, priorContextTokens: 480_000 });
  assert.equal(String(briefing), "");
  // v2 (2026-09-11): no retirement announcement, no idle/size stats, and no
  // recovery-order instructions — 13/13 canary wakes turned the v1 chrome
  // into a resume-protocol ritual instead of answering the waking message.
  assert.doesNotMatch(briefing, /retired|fresh session|idle|consult MEMORY|re-establish/i);
});

test("transcript tail yields last-activity time and last assistant context size", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const records = [
    { type: "user", timestamp: "2026-08-30T00:00:00.000Z", message: { content: "hi" } },
    {
      type: "assistant",
      timestamp: "2026-08-30T00:00:10.000Z",
      message: { usage: { input_tokens: 12, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 2_000 } },
    },
    { type: "user", timestamp: "2026-08-30T01:00:00.000Z", message: { content: "tool result" } },
  ];
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");

  const result = await readClaudeSessionResumeFacts(sessionId, home);
  assert.equal(result.lastActivityAtMs, Date.parse("2026-08-30T01:00:00.000Z"));
  assert.equal(result.lastContextTokens, 402_012);
});

test("a session with no transcript on disk yields unknown facts (and therefore resume)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const result = await readClaudeSessionResumeFacts("99999999-0000-0000-0000-000000000000", home);
  assert.equal(result.transcriptPath, null);
  assert.equal(result.lastActivityAtMs, null);
  assert.equal(result.lastContextTokens, null);
});

// Cold idle (reconciler step 8b): the memory-only gate, then the verdict over
// the facts read from the transcript. Idle itself is the agent manager's
// (agentNotIdle); these tests cover only what makes an idle process cold.

function coldTranscriptHome(nowMs: number) {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const write = (sessionId: string, records: unknown[]) => {
    writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  };
  const assistant = (atMs: number, cacheRead = 400_000) => ({
    type: "assistant",
    timestamp: new Date(atMs).toISOString(),
    message: { usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
  });
  return { home, projectDir, write, assistant, coldAt: nowMs - 3 * HOUR_MS };
}

const coldConfig = (overrides: Record<string, unknown> = {}) =>
  ({ runtime: "claude", sessionId: null, envVars: { RAFT_WAKE_RECYCLE: "1" }, ...overrides }) as unknown as AgentConfig;

test("cold-idle gate: memory only, in order: enabled, a runtime the recycle supports, its CLI at the version floor, a session, past the cold gap since the last event", () => {
  const nowMs = Date.now();
  const gate = (overrides: Partial<Parameters<typeof coldIdleGate>[0]>) => coldIdleGate({
    config: coldConfig(),
    liveSessionId: "session-cold",
    lastEventAtMs: nowMs - 3 * HOUR_MS,
    runtimeCliVersion: "2.1.304 (Claude Code)",
    nowMs,
    processEnv: {},
    ...overrides,
  });

  const pass = gate({});
  assert.equal(pass.pass, true);
  if (pass.pass) {
    assert.equal(pass.sessionId, "session-cold");
    assert.equal(pass.sinceEventMs, 3 * HOUR_MS);
  }
  assert.deepEqual(gate({ config: coldConfig({ envVars: { RAFT_WAKE_RECYCLE: "0" } }) }), { pass: false, reason: "disabled" });
  assert.deepEqual(gate({ config: coldConfig({ runtime: "gemini" }) }), { pass: false, reason: "unsupported_runtime" });
  // Claude Code before typed task envelopes showed background shells only in
  // its transcript: an older or unknown version is never cold.
  assert.equal(gate({ runtimeCliVersion: "2.1.220 (Claude Code)" }).pass, true, "the floor itself");
  assert.equal(gate({ runtimeCliVersion: "2.2.0" }).pass, true);
  assert.deepEqual(gate({ runtimeCliVersion: "2.1.219 (Claude Code)" }), { pass: false, reason: "runtime_version_below_floor" });
  assert.deepEqual(gate({ runtimeCliVersion: undefined }), { pass: false, reason: "runtime_version_below_floor" }, "unknown");
  assert.deepEqual(gate({ runtimeCliVersion: "unknown" }), { pass: false, reason: "runtime_version_below_floor" }, "unparseable");
  assert.equal(gate({ config: coldConfig({ runtime: "codex" }), runtimeCliVersion: undefined }).pass, true, "a runtime without a floor");
  assert.deepEqual(gate({ liveSessionId: null }), { pass: false, reason: "no_session" });
  assert.equal((gate({ liveSessionId: null, config: coldConfig({ sessionId: "session-config" }) }) as { sessionId?: string }).sessionId, "session-config", "the config's session when none is latched");
  assert.deepEqual(gate({ lastEventAtMs: nowMs - 60_000 }), { pass: false, reason: "recent_event" });
  assert.deepEqual(gate({ lastEventAtMs: nowMs - HOUR_MS }), { pass: false, reason: "recent_event" }, "exactly the gap is not past it");
});

test("cold-idle verdict over the transcript: a large cold context is cold; unreadable facts, a small context or recent transcript activity are not", async () => {
  const nowMs = Date.now();
  const { home, write, assistant, coldAt } = coldTranscriptHome(nowMs);
  write("cccccccc-1111-2222-3333-444444444444", [assistant(coldAt)]);
  write("cccccccc-5555-6666-7777-888888888888", [assistant(coldAt, 100_000)]);
  // Recent transcript activity vetoes a stale memory clock (the at-wake
  // recycle would resume it, so stopping it buys nothing).
  write("dddddddd-1111-2222-3333-444444444444", [assistant(nowMs - 30_000)]);
  const config = enabledConfig();
  const verdict = async (runtime: string, sessionId: string) => decideColdIdle(
    await readRuntimeSessionResumeFacts(runtime, sessionId, home),
    { config, lastEventAtMs: coldAt, nowMs },
  );

  assert.deepEqual(await verdict("claude", "cccccccc-1111-2222-3333-444444444444"), {
    cold: true,
    idleMs: 3 * HOUR_MS,
    priorContextTokens: 400_005,
    thresholds: { minColdGapMs: HOUR_MS, minContextTokens: 128_000, cacheTier: "unknown", tierGate: false },
  });
  assert.deepEqual(await verdict("claude", "cccccccc-5555-6666-7777-888888888888"), { cold: false, reason: "context_below_threshold" });
  assert.deepEqual(await verdict("claude", "dddddddd-1111-2222-3333-444444444444"), { cold: false, reason: "recent_activity" });
  assert.deepEqual(await verdict("claude", "eeeeeeee-0000-0000-0000-000000000000"), { cold: false, reason: "session_facts_unavailable" }, "no transcript");
  assert.deepEqual(await verdict("codex", "cccccccc-1111-2222-3333-444444444444"), { cold: false, reason: "session_facts_unavailable" }, "no facts reader for codex");
  // A newer last event than the transcript's last record counts too.
  assert.deepEqual(
    decideColdIdle(facts({ lastActivityAtMs: coldAt }), { config, lastEventAtMs: nowMs - 10 * 60_000, nowMs }),
    { cold: false, reason: "recent_activity" },
  );
});

test("background work is not read from the transcript or its sidecar: an armed Monitor marker and a fresh sub-agent file leave a cold session cold (idle holds them, from the event stream)", async () => {
  const nowMs = Date.now();
  const { home, projectDir, write, assistant, coldAt } = coldTranscriptHome(nowMs);
  const sessionId = "ffffffff-1111-2222-3333-444444444444";
  write(sessionId, [
    assistant(coldAt),
    { type: "user", timestamp: new Date(coldAt).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "t", content: "Monitor started (task babc123x, timeout 60000ms). You will be notified" }] } },
  ]);
  const sidecar = path.join(projectDir, sessionId, "subagents");
  mkdirSync(sidecar, { recursive: true });
  writeFileSync(path.join(sidecar, "agent-live.jsonl"), "{}\n");

  const verdict = decideColdIdle(await readRuntimeSessionResumeFacts("claude", sessionId, home), { config: enabledConfig(), lastEventAtMs: coldAt, nowMs });
  assert.equal(verdict.cold, true);
});

test("planWakeSessionRecycle recycles end to end from a real transcript tail", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const lastTurnAt = Date.now() - 3 * HOUR_MS;
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: "assistant",
    timestamp: new Date(lastTurnAt).toISOString(),
    message: { usage: { input_tokens: 5, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 1_500 } },
  }) + "\n");

  const config = {
    runtime: "claude",
    sessionId,
    envVars: null,
  } as unknown as AgentConfig;
  const plan = await planWakeSessionRecycle({ config, hasResumePrompt: false, homeDir: home, processEnv: {} });
  assert.equal(plan.action, "recycle", "on by default: no env and no server field");
  if (plan.action === "recycle") {
    assert.equal(plan.priorSessionId, sessionId);
    assert.equal(plan.priorContextTokens, 601_505);
  }

  // The retired `constructedWakeContext` field is ignored, even when false.
  const ignoredFieldPlan = await planWakeSessionRecycle({
    config: { ...config, constructedWakeContext: false } as AgentConfig,
    hasResumePrompt: false,
    homeDir: home,
    processEnv: {},
  });
  assert.equal(ignoredFieldPlan.action, "recycle");

  const disabledPlan = await planWakeSessionRecycle({
    config: { ...config, envVars: { RAFT_WAKE_RECYCLE: "0" } } as AgentConfig,
    hasResumePrompt: false,
    homeDir: home,
    processEnv: {},
  });
  assert.equal(disabledPlan.action, "resume");

  const processEnvDisabledPlan = await planWakeSessionRecycle({ config, hasResumePrompt: false, homeDir: home, processEnv: { RAFT_WAKE_RECYCLE: "0" } });
  assert.equal(processEnvDisabledPlan.action, "resume");
});

test("task #3: an OAR session summary feeds the facts and the panel only for a listed runtime and its own session", async () => {
  const nowMs = Date.now();
  const sessionId = "oar-sess-1";
  const summary = {
    ...emptySessionSummary("grok", sessionId, nowMs - 3 * HOUR_MS),
    lastActivityAt: new Date(nowMs - 3 * HOUR_MS).toISOString(),
    context: { tokens: 300_000, window: 1_000_000, at: new Date(nowMs - 3 * HOUR_MS).toISOString() },
    lastNote: { sessionId, at: new Date(nowMs - 3 * HOUR_MS).toISOString(), text: "Waiting on review." },
    messages: [{ sessionId, direction: "received" as const, at: "2026-11-03 06:00:00Z", target: "#ops", msgId: "aaaaaaaa", raw: "[target=#ops msg=aaaaaaaa time=2026-11-03 06:00:00Z type=human] @alice: please review" }],
  };
  const config = { runtime: "grok", sessionId, envVars: null } as unknown as AgentConfig;

  assert.deepEqual([...WAKE_RECYCLE_SUMMARY_FACTS_RUNTIMES].sort(), ["codex", "grok"], "the OAR host's runtimes with summary facts");
  const byDefault = await planWakeSessionRecycle({ config, hasResumePrompt: false, processEnv: {}, readSessionSummary: () => summary });
  assert.deepEqual(byDefault, { action: "resume", reason: "session_facts_unavailable" }, "flag off (absent): the summary is not read");
  const flagOff = await planWakeSessionRecycle({ config: { ...config, wakeRecycleOar: false } as AgentConfig, hasResumePrompt: false, processEnv: {}, readSessionSummary: () => summary });
  assert.deepEqual(flagOff, { action: "resume", reason: "session_facts_unavailable" });
  const flagOn = await planWakeSessionRecycle({ config: { ...config, wakeRecycleOar: true } as AgentConfig, hasResumePrompt: false, processEnv: {}, readSessionSummary: () => summary });
  assert.equal(flagOn.action, "recycle", "wake_recycle_oar on: the summary's facts decide");
  const flagOnLocalOff = await planWakeSessionRecycle({ config: { ...config, wakeRecycleOar: true, envVars: { RAFT_WAKE_RECYCLE: "0" } } as AgentConfig, hasResumePrompt: false, processEnv: {}, readSessionSummary: () => summary });
  assert.equal(flagOnLocalOff.action, "resume", "the local off switch still wins");

  const listed = new Set(["grok"]);
  const plan = await planWakeSessionRecycle({ config, hasResumePrompt: false, processEnv: {}, readSessionSummary: () => summary, summaryFactsRuntimes: listed });
  assert.equal(plan.action, "recycle");
  if (plan.action === "recycle") {
    assert.equal(plan.priorContextTokens, 300_000);
    const briefing = String(plan.briefing);
    assert.match(briefing, /<recent-messages[^>]*>\n\[target=#ops msg=aaaaaaaa/);
    assert.match(briefing, /<last-note written="[^"]+" note="your own text at the end of a turn; delivered to no one">/);
  }

  const otherSession = await planWakeSessionRecycle({
    config: { ...config, sessionId: "oar-sess-0" } as AgentConfig,
    hasResumePrompt: false,
    processEnv: {},
    readSessionSummary: () => summary,
    summaryFactsRuntimes: listed,
  });
  assert.deepEqual(otherSession, { action: "resume", reason: "session_facts_unavailable" }, "a summary of another session says nothing");

  const unreadable = await planWakeSessionRecycle({
    config,
    hasResumePrompt: false,
    processEnv: {},
    readSessionSummary: () => { throw new Error("EACCES"); },
    summaryFactsRuntimes: listed,
  });
  assert.equal(unreadable.action, "resume");
});

test("#54: summaryFactsRuntimesFor lists Codex and Grok only while wake_recycle_oar is on", () => {
  assert.equal(summaryFactsRuntimesFor({}).size, 0);
  assert.equal(summaryFactsRuntimesFor({ wakeRecycleOar: false }).size, 0);
  assert.deepEqual([...summaryFactsRuntimesFor({ wakeRecycleOar: true })].sort(), ["codex", "grok"]);
});

test("task #3: summary facts are unknown when the latest turn never ended or no context was reported", async () => {
  const nowMs = Date.now();
  const sessionId = "oar-sess-2";
  const at = (ago: number) => new Date(nowMs - ago).toISOString();
  const finished: SessionSummary = {
    ...emptySessionSummary("grok", sessionId, nowMs - 3 * HOUR_MS),
    lastActivityAt: at(3 * HOUR_MS),
    context: { tokens: 300_000, window: 1_000_000, at: at(3 * HOUR_MS) },
    wake: { at: at(3.5 * HOUR_MS), input: "do the thing" },
    turns: { count: 4, lastEndedAt: at(3 * HOUR_MS), lastOutcome: "completed" },
  };
  const config = { runtime: "grok", sessionId, envVars: null } as unknown as AgentConfig;
  const plan = (summary: SessionSummary) => planWakeSessionRecycle({ config, hasResumePrompt: false, processEnv: {}, readSessionSummary: () => summary, summaryFactsRuntimes: new Set(["grok"]) });

  assert.equal((await plan(finished)).action, "recycle");
  // The daemon died mid-turn: a wake after the last turn end means the turn never finished.
  assert.deepEqual(await plan({ ...finished, wake: { at: at(2 * HOUR_MS), input: "a long turn" } }), { action: "resume", reason: "session_facts_unavailable" });
  assert.deepEqual(await plan({ ...finished, context: null }), { action: "resume", reason: "session_facts_unavailable" });
});

test("task #3: a readable Claude transcript wins over a session summary", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-precedence-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const sessionId = "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee";
  const lastTurnAt = Date.now() - 3 * HOUR_MS;
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: "assistant",
    timestamp: new Date(lastTurnAt).toISOString(),
    message: { usage: { input_tokens: 5, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 1_500 } },
  }) + "\n");
  let summaryRead = false;
  const plan = await planWakeSessionRecycle({
    config: { runtime: "claude", sessionId, envVars: null } as unknown as AgentConfig,
    hasResumePrompt: false,
    homeDir: home,
    processEnv: {},
    readSessionSummary: () => { summaryRead = true; return null; },
    summaryFactsRuntimes: new Set(["claude"]),
  });
  assert.equal(plan.action, "recycle");
  if (plan.action === "recycle") assert.equal(plan.priorContextTokens, 601_505);
  assert.equal(summaryRead, false);
});

// #proj-runtime:#54 phase 2: `wake_recycle_tier_gate`. The gate follows the
// cache tier the session last wrote, and a session with a known tier past its
// gate recycles from 64k. AndyLok's split: the 5-60 minute bands hold at most
// ~1.9% of Claude spend as stale rewrites, the over-an-hour band 6.1% at a
// median rewrite of 82k, which the 128k floor mostly let resume.

const MIN = 60_000;
const tierConfig = (overrides: Partial<WakeRecycleConfig> = {}) => enabledConfig({ tierGate: true, ...overrides });

test("#54: the cache tier comes from Claude's usage.cache_creation split; the hour wins when a request wrote both", () => {
  assert.equal(cacheTierFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 354, ephemeral_5m_input_tokens: 0 } }), "1h");
  assert.equal(cacheTierFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 2_100 } }), "5m");
  assert.equal(cacheTierFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 2_100 } }), "1h");
  assert.equal(cacheTierFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }), null, "a read-only request wrote nothing");
  assert.equal(cacheTierFromUsage({ input_tokens: 4, cache_read_input_tokens: 500_000 }), null, "an older Claude Code with no split");
  assert.equal(cacheTierFromUsage(null), null);
});

test("#54: the transcript reader keeps the tier of the last request that wrote cache, not of a later read-only one", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const write = (sessionId: string, records: unknown[]) =>
    writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  // The shape Claude Code writes (service_tier, iterations and so on trimmed).
  const assistant = (at: string, creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null) => ({
    type: "assistant",
    timestamp: at,
    message: {
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: creation ? creation.ephemeral_1h_input_tokens + creation.ephemeral_5m_input_tokens : 0,
        cache_read_input_tokens: 90_000,
        output_tokens: 45,
        ...(creation ? { cache_creation: creation } : {}),
      },
    },
  });
  write("aaaaaaaa-0000-0000-0000-00000000005f", [
    assistant("2026-11-10T10:00:00.000Z", { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 3_000 }),
    assistant("2026-11-10T10:00:30.000Z", { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }),
  ]);
  write("aaaaaaaa-0000-0000-0000-0000000001e0", [
    assistant("2026-11-10T10:00:00.000Z", { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 3_000 }),
    assistant("2026-11-10T10:00:30.000Z", { ephemeral_1h_input_tokens: 800, ephemeral_5m_input_tokens: 0 }),
  ]);
  write("aaaaaaaa-0000-0000-0000-000000000000", [assistant("2026-11-10T10:00:00.000Z", null)]);

  assert.equal((await readClaudeSessionResumeFacts("aaaaaaaa-0000-0000-0000-00000000005f", home)).cacheTier, "5m");
  assert.equal((await readClaudeSessionResumeFacts("aaaaaaaa-0000-0000-0000-0000000001e0", home)).cacheTier, "1h");
  assert.equal((await readClaudeSessionResumeFacts("aaaaaaaa-0000-0000-0000-000000000000", home)).cacheTier, null);
});

test("#54: the flag and the env knobs: off by default; the Server's flag turns it on; env tunes the short gate and the floor", () => {
  const off = resolveAgentWakeRecycleConfig({ envVars: null }, {});
  assert.equal(off.tierGate, false);
  const on = resolveAgentWakeRecycleConfig({ envVars: null, wakeRecycleTierGate: true }, {});
  assert.equal(on.tierGate, true);
  assert.equal(on.minColdGap5mTierMs, 12 * MIN);
  assert.equal(on.minContextTokensPastTier, 64_000);
  const tuned = resolveAgentWakeRecycleConfig(
    { envVars: { RAFT_WAKE_RECYCLE_MIN_COLD_GAP_5M_TIER_MS: String(15 * MIN) }, wakeRecycleTierGate: true },
    { RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS_PAST_TIER: "48000" },
  );
  assert.equal(tuned.minColdGap5mTierMs, 15 * MIN);
  assert.equal(tuned.minContextTokensPastTier, 48_000);
  // The flag never turns recycling on against the local off switch.
  assert.equal(resolveAgentWakeRecycleConfig({ envVars: { RAFT_WAKE_RECYCLE: "0" }, wakeRecycleTierGate: true }, {}).enabled, false);
});

test("#54: thresholds: today's with the flag off or no tier; with it, the 5-minute tier's short gate, and 64k only past the hour", () => {
  assert.deepEqual(recycleThresholds(enabledConfig(), "5m", 2 * HOUR_MS), { minColdGapMs: HOUR_MS, minContextTokens: 128_000, cacheTier: "5m", tierGate: false });
  assert.deepEqual(recycleThresholds(tierConfig(), null, 2 * HOUR_MS), { minColdGapMs: HOUR_MS, minContextTokens: 128_000, cacheTier: "unknown", tierGate: true });
  assert.deepEqual(recycleThresholds(tierConfig(), "5m", 20 * MIN), { minColdGapMs: 12 * MIN, minContextTokens: 128_000, cacheTier: "5m", tierGate: true });
  assert.deepEqual(recycleThresholds(tierConfig(), "5m", 70 * MIN), { minColdGapMs: 12 * MIN, minContextTokens: 64_000, cacheTier: "5m", tierGate: true });
  assert.deepEqual(recycleThresholds(tierConfig(), "1h", 2 * HOUR_MS), { minColdGapMs: HOUR_MS, minContextTokens: 64_000, cacheTier: "1h", tierGate: true });
});

test("#54: a 5-minute-tier session recycles after 12 minutes; a 1-hour-tier one waits the hour; the flag off keeps the hour for both", () => {
  const at = (idleMs: number, tier: "5m" | "1h" | null, config = tierConfig(), contextTokens = 200_000) =>
    decideWakeRecycle(decisionInput({ config, facts: facts({ lastActivityAtMs: 0, lastContextTokens: contextTokens, cacheTier: tier }), nowMs: idleMs }));

  assert.equal(at(13 * MIN, "5m").action, "recycle");
  assert.equal(at(11 * MIN, "5m").reason, "cache_possibly_warm");
  assert.equal(at(13 * MIN, "1h").reason, "cache_possibly_warm", "a 1-hour cache is still warm at 13 minutes");
  assert.equal(at(61 * MIN, "1h").action, "recycle");
  assert.equal(at(13 * MIN, null).reason, "cache_possibly_warm", "no tier read (Codex, an old transcript): the hour");
  assert.equal(at(13 * MIN, "5m", enabledConfig()).reason, "cache_possibly_warm", "flag off: today's hour");
  const recycled = at(13 * MIN, "5m");
  assert.equal(recycled.action, "recycle");
  if (recycled.action === "recycle") {
    assert.deepEqual(describeAppliedWakeRecycle("agent-1", recycled).traceAttrs, {
      agentId: "agent-1",
      reason: "cold_gap_large_context",
      prior_session_id: "session-1",
      idle_ms: 13 * MIN,
      prior_context_tokens: 200_000,
      cache_tier: "5m",
      tier_gate: true,
      min_cold_gap_ms: 12 * MIN,
      min_context_tokens: 128_000,
    });
  }
});

test("#54: the 64k floor applies only past the hour, whatever the tier; a 5-minute-tier session idle 12-60 minutes keeps 128k", () => {
  const at = (idleMs: number, tier: "5m" | "1h" | null, contextTokens: number, config = tierConfig()) =>
    decideWakeRecycle(decisionInput({ config, facts: facts({ lastActivityAtMs: 0, lastContextTokens: contextTokens, cacheTier: tier }), nowMs: idleMs }));

  assert.equal(at(2 * HOUR_MS, "1h", 82_000).action, "recycle", "the typical over-an-hour rewrite now recycles");
  assert.equal(at(2 * HOUR_MS, "1h", 82_000, enabledConfig()).reason, "context_below_threshold", "flag off: 128k");
  assert.equal(at(2 * HOUR_MS, null, 82_000).reason, "context_below_threshold", "no tier read: 128k");
  assert.equal(at(2 * HOUR_MS, "1h", 50_000).reason, "context_below_threshold", "below 64k still resumes");
  // Tenny's case: a 5-minute-tier session with 70k resumes after a 20-minute break and recycles after 70 minutes.
  assert.equal(at(20 * MIN, "5m", 70_000).reason, "context_below_threshold", "12-60 minutes: still the 128k floor");
  assert.equal(at(70 * MIN, "5m", 70_000).action, "recycle", "past the hour: 64k");
  assert.equal(at(20 * MIN, "5m", 200_000).action, "recycle", "above 128k the short gate recycles");
  assert.equal(at(5 * MIN, "5m", 82_000).reason, "cache_possibly_warm", "below the gate nothing changes");
  const resumed = at(20 * MIN, "5m", 70_000);
  assert.deepEqual(resumed.action === "resume" ? resumed.thresholds : null, { minColdGapMs: 12 * MIN, minContextTokens: 128_000, cacheTier: "5m", tierGate: true });
});

test("#54: the cold-idle stop uses the same gate: the memory-only gate opens at the short gap, the verdict applies the session's own tier", () => {
  const nowMs = Date.now();
  const gate = (config: AgentConfig) => coldIdleGate({ config, liveSessionId: "session-cold", lastEventAtMs: nowMs - 13 * MIN, runtimeCliVersion: "2.1.304 (Claude Code)", nowMs, processEnv: {} });
  assert.deepEqual(gate(coldConfig()), { pass: false, reason: "recent_event" }, "flag off: the hour");
  const opened = gate(coldConfig({ wakeRecycleTierGate: true }));
  assert.equal(opened.pass, true, "flag on: no session of this agent can be cold before 12 minutes, so the cheap gate opens there");
  if (!opened.pass) return;
  const verdict = (tier: "5m" | "1h" | null, contextTokens = 200_000) =>
    decideColdIdle(facts({ lastActivityAtMs: nowMs - 13 * MIN, lastContextTokens: contextTokens, cacheTier: tier }), { config: opened.config, lastEventAtMs: nowMs - 13 * MIN, nowMs });
  const fiveMinute = verdict("5m");
  assert.equal(fiveMinute.cold, true);
  if (fiveMinute.cold) assert.deepEqual(fiveMinute.thresholds, { minColdGapMs: 12 * MIN, minContextTokens: 128_000, cacheTier: "5m", tierGate: true });
  assert.deepEqual(verdict("1h"), { cold: false, reason: "recent_activity" }, "a 1-hour-tier session waits its hour");
  assert.deepEqual(verdict(null), { cold: false, reason: "recent_activity" }, "no tier: the hour");
  assert.deepEqual(verdict("5m", 50_000), { cold: false, reason: "context_below_threshold" });
  assert.deepEqual(verdict("5m", 70_000), { cold: false, reason: "context_below_threshold" }, "13 minutes: the 128k floor still holds a 70k session");
});

test("#54: planWakeSessionRecycle recycles a 5-minute-tier Claude session 13 minutes idle only while wake_recycle_tier_gate is on", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const sessionId = "bbbbbbbb-0000-0000-0000-00000000005f";
  const lastAtMs = Date.parse("2026-11-10T10:00:00.000Z");
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: "assistant",
    timestamp: new Date(lastAtMs).toISOString(),
    message: { usage: { input_tokens: 4, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 150_000, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 3_000 } } },
  }) + "\n");
  const plan = (wakeRecycleTierGate: boolean | undefined) => planWakeSessionRecycle({
    config: { runtime: "claude", sessionId, envVars: null, ...(wakeRecycleTierGate === undefined ? {} : { wakeRecycleTierGate }) } as unknown as AgentConfig,
    hasResumePrompt: false,
    nowMs: lastAtMs + 13 * MIN,
    homeDir: home,
    processEnv: { RAFT_WAKE_RECYCLE_PANEL_TOKENS: "0", RAFT_STARTUP_MEMORY_BLOCK: "0" },
  });
  const on = await plan(true);
  assert.equal(on.action, "recycle");
  if (on.action === "recycle") assert.equal(on.thresholds.cacheTier, "5m");
  const off = await plan(undefined);
  assert.equal(off.action, "resume");
  if (off.action === "resume") {
    assert.equal(off.reason, "cache_possibly_warm");
    assert.deepEqual(off.thresholds, { minColdGapMs: HOUR_MS, minContextTokens: 128_000, cacheTier: "5m", tierGate: false });
  }
});

// Warm wake recycle (#proj-runtime:#54, RFC 070 §6.5): the start's half.
const MINUTE = 60_000;
const warmStop = (overrides: Partial<WarmRecycleStop> = {}): WarmRecycleStop => ({ sessionId: "session-1", stoppedAtMs: 3 * MINUTE, contextTokens: 300_000, band: "quiet", ...overrides });
/** A start five minutes after the session's last activity: nowhere near any cold gate. */
const warmInput = (overrides: Record<string, unknown> = {}) => decisionInput({
  facts: facts({ lastActivityAtMs: 0, lastContextTokens: 300_000 }),
  nowMs: 5 * MINUTE,
  warmEnabled: true,
  warmStop: warmStop(),
  ...overrides,
});

test("§6.5: the flag on and this session stopped warm: recycle whatever the gap, with the warm reason and notice", () => {
  const plan = decideWakeRecycle(warmInput());
  assert.equal(plan.action, "recycle");
  if (plan.action !== "recycle") return;
  assert.equal(plan.reason, "warm_recycle");
  assert.equal(plan.priorSessionId, "session-1");
  assert.equal(plan.idleMs, 5 * MINUTE);
  assert.equal(plan.priorContextTokens, 300_000);
  assert.deepEqual(plan.warm, { gapSinceStopMs: 2 * MINUTE, band: "quiet" });
  assert.equal(String(plan.briefing), String(buildWarmRecycleNotice()));
  // The context was measured at the mark: the cold floor is not asked again.
  const small = decideWakeRecycle(warmInput({ facts: facts({ lastActivityAtMs: 0, lastContextTokens: 90_000 }) }));
  assert.equal(small.action, "recycle");
});

test("§6.5: flag off, no stop remembered, or another session's stop: exactly today's decision", () => {
  for (const [label, overrides] of [
    ["flag off", { warmEnabled: false }],
    ["flag absent", { warmEnabled: undefined }],
    ["no stop", { warmStop: null }],
    ["another session's stop", { warmStop: warmStop({ sessionId: "session-0" }) }],
  ] as const) {
    const plan = decideWakeRecycle(warmInput(overrides));
    assert.deepEqual(plan, decideWakeRecycle(decisionInput({ facts: facts({ lastActivityAtMs: 0, lastContextTokens: 300_000 }), nowMs: 5 * MINUTE })), label);
    assert.equal(plan.action, "resume", label);
    if (plan.action === "resume") assert.equal(plan.reason, "cache_possibly_warm", label);
  }
  // Past the cold gate with the flag off: the cold recycle, byte for byte.
  const cold = decideWakeRecycle(warmInput({ warmEnabled: false, nowMs: 2 * HOUR_MS }));
  assert.equal(cold.action, "recycle");
  if (cold.action === "recycle") {
    assert.equal(cold.reason, "cold_gap_large_context");
    assert.equal(cold.warm, undefined);
    assert.equal(String(cold.briefing), "");
  }
});

test("§6.5: the same exclusions as the cold recycle", () => {
  for (const [reason, overrides] of [
    ["disabled", { config: enabledConfig({ enabled: false }) }],
    ["unsupported_runtime", { runtime: "opencode" }],
    ["no_prior_session", { sessionId: null }],
    ["explicit_resume_prompt", { hasResumePrompt: true }],
    ["runtime_profile_control", { hasRuntimeProfileControl: true }],
    ["session_facts_unavailable", { facts: facts({ lastActivityAtMs: null, lastContextTokens: null }) }],
  ] as const) {
    const plan = decideWakeRecycle(warmInput(overrides));
    assert.equal(plan.action, "resume", reason);
    if (plan.action === "resume") assert.equal(plan.reason, reason);
  }
});

test("§6.5: the warm notice is a few plain lines naming the two re-checks with the CLI's real commands, and nothing else", () => {
  const notice = String(buildWarmRecycleNotice());
  assert.equal(notice, [
    "[This session was restarted to keep it short. Work may have been in progress.",
    "What follows is a reconstruction of recent activity, not the transcript.",
    "Before continuing, re-check two things: your unread inbox (`raft inbox check`) and the tasks assigned to you (`raft task list --mine`).]",
  ].join("\n"));
  assert.equal([...notice.matchAll(/`raft [^`]+`/g)].length, 2, "two commands, no further instructions");
  assert.doesNotMatch(notice, /MEMORY|re-establish|first,|then /i);
});

test("§6.5: the applied-recycle trace says warm or cold, the gap since the stop and the start's trigger; the cold attrs are unchanged", () => {
  const warm = decideWakeRecycle(warmInput());
  const cold = decideWakeRecycle(decisionInput());
  assert.equal(warm.action, "recycle");
  assert.equal(cold.action, "recycle");
  if (warm.action !== "recycle" || cold.action !== "recycle") return;
  assert.deepEqual(wakeRecycleKindTraceAttrs(warm, "reminder"), { recycle_kind: "warm", gap_since_stop_ms: 2 * MINUTE, band: "quiet", trigger_kind: "reminder" });
  assert.deepEqual(wakeRecycleKindTraceAttrs(cold, "message"), { recycle_kind: "cold", trigger_kind: "message" });
  assert.deepEqual(wakeRecycleKindTraceAttrs(cold, undefined), { recycle_kind: "cold" });
  assert.equal(describeAppliedWakeRecycle("agent-1", warm).traceAttrs.reason, "warm_recycle");
  assert.equal(
    describeAppliedWakeRecycle("agent-1", warm).logLine,
    "Retiring runtime session session-1 at wake (warm recycle, 120000ms since its warm stop, 300000 context tokens); starting fresh with briefing",
  );
  assert.equal(
    describeAppliedWakeRecycle("agent-1", cold).logLine,
    "Retiring runtime session session-1 at wake (cold recycle, idle 120m, ~500k context); starting fresh with briefing",
  );
});

test("§6.5: planWakeSessionRecycle recycles a warm-stopped session minutes after its last activity, notice first; without the stop it resumes", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-warm-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const nowMs = Date.parse("2026-11-10T10:05:00.000Z");
  writeFileSync(path.join(projectDir, "session-warm.jsonl"), JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-10T10:00:00.000Z",
    message: { usage: { input_tokens: 10, cache_read_input_tokens: 299_990, cache_creation_input_tokens: 0 } },
  }) + "\n");
  const config = { runtime: "claude", sessionId: "session-warm", envVars: { RAFT_STARTUP_MEMORY_BLOCK: "0" }, wakeRecycleWarm: true } as unknown as AgentConfig;
  const stop = warmStop({ sessionId: "session-warm", stoppedAtMs: nowMs - 30_000 });

  const plan = await planWakeSessionRecycle({ config, hasResumePrompt: false, nowMs, homeDir: home, processEnv: {}, warmStop: stop });
  assert.equal(plan.action, "recycle");
  if (plan.action === "recycle") {
    assert.equal(plan.reason, "warm_recycle");
    assert.deepEqual(plan.warm, { gapSinceStopMs: 30_000, band: "quiet" });
    assert.ok(String(plan.briefing).startsWith(String(buildWarmRecycleNotice())), "the notice opens the briefing");
  }
  for (const [label, args] of [
    ["no stop remembered", { config, warmStop: null }],
    ["flag off", { config: { ...config, wakeRecycleWarm: undefined }, warmStop: stop }],
    ["a caller's resume prompt", { config, warmStop: stop, hasResumePrompt: true }],
    ["a pending runtime profile control", { config: { ...config, runtimeProfileControl: { kind: "runtime_profile_migration", key: "k", message: "m" } } as unknown as AgentConfig, warmStop: stop }],
  ] as const) {
    const resumed = await planWakeSessionRecycle({ hasResumePrompt: false, nowMs, homeDir: home, processEnv: {}, ...args });
    assert.equal(resumed.action, "resume", label);
  }
});

test("§6.5 end to end: a warm recycle's briefing has the last notes, the open todos and 30 actions; a cold one has none of them", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-warm-panel-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const at = (seconds: number) => new Date(Date.parse("2026-11-10T10:00:00.000Z") + seconds * 1_000).toISOString();
  const lines: string[] = [
    JSON.stringify({ type: "user", timestamp: at(0), message: { content: "wake: please migrate the store" } }),
    JSON.stringify({ type: "assistant", timestamp: at(1), message: { id: "m0", content: [{ type: "text", text: "Reading the old store." }] } }),
    JSON.stringify({ type: "assistant", timestamp: at(2), message: { id: "m1", content: [{ type: "tool_use", id: "todo1", name: "TodoWrite", input: { todos: [
      { content: "read the old store", status: "completed", activeForm: "x" },
      { content: "port the reader", status: "in_progress", activeForm: "x" },
      { content: "run the store tests", status: "pending", activeForm: "x" },
    ] } }] } }),
    JSON.stringify({ type: "user", timestamp: at(3), message: { content: [{ type: "tool_result", tool_use_id: "todo1", content: "ok" }] } }),
  ];
  for (let i = 0; i < 35; i += 1) {
    lines.push(JSON.stringify({ type: "assistant", timestamp: at(10 + i), message: { id: `a${i}`, content: [{ type: "tool_use", id: `b${i}`, name: "Bash", input: { command: `echo warm-step-${i}` } }] } }));
    lines.push(JSON.stringify({ type: "user", timestamp: at(10 + i), message: { content: [{ type: "tool_result", tool_use_id: `b${i}`, content: "ok" }] } }));
  }
  lines.push(JSON.stringify({ type: "assistant", timestamp: at(50), message: { id: "m8", content: [{ type: "text", text: "Starting the store migration: reader next." }] } }));
  lines.push(JSON.stringify({ type: "user", timestamp: at(60), message: { content: "wake: status?" } }));
  lines.push(JSON.stringify({
    type: "assistant",
    timestamp: at(61),
    message: { id: "m9", content: [{ type: "text", text: "Reader ported; store tests next." }], usage: { input_tokens: 10, cache_read_input_tokens: 299_990, cache_creation_input_tokens: 0 } },
  }));
  writeFileSync(path.join(projectDir, "session-warm.jsonl"), lines.join("\n") + "\n");
  const config = { runtime: "claude", sessionId: "session-warm", envVars: { RAFT_STARTUP_MEMORY_BLOCK: "0" }, wakeRecycleWarm: true } as unknown as AgentConfig;
  const stopMs = Date.parse(at(90));

  const warm = await planWakeSessionRecycle({ config, hasResumePrompt: false, nowMs: stopMs + 30_000, homeDir: home, processEnv: {}, warmStop: warmStop({ sessionId: "session-warm", stoppedAtMs: stopMs }) });
  const cold = await planWakeSessionRecycle({ config, hasResumePrompt: false, nowMs: stopMs + 3 * HOUR_MS, homeDir: home, processEnv: {} });
  assert.equal(warm.action, "recycle");
  assert.equal(cold.action, "recycle");
  if (warm.action !== "recycle" || cold.action !== "recycle") return;
  assert.equal(warm.reason, "warm_recycle");
  assert.equal(cold.reason, "cold_gap_large_context");
  const warmText = String(warm.briefing);
  const coldText = String(cold.briefing);
  assert.ok(warmText.startsWith(String(buildWarmRecycleNotice())));
  assert.match(warmText, /<last-notes [^\n]*>\n<turn-note written="2026-11-10 10:00:50Z">\n.*Starting the store migration: reader next\.\n<\/turn-note>\n<turn-note written="2026-11-10 10:01:01Z">\n.*Reader ported; store tests next\.\n<\/turn-note>\n<\/last-notes>/);
  assert.match(warmText, /<open-todos written="2026-11-10 10:00:02Z" open="2 of 3"[^\n]*>\n.*- \[in_progress\] port the reader\n.*- \[pending\] run the store tests\n<\/open-todos>/);
  assert.match(warmText, /<recent-actions span="30 of 36" order="oldest first">/);
  assert.doesNotMatch(coldText, /<last-notes|<turn-note|<open-todos|port the reader|Reader ported/);
  assert.match(coldText, /<recent-actions span="12 of 36" order="oldest first">/);

  assert.deepEqual(warm.briefingParts, { memory: false, panel: true });
  assert.equal(
    describeRecycledWakeLogLine("agent-1", warm, "legacy"),
    `[WakeRecycle] recycled: agent agent-1 kind warm, old session session-warm, new session pending, gap 30000ms, band quiet, briefing ${Math.ceil(warmText.length / 4)} tokens (panel yes, memory no) (legacy)`,
  );
  assert.equal(
    describeRecycledWakeLogLine("agent-1", cold, "oar"),
    `[WakeRecycle] recycled: agent agent-1 kind cold, old session session-warm, new session pending, gap ${cold.idleMs}ms, briefing ${Math.ceil(coldText.length / 4)} tokens (panel yes, memory no) (oar)`,
  );
});

test("§6.5: the recycled log line of a plan with nothing added to its briefing says so", () => {
  const cold = decideWakeRecycle(decisionInput());
  assert.equal(cold.action, "recycle");
  if (cold.action !== "recycle") return;
  assert.equal(
    describeRecycledWakeLogLine("agent-1", cold, "legacy"),
    `[WakeRecycle] recycled: agent agent-1 kind cold, old session session-1, new session pending, gap ${cold.idleMs}ms, briefing 0 tokens (panel no, memory no) (legacy)`,
  );
});

test("§6.5: a recycle with nothing added to its briefing is the decision's own plan, and its log line says so", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-bare-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const nowMs = Date.parse("2026-11-10T13:00:00.000Z");
  writeFileSync(path.join(projectDir, "session-bare.jsonl"), JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-10T10:00:00.000Z",
    message: { usage: { input_tokens: 10, cache_read_input_tokens: 299_990, cache_creation_input_tokens: 0 } },
  }) + "\n");
  const config = { runtime: "claude", sessionId: "session-bare", envVars: { RAFT_STARTUP_MEMORY_BLOCK: "0" } } as unknown as AgentConfig;
  const plan = await planWakeSessionRecycle({ config, hasResumePrompt: false, nowMs, homeDir: home, processEnv: {} });
  assert.equal(plan.action, "recycle");
  if (plan.action !== "recycle") return;
  assert.equal(plan.briefingParts, undefined, "no panel (too few actions), no memory block");
  assert.equal(String(plan.briefing), "");
  assert.equal(
    describeRecycledWakeLogLine("agent-1", plan, "legacy"),
    `[WakeRecycle] recycled: agent agent-1 kind cold, old session session-bare, new session pending, gap ${plan.idleMs}ms, briefing 0 tokens (panel no, memory no) (legacy)`,
  );
});
