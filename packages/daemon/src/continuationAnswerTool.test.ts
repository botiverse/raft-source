// The daemon-local answer tool (continuationAnswerTool.ts) on the managed MCP
// proxy, through a real MCP client over the proxy's HTTP endpoint. The `raft`
// it runs is a fake shell script in a temp dir that prints what it was given
// and exits with the code its environment asks for (never the real CLI), so
// each test sees exactly which binary ran, as which agent, with which
// arguments and stdin.
//
// RED proof: list the tool without the registration's runner and the
// "not listed" tests fail; forward it to callTool and "never forwarded" fails;
// take the runner from the arguments and the token-isolation test fails; drop
// the id/choice/text checks and the "without spawning" tests find the marker;
// drop the stop and the timeout test finds the child alive; drop the SIGKILL
// escalation and the TERM-trapping child survives; drop the response-close
// hook or the notifications/cancelled match and the two cancellation tests
// find the child alive; let a catalog failure fail the list and the
// catalog-down test loses the tool.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ManagedMcpCallRequest, ManagedMcpRuntimeSnapshot } from "@botiverse/raft-shared";
import {
  callContinuationAnswerTool,
  continuationAnswerRunnerForLaunch,
  type ContinuationAnswerRunner,
} from "./continuationAnswerTool";
import {
  __resetManagedMcpRuntimeProxyForTest,
  prepareManagedMcpRuntimeProxy,
  registerManagedMcpRuntimeProxy,
} from "./managedMcpRuntimeProxy";

const ID = "k7q2m3x9ab";
const EMPTY: ManagedMcpRuntimeSnapshot = { catalogVersion: 1, tools: [] };

/**
 * The fake `raft`: touches FAKE_MARK (so a test can tell it ran), then by
 * FAKE_MODE prints and exits as the CLI would for an answer that finished
 * (0), paused again (10), was refused (1), crashed (3), echoes its stdin, or
 * hangs (its pid in FAKE_PID first).
 */
const FAKE_RAFT = `#!/bin/sh
[ -n "$FAKE_MARK" ] && : > "$FAKE_MARK"
case "$FAKE_MODE" in
  done) printf 'Sent to #ops (#1).\\nbin=%s agent=%s via=%s tool=%s args=%s\\n' "$0" "$SLOCK_AGENT_ID" "$RAFT_CONTINUATION_VIA" "$RAFT_CONTINUATION_TOOL" "$*"; exit 0;;
  paused) printf 'Post the rest?\\nChoose one of these (continuation mmmmmmmmmm, expires at 13:12 UTC):\\n  y) Yes\\n'; exit 10;;
  refused) printf 'raft: this CLI belongs to agent %s; the calling process is agent other-agent. Use your own raft command.\\n' "$SLOCK_AGENT_ID" >&2; exit 1;;
  refused-both) printf 'partial\\n'; printf 'Continuation %s was already answered.\\n' "$2" >&2; exit 1;;
  crash) printf 'boom\\n' >&2; exit 3;;
  warn) printf 'Sent to #ops (#1).\\n'; printf 'Warning: your draft was replaced.\\n' >&2; exit 0;;
  paused-warn) printf 'Post the rest?\\n'; printf 'Warning: slow server.\\n' >&2; exit 10;;
  refused-silent) exit 1;;
  stubborn) trap '' TERM; echo $$ > "$FAKE_PID"; while :; do sleep 0.05; done;;
  stdin) printf 'stdin=['; cat; printf ']\\n'; exit 0;;
  big) i=0; while [ $i -lt 200 ]; do printf '0123456789'; i=$((i+1)); done; exit 0;;
  hang) echo $$ > "$FAKE_PID"; exec sleep 30;;
esac
exit 99
`;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "raft-answer-tool-"));
});

