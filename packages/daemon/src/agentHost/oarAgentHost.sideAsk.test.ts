import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { AgentConfig, AgentSideAskAsker, AgentSideAskRequest } from "@botiverse/raft-shared";
import { SIDE_ASK_FORK_MAX_CONTEXT_TOKENS } from "../agentSideAsk";
import { ProviderLimitLedger, providerLimitCredentialKey } from "../providerLimitLedger";
import { harness, makeConfig, message, request, until } from "../testing/oarAgentHostHarness";

const ASKER: AgentSideAskAsker = {
  displayName: "Alice",
  role: "owner",
  isAgentOwner: true,
};

let nextRequestId = 1;
function statusReq(agentId: string): AgentSideAskRequest {
  return { type: "agent:side-ask", requestId: `req-${nextRequestId++}`, agentId, kind: "status" };
}
function questionReq(agentId: string, question: string): AgentSideAskRequest {
  return { type: "agent:side-ask", requestId: `req-${nextRequestId++}`, agentId, kind: "question", question, asker: ASKER };
}

interface FakeForkProcess {
  child: ChildProcess;
  stdinText: () => string;
  killed: string[];
  succeed(resultText: string): void;
  fail(code?: number): void;
}

function makeFakeForkProcess(): FakeForkProcess {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
  };
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  let stdinBuf = "";
  emitter.stdin.setEncoding("utf8");
  emitter.stdin.on("data", (chunk: string) => { stdinBuf += chunk; });
  const killed: string[] = [];
  let closed = false;
  const closeWith = (code: number | null) => {
    if (closed) return;
    closed = true;
    emitter.stdout.end();
    emitter.stderr.end();
    emitter.emit("close", code);
  };
  emitter.kill = (signal = "SIGTERM") => {
    killed.push(signal);
    queueMicrotask(() => closeWith(null));
    return true;
  };
  return {
    child: emitter as unknown as ChildProcess,
    stdinText: () => stdinBuf,
    killed,
    succeed(resultText: string) {
      emitter.stdout.write(JSON.stringify({ result: resultText, is_error: false }));
      closeWith(0);
    },
    fail(code = 1) {
      closeWith(code);
    },
  };
}

async function writeClaudeTranscript(
  homeDir: string,
  sessionId: string,
  options: { inputTokens?: number; noteText?: string; todos?: Array<{ content: string; status: string }> } = {},
): Promise<string> {
  const dir = path.join(homeDir, ".claude", "projects", "-tmp-workspace");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const content: unknown[] = [];
  if (options.todos) {
    content.push({
      type: "tool_use",
      id: "toolu_todo_1",
      name: "TodoWrite",
      input: { todos: options.todos },
    });
  }
  if (options.noteText) {
    content.push({ type: "text", text: options.noteText });
  }
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-20T06:00:00.000Z",
      message: {
        role: "assistant",
        content: content.length > 0 ? content : [{ type: "text", text: "Working on it." }],
        usage: {
          input_tokens: options.inputTokens ?? 12_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 100,
        },
      },
    }),
  ];
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

test("OarAgentHost.sideAsk returns agent_not_running when the agent is absent or stopped", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.host.sideAsk(statusReq("missing")), { outcome: "agent_not_running" });
    const ev = h.events.find((entry) => entry.name === "daemon.agent.side_ask");
    assert.equal(ev?.attrs.outcome, "agent_not_running");
    assert.equal(ev?.attrs.host, "oar");
  } finally {
    await h.cleanup();
  }
});

