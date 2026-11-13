import assert from "node:assert/strict";
import { getDriver, registeredRuntimeIds, runtimeIdsShippedWithComputer } from "./index";

const runtimeIds = ["builtin", "claude", "codex", "grok", "kimi", "cursor", "gemini", "copilot", "opencode", "pi"] as const;
const stdinSteerablePersistentRuntimeIds = ["claude", "codex", "grok", "kimi"] as const;
const perTurnRuntimeIds = ["cursor", "gemini", "copilot", "opencode"] as const;

const expectedContracts = {
  builtin: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "sticks_to_session" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
  claude: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
    stdinDuringCompaction: true,
  },
  codex: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "structured_protocol",
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
  grok: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "structured_protocol",
    session: { recovery: "resume_or_fresh", compaction: "unreported", compactionFailure: "does_not_stick" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
  kimi: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" },
    modelVerifiedAs: "launchable",
    // #11083: the standing prompt is written to Kimi CLI's own system file.
    nativeStandingPrompt: true,
  },
  cursor: {
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" },
    modelVerifiedAs: "launchable",
  },
  gemini: {
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh", compaction: "unreported", compactionFailure: "does_not_stick" },
    modelVerifiedAs: "suggestion_only",
  },
  copilot: {
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh", compaction: "unreported", compactionFailure: "does_not_stick" },
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
    session: { recovery: "resume_or_fresh", compaction: "unreported", compactionFailure: "does_not_stick" },
    modelVerifiedAs: "launchable",
    nativeStandingPrompt: true,
  },
  pi: {
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    stdoutChannel: "diagnostic",
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "sticks_to_session" },
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

// Glimpse reads whether a runtime reports compaction (session.compaction), and
// the stuck-session guard whether a failed compaction sticks
// (session.compactionFailure), from its driver alone; there is no other list. The type requires it; this
// checks every registered driver answers with a known value at run time too.
test("every registered runtime declares whether it reports compaction, and whether a failed one sticks", () => {
  for (const runtimeId of registeredRuntimeIds()) {
    assert.ok(["reported", "unreported"].includes(getDriver(runtimeId).session.compaction), runtimeId);
    assert.ok(["sticks_to_session", "does_not_stick"].includes(getDriver(runtimeId).session.compactionFailure), runtimeId);
  }
});

// These run as an SDK inside the daemon; every other runtime is a CLI found on
// PATH, whose version the Computer records to notice an older copy picked up
// after a restart (runtimeCliVersionTracker.ts). This pins today's set; it
// cannot notice a new in-process driver that forgets `shipsWithComputer`
// (a Computer downgrade would then report it as an older copy on PATH), so
// add the flag and the id here when adding one.
test("the runtimes that ship with the Computer are the in-process SDK drivers", () => {
  assert.deepEqual([...runtimeIdsShippedWithComputer()].sort(), ["builtin", "kimi-sdk", "pi"]);
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