afterEach(async () => {
  await __resetManagedMcpRuntimeProxyForTest();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake raft for one agent: its own bin path and the env the launch captured. */
function fakeRunner(agentId: string, mode: string, limits?: ContinuationAnswerRunner["limits"]): ContinuationAnswerRunner & { mark: string; pidFile: string } {
  const agentDir = mkdtempSync(path.join(dir, `${agentId}-`));
  const raftBin = path.join(agentDir, "raft");
  writeFileSync(raftBin, FAKE_RAFT, { mode: 0o755 });
  const mark = path.join(agentDir, "ran");
  const pidFile = path.join(agentDir, "pid");
  const runner = continuationAnswerRunnerForLaunch({
    config: { runtime: "claude", continuationTool: true },
    raftBin,
    env: { PATH: process.env.PATH, SLOCK_AGENT_ID: agentId, FAKE_MODE: mode, FAKE_MARK: mark, FAKE_PID: pidFile },
    cwd: agentDir,
    platform: "linux",
  });
  assert.ok(runner);
  return { ...runner, ...(limits ? { limits } : {}), mark, pidFile };
}

async function register(
  agentId: string,
  runner: ContinuationAnswerRunner | undefined,
  calls: ManagedMcpCallRequest[] = [],
  loadSnapshot: () => Promise<ManagedMcpRuntimeSnapshot> = async () => EMPTY,
) {
  return registerManagedMcpRuntimeProxy({
    agentId,
    launchId: `launch-${agentId}`,
    snapshot: EMPTY,
    loadSnapshot,
    async callTool(request) {
      calls.push(request);
      return { isError: false, content: [{ type: "text", text: "forwarded" }] };
    },
    ...(runner ? { continuationRunner: runner } : {}),
  });
}

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "answer-tool-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function answer(url: string, args: Record<string, unknown>): Promise<ToolResult> {
  return withClient(url, async (client) => (await client.callTool({ name: "answer_continuation", arguments: args })) as ToolResult);
}

const textOf = (result: ToolResult): string => result.content.map((part) => part.text ?? "").join("");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for the fake's pid file, then for that process to be gone (false if it outlives `withinMs`). */
async function diesWithin(pidFile: string, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(pid > 0);
  while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return !isAlive(pid);
}

test("offered only with the flag on, for a runtime the pilot reaches, off Windows", () => {
  const base = { raftBin: "/x/raft", env: { SLOCK_AGENT_ID: "a" }, platform: "linux" as const };
  assert.equal(continuationAnswerRunnerForLaunch({ ...base, config: { runtime: "claude" } }), null, "flag absent");
  assert.equal(continuationAnswerRunnerForLaunch({ ...base, config: { runtime: "claude", continuationTool: false } }), null, "flag off");
  assert.equal(continuationAnswerRunnerForLaunch({ ...base, config: { runtime: "codex", continuationTool: true } }), null, "runtime outside CONTINUATIONS_PILOT_RUNTIMES");
  assert.equal(continuationAnswerRunnerForLaunch({ ...base, platform: "win32", config: { runtime: "claude", continuationTool: true } }), null, "a .cmd wrapper needs a shell");
  const runner = continuationAnswerRunnerForLaunch({ ...base, config: { runtime: "claude", continuationTool: true } });
  assert.deepEqual(runner, {
    raftBin: "/x/raft",
    env: { SLOCK_AGENT_ID: "a", RAFT_CONTINUATION_TOOL: "answer_continuation", RAFT_CONTINUATION_VIA: "tool" },
  });
});

test("not listed and not callable without the launch's runner; never forwarded to the Server", async () => {
  const calls: ManagedMcpCallRequest[] = [];
  const handle = await register("agent-off", undefined, calls);
  await withClient(handle.url, async (client) => {
    assert.deepEqual((await client.listTools()).tools, []);
  });
  const result = await answer(handle.url, { id: ID, choice: "a" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /not available to this Agent; answer in a shell with cont <id> <choice>/);
  assert.deepEqual(calls, [], "nothing reached the Server gateway");
});

test("listed, unprefixed, beside the catalog tools, when the launch offers it", async () => {
  const handle = await register("agent-on", fakeRunner("agent-on", "done"));
  await withClient(handle.url, async (client) => {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ["answer_continuation"]);
    const [tool] = tools;
    assert.equal(tool!.description, "Answers a question a raft command paused on. The id and the choice letters are printed in the question; text is for an option that takes text.");
    assert.deepEqual(tool!.inputSchema.required, ["id"]);
    assert.deepEqual(Object.keys(tool!.inputSchema.properties ?? {}), ["id", "choice", "text"]);
  });
});

test("exit 0: the command's result as it printed it, run as the launch's agent with via=tool", async () => {
  const calls: ManagedMcpCallRequest[] = [];
  const runner = fakeRunner("agent-done", "done");
  const handle = await register("agent-done", runner, calls);
  const result = await answer(handle.url, { id: ID.toUpperCase(), choice: "a" });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), `Sent to #ops (#1).\nbin=${runner.raftBin} agent=agent-done via=tool tool=answer_continuation args=__continue ${ID} a\n`);
  assert.deepEqual(calls, [], "never forwarded to the Server");
});

