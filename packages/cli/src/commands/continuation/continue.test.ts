// Commands that pause for an answer and `cont` (raft __continue), through the
// real `raft` program (buildRaftProgram) over each agent's ledger, with test
// commands in the continuation table (no user-visible command pauses yet)
// and the CLI trace sink captured.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Readable } from "node:stream";

import type { Command } from "commander";
import {
  CONTINUATION_PAUSED_EXIT_CODE,
  CONTINUATION_RUN_LEASE_MS,
  defineCommand as defineContinuationCommand,
  type ContinuationStore,
} from "@botiverse/raft-shared/src/continuations/index";

import type { AgentContext } from "../../auth/env";
import { defineCommand, registerCliCommand } from "../../core/command";
import { CliExit } from "../../core/errors";
import { axSurface } from "../../core/renderer";
import { buildRaftProgram } from "../../program";
import { createCliContinuationStore } from "../../state/continuationStore";
import { __setCliTraceSinkForTest, type CliTraceSpanRecord } from "../../transportTrace";
import { normalizeVersion, readCliVersion } from "../../version";
import {
  defineCliContinuationCommand,
  runContinuable,
  type CliContinuationCommand,
  type CliContinuationOptions,
} from "./_runtime";

/** Spans carry the CLI version, which a dev checkout may not have (CI builds one). */
const CLI_VERSION = normalizeVersion(readCliVersion());
const CLI_VERSION_ATTR = CLI_VERSION ? { cli_version: CLI_VERSION } : {};

/** Reaches the commands as arguments or answers; none of it may reach an error, a refusal or a span. */
const PRIVATE = { body: "PRIVATE-ORIGINAL-BODY", reply: "PRIVATE-NEW-REPLY", note: "PRIVATE-NOTE", stray: "PRIVATE-STRAY-TEXT" };
const T0 = Date.UTC(2026, 9, 26, 13, 2);
const PROGRAM = { name: "raft", version: "1.0.0" };

let root = "";
let agents = 0;
let now = T0;
let spans: CliTraceSpanRecord[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-continue-"));
  now = T0;
  spans = [];
  __setCliTraceSinkForTest((record) => spans.push(record));
});

afterEach(() => {
  __setCliTraceSinkForTest(null);
  // Whatever a test did, no span carried content.
  const shipped = JSON.stringify(spans);
  for (const [what, value] of Object.entries(PRIVATE)) assert.ok(!shipped.includes(value), `a span carries the ${what}: ${shipped}`);
  fs.rmSync(root, { recursive: true, force: true });
});

const freshAgent = () => `agent-continue-${++agents}`;
const envOf = (): NodeJS.ProcessEnv => ({
  SLOCK_CLI_STATE_DIR: path.join(root, "state"),
  RAFT_HOME: path.join(root, "home"),
  RAFT_CURRENT_RUNTIME: "claude",
});
const agentContext = (agentId: string): AgentContext => ({
  agentId,
  serverUrl: "http://stub.local",
  serverId: "server-continue",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
});

