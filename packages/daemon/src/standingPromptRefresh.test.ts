import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt } from "./drivers/cliTransport";
import {
  applyFreshSessionStandingPrompt,
  applyStandingPromptUpdate,
  planStandingPromptRefresh,
  STANDING_PROMPT_LEDGER_VERSION_WITHOUT_NATIVE,
  STANDING_PROMPT_VOLATILE_FIELDS,
  stableStandingPromptConfig,
  standingPromptGoesInFirstInput,
  standingPromptHash,
  standingPromptRecordForReportedSession,
  standingPromptSessionBinding,
  StandingPromptLedger,
  UNDELIVERED_STANDING_PROMPT_HASH,
} from "./standingPromptRefresh";
import type { AxSurfaceText } from "./agentRuntimeInput";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "standing-prompt-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "agent",
  displayName: "Agent",
  description: "reviews code",
  runtime: "codex",
  model: "gpt-5",
  sessionId: null,
  serverUrl: "http://localhost",
  authToken: "x",
  runtimeContext: { agentId: "a1", serverId: "s1", machineName: "m", machineId: "mid", daemonVersion: "1.0.46", workspacePath: "/w" },
  ...overrides,
} as AgentConfig);
const hashOf = (c: AgentConfig) => standingPromptHash(String(buildCliTransportSystemPrompt(stableStandingPromptConfig(c), { extraCriticalRules: [] })), { nativeStandingPrompt: true });

test("the volatile fields are pinned: adding one is a deliberate change", () => {
  assert.deepEqual([...STANDING_PROMPT_VOLATILE_FIELDS], ["runtimeContext.daemonVersion", "runtimeProfileControl"]);
});

test("the hash ignores the daemon version and the release notice, and follows everything else", () => {
  const base = hashOf(config());
  assert.equal(hashOf(config({ runtimeContext: { ...config().runtimeContext!, daemonVersion: "1.0.47" } })), base, "a release alone is not a new prompt");
  assert.equal(hashOf(config({ runtimeProfileControl: { kind: "daemon_release_notice", key: "k", message: "Daemon v1.0.47 released" } as never })), base, "nor is its notice");
  assert.notEqual(hashOf(config({ description: "reviews code and docs" })), base, "a real change is");
  // The prompt itself still shows the version to a new session.
  assert.match(String(buildCliTransportSystemPrompt(config(), { extraCriticalRules: [] })), /- Daemon: v1\.0\.46/);
});

