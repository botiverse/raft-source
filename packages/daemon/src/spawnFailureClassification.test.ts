import assert from "node:assert/strict";
import os from "node:os";
import { classifyRuntimeStartupConfigFailure, classifySpawnFailure, displayHostDir, startFailureActivity } from "./spawnFailureClassification";
import { RuntimeVersionTooOldError } from "./runtimeLaunchVersion";
import {
  AgentProxyBindError,
  RuntimeExecutableNotFoundError,
  RuntimeModelNotFoundError,
  RuntimeSessionNeedsResetError,
  RuntimeSessionRuntimeMismatchError,
} from "./spawnFailureErrors";

test("classifySpawnFailure identifies a known-incompatible runtime CLI version", () => {
  const error = new RuntimeVersionTooOldError({
    runtimeId: "claude",
    displayName: "Claude Code",
    actualVersion: "2.1.59",
    testedGoodVersion: "2.1.220",
  });
  const result = classifySpawnFailure(error);
  assert.equal(result.reason, "runtime_version_too_old");
  assert.equal(result.userMessage, error.message);
});

// task #1120 — feedback 958a8809: Pi threw "Pi model not found: <model>" and the
// text-matching classifier told the user the runtime executable was missing.
// Classification is by typed code now; message text never decides.
test("classifySpawnFailure names a missing model as model_not_found by error code, not as a missing executable", () => {
  const error = new RuntimeModelNotFoundError({ runtimeId: "builtin", model: "deepseek/deepseek-v4-flash-vision-exp" });
  const result = classifySpawnFailure(error);
  assert.equal(result.reason, "model_not_found");
  assert.match(result.userMessage, /deepseek\/deepseek-v4-flash-vision-exp/, "the user message names the model");
  assert.doesNotMatch(result.userMessage, /executable|PATH/i, "must not send the user to reinstall the CLI");
  assert.match(result.userMessage, /renamed or removed/, "a model the runtime dropped (pi 0.86.0 renamed deepseek-v4-flash) is named as such");
  assert.match(result.userMessage, /API key/, "a provider without a key also surfaces as a missing model on pi");
  assert.equal(result.detail, error.message);
  // The same words in an untyped Error are just text: generic fallback, not a model verdict.
  assert.equal(classifySpawnFailure(new Error("Pi model not found: x")).reason, "runtime_spawn_failed");
});

test("classifySpawnFailure decides every known reason by code, never by message text", () => {
  const cases: Array<{ input: unknown; reason: string }> = [
    { input: new RuntimeExecutableNotFoundError({ runtimeId: "codex", message: "Cannot resolve a compatible Codex CLI app-server entry point" }), reason: "runtime_not_found" },
    { input: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }), reason: "runtime_not_found" },
    { input: new AgentProxyBindError("Agent Credential Proxy local proxy failed to bind 127.0.0.1 after 3 attempts"), reason: "agent_proxy_bind_failed" },
    { input: Object.assign(new Error("runner_credential_mint_failed: fetch failed"), { spawnFailureCode: "runner_credential_mint_failed" }), reason: "runner_credential_mint_failed" },
    // Text that used to match by accident now falls through to the generic fallback.
    { input: new Error("spawn claude ENOENT"), reason: "runtime_spawn_failed" },
    { input: new Error("Agent Credential Proxy local proxy failed to bind"), reason: "runtime_spawn_failed" },
    { input: new Error("Provider connection materialization failed (HTTP 503)"), reason: "runtime_spawn_failed" },
    { input: new Error("codex: command not found"), reason: "runtime_spawn_failed" },
    { input: Object.assign(new Error("weird"), { code: "EPERM" }), reason: "runtime_spawn_failed" },
  ];
  for (const specimen of cases) {
    assert.equal(classifySpawnFailure(specimen.input).reason, specimen.reason, String((specimen.input as Error).message));
  }
});