/** A message server that books each write once per idempotency key. */
function fakeServer(replies: string[] = ["@alice 13:01  I already fixed it in #11290"]) {
  const server = {
    checks: 0,
    sendKeys: [] as string[],
    written: new Map<string, string>(),
    /** Runs after the write lands and before the call returns (a hang there). */
    afterWrite: undefined as (() => Promise<void>) | undefined,
    newReplies() {
      server.checks += 1;
      return [...replies];
    },
    async send(idempotencyKey: string, body: string) {
      server.sendKeys.push(idempotencyKey);
      if (!server.written.has(idempotencyKey)) server.written.set(idempotencyKey, body);
      await server.afterWrite?.();
      return { seq: server.written.size };
    },
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

type DemoArgs = { target: string; body: string };
type DemoResult = { status: "sent"; target: string; seq: number } | { status: "cancelled" };

const formatDemoResult = axSurface(
  "Test-only: what the demo commands print when they finish.",
  (result: DemoResult): string => (result.status === "sent" ? `Sent to ${result.target} (#${result.seq}).\n` : "Cancelled; nothing was sent.\n"),
  { examples: [{ args: [{ status: "cancelled" }] }] },
);

function entry(verb: string, definition: CliContinuationCommand<DemoArgs, DemoResult>["definition"]): CliContinuationCommand {
  return defineCliContinuationCommand<DemoArgs, DemoResult>({
    definition,
    rerun: (args) => `raft demo ${verb} --target ${JSON.stringify(args.target)} <<'RAFTMSG'\n<your message>\nRAFTMSG`,
    check: (args) => `raft message read --target ${args ? JSON.stringify(args.target) : "<target>"}`,
    renderResult: formatDemoResult,
  });
}

/** The pilot's shape: check for new replies (a read), ask when there are some, send. */
const demoSend = (server: Server) => entry("send", defineContinuationCommand<DemoArgs, DemoResult>("demo send", async (ctx, args) => {
  const fresh = await ctx.step("check", () => server.newReplies(), { readOnly: true });
  let body = args.body;
  if (fresh.length > 0) {
    const answer = await ctx.ask("fresh", {
      question: `New replies arrived in ${args.target} since you started.`,
      preview: fresh.join("\n"),
      options: { a: "Send your original reply", b: { label: "Write a new reply", input: "stdin" }, c: "Cancel" },
    });
    if (answer.choice === "c") return { status: "cancelled" };
    if (answer.choice === "b" && answer.input !== undefined) body = answer.input;
  }
  const sent = await ctx.step("send", ({ idempotencyKey }) => server.send(idempotencyKey, body));
  return { status: "sent", target: args.target, seq: sent.seq };
}));

/** Asks for text alone. */
const demoNote = (server: Server) => entry("note", defineContinuationCommand<DemoArgs, DemoResult>("demo note", async (ctx, args) => {
  const note = await ctx.ask("note", { question: `Write the note to post in ${args.target}.`, input: "stdin" });
  const sent = await ctx.step("post", ({ idempotencyKey }) => server.send(idempotencyKey, note.input ?? ""));
  return { status: "sent", target: args.target, seq: sent.seq };
}));

/** Two questions with a write between them: the second continuation comes after an answer that ran. */
const demoChain = (server: Server) => entry("chain", defineContinuationCommand<DemoArgs, DemoResult>("demo chain", async (ctx, args) => {
  await ctx.ask("first", { question: `Post the first part to ${args.target}?`, options: { y: "Yes", n: "No" } });
  const posted = await ctx.step("post", ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
  const rest = await ctx.ask("second", { question: "Post the rest?", options: { y: "Yes", n: "No" } });
  return rest.choice === "y" ? { status: "sent", target: args.target, seq: posted.seq } : { status: "cancelled" };
}));

/** Writes, then asks: its first continuation already has a write behind it. */
const demoWrite = (server: Server) => entry("write", defineContinuationCommand<DemoArgs, DemoResult>("demo write", async (ctx, args) => {
  const posted = await ctx.step("post", ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
  const more = await ctx.ask("more", { question: `Posted to ${args.target}. Post a follow-up?`, options: { y: "Yes", n: "No" } });
  return more.choice === "y" ? { status: "sent", target: args.target, seq: posted.seq } : { status: "cancelled" };
}));

/** A send that fails, caught, then a question: the failed step may still have written. */
const demoRetry = (server: Server) => entry("retry", defineContinuationCommand<DemoArgs, DemoResult>("demo retry", async (ctx, args) => {
  try {
    const sent = await ctx.step("send", ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
    return { status: "sent", target: args.target, seq: sent.seq };
  } catch {
    const again = await ctx.ask("retry", { question: `Sending to ${args.target} failed. Try again?`, options: { y: "Try again", n: "Give up" } });
    if (again.choice === "n") return { status: "cancelled" };
    const sent = await ctx.step("send#2", ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
    return { status: "sent", target: args.target, seq: sent.seq };
  }
}));

/** Reads outside state outside a step, so a replay can go elsewhere. */
let driftStep = "one";
const demoDrift = () => entry("drift", defineContinuationCommand<DemoArgs, DemoResult>("demo drift", async (ctx) => {
  await ctx.step(driftStep, () => 1, { readOnly: true });
  await ctx.ask("go", { question: "Go on?", options: { y: "Yes" } });
  return { status: "cancelled" };
}));

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function readAll(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  let text = "";
  if (!stream) return text;
  stream.setEncoding("utf8");
  for await (const chunk of stream as Readable) text += String(chunk);
  return text;
}

/** `raft <argv>` as `agentId`, the demo commands registered under `raft demo <verb>`. */
async function runRaft(
  argv: string[],
  options: { agentId: string; stdin?: string | NodeJS.ReadableStream; commands: readonly CliContinuationCommand[]; continuations?: Partial<CliContinuationOptions> },
): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const continuations: CliContinuationOptions = { commands: options.commands, program: PROGRAM, now: () => now, stdinWindowMs: 50, ...options.continuations };
  const stdin = typeof options.stdin === "string" || options.stdin === undefined ? Readable.from(options.stdin === undefined ? [] : [options.stdin]) : options.stdin;
  const runtime = {
    io: {
      stdin,
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
    env: envOf(),
    loadAgentContext: () => agentContext(options.agentId),
    continuations,
  };
  const program = buildRaftProgram(runtime);
  const demo: Command = program.command("demo");
  for (const command of options.commands) {
    const verb = command.definition.name.replace(/^demo /, "");
    registerCliCommand(demo, defineCommand(
      { name: verb, description: `test-only ${verb}`, options: [{ flags: "--target <target>", description: "where" }] },
      async (ctx, opts: { target: string }) => runContinuable(ctx, continuations, command, { target: opts.target, body: await readAll(ctx.io.stdin) }),
    ), runtime);
  }
  let exitCode = 0;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    exitCode = error.exitCode;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}

/** Pause `demo <verb>` and return the continuation id the output gives. */
async function pausedId(agentId: string, verb: string, commands: readonly CliContinuationCommand[]): Promise<string> {
  const run = await runRaft(["demo", verb, "--target", "#ops"], { agentId, stdin: `${PRIVATE.body}\n`, commands });
  assert.equal(run.exitCode, CONTINUATION_PAUSED_EXIT_CODE, run.stderr);
  const id = /\(continuation ([0-9a-z]{10}), expires at/.exec(run.stdout)?.[1];
  assert.ok(id, run.stdout);
  return id;
}

function assertRefused(run: Run, text: string): void {
  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, `${text}\n`);
  for (const [what, value] of Object.entries(PRIVATE)) assert.ok(!run.stderr.includes(value), `the refusal carries the ${what}`);
}

const spansNamed = (name: string) => spans.filter((span) => span.name === name);
const cont = (id: string, ...rest: string[]) => ["__continue", id, ...rest];
const RERUN_SEND = `  raft demo send --target "#ops" <<'RAFTMSG'\n  <your message>\n  RAFTMSG`;

test("a command that pauses prints its question and every answer, exits 10, and keeps the continuation in the agent's ledger", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const run = await runRaft(["demo", "send", "--target", "#ops"], { agentId, stdin: `${PRIVATE.body}\n`, commands: [demoSend(server)] });

  assert.equal(run.exitCode, 10);
  assert.equal(run.stderr, "");
  const id = /continuation ([0-9a-z]{10})/.exec(run.stdout)![1]!;
  assert.equal(run.stdout, [
    "New replies arrived in #ops since you started.",
    "  @alice 13:01  I already fixed it in #11290",
    `Answer with one of these (continuation ${id}, expires at 13:12 UTC):`,
    "  a) Send your original reply",
    `     cont ${id} a`,
    "  b) Write a new reply (your text on stdin)",
    `     cont ${id} b <<'RAFTMSG'`,
    "     <your text>",
    "     RAFTMSG",
    "  c) Cancel",
    `     cont ${id} c`,
    "",
  ].join("\n"));
  assert.ok(!run.stdout.includes(PRIVATE.body));
  assert.equal(server.sendKeys.length, 0);
  assert.equal(createCliContinuationStore(agentId, envOf()).get(id as never)?.ownerAgentId, agentId);

  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span!.name, "cli.continuation.created");
  assert.equal(span!.status, "ok");
  assert.deepEqual(span!.attrs, {
    producer: "cli",
    continuation_id: id,
    root_id: id,
    command: "demo send",
    ask_kind: "choice_with_input",
    expires_in_ms: 600_000,
    runtime: "claude",
    ...CLI_VERSION_ATTR,
    serverId: "server-continue",
    agentId,
  });
});

test("cont answers it: the command carries on from its question, finishes, and exits 0", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];
  const id = await pausedId(agentId, "send", commands);
  now += 65_000;

  const done = await runRaft(cont(id, "a"), { agentId, commands });
  assert.equal(done.exitCode, 0, done.stderr);
  assert.equal(done.stdout, "Sent to #ops (#1).\n");
  assert.equal(done.stderr, "");
  assert.equal(server.checks, 1, "the replay used the journaled check");
  assert.deepEqual([...server.written.values()], [`${PRIVATE.body}\n`]);

  const answered = spansNamed("cli.continuation.answered");
  assert.equal(answered.length, 1);
  assert.deepEqual(answered[0]!.attrs, {
    producer: "cli",
    continuation_id: id,
    root_id: id,
    command: "demo send",
    choice: "a",
    outcome: "done",
    elapsed_ms: 65_000,
    runtime: "claude",
    ...CLI_VERSION_ATTR,
    serverId: "server-continue",
    agentId,
  });

  // The same answer again gives the same result without running anything, and is not counted again.
  assert.deepEqual(await runRaft(cont(id, "a"), { agentId, commands }), done);
  assert.equal(server.sendKeys.length, 1);
  assert.equal(spansNamed("cli.continuation.answered").length, 1);
});

test("an option that takes text reads it from stdin; cancel runs nothing further", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];
  const first = await pausedId(agentId, "send", commands);
  assert.equal((await runRaft(cont(first, "b"), { agentId, commands, stdin: `${PRIVATE.reply}\n` })).exitCode, 0);
  assert.deepEqual([...server.written.values()], [`${PRIVATE.reply}\n`]);

  const second = await pausedId(agentId, "send", commands);
  const cancelled = await runRaft(cont(second, "c"), { agentId, commands });
  assert.equal(cancelled.stdout, "Cancelled; nothing was sent.\n");
  assert.equal(server.sendKeys.length, 1);
});

