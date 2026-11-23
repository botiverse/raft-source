import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentConfig, RuntimeModelSet } from "@botiverse/raft-shared";
import { buildRuntimeErrorDiagnosticEnvelope } from "../runtimeErrorDiagnostics";
import { recoverableRuntimeProcessCloseReason } from "../runtimeErrorDeliveryPolicy";
import { AntigravityDriver, antigravityLegacyEffort, antigravityModelArgs, buildAntigravityArgs } from "./antigravity";
import type { ParsedEvent, RuntimeDriver, SpawnContext } from "./types";

const ctx = (overrides: Partial<AgentConfig> = {}): SpawnContext => ({
  agentId: "agent-1",
  config: {
    name: "a", displayName: null, description: null, model: "default", runtime: "antigravity", reasoningEffort: null,
    envVars: null, sessionId: null, serverUrl: "http://localhost:3001", authToken: "", ...overrides,
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
} as SpawnContext);

/** The value after `flag`, or undefined when the flag is absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

// ── Model and effort (the legacy fallback ran agy's default model) ──

test("the configured model and effort reach agy as --model and --effort", () => {
  const args = buildAntigravityArgs(ctx({ model: "gemini-3.8-flash", reasoningEffort: "high" }));
  assert.equal(flagValue(args, "--model"), "gemini-3.8-flash");
  assert.equal(flagValue(args, "--effort"), "high");

  const noEffort = buildAntigravityArgs(ctx({ model: "gemini-3.8-flash" }));
  assert.equal(flagValue(noEffort, "--model"), "gemini-3.8-flash");
  assert.equal(noEffort.includes("--effort"), false, "no effort leaves the model's own level");
});

test("agy's default model passes neither flag, as the OAR launch does", () => {
  const args = buildAntigravityArgs(ctx({ model: "default", reasoningEffort: "high" }));
  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("--effort"), false);
  assert.deepEqual(antigravityModelArgs("", "high"), []);
});

test("a combined id is passed verbatim (agy 1.5.9 takes it as it is); an effort set beside it is passed too", () => {
  const combined = buildAntigravityArgs(ctx({ model: "gemini-3.8-flash-high" }));
  assert.equal(flagValue(combined, "--model"), "gemini-3.8-flash-high");
  assert.equal(combined.includes("--effort"), false);

  const both = buildAntigravityArgs(ctx({ model: "gemini-4-hydrogen-xhigh", reasoningEffort: "low" }));
  assert.equal(flagValue(both, "--model"), "gemini-4-hydrogen-xhigh");
  assert.equal(flagValue(both, "--effort"), "low");
  assert.equal(both.filter((arg) => arg === "--model").length, 1);
  assert.equal(both.filter((arg) => arg === "--effort").length, 1);
});

test("#oar-raft:#35: a saved effort the Computer's model list doesn't offer for the model is left out", () => {
  const listed: RuntimeModelSet = {
    models: [
      { id: "gemini-3.8-flash", label: "Flash", verified: "launchable", supportedReasoningEfforts: ["low", "high"] },
      { id: "claude-sonnet-5", label: "Sonnet", verified: "launchable", supportedReasoningEfforts: [] },
      { id: "gemini-4-pro", label: "Pro", verified: "launchable" },
    ],
  };
  const args = (model: string, reasoningEffort: string) =>
    buildAntigravityArgs({ ...ctx({ model, reasoningEffort: reasoningEffort as AgentConfig["reasoningEffort"] }), cachedRuntimeModels: () => listed });

  assert.equal(flagValue(args("gemini-3.8-flash", "high"), "--effort"), "high", "a listed level is passed");
  const offMenu = args("gemini-3.8-flash", "xhigh");
  assert.equal(offMenu.includes("--effort"), false, "a level not on the model's menu is left out");
  assert.equal(flagValue(offMenu, "--model"), "gemini-3.8-flash", "the model is still passed");
  assert.equal(args("claude-sonnet-5", "high").includes("--effort"), false, "an empty menu: the model takes no effort");
  assert.equal(flagValue(args("gemini-4-pro", "high"), "--effort"), "high", "no menu read: passed as before");
  assert.equal(flagValue(args("unlisted-model", "high"), "--effort"), "high", "a model not listed: passed as before");
  assert.equal(flagValue(buildAntigravityArgs(ctx({ model: "claude-sonnet-5", reasoningEffort: "high" })), "--effort"), "high", "no cached list: passed as before");
  assert.equal(antigravityLegacyEffort("claude-sonnet-5", null, listed), null);
});

test("the model contract's launch spec carries the model", async () => {
  const driver = new AntigravityDriver();
  assert.deepEqual(await driver.model.toLaunchSpec?.("example/model"), { args: ["--model", "example/model"] });
  assert.deepEqual(await driver.model.toLaunchSpec?.("gemini-4-hydrogen-xhigh"), { args: ["--model", "gemini-4-hydrogen-xhigh"] });
  assert.deepEqual(await driver.model.toLaunchSpec?.("default"), { args: [] });
});

test("a resumed session still continues agy's conversation, with the model passed again", () => {
  const args = buildAntigravityArgs(ctx({ model: "gemini-3.8-flash", sessionId: "session-1" }));
  assert.ok(args.includes("--continue"));
  assert.equal(flagValue(args, "--model"), "gemini-3.8-flash");
});

// ── stream-json output: readiness at agy's first event, not at the turn's text ──

test("agy runs with stream-json output", () => {
  const args = buildAntigravityArgs(ctx());
  assert.equal(flagValue(args, "--output-format"), "stream-json");
  assert.ok(args.includes("--dangerously-skip-permissions"));
});

/** A driver as spawn() leaves it, without starting agy. */
function startedDriver(sessionId = "session-1"): AntigravityDriver {
  const driver = new AntigravityDriver();
  Object.assign(driver as unknown as { sessionId: string | null }, { sessionId });
  return driver;
}

const INIT = JSON.stringify({
  event: "init",
  conversation_id: "c3b66b04-872b-4fbe-a3a4-058a026ef20a",
  init: { model: "gemini-3.8-flash-high", cwd: "/work/agent-1", tools: ["run_command"], permission_mode: "bypass" },
});
const step = (stepUpdate: Record<string, unknown>) => JSON.stringify({
  event: "step_update",
  step_update: { conversation_id: "c3b66b04-872b-4fbe-a3a4-058a026ef20a", ...stepUpdate },
});
const result = (fields: Record<string, unknown>) => JSON.stringify({
  event: "result",
  result: { conversation_id: "c3b66b04-872b-4fbe-a3a4-058a026ef20a", duration_seconds: 7, num_turns: 1, usage: {}, ...fields },
});

test("the init event is the start's first event (startup readiness), before any model text", () => {
  const driver = startedDriver();
  // first_event readiness: any parsed event ends the start; session_init is the first one.
  assert.equal((driver as RuntimeDriver).startupReadiness ?? "first_event", "first_event");
  assert.deepEqual(driver.parseLine(INIT), [{ kind: "session_init", sessionId: "session-1" }]);
  // Announced once.
  const next = driver.parseLine(step({ step_index: 0, state: "DONE", step_type: "user_input" }));
  assert.equal(next.some((event) => event.kind === "session_init"), false);
  assert.deepEqual(next, [{ kind: "internal_progress", source: "antigravity_stream_event", itemType: "user_input" }]);
});

test("a turn's stream: text deltas, a tool step reported once, and the result's turn end", () => {
  const driver = startedDriver();
  const events: ParsedEvent[] = [
    INIT,
    // agy 1.5.9: ACTIVE steps carry the chunks, the DONE step the final one.
    step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Let me " }),
    step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "check" }),
    step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: ".", duration_seconds: 1.2 }),
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } } }),
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } } }),
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", output: "hi" } }),
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", output: "hi" } }),
    result({ status: "SUCCESS", response: "Let me check." }),
  ].flatMap((line) => driver.parseLine(line));

  assert.deepEqual(events.filter((event) => event.kind !== "internal_progress"), [
    { kind: "session_init", sessionId: "session-1" },
    { kind: "text", text: "Let me " },
    { kind: "text", text: "check" },
    { kind: "text", text: "." },
    { kind: "tool_call", name: "run_command", input: { CommandLine: "echo hi" }, callId: "step-2" },
    { kind: "tool_output", name: "run_command", callId: "step-2", ok: true },
    // The streamed answer is not repeated from `result.response`.
    { kind: "turn_end", sessionId: "session-1" },
  ]);
  // The full text once, in order: what `result.response` reports.
  const text = events.flatMap((event) => event.kind === "text" ? [event.text] : []).join("");
  assert.equal(text, "Let me check.");
});