test("task #1242: a runtime_not_found start carries the resolver's lookup verdict, and only a confirmed miss keeps the install copy", () => {
  const install = "Runtime executable not found. Ensure the required CLI is installed and available on PATH.";

  // Confirmed miss: the install guidance stays, and the verdict rides along.
  const missing = classifySpawnFailure(new RuntimeExecutableNotFoundError({ runtimeId: "codex", message: "`codex` was not found on PATH.", reason: "not_on_path" }));
  assert.equal(missing.reason, "runtime_not_found");
  assert.equal(missing.lookupReason, "not_on_path");
  assert.equal(missing.userMessage, install);

  // Undecided lookups are not a missing CLI: the resolver's path-free message is what the owner reads.
  for (const reason of ["lookup_timed_out", "lookup_permission_denied", "lookup_failed"] as const) {
    const message = `The PATH lookup for \`codex\` did not finish within 1000 ms. This is not evidence that codex is missing. (${reason})`;
    const undecided = classifySpawnFailure(new RuntimeExecutableNotFoundError({ runtimeId: "codex", message, reason }));
    assert.equal(undecided.reason, "runtime_not_found", reason);
    assert.equal(undecided.lookupReason, reason);
    assert.equal(undecided.userMessage, message, `${reason}: never "install it"`);
    assert.doesNotMatch(undecided.userMessage, /installed/i);
    assert.deepEqual(startFailureActivity(undecided, "gpt-5").spawnFailure, { reason: "runtime_not_found", lookupReason: reason, message });
  }

  // The verdict is read from the cause too (a wrapped launch error).
  const wrapped = classifySpawnFailure(Object.assign(new Error("wrapped"), {
    code: "runtime_not_found",
    cause: new RuntimeExecutableNotFoundError({ runtimeId: "codex", message: "lookup failed", reason: "lookup_failed" }),
  }));
  assert.equal(wrapped.lookupReason, "lookup_failed");

  // No verdict (plain ENOENT, a reason the wire does not know) → no field, neutral copy: never "install it".
  const neutral = "Could not confirm whether the runtime executable is available on this computer. Retry, or check the Computer's status.";
  for (const noVerdict of [
    new RuntimeExecutableNotFoundError({ runtimeId: "codex", message: "spawn codex ENOENT" }),
    new RuntimeExecutableNotFoundError({ runtimeId: "codex", message: "node unavailable", reason: "node_unavailable" }),
    Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
  ]) {
    const classified = classifySpawnFailure(noVerdict);
    assert.equal(classified.reason, "runtime_not_found", noVerdict.message);
    assert.equal(classified.lookupReason, undefined, noVerdict.message);
    assert.equal(classified.userMessage, neutral, noVerdict.message);
    assert.doesNotMatch(classified.userMessage, /installed/i);
    assert.deepEqual(startFailureActivity(classified, "gpt-5").spawnFailure, { reason: "runtime_not_found", message: noVerdict.message });
  }

  // A resolver that speaks the probe vocabulary (Grok's lookupCommandOnPath) is mapped at this boundary.
  for (const [probeReason, launchReason, installCopy] of [
    ["not_installed", "not_on_path", true],
    ["probe_timeout", "lookup_timed_out", false],
    ["permission_denied", "lookup_permission_denied", false],
    ["probe_failed", "lookup_failed", false],
  ] as const) {
    const message = `The PATH lookup for \`grok\` ended as ${probeReason}.`;
    const classified = classifySpawnFailure(new RuntimeExecutableNotFoundError({ runtimeId: "grok", message, reason: probeReason }));
    assert.equal(classified.lookupReason, launchReason, probeReason);
    assert.equal(classified.userMessage, installCopy ? install : message, probeReason);
    assert.deepEqual(startFailureActivity(classified, null).spawnFailure, { reason: "runtime_not_found", lookupReason: launchReason, message });
  }
  // `unsupported_version` is a probe reason with no lookup meaning: no verdict.
  assert.equal(classifySpawnFailure(new RuntimeExecutableNotFoundError({ runtimeId: "grok", message: "x", reason: "unsupported_version" })).lookupReason, undefined);

  // Other reasons never grow the field, even if the error happens to carry a `reason`.
  const other = classifySpawnFailure(Object.assign(new Error("boom"), { reason: "lookup_timed_out" }));
  assert.equal(other.reason, "runtime_spawn_failed");
  assert.equal(other.lookupReason, undefined);
  assert.deepEqual(startFailureActivity(other, null).spawnFailure, { reason: "runtime_spawn_failed", message: "boom" });
});

