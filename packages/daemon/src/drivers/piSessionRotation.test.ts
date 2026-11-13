import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
  RUNTIME_CONFIG_VERSION,
  type AgentConfig,
  type ModelLimits,
} from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core";
import { COMPACTION_END, compactedSession, FakePiSession } from "../testing/fakePiSession";
import { withFifos } from "../testing/fifo";
import { traceRows } from "../testing/traceRows";
import { buildBuiltInAgentDir, buildBuiltInSessionDir, BuiltInDriver, createPiAgentSessionForContext, openPiAgentSessionForContext, PiSdkRuntimeSession, PiSdkSessionHandle } from "./pi";
import { piSessionMemoryAttrs } from "./piSessionMemory";
import { buildPiSessionSeed } from "./piSessionSeed";
import { resolveRuntimeSessionRefDetailed } from "./runtimeArtifacts";
import {
  DEFAULT_PI_SESSION_ROTATION_MIN_BYTES,
  newestPiSessionFile,
  PI_DAEMON_EXTENSION_NAME,
  piSessionSeedRefusalTraceAttrs,
  resolvePiSessionRotationConfig,
  undoPiSessionRotationFiles,
  writePiSessionRotationFiles,
  type PiSessionRotationFs,
} from "./piSessionRotation";
import type { ParsedEvent, RuntimeSessionRotationHold, SpawnContext } from "./types";
import { answerGatewayModelListRead } from "../testing/gatewayModelListProbe";

// The file steps' renames and removals, failable per test (pass-through otherwise).
const fsFaults = vi.hoisted(() => ({ rename: null as ((from: string, to: string) => void) | null, rm: null as ((file: string) => void) | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => { fsFaults.rename?.(from, to); actual.renameSync(from, to); },
    rmSync: (file: string, options?: Parameters<typeof actual.rmSync>[1]) => { fsFaults.rm?.(file); actual.rmSync(file, options); },
  };
});
afterEach(() => {
  fsFaults.rename = null;
  fsFaults.rm = null;
});

// Rotation is the dispose-and-resume of a live pi session onto a seed file.
// These tests run the real PiSdkRuntimeSession and real pi SessionManagers on
// disk; only the AgentSession around each manager is a stand-in, so a test can
// say when a compaction ended and whether pi is idle.

const SESSION_ID = "pi-rotation-test";
const DAEMON_EXTENSION = { path: `<inline:${PI_DAEMON_EXTENSION_NAME}>` };

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-session-rotation-"));
  onTestFinished(() => {
    chmodSync(path.join(root, ".pi-sessions"), 0o755);
    rmSync(root, { recursive: true, force: true });
  });
  const sessionDir = path.join(root, ".pi-sessions");
  mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir };
}

interface HarnessOptions {
  flag?: boolean;
  envVars?: Record<string, string>;
  before?: (sm: SessionManager) => void;
  /** Resume (every open after the first): throw, or wait for the returned promise. */
  resume?: () => Promise<void>;
  /** task #1357 item 1: the limits the spawn registered, carried by every handle, and the config's revision. */
  modelLimits?: ModelLimits;
  configRevision?: number;
}

async function harness(options: HarnessOptions = {}) {
  const { root, sessionDir } = workspace();
  const original = compactedSession(sessionDir, root, SESSION_ID, options.before);
  const oldFile = original.getSessionFile()!;
  const sink = new MemoryTraceSink();
  const opened: FakePiSession[] = [];
  const config = {
    name: "rotation", displayName: null, description: null, runtime: "pi", serverUrl: "https://slock.example", authToken: "t",
    sessionId: SESSION_ID, model: "anthropic/claude-sonnet", reasoningEffort: null, runtimeContext: null,
    envVars: { RAFT_PI_SESSION_ROTATION_MIN_BYTES: "1", ...options.envVars },
    piSessionRotation: options.flag ?? true,
    ...(options.configRevision !== undefined ? { configRevision: options.configRevision } : {}),
  } as AgentConfig;
  const ctx: SpawnContext = {
    agentId: "agent-rotation", standingPrompt: "standing", prompt: "wake", workingDirectory: root, slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "x", launchId: "launch-rotation",
    // The production layering: attrs outside DAEMON_CORE_TRACE_ATTR_CONTRACTS are dropped.
    tracer: createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS),
    config,
  };
  // The production contract: reopen opens the newest file of the id, then disposes the old session.
  const handleOf = (session: FakePiSession): PiSdkSessionHandle => new PiSdkSessionHandle(session as unknown as AgentSession, async () => {
    await options.resume?.();
    const file = newestPiSessionFile(sessionDir, session.sessionId);
    assert.ok(file, "a resume finds a session file");
    opened.push(new FakePiSession(SessionManager.open(file, sessionDir, root)));
    session.dispose();
    return handleOf(opened.at(-1)!);
  }, options.modelLimits ?? null);
  let spawns = 0;
  const runtime = new PiSdkRuntimeSession(ctx, () => undefined, async () => {
    spawns += 1;
    opened.push(new FakePiSession(original));
    return handleOf(opened[0]!);
  });
  const events: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => events.push(event));
  await runtime.start({ text: "wake" });
  await settle();
  // The seed's file name must sort after the old one's (millisecond timestamps).
  await new Promise((resolve) => setTimeout(resolve, 5));
  const live = () => opened.at(-1)!;
  return {
    runtime, sessionDir, oldFile, opened, events, live, spawns: () => spawns,
    rows: () => traceRows(sink).filter((row) => row.name.startsWith("pi.session.")).map((row) => {
      const { status: _status, ...attrs } = (row.attrs ?? {}) as Record<string, unknown>;
      return { name: row.name, attrs };
    }),
    /** pi finishes a compaction and the run settles. */
    compact: () => {
      live().emit(COMPACTION_END);
      live().emit({ type: "agent_settled", aborted: false });
    },
    /** What APM does at a turn end. */
    turnEnd: async (hold: () => RuntimeSessionRotationHold | null = () => null) => {
      runtime.rotateSessionIfDue(hold);
      await settle();
    },
  };
}

