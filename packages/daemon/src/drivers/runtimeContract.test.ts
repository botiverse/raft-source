import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { getDriver } from "./index.js";

const runtimeIds = ["builtin", "claude", "codex", "grok", "kimi", "cursor", "gemini", "copilot", "opencode", "pi"] as const;
const stdinSteerablePersistentRuntimeIds = ["claude", "codex", "grok", "kimi"] as const;
const perTurnRuntimeIds = ["cursor", "gemini", "copilot", "opencode"] as const;

const expectedContracts = {
  builtin: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
  claude: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
    stdinDuringCompaction: true,
  },
  codex: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "structured_protocol",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
  grok: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "structured_protocol",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
  kimi: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
  },
  cursor: {
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
  },
  gemini: {
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "suggestion_only",
  },
  copilot: {
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
  },
  opencode: {
    lifecycle: {
      kind: "per_turn",
      start: "defer_until_concrete_message",
      exit: "terminate_on_turn_end",
      inFlightWake: "coalesce_into_pending",
    },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
  pi: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
} as const;

test("built-in runtime contracts match the current driver matrix", () => {
  for (const runtimeId of runtimeIds) {
    const driver = getDriver(runtimeId);
    const expected = expectedContracts[runtimeId];

    assert.deepEqual(driver.lifecycle, expected.lifecycle, runtimeId);
    assert.deepEqual(driver.communication, expected.communication, runtimeId);
    assert.equal(driver.stdoutChannel ?? "diagnostic", expected.stdoutChannel, runtimeId);
    assert.deepEqual(driver.session, expected.session, runtimeId);
    assert.equal(driver.model.detectedModelsVerifiedAs, expected.modelVerifiedAs, runtimeId);
    assert.equal(Boolean(driver.supportsNativeStandingPrompt), "nativeStandingPrompt" in expected && expected.nativeStandingPrompt === true, runtimeId);
    assert.equal(Boolean(driver.acceptsStdinDuringCompaction), "stdinDuringCompaction" in expected && expected.stdinDuringCompaction === true, runtimeId);
  }
});

test("structured contracts preserve daemon delivery behavior", () => {
  for (const runtimeId of runtimeIds) {
    const driver = getDriver(runtimeId);

    if (driver.lifecycle.kind === "persistent") {
      assert.equal(driver.supportsStdinNotification, true, runtimeId);
      assert.equal(driver.busyDeliveryMode, driver.lifecycle.stdin, runtimeId);
    } else {
      assert.equal(driver.supportsStdinNotification, false, runtimeId);
      assert.equal(driver.busyDeliveryMode, "none", runtimeId);
      assert.equal(driver.deferSpawnUntilMessage === true, driver.lifecycle.start === "defer_until_concrete_message", runtimeId);
      assert.equal(driver.terminateProcessOnTurnEnd === true, driver.lifecycle.exit === "terminate_on_turn_end", runtimeId);
    }
  }
});

test("built-in runtimes communicate through slock CLI without a runtime-control bridge", () => {
  for (const runtimeId of runtimeIds) {
    const driver = getDriver(runtimeId);
    assert.deepEqual(driver.communication, { chat: "slock_cli", runtimeControl: "none" }, runtimeId);
  }
});

test("stdin steerable persistent sessions distinguish idle prompt from busy steering", () => {
  for (const runtimeId of stdinSteerablePersistentRuntimeIds) {
    const driver = getDriver(runtimeId);
    const sessionId = `${runtimeId}-session`;

    if (runtimeId === "codex") {
      driver.parseLine(JSON.stringify({ method: "thread/started", params: { thread: { id: sessionId } } }));
    }

    const idleEncoded = driver.encodeStdinMessage("idle prompt", sessionId, { mode: "idle" });
    assert.ok(idleEncoded, `${runtimeId} must accept idle stdin prompt`);

    if (runtimeId === "codex") {
      driver.parseLine(JSON.stringify({
        method: "turn/started",
        params: { threadId: sessionId, turn: { id: `${runtimeId}-turn` } },
      }));
    }

    const busyEncoded = driver.encodeStdinMessage("busy steering", sessionId, { mode: "busy" });
    assert.ok(busyEncoded, `${runtimeId} must accept busy stdin steering`);

    const idle = JSON.parse(idleEncoded!);
    const busy = JSON.parse(busyEncoded!);
    const idleKind = idle.method ?? idle.type;
    const busyKind = busy.method ?? busy.type;

    if (runtimeId === "claude") {
      assert.equal(idleKind, "user", "Claude uses the same native user frame at idle and while busy");
      assert.equal(busyKind, "user", "Claude Code assigns an active-turn user frame to its queued-command path");
    } else {
      assert.match(idleKind, /^(turn\/start|session\/prompt|prompt)$/, `${runtimeId} idle input must start a normal prompt/turn`);
      assert.match(busyKind, /^(turn\/steer|_x\.ai\/interject|steer)$/, `${runtimeId} busy input must steer the active session`);
      assert.notEqual(idleKind, busyKind, `${runtimeId} idle and busy input must not collapse to the same command`);
    }
  }
});

