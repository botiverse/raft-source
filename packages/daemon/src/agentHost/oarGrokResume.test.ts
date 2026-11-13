// RFC 060 host switch, grok: the session the legacy driver started is the
// session OAR resumes (same native id, same cwd, same store), a refused resume
// is never replaced by a fresh session, and the OAR host hands that start back.
//
// One fake grok ACP agent stands in for `grok agent ... stdio`: it keeps its
// sessions in a store keyed by id with the cwd they were created in, the way
// grok keeps them per directory, and answers an unknown (or other-cwd)
// `session/load` with grok's FS_NOT_FOUND. The legacy GrokDriver and OAR's real
// grok runtime (`@botiverse/oar/runtimes/grok`) both run against it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, MachineToServerMessage } from "@botiverse/raft-shared";
import { GrokDriver } from "../drivers/grok";
import type { ParsedEvent, SpawnContext } from "../drivers/types";
import { formatResumeEmptyPrompt } from "../agentRuntimeInput";
import { exampleMessage } from "../axExampleFixtures";
import { loadOarRuntime } from "../oarLoader";
import type { AgentStartRequest } from "./agentLifecycleHost";
import { OarAgentHost } from "./oarAgentHost";
import { launchEnvOverlay } from "./oarGrokLaunch";

const FAKE_GROK = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("grok 1.0.60 (fake)\n"); process.exit(0); }
if (!args.includes("agent") || args[args.length - 1] !== "stdio") { process.stderr.write("unexpected argv " + JSON.stringify(args) + "\n"); process.exit(2); }
const storePath = process.env.FAKE_GROK_STORE;
const logPath = process.env.FAKE_GROK_LOG;
const read = () => (fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : {});
const log = (message) => fs.appendFileSync(logPath, JSON.stringify({ argv: args, ...message }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) return;
  log({ method: message.method, params: message.params });
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    case "session/new": {
      const store = read();
      const sessionId = "grok-" + Object.keys(store).length + "-" + process.pid;
      store[sessionId] = { cwd: message.params.cwd };
      fs.writeFileSync(storePath, JSON.stringify(store));
      return send({ id: message.id, result: { sessionId } });
    }
    case "session/load": {
      const known = read()[message.params.sessionId];
      if (!known || known.cwd !== message.params.cwd) {
        return send({ id: message.id, error: { code: -32603, message: "Path not found", data: { code: "FS_NOT_FOUND" } } });
      }
      return send({ id: message.id, result: {} });
    }
    case "session/set_model":
      return send({ id: message.id, result: {} });
    case "_x.ai/interject": {
      // Grok 1.0.77: answers queued at once; the running turn takes it at its
      // next safe point and ends normally (nothing cancelled).
      send({ id: message.id, result: { status: "queued" } });
      const held = globalThis.heldPrompt;
      if (held) {
        globalThis.heldPrompt = null;
        setTimeout(() => {
          send({ method: "session/update", params: { sessionId: held.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "took the interjection" } } } });
          send({ id: held.id, result: { stopReason: "end_turn" } });
        }, 50);
      }
      return;
    }
    case "session/prompt": {
      const sessionId = message.params.sessionId;
      if (JSON.stringify(message.params.prompt).includes("HOLD_UNTIL_INTERJECT")) {
        globalThis.heldPrompt = { id: message.id, sessionId };
        send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } } } });
        return;
      }
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      // Grok after a sub-agent finishes: it injects its own prompt into the
      // session (outside session/prompt) and runs that turn, ending it with a
      // turn_completed whose prompt id is "subagent-completed-<id>".
      if (JSON.stringify(message.params.prompt).includes("SPAWN_BACKGROUND")) {
        setTimeout(() => {
          send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the sub-agent is done" } } } });
          send({ method: "_x.ai/session_notification", params: { sessionId, _meta: { eventId: "evt-" + Date.now() }, update: { sessionUpdate: "turn_completed", prompt_id: "subagent-completed-call-1", stop_reason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } } });
        }, 200);
      }
      return;
    }
    default:
      return send({ id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
`;

interface FakeGrok {
  root: string;
  command: string;
  workDir: string;
  slockHome: string;
  log(): Array<{ method: string; params: Record<string, unknown>; argv: string[] }>;
  restore(): void;
}

function installFakeGrok(): FakeGrok {
  const root = mkdtempSync(path.join(os.tmpdir(), "oar-grok-resume-"));
  const binDir = path.join(root, "bin");
  const workDir = path.join(root, "agents", "agent-1");
  const slockHome = path.join(root, "raft-home");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(slockHome, { recursive: true });
  const command = path.join(binDir, "grok");
  writeFileSync(command, `#!${process.execPath}\n${FAKE_GROK}`);
  chmodSync(command, 0o755);
  const logPath = path.join(root, "grok.log");
  const previous = {
    PATH: process.env.PATH,
    FAKE_GROK_STORE: process.env.FAKE_GROK_STORE,
    FAKE_GROK_LOG: process.env.FAKE_GROK_LOG,
    GROK_HOME: process.env.GROK_HOME,
  };
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.FAKE_GROK_STORE = path.join(root, "sessions.json");
  process.env.FAKE_GROK_LOG = logPath;
  process.env.GROK_HOME = path.join(root, "grok-home");
  return {
    root,
    command,
    workDir,
    slockHome,
    log: () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const config: AgentConfig = {
  name: "grok-agent",
  displayName: "Grok Agent",
  description: "test agent",
  model: "default",
  runtime: "grok",
  reasoningEffort: null,
  envVars: null,
  sessionId: null,
  serverUrl: "http://localhost:3001",
  authToken: "",
};

/** The legacy driver's own launch, up to the session it announces. */
async function legacySession(fake: FakeGrok): Promise<string> {
  const driver = new GrokDriver();
  const ctx: SpawnContext = {
    agentId: "agent-1",
    config,
    standingPrompt: "standing instructions",
    prompt: "first input",
    workingDirectory: fake.workDir,
    slockCliPath: process.execPath,
    daemonApiKey: "sk_machine_test",
    slockHome: fake.slockHome,
    launchId: "launch-legacy",
  };
  const { process: child } = await driver.spawn(ctx);
  try {
    return await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("legacy grok session never started")), 10_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          for (const event of driver.parseLine(line) as ParsedEvent[]) {
            if (event.kind === "session_init") {
              clearTimeout(timer);
              resolve(event.sessionId);
            }
          }
        }
      });
    });
  } finally {
    // Gone before the caller reads the log: nothing it was sent lands later.
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
}