test("a catalog reload that fails still lists the answer tool; without it the list fails as before", async () => {
  const failing = async (): Promise<ManagedMcpRuntimeSnapshot> => {
    throw new Error("Raft MCP gateway request failed: HTTP 503");
  };
  const withTool = await register("agent-catalog-down", fakeRunner("agent-catalog-down", "done"), [], failing);
  await withClient(withTool.url, async (client) => {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["answer_continuation"]);
  });
  assert.match(textOf(await answer(withTool.url, { id: ID, choice: "a" })), /^Sent to #ops/);

  const withoutTool = await register("agent-catalog-down-off", undefined, [], failing);
  await withClient(withoutTool.url, async (client) => {
    await assert.rejects(client.listTools(), /HTTP 503/);
  });
});

test("exit 0 and 10 keep the command's stderr after its stdout, as a shell shows both", async () => {
  const done = await register("agent-warn", fakeRunner("agent-warn", "warn"));
  const result = await answer(done.url, { id: ID, choice: "a" });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), "Sent to #ops (#1).\nWarning: your draft was replaced.");
  const paused = await register("agent-paused-warn", fakeRunner("agent-paused-warn", "paused-warn"));
  const next = await answer(paused.url, { id: ID, choice: "a" });
  assert.equal(next.isError, undefined);
  assert.equal(textOf(next), "Post the rest?\nWarning: slow server.");
});

test("exit 10: the next question, as a normal result", async () => {
  const handle = await register("agent-paused", fakeRunner("agent-paused", "paused"));
  const result = await answer(handle.url, { id: ID, choice: "a" });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), "Post the rest?\nChoose one of these (continuation mmmmmmmmmm, expires at 13:12 UTC):\n  y) Yes\n");
});

test("exit 1: the refusal as an error result, a foreign-caller refusal included", async () => {
  const handle = await register("agent-refused", fakeRunner("agent-refused", "refused"));
  const result = await answer(handle.url, { id: ID, choice: "a" });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), "raft: this CLI belongs to agent agent-refused; the calling process is agent other-agent. Use your own raft command.");

  const both = await register("agent-refused-both", fakeRunner("agent-refused-both", "refused-both"));
  const refused = await answer(both.url, { id: ID, choice: "a" });
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), `Continuation ${ID} was already answered.\npartial`, "stderr first, then any stdout");

  const silent = await register("agent-refused-silent", fakeRunner("agent-refused-silent", "refused-silent"));
  const bare = await answer(silent.url, { id: ID, choice: "a" });
  assert.equal(bare.isError, true);
  assert.equal(textOf(bare), `The answer to continuation ${ID} was refused without a reason. Run the original command again, or answer in a shell to see why: cont ${ID} a`);
});

test("any other exit: an error result that says so, with what the command printed", async () => {
  const handle = await register("agent-crash", fakeRunner("agent-crash", "crash"));
  const result = await answer(handle.url, { id: ID, choice: "b" });
  assert.equal(result.isError, true);
  assert.equal(
    textOf(result),
    `boom\nAnswering continuation ${ID} exited with code 3, so it is not known whether it took effect. Check first, then answer again or in a shell: cont ${ID} b`,
  );
});

test("a raft that cannot be started: an error result with the shell fallback", async () => {
  const runner = fakeRunner("agent-missing", "done");
  const handle = await register("agent-missing", { ...runner, raftBin: path.join(dir, "no-such-raft") });
  const result = await answer(handle.url, { id: ID, choice: "a" });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), `This agent's raft command could not be started (ENOENT), so the question is still open. Answer it in a shell instead: cont ${ID} a`);
});

test("text goes on stdin only; without text stdin is empty at once", async () => {
  const runner = fakeRunner("agent-stdin", "stdin");
  const handle = await register("agent-stdin", runner);
  const withText = await answer(handle.url, { id: ID, choice: "b", text: "line one\n$(touch /tmp/never) `x` ;|&\n" });
  assert.equal(textOf(withText), "stdin=[line one\n$(touch /tmp/never) `x` ;|&\n]\n");

  const started = Date.now();
  const without = await answer(handle.url, { id: ID, choice: "a" });
  assert.equal(textOf(without), "stdin=[]\n");
  assert.ok(Date.now() - started < 900, "no wait for a stdin that never comes");
  assert.equal(textOf(await answer(handle.url, { id: ID, choice: "a", text: "" })), "stdin=[]\n", "empty text is no text");
});

