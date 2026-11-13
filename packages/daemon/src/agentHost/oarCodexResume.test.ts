// RFC 060 host switch, codex (#wg-ax:#3): a thread the legacy driver started
// is the thread OAR resumes (same thread id, same cwd, same CODEX_HOME), and
// the other way round; a thread codex cannot find is handed back, never
// replaced by a fresh one; what each host sends codex for the thread is
// the same: the standing prompt as developer instructions (never base
// instructions), the model, an explicit service tier; and the activity each
// host reports for one turn is the same.
//
// One fake `codex app-server` stands in for codex: it keeps its threads in a
// store in CODEX_HOME (where codex keeps its rollouts), reports
// the tier the way codex does (`fast` reads back as `priority`), and answers
// an unknown `thread/resume` with codex's own -32600 "no rollout found". The
// legacy CodexDriver and OAR's real codex runtime both run against it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeToolDisplayInvocation, type AgentConfig, type MachineToServerMessage } from "@botiverse/raft-shared";
import { clearCodexProbeCacheForTests, CodexDriver } from "../drivers/codex";
import { CodexEventNormalizer } from "../drivers/codexEventNormalizer";
import type { ParsedEvent, SpawnContext } from "../drivers/types";
import { exampleMessage } from "../axExampleFixtures";
import type { AgentStartRequest } from "./agentLifecycleHost";
import { OarAgentHost } from "./oarAgentHost";

const FAKE_CODEX = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-cli 0.166.0\n"); process.exit(0); }
if (args[0] === "app-server" && args.includes("--help")) { process.stdout.write("Usage: codex app-server\n"); process.exit(0); }
if (args[0] !== "app-server" || args[args.length - 1] !== "stdio://") { process.stderr.write("unexpected argv " + JSON.stringify(args) + "\n"); process.exit(2); }
// The threads live in CODEX_HOME, as codex's rollouts do: a host that lost or
// changed it would find none.
const storePath = require("node:path").join(process.env.CODEX_HOME, "fake-threads.json");
const logPath = process.env.FAKE_CODEX_LOG;
const read = () => (fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : {});
// Whole or not at all: a test kills one app-server while it may be writing.
const write = (store) => { const tmp = storePath + "." + process.pid; fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, storePath); };
const log = (message) => fs.appendFileSync(logPath, JSON.stringify({ argv: args, pid: process.pid, ...message }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
// codex names the fast tier "priority" in what it reports; null is the default tier.
const tierOf = (requested) => (requested === "fast" || requested === "priority" ? "priority" : null);
const threadReply = (id, thread, params) => ({
  thread: { id, name: thread.name ?? null },
  model: params.model ?? thread.model,
  modelProvider: "openai",
  serviceTier: params.serviceTier === undefined ? thread.serviceTier : tierOf(params.serviceTier),
  cwd: thread.cwd,
  approvalPolicy: "never",
  reasoningEffort: (params.config && params.config.model_reasoning_effort) ?? thread.reasoningEffort ?? null,
});
let turns = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) return;
  log({ method: message.method, params: message.params });
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return send({ id: message.id, result: { userAgent: "codex_cli_rs/0.166.0 (fake)", codexHome: process.env.CODEX_HOME } });
    case "thread/start": {
      const store = read();
      const id = "thread-" + Object.keys(store).length + "-" + process.pid;
      const params = message.params;
      const thread = { cwd: params.cwd, model: params.model ?? "gpt-5.5", serviceTier: tierOf(params.serviceTier), reasoningEffort: (params.config && params.config.model_reasoning_effort) ?? null };
      store[id] = thread;
      write(store);
      send({ id: message.id, result: threadReply(id, thread, params) });
      return send({ method: "thread/started", params: { thread: { id } } });
    }
    case "thread/resume": {
      const params = message.params;
      const thread = read()[params.threadId];
      if (!thread) return send({ id: message.id, error: { code: -32600, message: "no rollout found for thread id " + params.threadId } });
      return send({ id: message.id, result: threadReply(params.threadId, thread, params) });
    }
    case "thread/name/set": {
      const store = read();
      if (store[message.params.threadId]) { store[message.params.threadId].name = message.params.name; write(store); }
      return send({ id: message.id, result: {} });
    }
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      const threadId = message.params.threadId;
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
      // A scripted turn (FAKE_CODEX_TURN: notifications), each sent for this thread and turn.
      if (process.env.FAKE_CODEX_TURN) for (const note of JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_TURN, "utf8"))) send({ method: note.method, params: { threadId, turnId, ...note.params } });
      return send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    }
    default:
      return send({ id: message.id, error: { code: -32601, message: "method not found: " + message.method } });
  }
});
`;

interface LoggedRequest { method: string; params: Record<string, unknown>; argv: string[]; pid: number }

interface FakeCodex {
  root: string;
  command: string;
  workDir: string;
  slockHome: string;
  log(): LoggedRequest[];
  restore(): void;
}

function installFakeCodex(): FakeCodex {
  const root = mkdtempSync(path.join(os.tmpdir(), "oar-codex-resume-"));
  const binDir = path.join(root, "bin");
  const workDir = path.join(root, "agents", "agent-1");
  const slockHome = path.join(root, "raft-home");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(slockHome, { recursive: true });
  const command = path.join(binDir, "codex");
  writeFileSync(command, `#!${process.execPath}\n${FAKE_CODEX}`);
  chmodSync(command, 0o755);
  const logPath = path.join(root, "codex.log");
  const previous = {
    PATH: process.env.PATH,
    CODEX_BIN: process.env.CODEX_BIN,
    CODEX_HOME: process.env.CODEX_HOME,
    FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
    FAKE_CODEX_TURN: process.env.FAKE_CODEX_TURN,
    OAR_CODEX_SANDBOX: process.env.OAR_CODEX_SANDBOX,
  };
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.CODEX_BIN = command;
  process.env.CODEX_HOME = path.join(root, "codex-home");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  process.env.FAKE_CODEX_LOG = logPath;
  delete process.env.OAR_CODEX_SANDBOX;
  clearCodexProbeCacheForTests();
  return {
    root,
    command,
    workDir,
    slockHome,
    // Whole lines only: a line codex is still writing has no newline yet.
    log: () => existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line)) : [],
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      clearCodexProbeCacheForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const config: AgentConfig = {
  name: "codex-agent",
  displayName: "Codex Agent",
  description: "test agent",
  model: "gpt-5.5",
  runtime: "codex",
  reasoningEffort: "high",
  envVars: null,
  sessionId: null,
  serverUrl: "http://localhost:3001",
  authToken: "",
};