test("Pi SDK session distinguishes idle prompt from busy steering by descriptor", () => {
  const source = readFileSync(new URL("./pi.ts", import.meta.url), "utf8");

  assert.match(source, /transport:\s*"sdk"/);
  assert.match(source, /idle:\s*"sdk_prompt"/);
  assert.match(source, /busy:\s*"sdk_steer"/);
  assert.match(source, /inFlightWake:\s*"steer"/);
  assert.match(source, /busyDelivery:\s*"direct"/);
  assert.match(source, /postTurn:\s*"keep_alive"/);
});

test("per-turn sessions reject live stdin steering", () => {
  for (const runtimeId of perTurnRuntimeIds) {
    const driver = getDriver(runtimeId);

    assert.equal(driver.lifecycle.kind, "per_turn", runtimeId);
    assert.equal(driver.supportsStdinNotification, false, runtimeId);
    assert.equal(driver.busyDeliveryMode, "none", runtimeId);
    assert.equal(driver.encodeStdinMessage("idle prompt", `${runtimeId}-session`, { mode: "idle" }), null, runtimeId);
    assert.equal(driver.encodeStdinMessage("busy steering", `${runtimeId}-session`, { mode: "busy" }), null, runtimeId);
  }
});

test("launchable model contracts expose a model-to-launch-spec round trip", async () => {
  for (const runtimeId of runtimeIds) {
    const driver = getDriver(runtimeId);
    if (driver.model.detectedModelsVerifiedAs !== "launchable") continue;

    const launchSpec = await driver.model.toLaunchSpec?.("example/model");
    assert.ok(launchSpec, runtimeId);
    assert.ok(
      launchSpec.args?.includes("example/model")
        || Object.values(launchSpec.env ?? {}).includes("example/model")
        || Object.values(launchSpec.params ?? {}).includes("example/model"),
      runtimeId,
    );
  }
});

test("agent process manager uses RuntimeSession instead of raw child-process IO", () => {
  const source = readFileSync(new URL("../agentProcessManager.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /node:child_process/);
  assert.doesNotMatch(source, /\bChildProcess\b/);
  assert.doesNotMatch(source, /\.stdin\?\.write/);
  assert.doesNotMatch(source, /\.stdout\?\.on/);
  assert.doesNotMatch(source, /\.stderr\?\.on/);
  assert.doesNotMatch(source, /\.kill\(/);
  assert.doesNotMatch(source, /driver\.encodeStdinMessage/);
  assert.doesNotMatch(source, /transport\s*={2,3}\s*["']child_process["']/);
  assert.doesNotMatch(source, /ap\.driver\.busyDeliveryMode\s*[!=]==/);
  assert.match(source, /createChildProcessRuntimeSession/);
});

test("daemon orphan reaper is the shutdown process-tree signal boundary", () => {
  const apmSource = readFileSync(new URL("../agentProcessManager.ts", import.meta.url), "utf8");
  const reaperSource = readFileSync(new URL("../daemonOrphanReaper.ts", import.meta.url), "utf8");

  assert.match(apmSource, /reapOrphanProcesses\(/);
  assert.match(apmSource, /daemonOrphanReaper\.js/);

  assert.match(reaperSource, /process\.kill\(pid,\s*0\)/);
  assert.match(reaperSource, /process\.kill\(pid,\s*"SIGKILL"\)/);
  assert.match(reaperSource, /daemon\.agent\.stop_all\.survivor_reaped/);
  assert.match(reaperSource, /daemon\.agent\.stop_all\.completed/);
  assert.match(reaperSource, /shutdown process-tree orphan safeguard/i);

  assert.doesNotMatch(reaperSource, /^import\b/m);
  assert.doesNotMatch(reaperSource, /RuntimeSession\s*[<({:]/);
  assert.doesNotMatch(reaperSource, /createChildProcessRuntimeSession/);
  assert.doesNotMatch(reaperSource, /AgentProcessManager/);
});

test("only daemon orphan reaper owns shutdown raw process signals outside RuntimeSession", () => {
  const runtimeSessionSource = readFileSync(new URL("./runtimeSession.ts", import.meta.url), "utf8");
  const apmSource = readFileSync(new URL("../agentProcessManager.ts", import.meta.url), "utf8");
  const reaperSource = readFileSync(new URL("../daemonOrphanReaper.ts", import.meta.url), "utf8");

  assert.match(runtimeSessionSource, /\.kill\(/, "RuntimeSession remains the per-session child-process owner");
  assert.doesNotMatch(apmSource, /\.kill\(/, "AgentProcessManager must not own raw child-process signals");
  assert.match(reaperSource, /\.kill\(/, "DaemonOrphanReaper owns only the shutdown process-tree survivor signal path");
});

test("Pi runtime uses a native SDK RuntimeSession instead of fake child-process IO", () => {
  const source = readFileSync(new URL("./pi.ts", import.meta.url), "utf8");

  assert.match(source, /createSession\(ctx: SpawnContext\): RuntimeSession/);
  assert.match(source, /transport:\s*"sdk"/);
  assert.doesNotMatch(source, /class\s+PiSdkProcess/);
  assert.doesNotMatch(source, /\bPassThrough\b/);
  assert.doesNotMatch(source, /\bWritable\b/);
});