test("OAR grok resumes the session the legacy grok driver started: same id, same cwd, same store", async () => {
  const fake = installFakeGrok();
  try {
    const sessionId = await legacySession(fake);
    assert.match(sessionId, /^grok-0-/);
    const runtime = await loadOarRuntime("grok");
    const session = await runtime.session({ kind: "available", via: "executable", command: fake.command }, {
      cwd: fake.workDir,
      resume: sessionId,
      env: launchEnvOverlay({ ...process.env }),
    });
    try {
      assert.equal(session.id, sessionId);
    } finally {
      await session.dispose();
    }
    const loads = fake.log().filter((entry) => entry.method === "session/load");
    assert.equal(loads.length, 1);
    assert.equal(loads[0]!.params.sessionId, sessionId);
    assert.equal(loads[0]!.params.cwd, fake.workDir);
    assert.ok(loads[0]!.argv.includes("--always-approve") && loads[0]!.argv.includes("--no-leader"), "the driver's flags");

    // The same id from another directory is another session to grok: refused, typed.
    const elsewhere = path.join(fake.root, "elsewhere");
    mkdirSync(elsewhere);
    await assert.rejects(
      runtime.session({ kind: "available", via: "executable", command: fake.command }, { cwd: elsewhere, resume: sessionId }),
      (error: Error) => error.name === "SessionNotFoundError",
    );
  } finally {
    fake.restore();
  }
});