test("an invalid id, choice or argument is refused before anything runs", async () => {
  const runner = fakeRunner("agent-invalid", "done");
  const handle = await register("agent-invalid", runner);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ choice: "a" }, /The id is missing/],
    [{ id: "not-an-id", choice: "a" }, /That is not a continuation id/],
    [{ id: `${ID}; rm -rf /`, choice: "a" }, /That is not a continuation id/],
    [{ id: ID, choice: "a; rm -rf /" }, /The choice must be one option letter/],
    [{ id: ID, choice: "-a" }, /The choice must be one option letter/],
    [{ id: ID, choice: "a".repeat(33) }, /The choice must be one option letter/],
    [{ id: ID, choice: 1 }, /The choice must be one option letter/],
    [{ id: ID, choice: "b", text: 7 }, /The text must be a string/],
    // Who answers is the launch's: an agent id, a binary or an env in the arguments is refused, not honoured.
    [{ id: ID, choice: "a", agentId: "agent-other" }, /takes only id, choice and text, not agentId/],
    [{ id: ID, choice: "a", env: { SLOCK_AGENT_ID: "agent-other" }, raftBin: "/bin/sh" }, /not env, raftBin/],
  ];
  for (const [args, expected] of cases) {
    const result = await answer(handle.url, args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), expected, JSON.stringify(args));
    assert.match(textOf(result), /Call answer_continuation with the id the question printed/, "each refusal gives the next step");
  }
  assert.equal(existsSync(runner.mark), false, "the raft was never run");
});

test("text over the cap is refused before anything runs", async () => {
  const runner = fakeRunner("agent-big-text", "stdin", { maxTextBytes: 16 });
  const handle = await register("agent-big-text", runner);
  const ok = await answer(handle.url, { id: ID, choice: "b", text: "x".repeat(16) });
  assert.equal(ok.isError, undefined);
  rmSync(runner.mark, { force: true });
  // 17 bytes in UTF-8, 9 characters: the cap is in bytes.
  const result = await answer(handle.url, { id: ID, choice: "b", text: "é".repeat(8) + "x" });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), "The text is longer than 16 bytes, so it was not sent and the question is still open. Shorten it and call answer_continuation again with the same id and choice.");
  assert.equal(existsSync(runner.mark), false);
});

test("captured output is capped", async () => {
  const handle = await register("agent-big-out", fakeRunner("agent-big-out", "big", { maxOutputBytes: 100 }));
  const result = await answer(handle.url, { id: ID, choice: "a" });
  assert.equal(textOf(result), `${"0123456789".repeat(10)}\n[output cut at 100 bytes; 1900 more bytes not shown]`);
});

const STOPPED_NEXT_STEP = `First check whether it did (for a message, raft message read on the conversation you were writing to). If it did not, wait 30 seconds (the stopped run holds the continuation until then), then answer again with the same id and choice, or in a shell: cont ${ID} c`;

test("a timeout stops the child (SIGTERM) and returns an error result that ends with the next step", async () => {
  const runner = fakeRunner("agent-hang", "hang", { timeoutMs: 300 });
  const handle = await register("agent-hang", runner);
  const started = Date.now();
  const result = await answer(handle.url, { id: ID, choice: "c" });
  assert.ok(Date.now() - started < 2_000, "answered at the timeout, not after the kill grace");
  assert.equal(result.isError, true);
  assert.equal(textOf(result), `The answer to continuation ${ID} did not finish within 300 ms and was stopped; it may or may not have taken effect. ${STOPPED_NEXT_STEP}`);
  assert.equal(await diesWithin(runner.pidFile, 1_000), true, "SIGTERM ended it");
});

test("a child that ignores SIGTERM is killed after the grace", async () => {
  const runner = fakeRunner("agent-stubborn", "stubborn", { timeoutMs: 300, killGraceMs: 300 });
  const handle = await register("agent-stubborn", runner);
  const result = await answer(handle.url, { id: ID, choice: "c" });
  assert.equal(result.isError, true);
  const pid = Number(readFileSync(runner.pidFile, "utf8").trim());
  assert.equal(isAlive(pid), true, "still running through the grace (it traps TERM)");
  assert.equal(await diesWithin(runner.pidFile, 3_000), true, "SIGKILL after the grace");
});