test("a failed tool step's output is not ok", () => {
  const driver = startedDriver();
  driver.parseLine(INIT);
  const events = driver.parseLine(step({
    step_index: 3, state: "DONE", step_type: "tool", tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "false" }, error: { type: "EXIT", message: "exit 1" } },
  }));
  assert.deepEqual(events, [
    { kind: "tool_call", name: "run_command", input: { CommandLine: "false" }, callId: "step-3" },
    { kind: "tool_output", name: "run_command", callId: "step-3", ok: false },
  ]);
});

test("a result whose answer was not streamed carries it as text", () => {
  const driver = startedDriver();
  driver.parseLine(INIT);
  assert.deepEqual(driver.parseLine(result({ status: "SUCCESS", response: "Done." })), [
    { kind: "text", text: "Done." },
    { kind: "turn_end", sessionId: "session-1" },
  ]);
});

test("a failed result is a runtime error; a Go request EOF in it is a retryable connection error", () => {
  const driver = startedDriver();
  driver.parseLine(INIT);
  const events = driver.parseLine(result({
    status: "ERROR",
    response: "",
    error: 'Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF',
  }));
  assert.equal(events.at(-1)?.kind, "turn_end");
  const error = events.find((event) => event.kind === "error");
  assert.ok(error && error.kind === "error");
  assert.match(error.message, /^Antigravity error: Post "https:\/\/.*": EOF$/);
  assert.equal(buildRuntimeErrorDiagnosticEnvelope(error.message).spanAttrs.runtime_error_class, "ProviderConnectionError");

  const invalidModel = startedDriver().parseLine(result({ status: "ERROR", response: "", error: "invalid model selection" }));
  assert.ok(invalidModel.some((event) => event.kind === "error" && event.message === "Antigravity error: invalid model selection"));

  const noDetail = startedDriver().parseLine(result({ status: "INVALID" }));
  assert.ok(noDetail.some((event) => event.kind === "error" && /status INVALID/.test(event.message)));
});