test("task #10: a session stuck on compaction is classified session_needs_reset, with the Reset Session way out", () => {
  const classified = classifySpawnFailure(new RuntimeSessionNeedsResetError({ runtimeId: "builtin", failures: 3 }));
  assert.equal(classified.reason, "session_needs_reset");
  assert.match(classified.userMessage, /failed context compaction several times in a row/);
  assert.match(classified.userMessage, /open Restart \/ Reset and choose Reset Session & Restart/);
  assert.deepEqual(startFailureActivity(classified, "deepseek/v4").spawnFailure, { reason: "session_needs_reset", message: classified.detail });
});

test("task #1258: a session made by another runtime major line is session_runtime_mismatch, with Reset Session or the recorded line as the way out", () => {
  const classified = classifySpawnFailure(new RuntimeSessionRuntimeMismatchError({ runtimeId: "opencode", sessionId: "ses_a", reason: "major_mismatch", recordedMajor: 1, installedVersion: "2.0.27" }));
  assert.equal(classified.reason, "session_runtime_mismatch");
  assert.match(classified.userMessage, /created by OpenCode 1\.x and cannot be resumed with the installed OpenCode 2\.0\.27/);
  assert.match(classified.userMessage, /automatic restarts are paused/);
  assert.match(classified.userMessage, /open Restart \/ Reset and choose Reset Session & Restart/);
  assert.match(classified.userMessage, /install the runtime version line the session was created with/);
  assert.deepEqual(startFailureActivity(classified, "opencode/gpt-5-nano").spawnFailure, { reason: "session_runtime_mismatch", message: classified.detail });

  const unknown = classifySpawnFailure(new RuntimeSessionRuntimeMismatchError({ runtimeId: "opencode", sessionId: "ses_a", reason: "unrecorded", recordedMajor: null, installedVersion: "2.0.27" }));
  assert.match(unknown.userMessage, /its major version was not recorded/);
  const unreadable = classifySpawnFailure(new RuntimeSessionRuntimeMismatchError({ runtimeId: "opencode", sessionId: "ses_a", reason: "record_unreadable", recordedMajor: null, installedVersion: "1.19.0" }));
  assert.equal(unreadable.reason, "session_runtime_mismatch");
  assert.match(unreadable.userMessage, /session record is unreadable/);
});

// task #1307: the real header check, classified end to end. The user message
// is Cat's copy and carries neither the key nor where or what the bad
// character is; those stay in the error message for the local log.
test("a provider API key that cannot go in an HTTP header is classified as provider_api_key_invalid with safe copy", async () => {
  const { assertProviderApiKeyIsHeaderSafe } = await import("./drivers/pi");
  const { PROVIDER_API_KEY_INVALID_USER_MESSAGE } = await import("./spawnFailureClassification");
  const secretKey = "sk-live-SECRET\nPASTED-NOTE";
  let thrown: unknown;
  try { assertProviderApiKeyIsHeaderSafe(secretKey, "ANTHROPIC_API_KEY"); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof Error, "the header check must refuse the key");
  const classification = classifySpawnFailure(thrown);
  assert.equal(classification.reason, "provider_api_key_invalid");
  assert.equal(
    classification.userMessage,
    "Couldn't start: there's a problem with the API key. Copy the full key again from your provider's dashboard, save, and retry.",
  );
  assert.equal(classification.userMessage, PROVIDER_API_KEY_INVALID_USER_MESSAGE);
  for (const leak of ["SECRET", "PASTED", "ANTHROPIC_API_KEY", "position", "code 10"]) {
    assert.ok(!classification.userMessage.includes(leak), `user message must not carry ${leak}`);
  }
  assert.match(classification.detail, /position 15, code 10/, "the local log keeps the diagnostic");
  // The local log names the variable, position and character code, never the key.
  for (const part of ["sk-live", "SECRET", "PASTED-NOTE"]) {
    assert.ok(!classification.detail.includes(part), `local detail must not carry ${part}`);
    assert.ok(!String((thrown as Error).message).includes(part), `error message must not carry ${part}`);
  }
  // The activity: the typed reason and the safe text; the carrier's `message`
  // (the agent's managers only, see SpawnFailureActivityDiagnostic) is the
  // local diagnostic, which names the variable and position, never the key.
  const activity = startFailureActivity(classification, "claude-opus-5");
  assert.deepEqual(activity.spawnFailure, { reason: "provider_api_key_invalid", message: classification.detail });
  assert.equal(activity.detail, PROVIDER_API_KEY_INVALID_USER_MESSAGE);
  assert.doesNotMatch(activity.detail, /SECRET|PASTED|position|ANTHROPIC/);
  assert.doesNotMatch(JSON.stringify(activity), /sk-live|SECRET|PASTED/);
});