const IDENTITY = { agentId: "agent-rotation", launchId: "launch-rotation", runtime: "pi" };

test("a due rotation writes the seed under the same id, retires the old file, disposes the old session and resumes the seed", async () => {
  const h = await harness();
  const old = h.live();
  const entriesBefore = old.sessionManager.getEntryCount();
  const bytesBefore = statSync(h.oldFile).size;
  const oldContext = JSON.stringify(old.sessionManager.buildSessionContext());

  h.compact();
  await h.turnEnd();

  assert.equal(h.opened.length, 2, "resumed once");
  assert.equal(h.spawns(), 1, "the spawn path did not run again");
  assert.equal(old.disposed, true, "the old session (and its SessionManager) is let go");
  assert.equal(existsSync(h.oldFile), false);
  assert.equal(existsSync(`${h.oldFile}.rotated`), true, "the old file is kept as .rotated");
  const resumed = h.live().sessionManager;
  const seedFile = resumed.getSessionFile()!;
  assert.equal(newestPiSessionFile(h.sessionDir, SESSION_ID), seedFile);
  assert.match(path.basename(seedFile), new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z_${SESSION_ID}\\.jsonl$`));
  assert.ok(path.basename(seedFile) > path.basename(h.oldFile));
  assert.equal(resumed.getSessionId(), SESSION_ID);
  assert.equal(resumed.getHeader()?.parentSession, `${h.oldFile}.rotated`);
  assert.equal(JSON.stringify(resumed.buildSessionContext()), oldContext, "the resumed session rebuilds the same model context");
  assert.equal(h.runtime.currentSessionId, SESSION_ID);
  assert.deepEqual(
    h.events.filter((event) => event.kind === "session_init"),
    [{ kind: "session_init", sessionId: SESSION_ID }],
    "the id is unchanged: nothing to announce again",
  );
  assert.deepEqual(h.rows(), [{
    name: "pi.session.rotated",
    attrs: {
      ...IDENTITY,
      entries_before: entriesBefore,
      bytes_before: bytesBefore,
      entries_after: resumed.getEntryCount(),
      bytes_after: statSync(seedFile).size,
    },
  }]);
  assert.ok(resumed.getEntryCount() < entriesBefore);

  // Input after the rotation reaches the resumed session.
  assert.deepEqual(h.runtime.send({ mode: "idle", text: "after" }), { ok: true, acceptedAs: "prompt" });
  await settle();
  assert.deepEqual(h.live().prompts, ["after"]);
  assert.deepEqual(old.prompts, ["wake"]);
});

test("task #1357: the start and a rotation's reopen each report the spawn's registered limits with its config revision", async () => {
  const modelLimits: ModelLimits = {
    contextWindow: { value: 200_000, source: "raft_default" },
    maxTokens: { value: 8192, source: "raft_default" },
  };
  const h = await harness({ modelLimits, configRevision: 7 });
  const reports = () => h.events.filter((event) => event.kind === "model_limits");
  assert.deepEqual(reports(), [{ kind: "model_limits", sessionId: SESSION_ID, configRevision: 7, modelLimits }], "the start reports once");

  h.compact();
  await h.turnEnd();
  assert.equal(h.opened.length, 2, "resumed once");
  assert.deepEqual(reports(), [
    { kind: "model_limits", sessionId: SESSION_ID, configRevision: 7, modelLimits },
    { kind: "model_limits", sessionId: SESSION_ID, configRevision: 7, modelLimits },
  ], "the reopened session reports again: same spawn, same registration, same revision");
});

test("task #1357: a session without registered limits (not a gateway custom model) reports none", async () => {
  const h = await harness({ configRevision: 3 });
  assert.deepEqual(h.events.filter((event) => event.kind === "model_limits"), []);
});

test("a rotation writes one content-free session_rotated record to the session's lifecycle diagnostics", async () => {
  const h = await harness();
  const entriesBefore = h.live().sessionManager.getEntryCount();
  const bytesBefore = statSync(h.oldFile).size;
  const lifecycleFile = path.join(path.dirname(h.sessionDir), ".slock", "runtime-sessions", `pi-${SESSION_ID}.jsonl`);
  const rotatedRecords = () => (existsSync(lifecycleFile) ? readFileSync(lifecycleFile, "utf8").trim().split("\n") : [])
    .map((line) => JSON.parse(line) as { type: string; sessionId: string; launchId: string; event: { kind: string } })
    .filter((record) => record.type === "runtime_lifecycle" && record.event.kind === "session_rotated");
  assert.deepEqual(rotatedRecords(), [], "nothing before the rotation");

  h.compact();
  await h.turnEnd();

  const seedFile = h.live().sessionManager.getSessionFile()!;
  const records = rotatedRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.sessionId, SESSION_ID, "one lifecycle file: the id does not change");
  assert.equal(records[0]!.launchId, "launch-rotation");
  assert.deepEqual(records[0]!.event, {
    kind: "session_rotated",
    fromFile: `${path.basename(h.oldFile)}.rotated`,
    toFile: path.basename(seedFile),
    entriesBefore,
    bytesBefore,
    entriesAfter: h.live().sessionManager.getEntryCount(),
    bytesAfter: statSync(seedFile).size,
  });

  // The seed pi wrote names the file it continues: the diagnostics follow it.
  const root = path.dirname(h.sessionDir);
  const resolved = resolveRuntimeSessionRefDetailed("pi", SESSION_ID, root, undefined, { workingDirectory: root });
  assert.equal(resolved.ref.path, seedFile);
  assert.deepEqual(resolved.sessionChain, { earlier: [`${h.oldFile}.rotated`], end: "root" });
});

test("a rotation that fails records no session_rotated", async () => {
  const h = await harness({ resume: async () => { throw new Error("reopen failed"); } });
  h.compact();
  await h.turnEnd();
  const lifecycleFile = path.join(path.dirname(h.sessionDir), ".slock", "runtime-sessions", `pi-${SESSION_ID}.jsonl`);
  assert.ok(!readFileSync(lifecycleFile, "utf8").includes("session_rotated"));
  assert.equal(h.rows().at(-1)?.name, "pi.session.rotation_failed");
});

test("a turn end without a compaction since the last rotation does not rotate again", async () => {
  const h = await harness();
  h.compact();
  await h.turnEnd();
  assert.equal(h.opened.length, 2);

  h.live().emit({ type: "agent_settled", aborted: false });
  await h.turnEnd();
  assert.equal(h.opened.length, 2, "no compaction since the rotation");

  await new Promise((resolve) => setTimeout(resolve, 5));
  h.compact();
  await h.turnEnd();
  assert.equal(h.opened.length, 3, "the next compaction makes it due again");
  assert.deepEqual(h.rows().map((row) => row.name), ["pi.session.rotated", "pi.session.rotated"]);
});

test("only a compaction that ended for good and then settled makes a rotation due", async () => {
  const h = await harness();
  h.live().emit({ ...COMPACTION_END, willRetry: true });
  h.live().emit({ type: "agent_settled", aborted: false });
  await h.turnEnd();
  h.live().emit({ ...COMPACTION_END, result: undefined, errorMessage: "failed" });
  h.live().emit({ type: "agent_settled", aborted: false });
  await h.turnEnd();
  h.live().emit(COMPACTION_END);
  await h.turnEnd();
  assert.equal(h.opened.length, 1, "retrying, failed, or not settled yet");
  assert.deepEqual(h.rows(), []);

  h.live().emit({ type: "agent_settled", aborted: false });
  await h.turnEnd();
  assert.equal(h.opened.length, 2);
});

for (const [label, options] of [
  ["the server flag is off", { flag: false }],
  ["the local off switch is set", { envVars: { RAFT_PI_SESSION_ROTATION: "0" } }],
] as const) {
  test(`no rotation and no events when ${label}`, async () => {
    const h = await harness(options);
    h.compact();
    await h.turnEnd();
    assert.equal(h.opened.length, 1);
    assert.equal(existsSync(h.oldFile), true);
    assert.deepEqual(h.rows(), []);
  });
}

test("below the size threshold: skipped with the sizes, and not retried before the next compaction", async () => {
  const h = await harness({ envVars: { RAFT_PI_SESSION_ROTATION_MIN_BYTES: String(10 * 1024 * 1024) } });
  h.compact();
  await h.turnEnd();
  await h.turnEnd();
  assert.equal(h.opened.length, 1);
  assert.equal(existsSync(h.oldFile), true);
  assert.deepEqual(h.rows(), [{
    name: "pi.session.rotation_skipped",
    attrs: { ...IDENTITY, reason: "below_threshold", session_bytes: statSync(h.oldFile).size, min_bytes: 10 * 1024 * 1024 },
  }]);
});

test("a session with a user extension is skipped, whatever the extension", async () => {
  const h = await harness();
  h.live().extensions = [DAEMON_EXTENSION, { path: "/home/user/.pi/agent/extensions/codemode/index.ts" }];
  h.compact();
  await h.turnEnd();
  assert.equal(h.opened.length, 1);
  assert.equal(existsSync(h.oldFile), true);
  assert.deepEqual(h.rows(), [{ name: "pi.session.rotation_skipped", attrs: { ...IDENTITY, reason: "user_extension", user_extension_count: 1 } }]);
});

test("a hold from the daemon or a busy pi session keeps the rotation due until a turn end without one", async () => {
  const h = await harness();
  h.compact();
  for (const hold of ["agent_busy", "delivery_in_flight", "mention_in_flight"] as const) {
    await h.turnEnd(() => hold);
  }
  const busy: Array<[keyof FakePiSession, unknown]> = [["pendingMessageCount", 1], ["isIdle", false], ["isRetrying", true]];
  for (const [key, value] of busy) {
    const session = h.live() as unknown as Record<string, unknown>;
    const saved = session[key];
    session[key] = value;
    await h.turnEnd();
    session[key] = saved;
  }
  assert.equal(h.opened.length, 1, "nothing rotated under a hold");
  assert.equal(existsSync(h.oldFile), true);
  assert.deepEqual(h.rows().map((row) => row.attrs.reason), [
    "agent_busy", "delivery_in_flight", "mention_in_flight", "runtime_busy", "runtime_busy", "runtime_busy",
  ]);

  await h.turnEnd();
  assert.equal(h.opened.length, 2);
  assert.equal(h.rows().at(-1)?.name, "pi.session.rotated");
});

test("the hold is read when the rotation runs, after the turn end that offered it", async () => {
  const h = await harness();
  h.compact();
  let hold: RuntimeSessionRotationHold | null = null;
  h.runtime.rotateSessionIfDue(() => hold);
  // A mention lands between the turn end and the rotation.
  hold = "mention_in_flight";
  await settle();
  assert.equal(h.opened.length, 1);
  assert.deepEqual(h.rows().map((row) => row.attrs.reason), ["mention_in_flight"]);
});

test("an input sent in the same tick as the turn end holds the rotation, and reaches the live session", async () => {
  const h = await harness();
  const old = h.live();
  h.compact();
  h.runtime.rotateSessionIfDue(() => null);
  assert.deepEqual(h.runtime.send({ mode: "idle", text: "same tick" }), { ok: true, acceptedAs: "prompt" });
  await settle();
  assert.equal(h.opened.length, 1, "not rotated under the input");
  assert.equal(old.disposed, false);
  assert.deepEqual(old.prompts, ["wake", "same tick"]);
  assert.deepEqual(h.rows().map((row) => row.attrs.reason), ["runtime_busy"]);
  await h.turnEnd();
  assert.equal(h.opened.length, 2, "still due, and rotated at the next turn end");
});

test("a session that cannot be reopened is never rotated", async () => {
  const { root, sessionDir } = workspace();
  const session = new FakePiSession(compactedSession(sessionDir, root, SESSION_ID));
  const runtime = new PiSdkRuntimeSession({
    agentId: "agent-rotation", standingPrompt: "standing", prompt: "wake", workingDirectory: root, slockCliPath: "/tmp/slock-cli.js", daemonApiKey: "x",
    config: {
      name: "rotation", displayName: null, description: null, runtime: "pi", serverUrl: "https://slock.example", authToken: "t",
      sessionId: SESSION_ID, model: "anthropic/claude-sonnet", reasoningEffort: null, runtimeContext: null,
      envVars: { RAFT_PI_SESSION_ROTATION_MIN_BYTES: "1" }, piSessionRotation: true,
    },
  }, () => undefined, async () => session as unknown as AgentSession);
  await runtime.start({ text: "wake" });
  await settle();
  session.emit(COMPACTION_END);
  session.emit({ type: "agent_settled", aborted: false });
  runtime.rotateSessionIfDue(() => null);
  await settle();
  assert.equal(session.disposed, false);
  assert.equal(readdirSync(sessionDir).length, 1);
});

test("a refused seed records why, with a custom type only in a short identifier shape", async () => {
  for (const [customType, recorded] of [["codemode-store", "codemode-store"], ["a type/with spaces", "other"]] as const) {
    const h = await harness({ before: (sm) => sm.appendCustomEntry(customType, { n: 1 }) });
    h.compact();
    await h.turnEnd();
    assert.equal(h.opened.length, 1);
    assert.equal(existsSync(h.oldFile), true, "nothing written");
    assert.deepEqual(h.rows(), [{
      name: "pi.session.rotate_refused",
      attrs: { ...IDENTITY, reason: "unknown_custom_type", custom_type: recorded, session_bytes: statSync(h.oldFile).size },
    }]);
  }
  assert.deepEqual(piSessionSeedRefusalTraceAttrs({ rotatable: false, reason: "unknown_custom_type", customType: "x".repeat(65) }), { reason: "unknown_custom_type", custom_type: "other" });
  assert.deepEqual(piSessionSeedRefusalTraceAttrs({ rotatable: false, reason: "unknown_custom_type", customType: "pi.Codemode_store-1" }), { reason: "unknown_custom_type", custom_type: "pi.Codemode_store-1" });
  assert.deepEqual(piSessionSeedRefusalTraceAttrs({ rotatable: false, reason: "no_compaction" }), { reason: "no_compaction" });
});

test("a failure before the old file is renamed leaves the old session running on it", async () => {
  const h = await harness();
  const old = h.live();
  const before = readFileSync(h.oldFile, "utf8");
  chmodSync(h.sessionDir, 0o555);
  try {
    h.compact();
    await h.turnEnd();
  } finally {
    chmodSync(h.sessionDir, 0o755);
  }
  assert.equal(h.opened.length, 1);
  assert.equal(old.disposed, false);
  assert.equal(readFileSync(h.oldFile, "utf8"), before);
  assert.equal(newestPiSessionFile(h.sessionDir, SESSION_ID), h.oldFile);
  assert.deepEqual(h.rows(), [{ name: "pi.session.rotation_failed", attrs: { ...IDENTITY, stage: "write_seed", outcome: "kept_old", error_class: "Error", error_code: "EACCES" } }]);
  h.runtime.send({ mode: "idle", text: "still here" });
  await settle();
  assert.deepEqual(old.prompts, ["wake", "still here"]);
});

test("the old file cannot be renamed nor the seed removed: reported, and the live session follows the seed a resume would open", async () => {
  const h = await harness();
  const old = h.live();
  const busy = () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
  fsFaults.rename = (_from, to) => { if (to.endsWith(".rotated")) busy(); };
  fsFaults.rm = (file) => { if (file.endsWith(".jsonl")) busy(); };
  h.compact();
  await h.turnEnd();
  assert.deepEqual(h.rows(), [{ name: "pi.session.rotation_failed", attrs: { ...IDENTITY, stage: "rename_old", outcome: "resumed_seed", error_class: "Error", error_code: "EBUSY" } }]);
  assert.equal(existsSync(h.oldFile), true, "the old file is still there");
  const seedFile = newestPiSessionFile(h.sessionDir, SESSION_ID)!;
  assert.notEqual(seedFile, h.oldFile);
  assert.equal(old.disposed, true);
  assert.equal(h.live().sessionManager.getSessionFile(), seedFile, "the live session runs on what a resume opens");
});

test("a resume that fails undoes the files and keeps the old session, which gets the input queued meanwhile", async () => {
  let fail!: (error: Error) => void;
  const resumeGate = new Promise<void>((_resolve, reject) => { fail = reject; });
  const h = await harness({ resume: () => resumeGate });
  const old = h.live();
  const oldBytes = readFileSync(h.oldFile);
  h.compact();
  await h.turnEnd();
  assert.equal(existsSync(`${h.oldFile}.rotated`), true, "precondition: the files were rotated");
  // An inbox delivery during the reopen: accepted, so APM counts it as told.
  assert.deepEqual(h.runtime.send({ mode: "idle", text: "during a failing resume" }), { ok: true, acceptedAs: "prompt" });
  fail(new Error("resume broke"));
  await settle();

  assert.equal(h.runtime.closed, false, "the runtime goes on");
  assert.equal(old.disposed, false);
  assert.deepEqual(old.prompts, ["wake", "during a failing resume"], "the queued input reached the live session");
  assert.equal(newestPiSessionFile(h.sessionDir, SESSION_ID), h.oldFile, "a resume opens the old file again");
  assert.equal(existsSync(`${h.oldFile}.rotated`), false);
  assert.equal(readFileSync(h.oldFile, "utf8").startsWith(oldBytes.toString("utf8")), true, "the old file kept its entries");
  assert.deepEqual(h.rows(), [{ name: "pi.session.rotation_failed", attrs: { ...IDENTITY, stage: "resume", outcome: "kept_old", error_class: "Error" } }]);
});

test("a resume that fails and cannot be undone ends the runtime; the next start resumes the seed", async () => {
  const h = await harness({ resume: async () => { throw new Error("resume broke"); } });
  const oldContext = JSON.stringify(h.live().sessionManager.buildSessionContext());
  const exits: unknown[] = [];
  h.runtime.on("exit", (info) => exits.push(info));
  // The undo renames `.rotated` back: that rename fails.
  fsFaults.rename = (from) => { if (from.endsWith(".rotated")) throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
  h.compact();
  await h.turnEnd();
  assert.equal(h.runtime.closed, true);
  assert.equal(exits.length, 1);
  assert.ok(h.events.some((event) => event.kind === "error" && event.message.includes("resume broke")));
  assert.deepEqual(h.rows(), [{ name: "pi.session.rotation_failed", attrs: { ...IDENTITY, stage: "resume", outcome: "runtime_ended", error_class: "Error" } }]);
  const seedFile = newestPiSessionFile(h.sessionDir, SESSION_ID)!;
  assert.notEqual(seedFile, h.oldFile);
  assert.equal(JSON.stringify(SessionManager.open(seedFile, h.sessionDir).buildSessionContext()), oldContext);
});

test("input that arrives during the resume waits for it and reaches the resumed session", async () => {
  let release!: () => void;
  const resumeGate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness({ resume: () => resumeGate });
  const old = h.live();
  h.compact();
  await h.turnEnd();
  assert.equal(old.disposed, false, "the old session stays until the seed is open");
  assert.deepEqual(h.runtime.send({ mode: "idle", text: "during" }), { ok: true, acceptedAs: "prompt" });
  release();
  await settle();
  assert.equal(h.opened.length, 2);
  assert.equal(old.disposed, true);
  assert.deepEqual(h.live().prompts, ["during"]);
  assert.deepEqual(old.prompts, ["wake"]);
});

test("rollout knobs: off unless the server flag is on; the agent's env wins over the daemon's", () => {
  assert.deepEqual(resolvePiSessionRotationConfig(undefined, null, {}), { enabled: false, minBytes: DEFAULT_PI_SESSION_ROTATION_MIN_BYTES });
  assert.deepEqual(resolvePiSessionRotationConfig(false, { RAFT_PI_SESSION_ROTATION: "1" }, {}), { enabled: false, minBytes: DEFAULT_PI_SESSION_ROTATION_MIN_BYTES });
  assert.equal(DEFAULT_PI_SESSION_ROTATION_MIN_BYTES, 30 * 1024 * 1024);
  assert.deepEqual(resolvePiSessionRotationConfig(true, null, {}), { enabled: true, minBytes: DEFAULT_PI_SESSION_ROTATION_MIN_BYTES });
  assert.deepEqual(resolvePiSessionRotationConfig(true, null, { RAFT_PI_SESSION_ROTATION: "off" }).enabled, false);
  assert.deepEqual(
    resolvePiSessionRotationConfig(true, { RAFT_PI_SESSION_ROTATION_MIN_BYTES: "2048" }, { RAFT_PI_SESSION_ROTATION_MIN_BYTES: "4096" }),
    { enabled: true, minBytes: 2048 },
  );
  assert.equal(resolvePiSessionRotationConfig(true, { RAFT_PI_SESSION_ROTATION_MIN_BYTES: "lots" }, {}).minBytes, DEFAULT_PI_SESSION_ROTATION_MIN_BYTES);
});

// ── Crash safety: the file steps, and what a resume opens after a crash ──

function seedFixture() {
  const { root, sessionDir } = workspace();
  const sm = compactedSession(sessionDir, root, SESSION_ID);
  const oldFile = sm.getSessionFile()!;
  const seed = buildPiSessionSeed(sm, { now: new Date("2099-01-01T00:00:00.000Z"), oldFileBytes: statSync(oldFile).size });
  assert.equal(seed.rotatable, true);
  if (!seed.rotatable) throw new Error("unreachable");
  return { root, sessionDir, sm, oldFile, seed };
}

test("findPiSessionFile resumes the newest-named file of the id", () => {
  const { sessionDir } = workspace();
  const names = [
    `2026-03-01T00-00-00-000Z_${SESSION_ID}.jsonl`,
    `2026-05-01T00-00-00-000Z_${SESSION_ID}.jsonl`,
    `2026-04-01T00-00-00-000Z_${SESSION_ID}.jsonl`,
    `2026-06-01T00-00-00-000Z_${SESSION_ID}.jsonl.rotated`,
    `2026-07-01T00-00-00-000Z_${SESSION_ID}.jsonl.tmp`,
    `2026-08-01T00-00-00-000Z_other-${SESSION_ID}x.jsonl`,
  ];
  for (const name of names) writeFileSync(path.join(sessionDir, name), "{}\n");
  assert.equal(newestPiSessionFile(sessionDir, SESSION_ID), path.join(sessionDir, names[1]!));
  assert.equal(newestPiSessionFile(sessionDir, "missing"), null);
  assert.equal(newestPiSessionFile(path.join(sessionDir, "absent"), SESSION_ID), null);
});

test("findPiSessionFile skips a newer session name that is not a regular file", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const { sessionDir } = workspace();
  const regular = path.join(sessionDir, `2026-03-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(regular, "{}\n");
  mkdirSync(path.join(sessionDir, `2026-06-01T00-00-00-000Z_${SESSION_ID}.jsonl`));
  // A FIFO would block pi's SessionManager.open (and the daemon) until a writer appears.
  const found = await withFifos([path.join(sessionDir, `2026-05-01T00-00-00-000Z_${SESSION_ID}.jsonl`)], () => newestPiSessionFile(sessionDir, SESSION_ID));
  assert.equal(found.waitedForUnblock, false);
  assert.equal(found.result, regular);
});

/** The daemon's own resume path (createPiAgentSessionForContext) for SESSION_ID in a Built-in workspace. */
async function resumeThroughDaemon(root: string): Promise<AgentSession> {
  const ctx: SpawnContext = {
    agentId: "agent-rotation", standingPrompt: "standing", prompt: "wake", workingDirectory: root, slockCliPath: "/tmp/slock-cli.js", daemonApiKey: "x",
    config: {
      name: "rotation", displayName: null, description: null, runtime: "builtin", serverUrl: "https://slock.example", authToken: "t",
      sessionId: SESSION_ID, model: "fake-model", reasoningEffort: null, envVars: null, runtimeContext: null,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION, runtime: "builtin",
        provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: "http://127.0.0.1:9/anthropic", apiKey: "fake" },
        hostUserState: "forbidden", model: { kind: "custom", name: "fake-model" }, mode: { kind: "default" },
      },
    },
  };
  const session = await createPiAgentSessionForContext(ctx, SESSION_ID, {
    agentDir: buildBuiltInAgentDir(root), sessionDir: buildBuiltInSessionDir(root), agentDirSource: "managed_builtin", isolateHostProviderEnv: true,
  });
  onTestFinished(() => session.dispose());
  return session;
}

function builtInFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-session-rotation-crash-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const sessionDir = buildBuiltInSessionDir(root);
  mkdirSync(sessionDir, { recursive: true });
  const sm = compactedSession(sessionDir, root, SESSION_ID);
  const oldFile = sm.getSessionFile()!;
  const seed = buildPiSessionSeed(sm, { now: new Date("2099-01-01T00:00:00.000Z"), oldFileBytes: statSync(oldFile).size });
  if (!seed.rotatable) throw new Error(JSON.stringify(seed));
  return { root, sm, oldFile, seed };
}

test("a crash between writing the seed and renaming the old file: the resume opens the seed", { timeout: 30_000 }, async () => {
  const { root, sm, oldFile, seed } = builtInFixture();
  writeFileSync(seed.seedFile, seed.content);
  assert.equal(existsSync(oldFile), true, "both files are on disk");
  const session = await resumeThroughDaemon(root);
  assert.equal(session.sessionManager.getSessionFile(), seed.seedFile);
  assert.equal(session.sessionId, SESSION_ID);
  assert.equal(JSON.stringify(session.sessionManager.buildSessionContext()), JSON.stringify(sm.buildSessionContext()));
});

test("a crash after renaming the old file: the resume opens the seed", { timeout: 30_000 }, async () => {
  const { root, sm, oldFile, seed } = builtInFixture();
  assert.deepEqual(writePiSessionRotationFiles(seed, oldFile), { ok: true });
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(seed.rotatedOldFile), true);
  assert.equal(existsSync(`${seed.seedFile}.tmp`), false);
  const session = await resumeThroughDaemon(root);
  assert.equal(session.sessionManager.getSessionFile(), seed.seedFile);
  assert.equal(JSON.stringify(session.sessionManager.buildSessionContext()), JSON.stringify(sm.buildSessionContext()));
});