/** The standing prompt the driver builds for this agent, which both hosts send. */
function standingPrompt(fake: FakeCodex, agentConfig: AgentConfig = config): string {
  const runtimeConfig = { ...agentConfig, runtimeContext: { agentId: "agent-1", workspacePath: fake.workDir } };
  return String(new CodexDriver().buildSystemPrompt(runtimeConfig, "agent-1"));
}

/** The legacy driver's own launch, up to the thread it announces. */
async function legacyThread(fake: FakeCodex, agentConfig: AgentConfig = config): Promise<string> {
  const driver = new CodexDriver();
  const ctx: SpawnContext = {
    agentId: "agent-1",
    config: agentConfig,
    standingPrompt: standingPrompt(fake, agentConfig),
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
      const timer = setTimeout(() => reject(new Error("legacy codex thread never started")), 10_000);
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
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
}

/** The fake's log entries for `method` past the first `from` entries, once there is at least one. */
async function waitForLogged(fake: FakeCodex, method: string, from: number, timeoutMs = 10_000): Promise<LoggedRequest[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = fake.log().slice(from).filter((entry) => entry.method === method);
    if (entries.length > 0) return entries;
    if (Date.now() > deadline) assert.fail(`codex never logged ${method}: ${fake.log().map((entry) => entry.method).join(",")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function hostFor(fake: FakeCodex, frames: MachineToServerMessage[]): OarAgentHost {
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

function startRequest(sessionId: string | null, agentConfig: AgentConfig = config): AgentStartRequest {
  return {
    agentId: "agent-1",
    config: { ...agentConfig, sessionId, runtimeHost: "oar" },
    launchId: "launch-oar",
    wakeMessageTransient: false,
    recoveryGrant: null,
    claimedConnectionEpochId: null,
  };
}

/** What a thread request says about the thread, the fields both hosts must agree on. */
function threadFacts(params: Record<string, unknown>) {
  return {
    cwd: params.cwd,
    model: params.model,
    approvalPolicy: params.approvalPolicy,
    developerInstructions: params.developerInstructions,
    baseInstructions: params.baseInstructions,
  };
}

test("the OAR host resumes the thread the legacy codex driver started, and says the same about it", async () => {
  const fake = installFakeCodex();
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  try {
    const threadId = await legacyThread(fake);
    assert.match(threadId, /^thread-0-/);
    const legacyStart = fake.log().find((entry) => entry.method === "thread/start")!;
    const legacyEntries = fake.log().length;

    assert.deepEqual(await host.start(startRequest(threadId)), { kind: "started" });
    assert.equal(host.getAgentSessionId("agent-1"), threadId);
    const turns = await waitForLogged(fake, "turn/start", legacyEntries);
    const oar = fake.log().slice(legacyEntries);
    assert.deepEqual(oar.filter((entry) => entry.method === "thread/start"), [], "no fresh thread");
    const resume = oar.find((entry) => entry.method === "thread/resume")!;
    assert.equal(resume.params.threadId, threadId);
    assert.equal(turns.at(-1)!.params.threadId, threadId);

    // The same thread facts as the legacy driver's start: cwd, model, approvals,
    // the standing prompt as developer instructions and never base instructions.
    assert.deepEqual(threadFacts(resume.params), threadFacts(legacyStart.params));
    assert.equal(resume.params.developerInstructions, standingPrompt(fake));
    assert.equal(resume.params.baseInstructions, undefined);
    // An explicit tier: OAR's "default" where the driver sends null (#11175).
    assert.equal(legacyStart.params.serviceTier, null);
    assert.equal(resume.params.serviceTier, "default");
    // The sandbox: the driver's thread params, OAR's launch override.
    assert.equal(legacyStart.params.sandbox, "danger-full-access");
    assert.ok(resume.argv.join(" ").includes('sandbox_mode="danger-full-access"'), resume.argv.join(" "));
    assert.ok(frames.some((frame) => frame.type === "agent:process_spawned"), frames.map((frame) => frame.type).join(","));
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

test("the legacy codex driver resumes a thread the OAR host started", async () => {
  const fake = installFakeCodex();
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  try {
    assert.deepEqual(await host.start(startRequest(null)), { kind: "started" });
    const oarStart = (await waitForLogged(fake, "thread/start", 0))[0]!;
    const threadId = host.getAgentSessionId("agent-1");
    assert.ok(threadId, "the OAR host reports the new thread");
    assert.equal(oarStart.params.developerInstructions, standingPrompt(fake));
    assert.equal(oarStart.params.baseInstructions, undefined);
    await host.stopAll();

    const oarEntries = fake.log().length;
    assert.equal(await legacyThread(fake, { ...config, sessionId: threadId }), threadId);
    const legacy = fake.log().slice(oarEntries);
    assert.deepEqual(legacy.filter((entry) => entry.method === "thread/start"), [], "no fresh thread");
    const resume = legacy.find((entry) => entry.method === "thread/resume")!;
    assert.equal(resume.params.threadId, threadId);
    assert.deepEqual(threadFacts(resume.params), threadFacts(oarStart.params));
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

test("fast mode opens on OAR: it asks for codex's own tier id, which codex reports back", async () => {
  const fake = installFakeCodex();
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  const fast: AgentConfig = { ...config, runtimeConfig: { version: 1, runtime: "codex", model: { kind: "preset", id: "gpt-5.5" }, mode: { kind: "fast" } } } as AgentConfig;
  try {
    const threadId = await legacyThread(fake, fast);
    const legacyStart = fake.log().find((entry) => entry.method === "thread/start")!;
    assert.equal(legacyStart.params.serviceTier, "fast");
    const legacyEntries = fake.log().length;
    assert.deepEqual(await host.start(startRequest(threadId, fast)), { kind: "started" });
    const resume = (await waitForLogged(fake, "thread/resume", legacyEntries))[0]!;
    assert.equal(resume.params.serviceTier, "priority");
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

test("a thread codex cannot find is handed back, never replaced by a fresh one", async () => {
  const fake = installFakeCodex();
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  try {
    const outcome = await host.start(startRequest("thread-unknown"));
    assert.equal(outcome.kind, "fallback");
    assert.equal(outcome.kind === "fallback" && outcome.reason, "resume_failed:SessionNotFoundError");
    const methods = fake.log().map((entry) => entry.method);
    assert.ok(methods.includes("thread/resume"));
    assert.ok(!methods.includes("thread/start"), `no fresh thread: ${methods.join(",")}`);
    assert.ok(!methods.includes("turn/start"));
    assert.deepEqual(frames.filter((frame) => frame.type === "agent:process_spawned" || frame.type === "agent:status"), []);
    assert.equal(host.owns("agent-1"), false);
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

/** One turn as codex app-server reports it: a command, an MCP call, a two-file change, commentary, a final answer, a warning. */
const SCRIPTED_TURN = [
  { method: "item/started", params: { item: { type: "agentMessage", id: "msg-c", phase: "commentary", text: "" } } },
  { method: "item/agentMessage/delta", params: { itemId: "msg-c", delta: "Checking the files first." } },
  { method: "item/completed", params: { item: { type: "agentMessage", id: "msg-c", phase: "commentary", text: "Checking the files first." } } },
  { method: "item/started", params: { item: { type: "commandExecution", id: "cmd-1", command: "/bin/bash -lc 'ls -la'", status: "inProgress" } } },
  { method: "item/completed", params: { item: { type: "commandExecution", id: "cmd-1", command: "/bin/bash -lc 'ls -la'", status: "failed", exitCode: 2, aggregatedOutput: "ls: x" } } },
  { method: "item/started", params: { item: { type: "mcpToolCall", id: "mcp-1", server: "github", tool: "create_issue", arguments: { title: "Bug" }, status: "inProgress" } } },
  { method: "item/completed", params: { item: { type: "mcpToolCall", id: "mcp-1", server: "github", tool: "create_issue", arguments: { title: "Bug" }, status: "completed", result: { content: [] } } } },
  { method: "item/started", params: { item: { type: "fileChange", id: "fc-1", status: "inProgress", changes: [{ path: "/w/a.ts", kind: { type: "update" }, diff: "" }, { path: "/w/b.ts", kind: { type: "add" }, diff: "" }] } } },
  { method: "item/completed", params: { item: { type: "fileChange", id: "fc-1", status: "completed", changes: [{ path: "/w/a.ts", kind: { type: "update" }, diff: "" }, { path: "/w/b.ts", kind: { type: "add" }, diff: "" }] } } },
  { method: "configWarning", params: { summary: "Unknown key foo", details: "foo = 1", path: "/c/config.toml" } },
  { method: "item/started", params: { item: { type: "agentMessage", id: "msg-f", phase: "final_answer", text: "" } } },
  { method: "item/agentMessage/delta", params: { itemId: "msg-f", delta: "All done." } },
  { method: "item/completed", params: { item: { type: "agentMessage", id: "msg-f", phase: "final_answer", text: "All done." } } },
];

test("a Codex turn shows the same tool rows, text and warnings on the OAR host as the legacy driver reports", async () => {
  const fake = installFakeCodex();
  const turnPath = path.join(fake.root, "turn.json");
  writeFileSync(turnPath, JSON.stringify(SCRIPTED_TURN));
  process.env.FAKE_CODEX_TURN = turnPath;
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  try {
    // The legacy driver's reading of the same notifications.
    const normalizer = new CodexEventNormalizer();
    normalizer.reset({ threadId: "thread-x" });
    const legacy = [
      { method: "turn/started", params: { threadId: "thread-x", turn: { id: "turn-1" } } },
      ...SCRIPTED_TURN.map((note) => ({ method: note.method, params: { threadId: "thread-x", turnId: "turn-1", ...note.params } })),
    ].flatMap((note) => normalizer.normalizeMessage(note).events);
    const legacyTools = legacy.flatMap((event) => event.kind === "tool_call" ? [[normalizeToolDisplayInvocation(event.name, event.input).toolName, event.callId]] : []);
    const legacyEnds = legacy.flatMap((event) => event.kind === "tool_output" ? [event.callId] : []);
    const legacyText = legacy.flatMap((event) => event.kind === "text" ? [event.text] : []);
    assert.deepEqual(legacyTools.map(([name]) => name).slice(1), ["mcp_github_create_issue", "file_change", "file_change"]);

    assert.deepEqual(await host.start(startRequest(null)), { kind: "started" });
    const entries = () => frames.flatMap((frame) => frame.type === "agent:activity" ? frame.entries ?? [] : []);
    const deadline = Date.now() + 10_000;
    while (!frames.some((frame) => frame.type === "agent:activity" && frame.detailKind === "idle")) {
      if (Date.now() > deadline) assert.fail(`no idle: ${JSON.stringify(entries())}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const oarTools = entries().flatMap((entry) => entry.kind === "tool_start" ? [[entry.toolName, entry.callId]] : []);
    const oarEnds = entries().flatMap((entry) => entry.kind === "status" && entry.detailKind === "tool_end" ? [entry.tool] : []);
    const oarText = entries().flatMap((entry) => entry.kind === "text" ? [entry.text] : []);
    assert.deepEqual(oarTools, legacyTools);
    assert.deepEqual(oarEnds.map((tool) => tool?.callId), legacyEnds);
    // What the legacy driver does not say: the command ran (ok) and exited 2.
    assert.equal(oarEnds[0]?.exitCode, 2);
    assert.equal(oarEnds[0]?.ok, true);
    // Commentary stays out on both.
    assert.deepEqual(oarText, legacyText);
    assert.deepEqual(oarText, ["All done."]);
    assert.ok(entries().some((entry) => entry.kind === "system" && entry.title === "Codex config warning" && entry.text.includes("Path: /c/config.toml")), JSON.stringify(entries()));

    // A second turn, read live (the first came through the replay): the same rows again.
    const firstTurn = entries().length;
    const idles = frames.filter((frame) => frame.type === "agent:activity" && frame.detailKind === "idle").length;
    assert.equal(await host.deliverMessage("agent-1", { ...exampleMessage, message_id: "m-second" }, { deliveryId: "d-second" }), true);
    while (frames.filter((frame) => frame.type === "agent:activity" && frame.detailKind === "idle").length <= idles) {
      if (Date.now() > deadline + 10_000) assert.fail(`no second idle: ${JSON.stringify(entries().slice(firstTurn))}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const second = entries().slice(firstTurn);
    assert.deepEqual(second.flatMap((entry) => entry.kind === "tool_start" ? [[entry.toolName, entry.callId]] : []), legacyTools);
    assert.deepEqual(second.flatMap((entry) => entry.kind === "text" ? [entry.text] : []), ["All done."]);
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

test("a Codex turn whose final answer is blank says so on the OAR host", async () => {
  const fake = installFakeCodex();
  const turnPath = path.join(fake.root, "turn.json");
  writeFileSync(turnPath, JSON.stringify([
    { method: "item/started", params: { item: { type: "agentMessage", id: "msg-c", phase: "commentary", text: "" } } },
    { method: "item/agentMessage/delta", params: { itemId: "msg-c", delta: "Thinking about it." } },
    { method: "item/started", params: { item: { type: "agentMessage", id: "msg-f", phase: "final_answer", text: "" } } },
    { method: "item/agentMessage/delta", params: { itemId: "msg-f", delta: " \n" } },
  ]));
  process.env.FAKE_CODEX_TURN = turnPath;
  const frames: MachineToServerMessage[] = [];
  const host = hostFor(fake, frames);
  try {
    assert.deepEqual(await host.start(startRequest(null)), { kind: "started" });
    const entries = () => frames.flatMap((frame) => frame.type === "agent:activity" ? frame.entries ?? [] : []);
    const deadline = Date.now() + 10_000;
    while (!entries().some((entry) => entry.kind === "system" && entry.text.includes("without a user-visible answer"))) {
      if (Date.now() > deadline) assert.fail(`no blank-answer row: ${JSON.stringify(entries())}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(entries().filter((entry) => entry.kind === "text"), []);
  } finally {
    await host.stopAll();
    fake.restore();
  }
});

// Guard for the fixture itself: it must be runnable by this Node.
test("fake codex fixture answers the driver's probes", () => {
  const fake = installFakeCodex();
  try {
    assert.equal(spawnSync(fake.command, ["--version"], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync(fake.command, ["app-server", "--help"], { encoding: "utf8" }).status, 0);
  } finally {
    fake.restore();
  }
});