test("empty stdin is not text; text given to an option that takes none, or none to one that needs it, is refused", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];

  // /dev/null (Claude Code's Bash), blank lines, and an open pipe nobody writes to: no text, so `a` goes through.
  for (const stdin of ["", " \n\n", new PassThrough()]) {
    const id = await pausedId(agentId, "send", commands);
    const run = await runRaft(cont(id, "a"), { agentId, commands, stdin });
    assert.equal(run.exitCode, 0, `${JSON.stringify(stdin)}: ${run.stderr}`);
  }
  assert.equal(server.written.size, 3);

  const id = await pausedId(agentId, "send", commands);
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands, stdin: PRIVATE.stray }), `Option a takes no text. Run it without stdin:\n  cont ${id} a`);
  assertRefused(await runRaft(cont(id, "b"), { agentId, commands, stdin: "" }), [
    "Option b needs your text on stdin:",
    `  cont ${id} b <<'RAFTMSG'`,
    "  <your text>",
    "  RAFTMSG",
  ].join("\n"));
  const refused = spansNamed("cli.continuation.refused").map((span) => span.attrs);
  assert.deepEqual(refused.map((attrs) => [attrs.code, attrs.invalid_answer_category, attrs.continuation_id]), [
    ["INVALID_ANSWER", "unexpected_input", id],
    ["INVALID_ANSWER", "missing_input", id],
  ]);
  // Refused answers leave it open.
  assert.equal((await runRaft(cont(id, "a"), { agentId, commands })).exitCode, 0);
});