test("the daemon's reopen opens the seed before it lets the old session go: a failed open leaves it untouched", { timeout: 30_000 }, async () => {
  const { root, oldFile, seed } = builtInFixture();
  let launchChecks = 0;
  const ctx: SpawnContext = {
    agentId: "agent-rotation", standingPrompt: "standing", prompt: "wake", workingDirectory: root, slockCliPath: "/tmp/slock-cli.js", daemonApiKey: "x",
    // The reopen's open checks the launch like a spawn does: fail the second check.
    assertLaunchCurrent: () => {
      launchChecks += 1;
      if (launchChecks > 1) throw new Error("open failed");
    },
    config: {
      name: "rotation", displayName: null, description: null, runtime: "builtin", serverUrl: "https://slock.example", authToken: "t",
      sessionId: SESSION_ID, model: "fake-model", reasoningEffort: null, envVars: null, runtimeContext: null,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION, runtime: "builtin",
        provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: "http://127.0.0.1:9/anthropic", apiKey: "fake" },
        hostUserState: "forbidden", model: { kind: "custom", name: "fake-model" }, mode: { kind: "default" },
      },
    },
  };
  const handle = await openPiAgentSessionForContext(ctx, SESSION_ID, {
    agentDir: buildBuiltInAgentDir(root), sessionDir: buildBuiltInSessionDir(root), agentDirSource: "managed_builtin", isolateHostProviderEnv: true,
  });
  onTestFinished(() => handle.session.dispose());
  assert.equal(handle.session.sessionManager.getSessionFile(), oldFile);
  assert.deepEqual(writePiSessionRotationFiles(seed, oldFile), { ok: true });
  assert.equal(piSessionMemoryAttrs(Date.now()).pi_session_count, 1);

  await assert.rejects(handle.reopen(), /open failed/);
  assert.equal(piSessionMemoryAttrs(Date.now()).pi_session_count, 1, "the old session is still live");
  assert.equal(handle.session.sessionManager.getSessionFile(), oldFile);

  launchChecks = 0;
  const next = await handle.reopen();
  onTestFinished(() => next.session.dispose());
  assert.equal(next.session.sessionManager.getSessionFile(), seed.seedFile);
  assert.equal(piSessionMemoryAttrs(Date.now()).pi_session_count, 1, "the old session went once the seed was open");
});

