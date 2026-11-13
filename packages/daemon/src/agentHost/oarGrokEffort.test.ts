// RFC 060 host switch, grok (#oar-raft:#4 gap 4): the model and reasoning
// effort an agent chose reach Grok on the OAR host, through OAR's real grok
// runtime (`@botiverse/oar/runtimes/grok`), the way they reach it on the legacy
// driver.
//
// The legacy driver sends the effort with `session/set_model` (`_meta`); OAR
// sends it as `session/set_config_option` on the `thought_level` option Grok
// advertises (`reasoning_effort`, per model), after any `set_model`. The fake
// below answers with the shapes OAR documents for Grok 1.0.41+, without the
// `model_changed`/`config_option_update` pushes OAR does not wait for on grok (OAR
// docs/runtimes/grok.md, "Effort"): `session/new`/`session/resume` carry
// `models` and `configOptions`, `set_config_option` answers every option's
// current value, an effort the model does not offer is `-32602 Invalid params`
// ("unknown reasoning_effort value"), and a session keeps its level across a
// resume. Each prompt is logged with the model and effort in effect, so a test
// reads what the turn ran at, not only what was asked.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, MachineToServerMessage } from "@botiverse/raft-shared";
import type { AgentStartRequest } from "./agentLifecycleHost";
import { OarAgentHost } from "./oarAgentHost";