test("an answer that is not one of the options, or no option at all, lists the options again", async () => {
  const agentId = freshAgent();
  const commands = [demoSend(fakeServer())];
  const id = await pausedId(agentId, "send", commands);
  const options = [
    "  a) Send your original reply",
    `     cont ${id} a`,
    "  b) Write a new reply (your text on stdin)",
    `     cont ${id} b <<'RAFTMSG'`,
    "     <your text>",
    "     RAFTMSG",
    "  c) Cancel",
    `     cont ${id} c`,
  ];
  assertRefused(await runRaft(cont(id, "d"), { agentId, commands }), [`Continuation ${id} has no option "d". Answer with one of these:`, ...options].join("\n"));
  assertRefused(await runRaft(cont(id), { agentId, commands }), [`Continuation ${id} needs one of its options. Answer with one of these:`, ...options].join("\n"));
  assert.deepEqual(spansNamed("cli.continuation.refused").map((span) => span.attrs.invalid_answer_category), ["no_such_option", "no_such_option"]);
});

test("an ask for text alone is answered with stdin and no option", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoNote(server)];
  const run = await runRaft(["demo", "note", "--target", "#ops"], { agentId, commands });
  assert.equal(run.exitCode, 10);
  const id = /continuation ([0-9a-z]{10})/.exec(run.stdout)![1]!;
  assert.equal(run.stdout, [
    "Write the note to post in #ops.",
    `Answer with your text on stdin (continuation ${id}, expires at 13:12 UTC):`,
    `  cont ${id} <<'RAFTMSG'`,
    "  <your text>",
    "  RAFTMSG",
    "",
  ].join("\n"));
  assert.equal(spansNamed("cli.continuation.created")[0]!.attrs.ask_kind, "input");

  assertRefused(await runRaft(cont(id), { agentId, commands }), [
    `Continuation ${id} needs your text on stdin:`,
    `  cont ${id} <<'RAFTMSG'`,
    "  <your text>",
    "  RAFTMSG",
  ].join("\n"));
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands, stdin: PRIVATE.note }), [
    `Continuation ${id} has no option "a". Answer with your text on stdin:`,
    `  cont ${id} <<'RAFTMSG'`,
    "  <your text>",
    "  RAFTMSG",
  ].join("\n"));
  const done = await runRaft(cont(id), { agentId, commands, stdin: PRIVATE.note });
  assert.equal(done.exitCode, 0, done.stderr);
  assert.deepEqual([...server.written.values()], [PRIVATE.note]);
  assert.equal(spansNamed("cli.continuation.answered")[0]!.attrs.choice, undefined);
});