test("plan: fresh sessions and self-refreshing runtimes need nothing; a resume is checked against its record", () => {
  const ledger = new StandingPromptLedger(dir, () => 5_000);
  const plan = (resumeSessionId: string | null, promptHash: string, refreshesOnResume = false) =>
    planStandingPromptRefresh({ ledger, agentId: "a1", resumeSessionId, refreshesOnResume, promptHash, nowMs: 9_000 });
  assert.deepEqual(plan(null, "h1"), { action: "none" });
  assert.deepEqual(plan("s1", "h1", true), { action: "none" });
  assert.deepEqual(plan("s1", "h1"), { action: "baseline_unknown" }, "no record yet: no injection");
  ledger.write("a1", "s1", "h1");
  assert.deepEqual(plan("s1", "h1"), { action: "unchanged" });
  assert.deepEqual(plan("s1", "h2"), { action: "inject", staleForMs: 4_000 });
  assert.deepEqual(plan("s2", "h2"), { action: "baseline_unknown" }, "a record of another session says nothing about this one");
  const stored = JSON.parse(readFileSync(path.join(dir, ".agent-state", "a1", "standing-prompt.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["promptHash", "recordedAtMs", "sessionId", "version"]);
});

test("an injection puts the full current prompt first, marked as replacing the earlier instructions; nothing else is touched", () => {
  const input = "New message received: hello" as AxSurfaceText;
  assert.deepEqual(applyStandingPromptUpdate({ action: "unchanged" }, "PROMPT", input, "wake"), { prompt: input, promptSource: "wake" });
  const applied = applyStandingPromptUpdate({ action: "inject", staleForMs: 1 }, "PROMPT V2", input, "wake");
  assert.equal(applied.promptSource, "wake_with_standing_prompt_update");
  assert.ok(String(applied.prompt).startsWith("<raft-standing-prompt-update>\n"));
  assert.match(String(applied.prompt), /replace the earlier standing instructions/);
  assert.match(String(applied.prompt), /PROMPT V2\n<\/raft-standing-prompt-update>\n\nNew message received: hello$/);
});

test("without a native standing prompt, a fresh session's first input opens with it; nothing else changes", () => {
  const input = "[Raft inbox notice: 1 message pending]" as AxSurfaceText;
  assert.equal(standingPromptGoesInFirstInput({ nativeStandingPrompt: false, resumeSessionId: null }), true);
  assert.equal(standingPromptGoesInFirstInput({ nativeStandingPrompt: false, resumeSessionId: "s1" }), false, "a resume is the refresh plan's job");
  assert.equal(standingPromptGoesInFirstInput({ nativeStandingPrompt: true, resumeSessionId: null }), false);
  assert.equal(applyFreshSessionStandingPrompt(false, "PROMPT" as AxSurfaceText, input), input);
  assert.equal(applyFreshSessionStandingPrompt(true, "PROMPT" as AxSurfaceText, input), "PROMPT\n\n[Raft inbox notice: 1 message pending]");
});

test("a reported session is recorded as current only if the launch's standing prompt reached it", () => {
  // Feeds each report the binding the previous one returned, as the manager does.
  const reports = (binding: ReturnType<typeof standingPromptSessionBinding>, ...sessionIds: string[]) =>
    sessionIds.map((sessionId) => {
      const reported = standingPromptRecordForReportedSession(binding, sessionId, "h1");
      binding = reported.binding;
      return reported.promptHash;
    });
  // Native: every session the runtime reports carries it.
  const native = standingPromptSessionBinding({ nativeStandingPrompt: true, resumeSessionId: "s1", promptInFirstInput: false });
  assert.deepEqual(reports(native, "s2"), ["h1"]);
  // In the first input: the first session reported got it, a later different one did not.
  const firstInput = standingPromptSessionBinding({ nativeStandingPrompt: false, resumeSessionId: null, promptInFirstInput: true });
  assert.deepEqual(reports(firstInput, "s1", "s1", "s2"), ["h1", "h1", UNDELIVERED_STANDING_PROMPT_HASH]);
  assert.deepEqual(firstInput, { kind: "first_reported", sessionId: null }, "the binding passed in is not modified");
  assert.deepEqual(standingPromptRecordForReportedSession(firstInput, "s9", "h1").binding, { kind: "first_reported", sessionId: "s9" });
  // Not in the input: only the resumed session is on it.
  const resumed = standingPromptSessionBinding({ nativeStandingPrompt: false, resumeSessionId: "s1", promptInFirstInput: false });
  assert.deepEqual(reports(resumed, "s1", "s2"), ["h1", UNDELIVERED_STANDING_PROMPT_HASH]);
  for (const nativeStandingPrompt of [true, false]) {
    assert.notEqual(UNDELIVERED_STANDING_PROMPT_HASH, standingPromptHash("", { nativeStandingPrompt }), "never a real hash");
  }
});

test("ledger version: a runtime without a native standing prompt gets one re-delivery for a record written before it; native records still match", () => {
  const prompt = "PROMPT V1";
  // What every record before STANDING_PROMPT_LEDGER_VERSION_WITHOUT_NATIVE holds: the bare prompt hash.
  const legacyHash = createHash("sha256").update(prompt).digest("hex").slice(0, 32);
  assert.equal(STANDING_PROMPT_LEDGER_VERSION_WITHOUT_NATIVE, 2);
  assert.equal(standingPromptHash(prompt, { nativeStandingPrompt: true }), legacyHash, "native runtimes: unchanged");
  const currentHash = standingPromptHash(prompt, { nativeStandingPrompt: false });
  assert.notEqual(currentHash, legacyHash);

  const ledger = new StandingPromptLedger(dir, () => 5_000);
  const plan = (promptHash: string) =>
    planStandingPromptRefresh({ ledger, agentId: "a-legacy", resumeSessionId: "s1", refreshesOnResume: false, promptHash, nowMs: 9_000 });
  ledger.write("a-legacy", "s1", legacyHash);
  assert.deepEqual(plan(standingPromptHash(prompt, { nativeStandingPrompt: true })), { action: "unchanged" }, "a native session is left alone");
  assert.deepEqual(plan(currentHash), { action: "inject", staleForMs: 4_000 }, "a non-native session gets the prompt once");
  // The re-delivered resume reports its session; the manager records the current hash.
  ledger.write("a-legacy", "s1", currentHash);
  assert.deepEqual(plan(currentHash), { action: "unchanged" }, "and only once");
});

test("which runtimes rebuild the standing prompt on resume is pinned (measured, task #13)", async () => {
  const { PiDriver, BuiltInDriver } = await import("./drivers/pi");
  const { OpenCodeDriver } = await import("./drivers/opencode");
  const { KimiSdkDriver } = await import("./drivers/kimi-sdk");
  const { CodexDriver } = await import("./drivers/codex");
  const { ClaudeDriver } = await import("./drivers/claude");
  const { GrokDriver } = await import("./drivers/grok");
  const { CursorDriver } = await import("./drivers/cursor");
  const { GeminiDriver } = await import("./drivers/gemini");
  const { CopilotDriver } = await import("./drivers/copilot");
  const { KimiDriver } = await import("./drivers/kimi");
  const refreshes = (Driver: unknown) =>
    new (Driver as new () => { standingPromptRefreshesOnResume?: boolean })().standingPromptRefreshesOnResume === true;
  // Fresh on resume: Pi / Built-in (systemPromptOverride), OpenCode 1.18.35 and the Kimi SDK 0.34 (measured).
  for (const Driver of [PiDriver, BuiltInDriver, OpenCodeDriver, KimiSdkDriver]) assert.equal(refreshes(Driver), true, Driver.name);
  // Keep the session's original prompt: Codex >= 0.105, Claude Code 2.1.288 (measured); Grok and the Kimi CLI
  // (system file rewritten every launch) not measured yet; Cursor / Gemini / Copilot have no native standing prompt.
  for (const Driver of [CodexDriver, ClaudeDriver, GrokDriver, KimiDriver, CursorDriver, GeminiDriver, CopilotDriver]) assert.equal(refreshes(Driver), false, Driver.name);
});