test("OarAgentHost.sideAsk status reports live activity, oldest open tool, and session summary notes/todos for non-Claude OAR runtimes, while question returns unsupported_runtime", async () => {
  let clock = 1_700_000_000_000;
  let releaseTool!: () => void;
  const toolWait = new Promise<void>((resolve) => { releaseTool = resolve; });
  let allowReadStart!: () => void;
  const readStartGate = new Promise<void>((resolve) => { allowReadStart = resolve; });
  let turnNumber = 0;

  const h = await harness({
    deps: { now: () => clock },
    turn: async (turn) => {
      turnNumber += 1;
      if (turnNumber === 1) {
        await turn.tool(
          "TodoWrite",
          JSON.stringify({ todos: [{ content: "Check metrics", status: "in_progress" }, { content: "Ship PR", status: "pending" }] }),
          () => "ok",
        );
        turn.say("First turn finished cleanly.");
        return;
      }
      // Two concurrent open tools: Bash starts first, Read starts after host observes Bash and clock advances.
      const bash = turn.tool("Bash", JSON.stringify({ command: "pnpm test" }), async () => {
        await toolWait;
        return "ok";
      });
      await readStartGate;
      const read = turn.tool("Read", JSON.stringify({ file_path: "README.md" }), async () => {
        await toolWait;
        return "ok";
      });
      await Promise.all([bash, read]);
    },
  });

  try {
    const startRes = await h.host.start(request({ config: makeConfig({ runtime: "grok" }) }));
    assert.equal(startRes.kind, "started");
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "turn 1 completed");

    const idleStatus = await h.host.sideAsk(statusReq("agent-1"));
    assert.equal(idleStatus.outcome, "answered");
    assert.match(idleStatus.text ?? "", /Open todos \(2 of 2\): \[doing\] Check metrics; Ship PR\./);
    assert.match(idleStatus.text ?? "", /Latest note: First turn finished cleanly\./);

    // Start turn 2 with two open tools; deterministically wait for host observation before advancing clock.
    await h.host.deliverMessage("agent-1", message("m-2", { content: "run tests" }));
    await until(() => h.framesOf("agent:activity").some((f) => JSON.stringify(f).includes("pnpm test")), "Bash started");
    clock += 2 * 60_000;
    allowReadStart();
    await until(() => h.framesOf("agent:activity").some((f) => JSON.stringify(f).includes("README.md")), "Read started");
    clock += 60_000;

    const busyStatus = await h.host.sideAsk(statusReq("agent-1"));
    assert.equal(busyStatus.outcome, "answered");
    assert.match(busyStatus.text ?? "", /Running Bash for 3 minutes\./);

    const question = await h.host.sideAsk(questionReq("agent-1", "What failed?"));
    assert.deepEqual(question, { outcome: "unsupported_runtime" });
    const qEvent = h.events.filter((e) => e.name === "daemon.agent.side_ask").at(-1);
    assert.equal(qEvent?.attrs.runtime, "grok");
    assert.equal(qEvent?.attrs.outcome, "unsupported_runtime");
    assert.equal(qEvent?.attrs.host, "oar");

    releaseTool();
    await h.host.stopAgent("agent-1", { wait: true });
    assert.deepEqual(await h.host.sideAsk(statusReq("agent-1")), { outcome: "agent_not_running" });
  } finally {
    allowReadStart();
    releaseTool();
    await h.cleanup();
  }
});