test("a reopen whose extensions fail to bind leaves the kept old session its provider client", { timeout: 30_000 }, async () => {
  const { bodies, port } = await fakeAnthropic();
  const { root, oldFile, seed } = builtInFixture();
  // Host extensions load from here: none.
  vi.stubEnv("PI_CODING_AGENT_DIR", mkdtempSync(path.join(os.tmpdir(), "pi-rotation-host-agent-")));
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const bindExtensions = AgentSession.prototype.bindExtensions;
  let binds = 0;
  const bind = vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(function (this: AgentSession, ...args) {
    binds += 1;
    if (binds > 1) return Promise.reject(new Error("bind failed"));
    return bindExtensions.apply(this, args);
  });
  onTestFinished(() => bind.mockRestore());
  const handle = await openPiAgentSessionForContext({
    agentId: "agent-rotation", standingPrompt: "standing instructions", prompt: "wake", workingDirectory: root, slockCliPath: "/tmp/slock-cli.js", daemonApiKey: "x",
    config: {
      name: "rotation", displayName: null, description: null, runtime: "builtin", serverUrl: "https://slock.example", authToken: "t",
      sessionId: SESSION_ID, model: "fake-model", reasoningEffort: null, envVars: null, runtimeContext: null,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION, runtime: "builtin", loadLocalPlugins: true,
        provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: "fake" },
        hostUserState: "forbidden", model: { kind: "custom", name: "fake-model" }, mode: { kind: "default" },
      },
    },
  }, SESSION_ID, {
    agentDir: buildBuiltInAgentDir(root), sessionDir: buildBuiltInSessionDir(root), agentDirSource: "managed_builtin", isolateHostProviderEnv: true,
  });
  onTestFinished(() => handle.session.dispose());
  assert.equal(binds, 1, "precondition: the spawn bound its extensions");

  assert.deepEqual(writePiSessionRotationFiles(seed, oldFile), { ok: true });
  await assert.rejects(handle.reopen(), /bind failed/);
  assert.equal(undoPiSessionRotationFiles(seed, oldFile), true, "as the runtime does after a failed reopen");

  const before = bodies.length;
  await handle.session.prompt("after the failed reopen");
  assert.ok(bodies.length > before, "the kept session still reaches the provider");
  assert.equal(handle.session.messages.at(-1)?.role, "assistant");
  assert.notEqual((handle.session.messages.at(-1) as { stopReason?: string } | undefined)?.stopReason, "error");
});