test("an id that is not here, or not one at all: UNKNOWN, which also covers another agent's id from its own ledger", async () => {
  const agentA = freshAgent();
  const commands = [demoSend(fakeServer())];
  const id = await pausedId(agentA, "send", commands);
  const unknownText = (shown: string) =>
    `No continuation ${shown} here. Check the id in the output that gave it to you; a continuation can only be answered by the agent it was given to.`;

  assertRefused(await runRaft(cont("zzzzzzzzzz", "a"), { agentId: agentA, commands }), unknownText("zzzzzzzzzz"));
  assertRefused(await runRaft(cont(" K7Q2 ", "a"), { agentId: agentA, commands }), unknownText("K7Q2"));
  // Agent B's CLI reads B's ledger, which has no such continuation.
  assertRefused(await runRaft(cont(id, "a"), { agentId: freshAgent(), commands }), unknownText(id));
  assert.deepEqual(spansNamed("cli.continuation.refused").map((span) => [span.attrs.code, span.attrs.continuation_id]), [
    ["UNKNOWN", "zzzzzzzzzz"],
    ["UNKNOWN", undefined],
    ["UNKNOWN", id],
  ]);
});

test("another agent reaching the same store is refused: NOT_YOURS, and the continuation stays open for its agent", async () => {
  const agentA = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];
  const id = await pausedId(agentA, "send", commands);
  const ledgerOfA: ContinuationStore = createCliContinuationStore(agentA, envOf());

  const intruder = await runRaft(cont(id, "a"), { agentId: freshAgent(), commands, continuations: { store: () => ledgerOfA } });
  assertRefused(intruder, `Continuation ${id} was given to another agent; only that agent can answer it.`);
  assert.equal(server.sendKeys.length, 0);
  assert.equal((await runRaft(cont(id, "a"), { agentId: agentA, commands })).exitCode, 0);
});

// demo send's only step before its question reads, and says so (readOnly): nothing may have taken effect.
test("past its deadline: EXPIRED, with the original command to run again and how long it had", async () => {
  const agentId = freshAgent();
  const commands = [demoSend(fakeServer())];
  const id = await pausedId(agentId, "send", commands);
  now += 10 * 60_000 + 1;
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands }), [
    `Continuation ${id} expired at 13:12 UTC (10 minutes to answer); nothing after its question ran. To start over, run the original command again:`,
    RERUN_SEND,
  ].join("\n"));
  assert.equal(spansNamed("cli.continuation.refused")[0]!.attrs.code, "EXPIRED");
});

test("once its result is no longer kept: RESULT_EXPIRED, with the exact command to check before running anything again", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];
  const id = await pausedId(agentId, "send", commands);
  assert.equal((await runRaft(cont(id, "a"), { agentId, commands })).exitCode, 0);
  const store = createCliContinuationStore(agentId, envOf());
  const tombstone = store.getTombstone(id as never);
  assert.equal(tombstone?.check, `raft message read --target "#ops"`, "rendered when the run started");
  assert.ok(!JSON.stringify(tombstone).includes(PRIVATE.body), "the tombstone keeps no content");
  now += 30 * 60_000 + 1;
  // Any command's start sweeps what has expired.
  await pausedId(agentId, "send", commands);

  const gone = `The result of continuation ${id} is no longer kept (results are kept 30 minutes). It may already have taken effect, so check before running anything again:`;
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands }), [gone, `  raft message read --target "#ops"`].join("\n"));
  assert.equal(server.sendKeys.length, 1);

  // A tombstone without the line (none could be rendered): the command's placeholder form.
  const { check: _dropped, ...withoutCheck } = store.getTombstone(id as never)!;
  store.putTombstone(withoutCheck);
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands }), [gone, "  raft message read --target <target>"].join("\n"));
});