test("other untyped start errors keep the generic runtime_spawn_failed", () => {
  assert.equal(classifySpawnFailure(new Error("API key contains a bad character")).reason, "runtime_spawn_failed");
});

// #proj-raft-computer:1bfb0122: a missing model in a workspace with Pi code
// Raft no longer loads (#14773) names that as the likely cause, keeps the
// usual way out, and names the Computer's own extension folder. The error's
// text (its fingerprint) stays as it was.
test("a missing model with ignored workspace Pi code names the likely cause, the agent dir, and keeps the usual way out", () => {
  const error = new RuntimeModelNotFoundError({
    runtimeId: "pi", model: "wildwork/noname",
    ignoredWorkspaceCode: [".pi/extensions", ".pi/settings.json packages"], hostExtensionDir: "/srv/pi-agent",
  });
  assert.equal(error.message, "Model wildwork/noname is not available for the pi runtime on this computer");
  const result = classifySpawnFailure(error);
  assert.equal(result.reason, "model_not_found");
  assert.equal(result.userMessage, "Model wildwork/noname is not on this Computer. This agent's workspace has Pi code that Raft no longer loads, for security (.pi/extensions, .pi/settings.json packages). If the model came from there, install that extension or package on the Computer, in its Pi agent folder; otherwise choose another model in the agent's settings.");
  // Without workspace code, or without the folder to name: the old sentence.
  assert.doesNotMatch(classifySpawnFailure(new RuntimeModelNotFoundError({ runtimeId: "pi", model: "x/y" })).userMessage, /workspace/);
  assert.doesNotMatch(classifySpawnFailure(new RuntimeModelNotFoundError({ runtimeId: "pi", model: "x/y", ignoredWorkspaceCode: [".pi/extensions"] })).userMessage, /workspace/);
});