test("OarAgentHost.sideAsk supports Claude status + read-only question forks, enforces limits/busy, and kills in-flight forks on stopSideAsk/stopAgent", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "oar-side-ask-home-"));
  const providerLimits = new ProviderLimitLedger();
  const forkCalls: Array<{ config: AgentConfig; args: string[]; env: NodeJS.ProcessEnv; cwd: string; fork: FakeForkProcess }> = [];
  let nextFork: FakeForkProcess | null = null;
  const clock = 1_700_000_000_000;

  const h = await harness({
    deps: {
      now: () => clock,
      runtimeSessionHomeDir: homeDir,
      providerLimits,
      prepareLaunch: async (ctx) => ({
        runtimeId: "claude",
        installation: { kind: "available", via: "bundled" },
        options: {
          cwd: ctx.workingDirectory,
          appendSystemPrompt: ctx.standingPrompt,
          ...(ctx.config.sessionId ? { resume: ctx.config.sessionId } : {}),
        },
        busyDelivery: "now",
      }),
      sessionCapabilities: async () => ({
        steer: true,
        queue: true,
        resume: true,
        compact: true,
        contextUsage: { tokens: true, contextWindow: true },
      }),
      startClaudeSideQuestion: (config, args, env, cwd) => {
        assert.ok(nextFork, "unexpected side-ask fork spawn");
        const fork = nextFork;
        nextFork = null;
        forkCalls.push({ config, args, env, cwd, fork });
        return fork.child;
      },
    },
    turn: (turn) => {
      turn.say("Ready.");
    },
  });

  const prevEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    SLOCK_SIDE_ASK_TEST: process.env.SLOCK_SIDE_ASK_TEST,
    RAFT_AGENT_SIDE_ASK_TEST: process.env.RAFT_AGENT_SIDE_ASK_TEST,
  };
  process.env.ANTHROPIC_API_KEY = "sk-host-ambient-key";
  process.env.SLOCK_SIDE_ASK_TEST = "should-not-leak";
  process.env.RAFT_AGENT_SIDE_ASK_TEST = "should-not-leak";

  try {
    const claudeCfg = makeConfig({
      runtime: "claude",
      model: "claude-opus-4-6",
      envVars: null,
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        model: { kind: "preset", id: "claude-opus-4-6" },
        mode: { kind: "default" },
        provider: {
          kind: "custom",
          apiUrl: "https://proxy.example.test",
          authType: "auth_token",
          apiKey: "custom-provider-token",
        },
      },
    });
    const started = await h.host.start(request({ config: claudeCfg }));
    assert.equal(started.kind, "started");
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "claude turn 1 completed");
    const sessionId = h.sessions[0]!.id;

    // Missing transcript -> agent_not_running on question.
    assert.deepEqual(
      await h.host.sideAsk(questionReq("agent-1", "Status?")),
      { outcome: "agent_not_running" },
    );

    // Write Claude JSONL transcript with todos + note + normal context size.
    await writeClaudeTranscript(homeDir, sessionId, {
      inputTokens: 25_000,
      noteText: "Investigating OAR sideAsk parity.",
      todos: [{ content: "Wire OAR sideAsk", status: "in_progress" }],
    });

    // Status reads Claude transcript todos + note.
    const status = await h.host.sideAsk(statusReq("agent-1"));
    assert.equal(status.outcome, "answered");
    assert.match(status.text ?? "", /Open todos \(1 of 1\): \[doing\] Wire OAR sideAsk\./);
    assert.match(status.text ?? "", /Latest note: Investigating OAR sideAsk parity\./);

    // Provider limit blocks question forks.
    const credKey = providerLimitCredentialKey("agent-1", claudeCfg);
    providerLimits.record(
      credKey,
      { untilMs: clock + 60_000, reason: "rate_limit", attempts: 1, providerLimitKind: "transient_rate_limit", recordedAtMs: clock },
      { host: "oar", agentId: "agent-1" },
    );
    assert.deepEqual(
      await h.host.sideAsk(questionReq("agent-1", "Any blocker?")),
      { outcome: "usage_limited" },
    );
    providerLimits.release(credKey, "explicit_stop", { host: "oar", agentId: "agent-1" });

    // Context over SIDE_ASK_FORK_MAX_CONTEXT_TOKENS -> context_too_large.
    await writeClaudeTranscript(homeDir, sessionId, { inputTokens: SIDE_ASK_FORK_MAX_CONTEXT_TOKENS + 1 });
    assert.deepEqual(
      await h.host.sideAsk(questionReq("agent-1", "Too big?")),
      { outcome: "context_too_large" },
    );

    // Back within budget -> launches read-only fork, rejects concurrent busy request, and returns answer.
    await writeClaudeTranscript(homeDir, sessionId, { inputTokens: 25_000 });
    const fork1 = makeFakeForkProcess();
    nextFork = fork1;
    const pending1 = h.host.sideAsk(questionReq("agent-1", "What is the PR status?"));
    await until(() => forkCalls.length === 1, "fork 1 started");

    // Second concurrent question is rejected as busy.
    assert.deepEqual(
      await h.host.sideAsk(questionReq("agent-1", "Second?")),
      { outcome: "busy" },
    );

    const call1 = forkCalls[0]!;
    assert.ok(call1.args.includes("--resume") && call1.args.includes(sessionId));
    assert.ok(call1.args.includes("--fork-session"));
    assert.ok(call1.args.includes("--no-session-persistence"));
    assert.equal(call1.args[call1.args.indexOf("--model") + 1], "claude-opus-4-6");
    assert.equal(call1.args[call1.args.indexOf("--setting-sources") + 1], "project,local");
    assert.equal(call1.args[call1.args.indexOf("--settings") + 1], "{\"disableAllHooks\":true}");
    assert.ok(call1.args.includes("--strict-mcp-config"));
    assert.equal(call1.args[call1.args.indexOf("--mcp-config") + 1], "{\"mcpServers\":{}}");
    const promptFlagIdx = call1.args.indexOf("--append-system-prompt-file");
    assert.ok(promptFlagIdx >= 0);
    const promptPath = call1.args[promptFlagIdx + 1]!;
    assert.ok(promptPath.includes(".agent-state"), "standing prompt lives in daemon-owned state dir, not workspace");
    assert.ok((await readFile(promptPath, "utf8")).length > 0);
    assert.equal(call1.cwd, path.join(h.dataDir, "agent-1"));
    assert.equal(call1.env.CLAUDE_CODE_ENTRYPOINT, "raft");
    assert.equal(call1.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(call1.env.ANTHROPIC_BASE_URL, "https://proxy.example.test");
    assert.equal(call1.env.ANTHROPIC_AUTH_TOKEN, "custom-provider-token");
    assert.equal(call1.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(Object.keys(call1.env).some((k) => k.startsWith("SLOCK_") || k.startsWith("RAFT_AGENT_")), false);
    assert.match(fork1.stdinText(), /What is the PR status\?/);

    fork1.succeed("Tests are green and PR is queued.");
    assert.deepEqual(await pending1, { outcome: "answered", text: "Tests are green and PR is queued." });

    // In-flight fork is killed when stopSideAsk is called.
    const fork2 = makeFakeForkProcess();
    nextFork = fork2;
    const pending2 = h.host.sideAsk(questionReq("agent-1", "Hold on?"));
    await until(() => forkCalls.length === 2, "fork 2 started");
    h.host.stopSideAsk("agent-1");
    assert.deepEqual(await pending2, { outcome: "agent_not_running" });
    assert.deepEqual(fork2.killed, ["SIGKILL"]);

    // In-flight fork is also killed when stopAll runs.
    const fork3 = makeFakeForkProcess();
    nextFork = fork3;
    const pending3 = h.host.sideAsk(questionReq("agent-1", "Stopping?"));
    await until(() => forkCalls.length === 3, "fork 3 started");
    await h.host.stopAll();
    assert.deepEqual(await pending3, { outcome: "agent_not_running" });
    assert.deepEqual(fork3.killed, ["SIGKILL"]);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await h.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});