/**
 * The fake's log entries for `method` past the first `from` entries, once
 * there is at least one. The host reports "started" when its first prompt is
 * accepted, before grok has read it, so a loaded CI runner can read the log
 * before it lands. `from` skips what an earlier process (the legacy driver's
 * own first prompt) logged.
 */
async function waitForLogged(fake: FakeGrok, method: string, from: number, timeoutMs = 10_000): Promise<ReturnType<FakeGrok["log"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = fake.log().slice(from).filter((entry) => entry.method === method);
    if (entries.length > 0) return entries;
    if (Date.now() > deadline) assert.fail(`grok never logged ${method}: ${fake.log().map((entry) => entry.method).join(",")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function hostFor(fake: FakeGrok, frames: MachineToServerMessage[]): OarAgentHost {
  return new OarAgentHost({
    dataDir: path.dirname(fake.workDir),
    serverUrl: "http://localhost:3001",
    daemonApiKey: "sk_machine_test",
    slockCliPath: process.execPath,
    slockHome: fake.slockHome,
    sendToServer: (msg) => { frames.push(msg); },
    nextClientSeq: (() => { let seq = 0; return () => ++seq; })(),
    daemonInstanceId: () => "daemon-1",
    buildSpawnConfig: async (_agentId, launchConfig) => launchConfig,
    isStaleClaim: () => false,
    gate: null,
    launches: { take: () => ["launch-oar"], settleNotSpawned: () => {}, settleRebound: () => {} },
    recordEvent: () => {},
    fetchImpl: async () => new Response(null, { status: 204 }),
    platform: "linux",
  });
}

function startRequest(sessionId: string): AgentStartRequest {
  return {
    agentId: "agent-1",
    config: { ...config, sessionId, runtimeHost: "oar" },
    launchId: "launch-oar",
    wakeMessageTransient: false,
    recoveryGrant: null,
    claimedConnectionEpochId: null,
  };
}

test("the OAR host, real grok launch: resumes the legacy session and gives it its first input", async () => {
  const fake = installFakeGrok();
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  try {
    const sessionId = await legacySession(fake);
    const legacyEntries = fake.log().length;
    assert.deepEqual(await host.start(startRequest(sessionId)), { kind: "started" });
    assert.equal(host.getAgentSessionId("agent-1"), sessionId);
    const prompts = await waitForLogged(fake, "session/prompt", legacyEntries);
    const methods = fake.log().map((entry) => entry.method);
    assert.equal(methods.filter((method) => method === "session/new").length, 1, "only the legacy driver's session was created");
    assert.equal(prompts.at(-1)!.params.sessionId, sessionId);
    const spawned = frames.find((frame) => frame.type === "agent:process_spawned");
    assert.ok(spawned, frames.map((frame) => frame.type).join(","));
    // The standing prompt the legacy driver mounts (its session/load _meta), as grok's systemPromptOverride.
    const initialize = fake.log().filter((entry) => entry.method === "initialize").at(-1)!;
    const runtimeConfig = { ...startRequest(sessionId).config, runtimeContext: { agentId: "agent-1", workspacePath: fake.workDir } };
    const meta = initialize.params._meta as { systemPromptOverride?: string };
    assert.equal(meta.systemPromptOverride, String(new GrokDriver().buildSystemPrompt(runtimeConfig, "agent-1")));
    // A resumed session with nothing new gets the legacy resume input.
    assert.equal((prompts.at(-1)!.params.prompt as Array<{ text: string }>)[0]!.text, String(formatResumeEmptyPrompt(new GrokDriver())));
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

test("the OAR host, real grok launch: a session grok cannot load is handed back, never replaced by a fresh one", async () => {
  const fake = installFakeGrok();
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  try {
    const outcome = await host.start(startRequest("grok-unknown"));
    assert.equal(outcome.kind, "fallback");
    assert.equal(outcome.kind === "fallback" && outcome.reason, "resume_failed:SessionNotFoundError");
    const methods = fake.log().map((entry) => entry.method);
    assert.ok(methods.includes("session/load"));
    assert.ok(!methods.includes("session/new"), `no fresh session: ${methods.join(",")}`);
    assert.ok(!methods.includes("session/prompt"));
    assert.deepEqual(frames.filter((frame) => frame.type === "agent:process_spawned" || frame.type === "agent:status"), []);
    assert.equal(host.owns("agent-1"), false);
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

async function deliverAfterPrompt(trigger: string): Promise<void> {
  const fake = installFakeGrok();
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  const message = (id: string, content: string) => ({ ...exampleMessage, message_id: id, seq: Number(id.replace(/\D/g, "")) || 1, content });
  try {
    const sessionId = await legacySession(fake);
    const from = fake.log().length;
    assert.deepEqual(await host.start(startRequest(sessionId)), { kind: "started" });
    await waitForLogged(fake, "session/prompt", from);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const beforeFirst = fake.log().length;
    assert.equal(await host.deliverMessage("agent-1", message("m-10", trigger)), true);
    await waitForLogged(fake, "session/prompt", beforeFirst);
    // A spontaneous turn starts and ends within ~200 ms of that prompt's answer.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const beforeNext = fake.log().length;
    assert.equal(await host.deliverMessage("agent-1", message("m-11", "the next message")), true);
    const next = await waitForLogged(fake, "session/prompt", beforeNext, 5_000);
    assert.ok(JSON.stringify(next.at(-1)!.params.prompt).includes("the next message"), "the next message reached Grok");
  } finally {
    await host.stopAll();
    fake.restore();
  }
}

test("the OAR host, real grok launch: the next message after an ordinary prompt is delivered (control for gap 2)", async () => {
  await deliverAfterPrompt("an ordinary prompt");
});

// #oar-raft:#4 gap 2, fixed by OAR 0.96 (#716): Grok's own turns now report
// turn_active / turn_ended, so after Grok runs one the session goes back to
// idle and the next message is delivered (it was held: the status stayed running).
test("the OAR host, real grok launch: a turn Grok runs by itself after a sub-agent ends, so the next message is delivered (#oar-raft:#4 gap 2)", async () => {
  await deliverAfterPrompt("SPAWN_BACKGROUND please");
});

// OAR 0.96 (#716): a message that arrives while Grok is busy goes into the
// running turn with `_x.ai/interject` (as the legacy driver does), not held
// for the turn end and not by cancelling the turn.
test("the OAR host, real grok launch: a message during a running turn is interjected into it, nothing cancelled", async () => {
  const fake = installFakeGrok();
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  const message = (id: string, content: string) => ({ ...exampleMessage, message_id: id, seq: Number(id.replace(/\D/g, "")) || 1, content });
  try {
    const sessionId = await legacySession(fake);
    const from = fake.log().length;
    assert.deepEqual(await host.start(startRequest(sessionId)), { kind: "started" });
    await waitForLogged(fake, "session/prompt", from);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const beforeHold = fake.log().length;
    assert.equal(await host.deliverMessage("agent-1", message("m-20", "HOLD_UNTIL_INTERJECT")), true);
    await waitForLogged(fake, "session/prompt", beforeHold);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const beforeSteer = fake.log().length;
    assert.equal(await host.deliverMessage("agent-1", message("m-21", "a message mid-turn")), true);
    const interjects = await waitForLogged(fake, "_x.ai/interject", beforeSteer, 5_000);
    assert.ok(String(interjects.at(-1)!.params.text).includes("a message mid-turn"), "the message went into the running turn");
    const after = fake.log().slice(beforeSteer).map((entry) => entry.method);
    assert.ok(!after.includes("session/cancel"), `nothing cancelled: ${after.join(",")}`);
    assert.ok(!after.includes("session/prompt"), `not held for a new turn: ${after.join(",")}`);
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

// Guard for the fixture itself: it must be runnable by this Node.
test("fake grok fixture answers --version", () => {
  const fake = installFakeGrok();
  try {
    const result = spawnSync(fake.command, ["--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fake.restore();
  }
});