// Tenny's 1.28.0 review: the agent's error is visible to everyone who can see
// the agent, so the folder never shows the Computer user's name.
test("the agent dir in a user message never shows the home folder's path", () => {
  assert.equal(displayHostDir("/home/alice/.pi/agent", "/home/alice"), "~/.pi/agent");
  assert.equal(displayHostDir("/home/alice", "/home/alice"), "its Pi agent folder", "never the home folder itself");
  assert.equal(displayHostDir("/home/alice/..pi", "/home/alice"), "~/..pi", "a folder named ..x is still under home");
  assert.equal(displayHostDir("/home/alicex/.pi/agent", "/home/alice"), "its Pi agent folder");
  assert.equal(displayHostDir("/srv/pi-agent", "/home/alice"), "its Pi agent folder");
  const error = new RuntimeModelNotFoundError({ runtimeId: "pi", model: "w/n", ignoredWorkspaceCode: [".pi/extensions"], hostExtensionDir: `${os.homedir()}/.pi/agent` });
  assert.match(classifySpawnFailure(error).userMessage, /in ~\/\.pi\/agent;/);
  assert.doesNotMatch(classifySpawnFailure(error).userMessage, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a failed start's activity carries the start's own error text, scrubbed and then capped at 300 characters", () => {
  const raw = [
    "spawn failed: C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd and /home/bob/.codex/config.toml",
    "and /Users/carol/.claude.json with key sk-proj-AbCdEfGh12345678ZyXw for dave@example.org",
    "x".repeat(400),
  ].join(" ");
  const classification = classifySpawnFailure(new Error(raw));
  assert.equal(classification.reason, "runtime_spawn_failed");
  assert.equal(classification.detail, raw, "the local log keeps the raw text");
  const activity = startFailureActivity(classification, null);
  const message = activity.spawnFailure.message ?? "";
  assert.equal(message.length, 300);
  assert.ok(message.startsWith("spawn failed: [REDACTED_PATH] and [REDACTED_PATH] and [REDACTED_PATH] with key [REDACTED_TOKEN] for [REDACTED_EMAIL] xxx"), message);
  for (const secret of ["alice", "bob", "carol", "AbCdEfGh", "dave@"]) assert.ok(!message.includes(secret), `${secret} must be gone`);
  // The shown copy is still the fixed one; nothing of the error in it.
  assert.equal(activity.detail, classification.userMessage);
  assert.ok(!activity.detail.includes("spawn failed"));
  // No text of its own: no field.
  assert.equal("message" in startFailureActivity({ reason: "runtime_spawn_failed", detail: "  ", userMessage: "x" }, null).spawnFailure, false);
});

test("classifyRuntimeStartupConfigFailure splits macOS managed-preferences sync (5-try pause) from deterministic config parse errors (1-try pause)", () => {
  // Managed preferences sync: most machines self-recover, so keep runtime_spawn_failed
  // (server pauses after 5 consecutive failures, not attempt 1) with actionable macOS copy.
  const managed = classifyRuntimeStartupConfigFailure("failed to load configuration: Failed to synchronize managed preferences", "codex");
  assert.ok(managed);
  assert.equal(managed.reason, "runtime_spawn_failed");
  assert.equal(managed.errorText, "failed to load configuration: Failed to synchronize managed preferences");
  assert.match(managed.userMessage, /macOS managed preferences/i);
  assert.match(managed.userMessage, /logged-in macOS desktop session/i);
  assert.match(managed.userMessage, /@openai\/codex@0\.156\.1/);

  // Nested cause + multiline OAR processFailure stderr slices from the matching line.
  const multilineNoise = `app-server exited: exit code 1; signal none\nstderr (tail):\n${"noise line\n".repeat(40)}Error: failed to load configuration: Failed to synchronize managed preferences`;
  const wrapped = new Error("Codex app-server initialize failed", { cause: new Error(multilineNoise) });
  const wrappedMatch = classifyRuntimeStartupConfigFailure(wrapped, "codex");
  assert.equal(wrappedMatch?.reason, "runtime_spawn_failed");
  assert.equal(wrappedMatch?.errorText, "Error: failed to load configuration: Failed to synchronize managed preferences");

  // OAR JSON-RPC wrapped native cause object.
  const nativeWrapped = new Error("initialize failed", {
    cause: { native: { code: -32000, message: "failed to load configuration: Failed to synchronize managed preferences" } },
  });
  assert.equal(classifyRuntimeStartupConfigFailure(nativeWrapped, "codex")?.reason, "runtime_spawn_failed");

  // Non-Codex runtime omits the @openai/codex pin hint.
  const other = classifyRuntimeStartupConfigFailure("Failed to synchronize managed preferences", "grok");
  assert.ok(other);
  assert.equal(other.reason, "runtime_spawn_failed");
  assert.doesNotMatch(other.userMessage, /@openai\/codex/);

  // Deterministic TOML/JSON/schema parse errors cannot self-heal: pause on attempt 1.
  const toml = classifyRuntimeStartupConfigFailure(
    "failed to load configuration: TOML parse error at line 3, column 1: expected `=`, found `foo`",
    "codex",
  );
  assert.ok(toml);
  assert.equal(toml.reason, "runtime_config_invalid");
  assert.match(toml.userMessage, /~\/\.codex\/config\.toml/);

  // Split across outer wrapper and inner cause + Rust toml_edit phrasing without literal "TOML parse error".
  const splitCause = new Error("Error loading config.toml", {
    cause: new Error("duplicate key `model` at line 5"),
  });
  assert.equal(classifyRuntimeStartupConfigFailure(splitCause, "codex")?.reason, "runtime_config_invalid");

  // Cyclic cause and primitive/null inputs terminate safely without throwing.
  const cyclic: { message: string; cause?: unknown } = { message: "unrelated failure" };
  cyclic.cause = cyclic;
  assert.equal(classifyRuntimeStartupConfigFailure(cyclic, "codex"), null);
  assert.equal(classifyRuntimeStartupConfigFailure(null, "codex"), null);
  assert.equal(classifyRuntimeStartupConfigFailure(undefined, "codex"), null);
  assert.equal(classifyRuntimeStartupConfigFailure(42, "codex"), null);

  // Transient config load errors (timeout, HTTP status mismatch) must not false-positive as runtime_config_invalid.
  assert.equal(classifyRuntimeStartupConfigFailure("failed to load configuration: connection timed out", "codex"), null);
  assert.equal(classifyRuntimeStartupConfigFailure("failed to load configuration: expected 200, found 503", "codex"), null);
  assert.equal(classifyRuntimeStartupConfigFailure("generic startup error", "codex"), null);
});