function recordingFs(fail: { write?: boolean; renameOld?: boolean; remove?: boolean }) {
  const calls: string[] = [];
  const real = { writeFileSync, rm: (file: string) => rmSync(file, { force: true }) };
  const fs: PiSessionRotationFs = {
    writeDurable(file, content) {
      calls.push(`write ${path.basename(file)}`);
      if (fail.write) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      real.writeFileSync(file, content);
    },
    rename(from, to) {
      calls.push(`rename ${path.basename(from)} -> ${path.basename(to)}`);
      if (fail.renameOld && to.endsWith(".rotated")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      renameSync(from, to);
    },
    remove(file) {
      calls.push(`remove ${path.basename(file)}`);
      if (fail.remove) throw new Error("cannot remove");
      real.rm(file);
    },
  };
  return { fs, calls };
}

test("the file steps: temp then rename, then retire the old file; each failure leaves a resumable state", () => {
  const { sessionDir, oldFile, seed } = seedFixture();
  const seedName = path.basename(seed.seedFile);
  const oldName = path.basename(oldFile);

  const ok = recordingFs({});
  assert.deepEqual(writePiSessionRotationFiles(seed, oldFile, ok.fs), { ok: true });
  assert.deepEqual(ok.calls, [`write ${seedName}.tmp`, `rename ${seedName}.tmp -> ${seedName}`, `rename ${oldName} -> ${oldName}.rotated`]);
  assert.equal(newestPiSessionFile(sessionDir, SESSION_ID), seed.seedFile);
  // Back to the old file alone.
  renameSync(seed.rotatedOldFile, oldFile);
  rmSync(seed.seedFile);

  const writeFails = recordingFs({ write: true });
  const written = writePiSessionRotationFiles(seed, oldFile, writeFails.fs);
  assert.equal(written.ok, false);
  assert.equal(!written.ok && written.stage, "write_seed");
  assert.equal(newestPiSessionFile(sessionDir, SESSION_ID), oldFile);

  const renameFails = recordingFs({ renameOld: true });
  const renamed = writePiSessionRotationFiles(seed, oldFile, renameFails.fs);
  assert.equal(!renamed.ok && renamed.stage, "rename_old");
  assert.equal(existsSync(seed.seedFile), false, "the seed is removed again");
  assert.equal(newestPiSessionFile(sessionDir, SESSION_ID), oldFile, "the old session keeps the file a resume opens");

  // The seed could not be removed either: reported as a failure, and the seed
  // is what a resume opens, so the live session must follow it.
  const neither = recordingFs({ renameOld: true, remove: true });
  const left = writePiSessionRotationFiles(seed, oldFile, neither.fs);
  assert.equal(left.ok, false);
  assert.deepEqual(!left.ok && [left.stage, left.resumeFrom], ["rename_old", "seed"]);
  assert.equal(!renamed.ok && renamed.resumeFrom, "old");
  assert.equal(!written.ok && written.resumeFrom, "old");
  assert.equal(newestPiSessionFile(sessionDir, SESSION_ID), seed.seedFile);
});

// ── The real thing: the Built-in driver, pi's own compaction, a loopback provider ──

const E2E_SESSION_ID = "pi-rotation-e2e";
const COMPACT_MARKER = "COMPACT-NOW";

const MCP_TOOL = {
  mcpServerId: "mcp-1", serverName: "Docs", toolName: "search", runtimeName: "mcp__docs__search", description: "Search the docs",
  inputSchema: { type: "object", properties: { query: { type: "string" } } }, configVersion: 1, assignmentVersion: 1,
};

/**
 * An Anthropic-compatible provider, and the Raft server's managed MCP tool
 * list. A turn starting with the marker reports a near-full context, so pi
 * compacts after it.
 */
async function fakeAnthropic() {
  const bodies: string[] = [];
  const mcpToolLists: string[] = [];
  const server = createServer((req, res) => {
    if (answerGatewayModelListRead(req, res)) return;
    if (req.url?.endsWith("/internal/agent-api/mcp/tools")) {
      mcpToolLists.push(String(req.headers.authorization));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ catalogVersion: 1, tools: [MCP_TOOL] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      const parsed = JSON.parse(body) as { system?: unknown; messages?: Array<{ content?: unknown }> };
      const lastUser = JSON.stringify(parsed.messages?.at(-1)?.content ?? "");
      const agentTurn = JSON.stringify(parsed.system ?? "").includes("standing instructions");
      const inputTokens = agentTurn && lastUser.includes(COMPACT_MARKER) ? 195_000 : 1_000;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "fake-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `answer ${"lorem ipsum ".repeat(200)}` } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 200 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { bodies, mcpToolLists, port: (server.address() as AddressInfo).port };
}

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Four turns, the last one compacted by pi, then one more turn; with the flag
 * on, the turn end after the compaction rotates, as APM offers it.
 */
async function builtInRun(root: string, port: number, bodies: string[], rotation: boolean) {
  mkdirSync(root, { recursive: true });
  const sink = new MemoryTraceSink();
  const runtime = new BuiltInDriver().createSession({
    agentId: "agent-rotation-e2e", standingPrompt: "standing instructions", prompt: "wake", workingDirectory: root, slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "x", launchId: "launch-rotation-e2e",
    tracer: createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS),
    config: {
      name: "rotation", displayName: null, description: null, runtime: "builtin", serverUrl: `http://127.0.0.1:${port}`, authToken: "t",
      agentCredentialKey: "sk_agent_rotation",
      sessionId: null, model: "fake-model", reasoningEffort: null, runtimeContext: null,
      envVars: { RAFT_PI_SESSION_ROTATION_MIN_BYTES: "1" },
      piSessionRotation: rotation,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION, runtime: "builtin",
        provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: "fake" },
        hostUserState: "forbidden", model: { kind: "custom", name: "fake-model" }, mode: { kind: "default" },
      },
    },
  });
  const events: ParsedEvent[] = [];
  let turnEnds = 0;
  runtime.on("runtime_event", (event) => {
    events.push(event);
    if (event.kind !== "turn_end") return;
    turnEnds += 1;
    runtime.rotateSessionIfDue?.(() => null);
  });
  const rotated = () => traceRows(sink).filter((row) => row.name === "pi.session.rotated");
  const prompt = (n: number) => `${n === 4 ? COMPACT_MARKER : "turn"} ${n}: ${"context line with some words ".repeat(1400)}`;
  const turn = async (n: number) => {
    const before = turnEnds;
    if (n === 1) await runtime.start({ text: prompt(n), sessionId: E2E_SESSION_ID });
    else assert.deepEqual(runtime.send({ mode: "idle", text: prompt(n) }), { ok: true, acceptedAs: "prompt" });
    await waitUntil(() => turnEnds > before, `turn ${n}`);
  };
  try {
    for (let n = 1; n <= 4; n++) await turn(n);
    assert.ok(events.some((event) => event.kind === "compaction_finished"), "pi compacted after turn 4");
    if (rotation) await waitUntil(() => rotated().length === 1, "the rotation");
    else await settle();
    const memoryAfterCompaction = piSessionMemoryAttrs(Date.now());
    const from = bodies.length;
    await turn(5);
    return {
      next: bodies.slice(from),
      rotated: rotated().map((row) => row.attrs),
      memoryAfterCompaction,
      sessionInits: events.filter((event) => event.kind === "session_init"),
      files: readdirSync(buildBuiltInSessionDir(root)).sort(),
    };
  } finally {
    await runtime.stop();
  }
}

test("Built-in end to end: after pi compacts, the session rotates and the next request is the one an unrotated session sends", { timeout: 90_000 }, async () => {
  const { bodies, mcpToolLists, port } = await fakeAnthropic();
  const parent = mkdtempSync(path.join(os.tmpdir(), "pi-session-rotation-e2e-"));
  onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  // The same workspace path for both runs, so the requests can be compared byte for byte.
  const root = path.join(parent, "ws");

  const unrotated = await builtInRun(root, port, bodies, false);
  assert.equal(mcpToolLists.length, 1, "the spawn lists the managed MCP tools");
  assert.deepEqual(unrotated.rotated, []);
  assert.equal(unrotated.files.length, 1);
  rmSync(root, { recursive: true, force: true });

  const rotated = await builtInRun(root, port, bodies, true);
  assert.equal(rotated.rotated.length, 1);
  assert.equal(mcpToolLists.length, 2, "the rotation did not list them again");
  const { entries_before, bytes_before, entries_after, bytes_after, ...identity } = rotated.rotated[0]!;
  assert.deepEqual(identity, { agentId: "agent-rotation-e2e", launchId: "launch-rotation-e2e", runtime: "builtin" });
  assert.ok(Number(entries_after) < Number(entries_before) && Number(bytes_after) < Number(bytes_before), JSON.stringify(rotated.rotated));

  // Same id, a newer file for it, the old one retired.
  assert.deepEqual(rotated.sessionInits, [{ kind: "session_init", sessionId: E2E_SESSION_ID }], "announced once: the id does not change");
  const live = rotated.files.filter((name) => name.endsWith(`_${E2E_SESSION_ID}.jsonl`));
  const retired = rotated.files.filter((name) => name.endsWith(`_${E2E_SESSION_ID}.jsonl.rotated`));
  assert.equal(live.length, 1, JSON.stringify(rotated.files));
  assert.equal(retired.length, 1, JSON.stringify(rotated.files));
  assert.ok(live[0]! > retired[0]!.replace(/\.rotated$/, ""));
  assert.equal(rotated.files.length, 2, "no temp file left");
  assert.equal(statSync(path.join(buildBuiltInSessionDir(root), retired[0]!)).size, bytes_before, "bytes_before is the retired file");

  // Memory: one live session, the resumed seed; the old one was disposed.
  assert.equal(rotated.memoryAfterCompaction.pi_session_count, 1);
  assert.equal(rotated.memoryAfterCompaction.pi_session_entry_count, entries_after);
  assert.equal(unrotated.memoryAfterCompaction.pi_session_count, 1);
  assert.ok(Number(unrotated.memoryAfterCompaction.pi_session_entry_count) > Number(entries_after));

  // The prompt cache sees the same request.
  const sha = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);
  assert.ok(unrotated.next.length > 0);
  assert.ok(rotated.next[0]!.includes(MCP_TOOL.runtimeName), "the managed MCP tool is still offered");
  assert.deepEqual(rotated.next.map(sha), unrotated.next.map(sha));
  assert.equal(rotated.next[0], unrotated.next[0]);
});