test("a different CLI version: PROGRAM_CHANGED says to run it again only while nothing ran, else what to check", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];
  const upgraded = { program: { name: "raft", version: "1.0.1" } };
  const id = await pausedId(agentId, "send", commands);
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands, continuations: upgraded }), [
    `Continuation ${id} was started by a different version of the raft CLI, so it can't be resumed safely; nothing after its question ran. Run the original command again:`,
    RERUN_SEND,
  ].join("\n"));

  assert.equal((await runRaft(cont(id, "a"), { agentId, commands })).exitCode, 0);
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands, continuations: upgraded }), [
    `Continuation ${id} was started by a different version of the raft CLI, so it can't be resumed safely. Part of this command already ran and may have taken effect, so check before running anything again:`,
    `  raft message read --target "#ops"`,
  ].join("\n"));
  assert.equal(server.sendKeys.length, 1);
});

test("on the second question of an exchange, after the first answer wrote: refusals say what to check, never to run the command again", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoChain(server)];
  const first = await pausedId(agentId, "chain", commands);
  const afterFirst = await runRaft(cont(first, "y"), { agentId, commands });
  assert.equal(afterFirst.exitCode, CONTINUATION_PAUSED_EXIT_CODE, afterFirst.stderr);
  const second = /continuation ([0-9a-z]{10})/.exec(afterFirst.stdout)![1]!;
  assert.equal(server.written.size, 1, "the first answer's run wrote");

  const partRan = "Part of this command already ran and may have taken effect, so check before running anything again:";
  const check = `  raft message read --target "#ops"`;
  const rerun = commands[0]!.rerun({ target: "#ops", body: PRIVATE.body });
  const refusedWithCheck = (run: Run, opening: string) => {
    assertRefused(run, `${opening} ${partRan}\n${check}`);
    assert.ok(`${run.stdout}${run.stderr}`.includes(check), "the check line is there");
    for (const line of rerun.split("\n")) {
      assert.ok(!`${run.stdout}${run.stderr}`.includes(line.split(" <<")[0]!), `no rerun line (${line}) in ${run.stderr}`);
    }
  };

  refusedWithCheck(
    await runRaft(cont(second, "y"), { agentId, commands, continuations: { program: { name: "raft", version: "1.0.1" } } }),
    `Continuation ${second} was started by a different version of the raft CLI, so it can't be resumed safely.`,
  );
  // No command left to render a line from: the one the first answer's tombstone kept.
  refusedWithCheck(
    await runRaft(cont(second, "y"), { agentId, commands: [] }),
    `Continuation ${second} can no longer be resumed by this raft CLI.`,
  );
  now += 10 * 60_000 + 1;
  refusedWithCheck(
    await runRaft(cont(second, "y"), { agentId, commands }),
    `Continuation ${second} expired at 13:12 UTC (10 minutes to answer); nothing after its question ran.`,
  );
  assert.deepEqual(spansNamed("cli.continuation.refused").map((span) => span.attrs.code), ["PROGRAM_CHANGED", "UNKNOWN_COMMAND", "EXPIRED"]);
  assert.equal(server.written.size, 1, "nothing ran again");
});

/** A refusal that sends the agent to check, never to run `verb` again (a rerun would write twice). */
function assertRefusedWithCheckOnly(run: Run, opening: string, verb: string): void {
  assertRefused(run, `${opening} Part of this command already ran and may have taken effect, so check before running anything again:\n  raft message read --target "#ops"`);
  const output = `${run.stdout}${run.stderr}`;
  assert.ok(!output.includes(`raft demo ${verb}`) && !output.includes("RAFTMSG"), `no line to run it again in ${output}`);
}

test("a command that wrote before its first question: once that continuation can't be resumed, what to check, never to run it again", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoWrite(server)];
  const id = await pausedId(agentId, "write", commands);
  assert.equal(server.written.size, 1, "the step before the question wrote");

  assertRefusedWithCheckOnly(
    await runRaft(cont(id, "y"), { agentId, commands, continuations: { program: { name: "raft", version: "1.0.1" } } }),
    `Continuation ${id} was started by a different version of the raft CLI, so it can't be resumed safely.`,
    "write",
  );
  now += 10 * 60_000 + 1;
  assertRefusedWithCheckOnly(
    await runRaft(cont(id, "y"), { agentId, commands }),
    `Continuation ${id} expired at 13:12 UTC (10 minutes to answer); nothing after its question ran.`,
    "write",
  );
  assert.deepEqual(spansNamed("cli.continuation.refused").map((span) => span.attrs.code), ["PROGRAM_CHANGED", "EXPIRED"]);
  assert.equal(server.written.size, 1, "nothing ran again");
});