test("a cancelled call stops the child and says what to do next", async () => {
  const runner = fakeRunner("agent-cancel", "hang");
  const controller = new AbortController();
  const pending = callContinuationAnswerTool(runner, { id: ID, choice: "c" }, { signal: controller.signal });
  while (!existsSync(runner.pidFile)) await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(textOf(result as ToolResult), `The answer to continuation ${ID} was cancelled and its command stopped; it may or may not have taken effect. ${STOPPED_NEXT_STEP}`);
  assert.equal(await diesWithin(runner.pidFile, 1_000), true);

  // Cancelled before it ran: nothing runs.
  const idle = fakeRunner("agent-cancel-early", "done");
  const early = await callContinuationAnswerTool(idle, { id: ID, choice: "a" }, { signal: AbortSignal.abort() });
  assert.equal(textOf(early as ToolResult), `The answer to continuation ${ID} was cancelled before it ran, so the question is still open. Answer again with the same id and choice, or in a shell: cont ${ID} a`);
  assert.equal(existsSync(idle.mark), false);
});

test("an MCP client that cancels its call (an interrupted turn) stops the child", async () => {
  const runner = fakeRunner("agent-mcp-cancel", "hang");
  const handle = await register("agent-mcp-cancel", runner);
  const controller = new AbortController();
  await withClient(handle.url, async (client) => {
    const pending = client.callTool({ name: "answer_continuation", arguments: { id: ID, choice: "c" } }, undefined, { signal: controller.signal });
    while (!existsSync(runner.pidFile)) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(pending);
  });
  assert.equal(await diesWithin(runner.pidFile, 2_000), true, "the cancellation reached the daemon and stopped the child");
});

test("a notifications/cancelled for the call, sent as its own POST (this proxy is stateless), stops the child", async () => {
  const runner = fakeRunner("agent-notify-cancel", "hang");
  const handle = await register("agent-notify-cancel", runner);
  const post = (body: unknown) => fetch(handle.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  // The call's connection stays open: only the notification can stop it.
  const call = post({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "answer_continuation", arguments: { id: ID, choice: "c" } } });
  while (!existsSync(runner.pidFile)) await new Promise((resolve) => setTimeout(resolve, 10));
  // Another request id is not this call.
  await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
  const pid = Number(readFileSync(runner.pidFile, "utf8").trim());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(isAlive(pid), true);
  await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41, reason: "turn interrupted" } });
  assert.equal(await diesWithin(runner.pidFile, 2_000), true);
  const answered = await (await call).json() as { result: ToolResult };
  assert.equal(answered.result.isError, true);
  assert.match(textOf(answered.result), /was cancelled and its command stopped/);
});

test("a token runs only its own launch's raft, with its own env", async () => {
  const runnerA = fakeRunner("agent-a", "done");
  const runnerB = fakeRunner("agent-b", "done");
  const handleA = await register("agent-a", runnerA);
  const handleB = await register("agent-b", runnerB);
  const viaA = textOf(await answer(handleA.url, { id: ID, choice: "a" }));
  const viaB = textOf(await answer(handleB.url, { id: ID, choice: "a" }));
  assert.match(viaA, new RegExp(`bin=${runnerA.raftBin} agent=agent-a `));
  assert.match(viaB, new RegExp(`bin=${runnerB.raftBin} agent=agent-b `));
  assert.ok(existsSync(runnerA.mark) && existsSync(runnerB.mark));
  // A's token and an argument naming B: refused, and B's raft does not run again.
  rmSync(runnerB.mark);
  const crossed = await answer(handleA.url, { id: ID, choice: "a", agentId: "agent-b" });
  assert.equal(crossed.isError, true);
  assert.equal(existsSync(runnerB.mark), false);
});

test("prepare passes the launch's runner to its registration", async () => {
  const originalFetch = globalThis.fetch;
  let handle: Awaited<ReturnType<typeof prepareManagedMcpRuntimeProxy>>;
  try {
    // The Server's catalog answer for discovery; restored before the MCP client (which uses fetch) connects.
    globalThis.fetch = (async () => new Response(JSON.stringify(EMPTY), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    handle = await prepareManagedMcpRuntimeProxy({
      agentId: "agent-prepared",
      launchId: "launch-prepared",
      serverUrl: "https://raft.test",
      agentCredentialKey: "sk_agent_test",
      continuationRunner: fakeRunner("agent-prepared", "done"),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(handle);
  assert.match(textOf(await answer(handle.url, { id: ID, choice: "a" })), /agent=agent-prepared via=tool/);
});