test("a result's error object is read by its message, so a Go request EOF in it is retryable", () => {
  const driver = startedDriver();
  driver.parseLine(INIT);
  const events = driver.parseLine(result({
    status: "ERROR",
    response: "",
    error: { type: "MODEL_REQUEST", message: 'Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF' },
  }));
  const error = events.find((event) => event.kind === "error");
  assert.ok(error && error.kind === "error");
  assert.equal(error.message, 'Antigravity error: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF');
  assert.equal(recoverableRuntimeProcessCloseReason(error.message, null, null), "provider_connection_error");
  assert.equal(events.at(-1)?.kind, "turn_end");

  // An error object without a message falls back to the status.
  const opaque = startedDriver().parseLine(result({ status: "ERROR", error: { type: "UNKNOWN" } }));
  assert.ok(opaque.some((event) => event.kind === "error" && /status ERROR/.test(event.message)));
});

test("an unknown event is progress, unless it carries an error", () => {
  const driver = startedDriver();
  driver.parseLine(INIT);
  assert.deepEqual(driver.parseLine(JSON.stringify({ event: "heartbeat", conversation_id: "c" })), [
    { kind: "internal_progress", source: "antigravity_stream_event", itemType: "heartbeat" },
  ]);
  assert.deepEqual(driver.parseLine(JSON.stringify({ event: "warning", error: "quota nearly used" })), [
    { kind: "error", message: "Antigravity error: quota nearly used" },
  ]);
  const eof = driver.parseLine(JSON.stringify({ event: "fatal", error: { message: 'Post "https://example.test/v1:x": EOF' } }));
  assert.deepEqual(eof, [{ kind: "error", message: 'Antigravity error: Post "https://example.test/v1:x": EOF' }]);
  assert.equal(buildRuntimeErrorDiagnosticEnvelope(eof[0]!.kind === "error" ? eof[0]!.message : "").spanAttrs.runtime_error_class, "ProviderConnectionError");
});

test("a canceled result ends the turn without an error of its own", () => {
  const driver = startedDriver();
  driver.parseLine(INIT);
  assert.deepEqual(driver.parseLine(result({ status: "CANCELED", response: "" })), [{ kind: "turn_end", sessionId: "session-1" }]);
});

test("a line outside the stream keeps the plain-text handling", () => {
  const driver = startedDriver();
  assert.deepEqual(driver.parseLine("Error: Please sign in to continue."), [
    { kind: "session_init", sessionId: "session-1" },
    { kind: "error", message: "Error: Please sign in to continue." },
  ]);
  assert.deepEqual(driver.parseLine("{not json"), [{ kind: "text", text: "{not json" }]);
  // JSON without agy's `event` field is not a stream event.
  assert.deepEqual(driver.parseLine('{"note":"x"}'), [{ kind: "text", text: '{"note":"x"}' }]);
});