test("a failed step the command caught before its question may still have written: past the deadline, what to check", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoRetry(server)];
  server.afterWrite = async () => {
    server.afterWrite = undefined;
    throw new Error("connection reset after the write");
  };
  const id = await pausedId(agentId, "retry", commands);
  assert.equal(server.written.size, 1, "the failed send wrote before it failed");
  now += 10 * 60_000 + 1;
  assertRefusedWithCheckOnly(
    await runRaft(cont(id, "y"), { agentId, commands }),
    `Continuation ${id} expired at 13:12 UTC (10 minutes to answer); nothing after its question ran.`,
    "retry",
  );
});

test("a record of another format, or a command the CLI no longer has, is refused without lines it cannot render", async () => {
  const agentId = freshAgent();
  const commands = [demoSend(fakeServer())];
  const id = await pausedId(agentId, "send", commands);
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands: [] }),
    `Continuation ${id} can no longer be resumed by this raft CLI; nothing after its question ran. Run the original command again.`);
  const different = `Continuation ${id} was started by a different version of the raft CLI, so it can't be resumed safely; nothing after its question ran. Run the original command again.`;

  const store = createCliContinuationStore(agentId, envOf());
  const record = store.get(id as never)!;
  store.update({ ...record, formatVersion: 2, revision: record.revision + 1 }, record.revision);
  assertRefused(await runRaft(cont(id, "a"), { agentId, commands }), different);
  assert.deepEqual(spansNamed("cli.continuation.refused").map((span) => span.attrs.code), ["UNKNOWN_COMMAND", "FORMAT_CHANGED"]);
});

test("a replay that no longer follows the journal: REPLAY_DIVERGED, with the original command", async () => {
  const agentId = freshAgent();
  const commands = [demoDrift()];
  driftStep = "one";
  const id = await pausedId(agentId, "drift", commands);
  driftStep = "two";
  assertRefused(await runRaft(cont(id, "y"), { agentId, commands }), [
    `Continuation ${id} could not be resumed (the command changed while it waited); nothing after its question ran. Run the original command again:`,
    `  raft demo drift --target "#ops" <<'RAFTMSG'\n  <your message>\n  RAFTMSG`,
  ].join("\n"));
});

test("a different answer to an answered continuation: ALREADY_ANSWERED, with how to get its result, never its text", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];
  const id = await pausedId(agentId, "send", commands);
  now += 60_000;
  await runRaft(cont(id, "a"), { agentId, commands });
  assertRefused(await runRaft(cont(id, "c"), { agentId, commands }),
    `Continuation ${id} was already answered with "a" at 13:03 UTC, so a different answer can't be applied. To get its result, run the same answer again: cont ${id} a`);

  const withText = await pausedId(agentId, "send", commands);
  await runRaft(cont(withText, "b"), { agentId, commands, stdin: PRIVATE.reply });
  assertRefused(await runRaft(cont(withText, "b"), { agentId, commands, stdin: PRIVATE.stray }), [
    `Continuation ${withText} was already answered with "b" and your text at 13:03 UTC, so a different answer can't be applied. To get its result, run the same answer again, with the same text on stdin:`,
    `  cont ${withText} b <<'RAFTMSG'`,
    "  <the same text>",
    "  RAFTMSG",
  ].join("\n"));
  assert.equal(server.sendKeys.length, 2);
});

test("while another call runs the answer: IN_PROGRESS; once its lease runs out the step runs again and the server sees one write", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];
  const id = await pausedId(agentId, "send", commands);

  let reached!: () => void;
  const atWrite = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const hang = new Promise<void>((resolve) => { release = resolve; });
  server.afterWrite = async () => {
    server.afterWrite = undefined;
    reached();
    await hang;
  };
  const stale = runRaft(cont(id, "a"), { agentId, commands });
  await atWrite;

  assertRefused(await runRaft(cont(id, "a"), { agentId, commands }),
    `Continuation ${id} is being answered right now. Wait a few seconds, then run the same command again to get its result.`);

  // The first call's process looks dead: a retry takes the run over and runs the send step again.
  now += CONTINUATION_RUN_LEASE_MS;
  const takeover = await runRaft(cont(id, "a"), { agentId, commands });
  assert.equal(takeover.exitCode, 0, takeover.stderr);
  release();
  assert.equal((await stale).exitCode, 1, "the stale run can no longer write its outcome");

  assert.equal(server.sendKeys.length, 2);
  assert.equal(new Set(server.sendKeys).size, 1, "both runs passed the same idempotency key");
  assert.equal(server.written.size, 1, "so the server booked one write");
}, 10_000);