const FAKE_GROK = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("grok 1.0.77\n"); process.exit(0); }
if (!args.includes("agent") || args[args.length - 1] !== "stdio") { process.stderr.write("unexpected argv " + JSON.stringify(args) + "\n"); process.exit(2); }
const MENUS = { "grok-4.7": ["xhigh", "high", "medium", "low"], "grok-4.5": ["high", "medium", "low"] };
const DEFAULT_MODEL = "grok-4.7";
const DEFAULT_EFFORT = "high";
const storePath = process.env.FAKE_GROK_STORE;
const logPath = process.env.FAKE_GROK_LOG;
const read = () => (fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : {});
const write = (store) => fs.writeFileSync(storePath, JSON.stringify(store));
const log = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const invalid = (id, data) => send({ id, error: { code: -32602, message: "Invalid params", data } });
const models = (session) => ({ currentModelId: session.model, availableModels: Object.keys(MENUS).map((modelId) => ({ modelId, name: modelId })) });
// FAKE_GROK_PLAIN: another ACP command in the grok slot, with no effort option.
const configOptions = (session) => process.env.FAKE_GROK_PLAIN === "1" ? undefined : [{
  id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
  currentValue: session.effort, options: MENUS[session.model].map((value) => ({ value, name: value })),
}];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined || message.id === undefined) return;
  const store = read();
  const sessionId = message.params && message.params.sessionId;
  const session = sessionId === undefined ? undefined : store[sessionId];
  log({ method: message.method, params: message.params, ...(session ? { model: session.model, effort: session.effort } : {}) });
  switch (message.method) {
    case "initialize":
      return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, authMethods: [] } });
    case "session/new": {
      const id = "grok-" + Object.keys(store).length + "-" + process.pid;
      store[id] = { cwd: message.params.cwd, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
      write(store);
      return send({ id: message.id, result: { sessionId: id, models: models(store[id]), configOptions: configOptions(store[id]) } });
    }
    case "session/resume":
      if (!session || session.cwd !== message.params.cwd) {
        return send({ id: message.id, error: { code: -32603, message: "Path not found", data: { code: "FS_NOT_FOUND" } } });
      }
      return send({ id: message.id, result: { models: models(session), configOptions: configOptions(session) } });
    case "session/set_model": {
      const menu = MENUS[message.params.modelId];
      if (!session || !menu) return invalid(message.id, "unknown model");
      session.model = message.params.modelId;
      if (!menu.includes(session.effort)) session.effort = DEFAULT_EFFORT;
      write(store);
      return send({ id: message.id, result: { _meta: { model: session.model } } });
    }
    case "session/set_config_option": {
      if (!session || message.params.configId !== "reasoning_effort") return invalid(message.id, "unknown config option");
      if (!MENUS[session.model].includes(message.params.value)) return invalid(message.id, "unknown reasoning_effort value");
      session.effort = message.params.value;
      write(store);
      return send({ id: message.id, result: { configOptions: configOptions(session) } });
    }
    case "session/prompt":
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
      return send({ id: message.id, result: { stopReason: "end_turn" } });
    default:
      return send({ id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
`;

interface LoggedRequest {
  method: string;
  params: Record<string, unknown>;
  /** The session's model and effort when the request arrived. */
  model?: string;
  effort?: string;
}

interface FakeGrok {
  root: string;
  workDir: string;
  slockHome: string;
  log(): LoggedRequest[];
  /** A session as grok keeps it, as if an earlier launch had left it. */
  seedSession(sessionId: string, saved: { model: string; effort: string }): void;
  restore(): void;
}

function installFakeGrok(options: { plain?: boolean } = {}): FakeGrok {
  const root = mkdtempSync(path.join(os.tmpdir(), "oar-grok-effort-"));
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
  const storePath = path.join(root, "sessions.json");
  const previous = {
    PATH: process.env.PATH,
    FAKE_GROK_STORE: process.env.FAKE_GROK_STORE,
    FAKE_GROK_LOG: process.env.FAKE_GROK_LOG,
    GROK_HOME: process.env.GROK_HOME,
    FAKE_GROK_PLAIN: process.env.FAKE_GROK_PLAIN,
  };
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.FAKE_GROK_STORE = storePath;
  process.env.FAKE_GROK_LOG = logPath;
  process.env.GROK_HOME = path.join(root, "grok-home");
  if (options.plain) process.env.FAKE_GROK_PLAIN = "1";
  else delete process.env.FAKE_GROK_PLAIN;
  return {
    root,
    workDir,
    slockHome,
    log: () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
    seedSession: (sessionId, saved) => {
      const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {};
      store[sessionId] = { cwd: workDir, ...saved };
      writeFileSync(storePath, JSON.stringify(store));
    },
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const baseConfig: AgentConfig = {
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

interface RecordedEvent { name: string; attrs: Record<string, unknown> }

function hostFor(fake: FakeGrok, frames: MachineToServerMessage[], events: RecordedEvent[]): OarAgentHost {
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
    recordEvent: (name, attrs) => { events.push({ name, attrs: (attrs ?? {}) as Record<string, unknown> }); },
    fetchImpl: async () => new Response(null, { status: 204 }),
    platform: "linux",
  });
}

function startRequest(config: Partial<AgentConfig>): AgentStartRequest {
  return {
    agentId: "agent-1",
    config: { ...baseConfig, ...config, runtimeHost: "oar" },
    launchId: "launch-oar",
    wakeMessageTransient: false,
    recoveryGrant: null,
    claimedConnectionEpochId: null,
  };
}

/**
 * The first prompt grok logged. The host reports "started" once the prompt is
 * accepted, before grok has read it, so a loaded runner can read the log first.
 */
async function firstPrompt(fake: FakeGrok, timeoutMs = 10_000): Promise<LoggedRequest> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const prompt = fake.log().find((entry) => entry.method === "session/prompt");
    if (prompt) return prompt;
    if (Date.now() > deadline) assert.fail(`grok never got a prompt: ${fake.log().map((entry) => entry.method).join(",")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withHost(
  run: (fake: FakeGrok, host: OarAgentHost, frames: MachineToServerMessage[], events: RecordedEvent[]) => Promise<void>,
  options: { plain?: boolean } = {},
): Promise<void> {
  const fake = installFakeGrok(options);
  const frames: MachineToServerMessage[] = [];
  const events: RecordedEvent[] = [];
  const host = hostFor(fake, frames, events);
  try {
    try {
      await run(fake, host, frames, events);
    } finally {
      await host.stopAll();
    }
  } finally {
    fake.restore();
  }
}

const methods = (fake: FakeGrok) => fake.log().map((entry) => entry.method);

test("effort without a model: OAR sets it on Grok's default model and the first turn runs at it", async () => {
  await withHost(async (fake, host) => {
    assert.deepEqual(await host.start(startRequest({ reasoningEffort: "low" })), { kind: "started" });
    const prompt = await firstPrompt(fake);
    assert.ok(!methods(fake).includes("session/set_model"), `the default model is not selected: ${methods(fake).join(",")}`);
    const set = fake.log().filter((entry) => entry.method === "session/set_config_option");
    assert.equal(set.length, 1);
    assert.equal(set[0]!.params.configId, "reasoning_effort");
    assert.equal(set[0]!.params.value, "low");
    assert.equal(prompt.model, "grok-4.7");
    assert.equal(prompt.effort, "low");
  });
});

test("model and effort: the model first, then the effort from that model's menu", async () => {
  await withHost(async (fake, host) => {
    assert.deepEqual(await host.start(startRequest({ model: "grok-4.5", reasoningEffort: "medium" })), { kind: "started" });
    const prompt = await firstPrompt(fake);
    const order = methods(fake).filter((method) => method === "session/set_model" || method === "session/set_config_option");
    assert.deepEqual(order, ["session/set_model", "session/set_config_option"]);
    assert.equal(prompt.model, "grok-4.5");
    assert.equal(prompt.effort, "medium");
  });
});

test("no effort chosen: Grok's own level stays, nothing is set", async () => {
  await withHost(async (fake, host) => {
    assert.deepEqual(await host.start(startRequest({})), { kind: "started" });
    const prompt = await firstPrompt(fake);
    assert.ok(!methods(fake).includes("session/set_config_option"), methods(fake).join(","));
    assert.equal(prompt.effort, "high");
  });
});

test("an effort the model does not offer: handed back to the legacy host before any prompt, classified settings_not_confirmed", async () => {
  await withHost(async (fake, host, frames, events) => {
    const outcome = await host.start(startRequest({ model: "grok-4.5", reasoningEffort: "xhigh" }));
    assert.equal(outcome.kind, "fallback");
    assert.equal(outcome.kind === "fallback" && outcome.reason, "open_failed:Error");
    const fallback = events.find((event) => event.name === "daemon.agent.oar.fallback");
    assert.ok(fallback, events.map((event) => event.name).join(","));
    assert.equal(fallback.attrs.open_failure_class, "settings_not_confirmed");
    assert.ok(!methods(fake).includes("session/prompt"), methods(fake).join(","));
    assert.deepEqual(frames.filter((frame) => frame.type === "agent:process_spawned" || frame.type === "agent:status"), []);
    assert.equal(host.owns("agent-1"), false);
  });
});

test("resume: Grok's saved level stays without a choice, and a chosen one replaces it", async () => {
  await withHost(async (fake, host) => {
    fake.seedSession("grok-saved", { model: "grok-4.7", effort: "low" });
    assert.deepEqual(await host.start(startRequest({ sessionId: "grok-saved" })), { kind: "started" });
    const prompt = await firstPrompt(fake);
    assert.ok(methods(fake).includes("session/resume"), methods(fake).join(","));
    assert.ok(!methods(fake).includes("session/set_config_option"), methods(fake).join(","));
    assert.equal(prompt.effort, "low");
  });
  await withHost(async (fake, host) => {
    fake.seedSession("grok-saved", { model: "grok-4.7", effort: "low" });
    assert.deepEqual(await host.start(startRequest({ sessionId: "grok-saved", reasoningEffort: "xhigh" })), { kind: "started" });
    const prompt = await firstPrompt(fake);
    assert.equal(prompt.params.sessionId, "grok-saved");
    assert.equal(prompt.effort, "xhigh");
  });
});

test("a command in the grok slot without an effort option: runs without an effort, hands back a start with one", async () => {
  await withHost(async (fake, host) => {
    assert.deepEqual(await host.start(startRequest({})), { kind: "started" });
    await firstPrompt(fake);
  }, { plain: true });
  await withHost(async (fake, host) => {
    const outcome = await host.start(startRequest({ reasoningEffort: "high" }));
    assert.equal(outcome.kind === "fallback" && outcome.reason, "open_failed:UnsupportedOptionError");
    assert.ok(!methods(fake).includes("session/prompt"), methods(fake).join(","));
  }, { plain: true });
});