test("a store that fails: what may already have taken effect and what to check, or that nothing was done and what to run again", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server), demoNote(server), demoWrite(server)];
  const ledger = createCliContinuationStore(agentId, envOf());
  /** The ledger, with the `nth` call of `method` failing. */
  const failingAt = (method: keyof ContinuationStore, nth = 1): (() => ContinuationStore) => () => {
    let calls = 0;
    return {
      ...ledger,
      [method]: (...args: unknown[]) => {
        calls += 1;
        if (calls === nth) throw new Error("database is locked");
        return (ledger[method] as (...a: unknown[]) => unknown)(...args);
      },
    };
  };
  const check = `  raft message read --target "#ops"`;

  // The first question could not be saved: no continuation. The write command posted first (a step that may write)...
  assertRefused(
    await runRaft(["demo", "write", "--target", "#ops"], { agentId, stdin: PRIVATE.body, commands, continuations: { store: failingAt("put") } }),
    `The command could not save its question on this computer; steps before it may already have taken effect. Check before running it again:\n${check}`,
  );
  // ...the send command only checked for replies (declared read-only) and the note command asks first: nothing was done.
  const nothingDone = (verb: string) =>
    `The command could not save its question on this computer, so nothing was done. Run it again:\n  raft demo ${verb} --target "#ops" <<'RAFTMSG'\n  <your message>\n  RAFTMSG`;
  assertRefused(
    await runRaft(["demo", "send", "--target", "#ops"], { agentId, stdin: PRIVATE.body, commands, continuations: { store: failingAt("put") } }),
    nothingDone("send"),
  );
  assertRefused(
    await runRaft(["demo", "note", "--target", "#ops"], { agentId, commands, continuations: { store: failingAt("put") } }),
    nothingDone("note"),
  );

  // cont, the continuation could not be read: nothing was done this time.
  const unread = await pausedId(agentId, "send", commands);
  assertRefused(await runRaft(cont(unread, "a"), { agentId, commands, continuations: { store: failingAt("get") } }),
    `Continuation ${unread} could not be read on this computer, so nothing was done this time. Run the same command again; if it keeps failing, report it.`);

  // cont, after its run started: the journal write after the send step (update 3), or the done write (update 4).
  // Updates of `cont <id> a`: 1 the claim, 2 before the send step, 3 after it, 4 the outcome.
  for (const nth of [3, 4]) {
    const id = await pausedId(agentId, "send", commands);
    const written = server.written.size;
    assertRefused(await runRaft(cont(id, "a"), { agentId, commands, continuations: { store: failingAt("update", nth) } }),
      `Continuation ${id} could not be saved on this computer, so its last step may already have taken effect. Check before running anything again:\n${check}`);
    assert.equal(server.written.size, written + 1, `update ${nth}: the send step ran`);
  }

  const failed = spansNamed("cli.continuation.refused");
  assert.deepEqual(failed.map((span) => [span.attrs.code, span.status, typeof span.attrs.continuation_id]), [
    ["STORE_FAILED", "error", "undefined"],
    ["STORE_FAILED", "error", "undefined"],
    ["STORE_FAILED", "error", "undefined"],
    ["STORE_FAILED", "error", "string"],
    ["STORE_FAILED", "error", "string"],
    ["STORE_FAILED", "error", "string"],
  ]);
});

test("`raft cont <id>` (the raft prefix an agent is used to) answers it like `cont <id>`", async () => {
  const agentId = freshAgent();
  const server = fakeServer();
  const commands = [demoSend(server)];
  const id = await pausedId(agentId, "send", commands);

  const done = await runRaft(["cont", id, "a"], { agentId, commands });
  assert.equal(done.exitCode, 0, done.stderr);
  assert.equal(server.sendKeys.length, 1);
  // The same output as answering through `__continue` ("cont answers it" above).
  assert.equal(done.stdout, "Sent to #ops (#1).\n");
});

test("`raft --help` does not list __continue", () => {
  const help = buildRaftProgram({ helpWidth: 200 }).helpInformation();
  assert.ok(help.includes("message"), help);
  assert.ok(!help.includes("__continue"), help);
  assert.ok(!/^\s+cont\b/m.test(help), help);
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
test("the paused output and the refusals are registered AX surfaces", { skip: existsSync(path.join(repoRoot, "RELEASE_SOURCE")) }, async () => {
  const { buildManifest } = await import(new URL("../../../../../scripts/generate-ax-manifest.ts", import.meta.url).href);
  const names = (buildManifest(repoRoot).entries as Array<{ family: string; name: string }>)
    .filter((entry) => entry.family === "continuation")
    .map((entry) => entry.name);
  assert.deepEqual(names.sort(), ["formatContinuationPausedOutput", "formatContinuationRefusalOutput"]);
});
