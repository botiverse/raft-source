import assert from "node:assert/strict";
import { ContinuationStepError, defineCommand, type CommandDefinition } from "./command";
import { stepIdempotencyKey } from "./id";
import { createMemoryContinuationStore } from "./memoryStore";
import type { ContinuationStore } from "./store";
import {
  asContinuationId,
  CONTINUATION_FORMAT_VERSION,
  DEFAULT_CONTINUATION_RESULT_RETENTION_MS,
  DEFAULT_CONTINUATION_TTL_MS,
  journalMayHaveTakenEffect,
  type AskSpec,
  type ContinuationId,
} from "./record";
import { CONTINUATION_EXPIRY_GRACE_MS, CONTINUATION_RUN_LEASE_MS, CONTINUATION_TOMBSTONE_MS, resume, start, type ResumeOutcome } from "./runtime";

const T0 = 1_000_000;
/** Tests that hold a run at a gate: a broken claim runs a second command into the closed gate, which must fail, not hang (shared sets no default timeout). */
const GATED_TEST_TIMEOUT_MS = 5_000;

function harness() {
  let time = T0;
  let issued = 0;
  const store = createMemoryContinuationStore();
  const options = {
    store,
    ownerAgentId: "agent-1",
    program: { name: "raft", version: "1.2.3" },
    now: () => time,
    newId: () => asContinuationId(`id${++issued}`),
  };
  return { store, options, advance: (ms: number) => { time += ms; } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A message server that books each write once per idempotency key. */
function fakeServer(replies: string[] = []) {
  const server = {
    /** How many times a command body using this server started. */
    runs: 0,
    checks: 0,
    sendKeys: [] as string[],
    written: new Map<string, string>(),
    /** Runs before the write (a refused request). */
    beforeWrite: undefined as (() => void) | undefined,
    /** Runs after the write lands and before the call returns (a crash or a hang there). */
    afterWrite: undefined as (() => Promise<void> | void) | undefined,
    newReplies() {
      server.checks += 1;
      return [...replies];
    },
    async send(idempotencyKey: string, body: string) {
      server.sendKeys.push(idempotencyKey);
      server.beforeWrite?.();
      if (!server.written.has(idempotencyKey)) server.written.set(idempotencyKey, body);
      await server.afterWrite?.();
      return { body: server.written.get(idempotencyKey) ?? body };
    },
  };
  return server;
}

type SendArgs = { target: string; body: string };
type SendResult = { status: "sent"; body: string } | { status: "cancelled" };

const FRESH_ASK: AskSpec = {
  question: "New replies arrived since you started.",
  options: { a: "Send your original reply", b: { label: "Write a new reply", input: "stdin" }, c: "Cancel" },
};

/** The pilot's shape: check for fresh replies, ask when there are some, send. */
function messageSend(server: ReturnType<typeof fakeServer>) {
  return defineCommand<SendArgs, SendResult>("message send", async (ctx, args) => {
    server.runs += 1;
    const fresh = await ctx.step("check", () => server.newReplies(), { readOnly: true });
    let body = args.body;
    if (fresh.length > 0) {
      const answer = await ctx.ask("fresh", { ...FRESH_ASK, preview: fresh.join("\n") });
      if (answer.choice === "c") return { status: "cancelled" };
      if (answer.choice === "b" && answer.input !== undefined) body = answer.input;
    }
    const sent = await ctx.step("send", ({ idempotencyKey }) => server.send(idempotencyKey, body));
    return { status: "sent", body: sent.body };
  });
}

const ARGS: SendArgs = { target: "#ops", body: "Fixed in #11290" };

async function pausedId(outcome: Promise<{ kind: string; continuation?: { id: ContinuationId } }>): Promise<ContinuationId> {
  const value = await outcome;
  assert.equal(value.kind, "paused");
  return value.continuation!.id;
}

function errorOf(outcome: ResumeOutcome) {
  assert.equal(outcome.kind, "error", `expected a refusal, got ${JSON.stringify(outcome)}`);
  return outcome.kind === "error" ? outcome.error : undefined;
}

test("a command that never asks returns its result and stores nothing", async () => {
  const { store, options } = harness();
  const server = fakeServer();
  const outcome = await start(messageSend(server), { ...options, args: ARGS });
  assert.deepEqual(outcome, { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.equal(await store.get(asContinuationId("id1")), undefined);
  assert.deepEqual(server.sendKeys, [stepIdempotencyKey(asContinuationId("id1"), "send")]);
});

test("an ask pauses with a stored record; answering it replays the journal and finishes the original call", async () => {
  const { store, options } = harness();
  const server = fakeServer(["@alice 13:02  I already fixed it"]);
  const def = messageSend(server);

  const paused = await start(def, { ...options, args: ARGS });
  assert.deepEqual(paused, {
    kind: "paused",
    continuation: { id: "id1", ask: { ...FRESH_ASK, preview: "@alice 13:02  I already fixed it" }, expiresAt: T0 + DEFAULT_CONTINUATION_TTL_MS },
  });
  const record = await store.get(asContinuationId("id1"));
  assert.equal(record?.formatVersion, CONTINUATION_FORMAT_VERSION);
  assert.equal(record?.status, "pending");
  assert.equal(record?.ownerAgentId, "agent-1");
  assert.equal(record?.command, "message send");
  assert.deepEqual(record?.args, ARGS);
  assert.deepEqual(record?.journal, [{ kind: "step", id: "check", result: ["@alice 13:02  I already fixed it"], readOnly: true }]);
  assert.equal(record?.pending.askId, "fresh");
  assert.equal(server.sendKeys.length, 0);

  const done = await resume(asContinuationId("id1"), { choice: "a" }, { ...options, commands: [def] });
  assert.deepEqual(done, { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.equal(server.checks, 1, "the replay returned the journaled check");
  assert.deepEqual(server.sendKeys, ["continuation:id1:send"]);
  assert.equal((await store.get(asContinuationId("id1")))?.status, "done");
});

test("an option that takes content carries it into the command; cancel runs no further step", async () => {
  const { options } = harness();
  const server = fakeServer(["@alice  done already"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };

  const first = await pausedId(start(def, { ...options, args: ARGS }));
  assert.deepEqual(await resume(first, { choice: "b", input: "Thanks, closing." }, resumeWith), {
    kind: "done", result: { status: "sent", body: "Thanks, closing." },
  });

  const second = await pausedId(start(def, { ...options, args: ARGS }));
  assert.deepEqual(await resume(second, { choice: "c" }, resumeWith), { kind: "done", result: { status: "cancelled" } });
  assert.equal(server.sendKeys.length, 1);
});

test("a second ask pauses again under a new id linked from the first; the old id with the same answer returns it", async () => {
  const { store, options } = harness();
  const server = fakeServer();
  let steps = 0;
  const def = defineCommand<SendArgs, SendResult>("message edit", async (ctx, args) => {
    server.runs += 1;
    await ctx.step("load", () => { steps += 1; return args.target; });
    const confirm = await ctx.ask("confirm", { question: "Rewrite it?", options: { y: "Yes", n: "No" } });
    if (confirm.choice === "n") return { status: "cancelled" };
    const body = await ctx.ask("body", { question: "Input your content", input: "stdin" });
    const sent = await ctx.step("send", ({ idempotencyKey }) => server.send(idempotencyKey, body.input ?? ""));
    return { status: "sent", body: sent.body };
  });
  const resumeWith = { ...options, commands: [def] };

  const first = await pausedId(start(def, { ...options, args: ARGS }));
  const again = await resume(first, { choice: "y" }, resumeWith);
  assert.deepEqual(again, { kind: "paused", continuation: { id: "id2", ask: { question: "Input your content", input: "stdin" }, expiresAt: T0 + DEFAULT_CONTINUATION_TTL_MS } });

  const old = await store.get(first);
  assert.equal(old?.status, "answered");
  assert.equal(old?.next, "id2");
  const next = await store.get(asContinuationId("id2"));
  assert.equal(next?.rootId, "id1");
  assert.deepEqual(next?.journal.map((entry) => `${entry.kind}:${entry.id}`), ["step:load", "ask:confirm"]);

  assert.equal(server.runs, 2);
  assert.deepEqual(await resume(first, { choice: "y" }, resumeWith), again, "the old id answers with the new pause");
  assert.equal(server.runs, 2, "without running the command again");
  assert.equal(steps, 1);

  const done = await resume(asContinuationId("id2"), { input: "Rewritten.\n" }, resumeWith);
  assert.deepEqual(done, { kind: "done", result: { status: "sent", body: "Rewritten.\n" } });
  // Idempotency keys follow the chain's root, not the link the step ran under.
  assert.deepEqual(server.sendKeys, ["continuation:id1:send"]);
  assert.equal(steps, 1);
});

test("an old link whose next continuation is gone says the result is gone: its answer took effect up to that ask", async () => {
  const { options, advance } = harness();
  const def = defineCommand<SendArgs, SendResult>("two asks", async (ctx) => {
    await ctx.ask("first", { question: "First?", options: { y: "Yes" } });
    await ctx.step("between", () => 1);
    await ctx.ask("second", { question: "Second?", options: { y: "Yes" }, expiresInMs: 60_000 });
    return { status: "cancelled" };
  });
  const resumeWith = { ...options, commands: [def] };
  const first = await pausedId(start(def, { ...options, args: ARGS }));
  const second = await pausedId(resume(first, { choice: "y" }, resumeWith));

  advance(60_001);
  assert.equal(errorOf(await resume(second, { choice: "y" }, resumeWith))?.code, "EXPIRED");
  assert.deepEqual(errorOf(await resume(first, { choice: "y" }, resumeWith)), {
    code: "RESULT_EXPIRED", id: first, rootId: first, command: "two asks", finishedAt: T0, check: null,
  });
});

test("an old link is kept as long as its next continuation can be answered", async () => {
  const { options, advance } = harness();
  const def = defineCommand<SendArgs, SendResult>("long second ask", async (ctx) => {
    await ctx.ask("first", { question: "First?", options: { y: "Yes" } });
    await ctx.ask("second", { question: "Second?", options: { y: "Yes" }, expiresInMs: 120_000 });
    return { status: "cancelled" };
  });
  // A retention shorter than the next ask's time, so only the link rule keeps the old record.
  const lifetimes = { ttlMs: 60_000, resultRetentionMs: 60_000 };
  const resumeWith = { ...options, ...lifetimes, commands: [def] };
  const first = await pausedId(start(def, { ...options, ...lifetimes, args: ARGS }));
  const again = await resume(first, { choice: "y" }, resumeWith);

  advance(90_000);
  await start(messageSend(fakeServer()), { ...options, args: ARGS });
  assert.deepEqual(await resume(first, { choice: "y" }, resumeWith), again);
});

test("an answer that does not fit the ask is refused by category and leaves the continuation open", async () => {
  const { options } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));

  const cases = [
    [{}, "no_such_option"],
    [{ choice: "z" }, "no_such_option"],
    [{ choice: "toString" }, "no_such_option"],
    [{ choice: "b" }, "missing_input"],
    [{ choice: "b", input: " \n" }, "missing_input"],
    [{ choice: "a", input: "stray text" }, "unexpected_input"],
  ] as const;
  for (const [answer, category] of cases) {
    const error = errorOf(await resume(id, answer, resumeWith));
    assert.deepEqual(error, { code: "INVALID_ANSWER", id, category, ask: { ...FRESH_ASK, preview: "@alice  hi" } }, JSON.stringify(answer));
  }
  assert.equal(server.sendKeys.length, 0);
  assert.equal((await resume(id, { choice: "a" }, resumeWith)).kind, "done");
});

test("the same answer again returns the stored outcome without running anything; another answer is ALREADY_ANSWERED", async () => {
  const { options } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));

  const first = await resume(id, { choice: "b", input: "New text" }, resumeWith);
  assert.equal(server.runs, 2);
  assert.deepEqual(await resume(id, { choice: "b", input: "New text\n" }, resumeWith), first, "a heredoc's trailing newline is the same answer");
  assert.deepEqual(errorOf(await resume(id, { choice: "b", input: "New text\n\n" }, resumeWith)), {
    code: "ALREADY_ANSWERED", id, command: "message send", args: ARGS, previous: { choice: "b", input: "New text" }, answeredAt: T0,
  });
  assert.deepEqual(await resume(id, { choice: "b", input: "New text" }, resumeWith), first);
  assert.equal(server.runs, 2, "the command did not run again");
  assert.equal(server.checks, 1);
  assert.equal(server.sendKeys.length, 1);

  assert.deepEqual(errorOf(await resume(id, { choice: "b", input: "Other text" }, resumeWith)), {
    code: "ALREADY_ANSWERED", id, command: "message send", args: ARGS, previous: { choice: "b", input: "New text" }, answeredAt: T0,
  });
  assert.deepEqual(errorOf(await resume(id, { choice: "c" }, resumeWith)), {
    code: "ALREADY_ANSWERED", id, command: "message send", args: ARGS, previous: { choice: "b", input: "New text" }, answeredAt: T0,
  });
  assert.equal(server.sendKeys.length, 1);
});

test("a continuation expires after ten minutes (or its ask's own time): refused with what to run again, and deleted", async () => {
  const { store, options, advance } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };

  const onTime = await pausedId(start(def, { ...options, args: ARGS }));
  const late = await pausedId(start(def, { ...options, args: ARGS }));
  advance(DEFAULT_CONTINUATION_TTL_MS);
  assert.equal((await resume(onTime, { choice: "a" }, resumeWith)).kind, "done", "expiring now is not yet expired");
  advance(1);
  assert.deepEqual(errorOf(await resume(late, { choice: "a" }, resumeWith)), {
    code: "EXPIRED", id: late, command: "message send", args: ARGS, createdAt: T0, expiresAt: T0 + DEFAULT_CONTINUATION_TTL_MS,
    mayHaveTakenEffect: false, check: null,
  });
  assert.equal(await store.get(late), undefined);
  assert.deepEqual(errorOf(await resume(late, { choice: "a" }, resumeWith)), { code: "UNKNOWN", id: late });

  // ttlMs sets the default; an ask's expiresInMs wins over it.
  const short = defineCommand<SendArgs, SendResult>("quick", async (ctx) => {
    await ctx.ask("go", { question: "Go?", options: { y: "Yes" }, expiresInMs: 5_000 });
    return { status: "cancelled" };
  });
  const quickStart = await start(short, { ...options, ttlMs: 60_000, args: ARGS });
  assert.equal(quickStart.kind === "paused" && quickStart.continuation.expiresAt, T0 + DEFAULT_CONTINUATION_TTL_MS + 1 + 5_000);
  const custom = await start(def, { ...options, ttlMs: 60_000, args: ARGS });
  assert.equal(custom.kind === "paused" && custom.continuation.expiresAt, T0 + DEFAULT_CONTINUATION_TTL_MS + 1 + 60_000);

  // Starting a command sweeps what has expired: a done record once its result retention is over.
  advance(DEFAULT_CONTINUATION_RESULT_RETENTION_MS);
  await start(messageSend(fakeServer()), { ...options, args: ARGS });
  assert.equal(await store.get(onTime), undefined, "a done record goes too once expired");
});

test("a late answer is told it expired, even after another command's sweep, until the grace after the deadline is over", async () => {
  const { store, options, advance } = harness();
  const def = messageSend(fakeServer(["@alice  hi"]));
  const resumeWith = { ...options, commands: [def] };
  const sweep = () => start(messageSend(fakeServer()), { ...options, args: ARGS });
  const late = await pausedId(start(def, { ...options, args: ARGS }));
  const tooLate = await pausedId(start(def, { ...options, args: ARGS }));

  advance(DEFAULT_CONTINUATION_TTL_MS + CONTINUATION_EXPIRY_GRACE_MS);
  await sweep();
  assert.deepEqual(errorOf(await resume(late, { choice: "a" }, resumeWith)), {
    code: "EXPIRED", id: late, command: "message send", args: ARGS, createdAt: T0, expiresAt: T0 + DEFAULT_CONTINUATION_TTL_MS,
    mayHaveTakenEffect: false, check: null,
  });

  advance(1);
  await sweep();
  assert.equal(await store.get(tooLate), undefined, "swept once the grace is over");
  assert.deepEqual(errorOf(await resume(tooLate, { choice: "a" }, resumeWith)), { code: "UNKNOWN", id: tooLate });
});

test("the answer deadline and the result retention are separate options", async () => {
  const { store, options, advance } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const lifetimes = { ttlMs: 1_000, resultRetentionMs: 5_000 };
  const resumeWith = { ...options, ...lifetimes, commands: [def] };
  const sweep = () => start(messageSend(fakeServer()), { ...options, ...lifetimes, args: ARGS });

  const id = await pausedId(start(def, { ...options, ...lifetimes, args: ARGS }));
  assert.equal((await store.get(id))?.expiresAt, T0 + 1_000);
  const done = await resume(id, { choice: "a" }, resumeWith);

  advance(5_000);
  await sweep();
  assert.deepEqual(await resume(id, { choice: "a" }, resumeWith), done, "kept for the retention, well past the deadline");
  advance(1);
  await sweep();
  assert.equal(await store.get(id), undefined);
  assert.equal(errorOf(await resume(id, { choice: "a" }, resumeWith))?.code, "RESULT_EXPIRED");
  assert.equal(server.runs, 2);
});

test("only the agent that paused can resume", async () => {
  const { options } = harness();
  const def = messageSend(fakeServer(["@alice  hi"]));
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...options, ownerAgentId: "agent-2", commands: [def] })), { code: "NOT_YOURS", id });
  assert.equal((await resume(id, { choice: "a" }, { ...options, commands: [def] })).kind, "done");
});

test("a program at another version or name refuses the continuation as PROGRAM_CHANGED with the original command", async () => {
  const { store, options } = harness();
  const def = messageSend(fakeServer(["@alice  hi"]));
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  for (const program of [{ name: "raft", version: "1.2.4" }, { name: "other", version: "1.2.3" }]) {
    assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...options, program, commands: [def] })), {
      code: "PROGRAM_CHANGED", id, command: "message send", args: ARGS, recorded: { name: "raft", version: "1.2.3" }, current: program,
      mayHaveTakenEffect: false, check: null,
    });
  }
  assert.equal((await store.get(id))?.status, "pending");
});

test("once an answer ran, the refusals that would send the agent to run the command again say it may have taken effect", async () => {
  const { store, options, advance } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  advance(5_000);
  await resume(id, { choice: "a" }, { ...options, commands: [def] });
  assert.equal(server.written.size, 1);

  const program = { name: "raft", version: "1.2.4" };
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...options, program, commands: [def] })), {
    code: "PROGRAM_CHANGED", id, command: "message send", args: ARGS, recorded: options.program, current: program, mayHaveTakenEffect: true, check: null,
  });
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...options, commands: [] })), {
    code: "UNKNOWN_COMMAND", id, command: "message send", mayHaveTakenEffect: true, check: null,
  });
  assert.deepEqual(errorOf(await resume(id, { choice: "c" }, { ...options, commands: [def] })), {
    code: "ALREADY_ANSWERED", id, command: "message send", args: ARGS, previous: { choice: "a" }, answeredAt: T0 + 5_000,
  });
  const record = (await store.get(id))!;
  await store.update({ ...record, formatVersion: 2, revision: record.revision + 1 }, record.revision);
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...options, commands: [def] })), {
    code: "FORMAT_CHANGED", id, recorded: 2, current: CONTINUATION_FORMAT_VERSION, mayHaveTakenEffect: true, check: null,
  });
  assert.equal(server.written.size, 1);
});

test("on a later continuation of a chain, an earlier answer's run may have written: no refusal sends the agent to run the command again", async () => {
  const { store, options, advance } = harness();
  const server = fakeServer();
  // Reading outside state outside a step breaks the replay rule on purpose (the divergence below).
  let postStep = "post";
  const def = defineCommand<SendArgs, SendResult>("message thread", async (ctx, args) => {
    await ctx.ask("first", { question: "Post the first part?", options: { y: "Yes" } });
    await ctx.step(postStep, ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
    const second = await ctx.ask("second", { question: "Post the rest?", options: { y: "Yes", n: "No" } });
    if (second.choice === "n") return { status: "cancelled" };
    return { status: "sent", body: args.body };
  });
  const CHECK = 'raft message read --target "#ops"';
  const resumeWith = { ...options, commands: [def], checkLine: () => CHECK };
  const first = await pausedId(start(def, { ...options, args: ARGS }));
  const second = await pausedId(resume(first, { choice: "y" }, resumeWith));
  assert.equal(server.written.size, 1, "the first answer's run wrote");

  const flagged = { mayHaveTakenEffect: true, check: CHECK };
  const program = { name: "raft", version: "1.2.4" };
  assert.deepEqual(errorOf(await resume(second, { choice: "y" }, { ...resumeWith, program })), {
    code: "PROGRAM_CHANGED", id: second, command: "message thread", args: ARGS, recorded: options.program, current: program, ...flagged,
  });
  // No command and no line from the program: the line the first answer's tombstone kept.
  assert.deepEqual(errorOf(await resume(second, { choice: "y" }, { ...resumeWith, commands: [], checkLine: () => undefined })), {
    code: "UNKNOWN_COMMAND", id: second, command: "message thread", ...flagged,
  });
  // A divergence in a run that claimed the answer itself: the earlier answer still ran.
  postStep = "post#changed";
  const diverged = errorOf(await resume(second, { choice: "y" }, resumeWith));
  assert.equal(diverged?.code, "REPLAY_DIVERGED");
  assert.deepEqual(diverged && "mayHaveTakenEffect" in diverged && [diverged.mayHaveTakenEffect, diverged.check], [true, CHECK]);
  postStep = "post";

  const third = await pausedId(resume(await pausedId(start(def, { ...options, args: ARGS })), { choice: "y" }, resumeWith));
  advance(DEFAULT_CONTINUATION_TTL_MS + 1);
  assert.deepEqual(errorOf(await resume(third, { choice: "y" }, resumeWith)), {
    code: "EXPIRED", id: third, command: "message thread", args: ARGS, createdAt: T0, expiresAt: T0 + DEFAULT_CONTINUATION_TTL_MS, ...flagged,
  });
  assert.equal((await store.get(third)), undefined);
  assert.equal(server.written.size, 2, "nothing ran again");
});

test("a step before the first question that may have written: that continuation's refusals say what to check, never to run it again", async () => {
  const { store, options, advance } = harness();
  const server = fakeServer();
  // Reading outside state outside a step breaks the replay rule on purpose (the divergence below).
  let postStep = "post";
  const def = defineCommand<SendArgs, SendResult>("message post", async (ctx, args) => {
    await ctx.step(postStep, ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
    await ctx.ask("more", { question: "Post a follow-up?", options: { y: "Yes", n: "No" } });
    return { status: "sent", body: args.body };
  });
  const CHECK = 'raft message read --target "#ops"';
  const resumeWith = { ...options, commands: [def], checkLine: () => CHECK };
  const flagged = { mayHaveTakenEffect: true, check: CHECK };

  const id = await pausedId(start(def, { ...options, args: ARGS }));
  const record = (await store.get(id))!;
  assert.deepEqual([record.rootId, record.status, record.journal.map((entry) => entry.kind)], [id, "pending", ["step"]], "a first continuation, no answer yet");
  assert.equal(server.written.size, 1, "the step before the question wrote");

  const program = { name: "raft", version: "1.2.4" };
  assert.deepEqual(errorOf(await resume(id, { choice: "y" }, { ...resumeWith, program })), {
    code: "PROGRAM_CHANGED", id, command: "message post", args: ARGS, recorded: options.program, current: program, ...flagged,
  });
  assert.deepEqual(errorOf(await resume(id, { choice: "y" }, { ...resumeWith, commands: [] })), {
    code: "UNKNOWN_COMMAND", id, command: "message post", ...flagged,
  });
  advance(DEFAULT_CONTINUATION_TTL_MS + 1);
  assert.deepEqual(errorOf(await resume(id, { choice: "y" }, resumeWith)), {
    code: "EXPIRED", id, command: "message post", args: ARGS, createdAt: T0, expiresAt: T0 + DEFAULT_CONTINUATION_TTL_MS, ...flagged,
  });

  const other = await pausedId(start(def, { ...options, args: ARGS }));
  const stored = (await store.get(other))!;
  await store.update({ ...stored, formatVersion: 2, revision: stored.revision + 1 }, stored.revision);
  assert.deepEqual(errorOf(await resume(other, { choice: "y" }, resumeWith)), {
    code: "FORMAT_CHANGED", id: other, recorded: 2, current: CONTINUATION_FORMAT_VERSION, mayHaveTakenEffect: true, check: null,
  });

  const drifting = await pausedId(start(def, { ...options, args: ARGS }));
  postStep = "post#changed";
  const diverged = errorOf(await resume(drifting, { choice: "y" }, resumeWith));
  assert.equal(diverged?.code, "REPLAY_DIVERGED");
  assert.deepEqual(diverged && "mayHaveTakenEffect" in diverged && [diverged.mayHaveTakenEffect, diverged.check], [true, CHECK]);
});

test("steps declared read-only before the first question: past its deadline the agent can run the command again", async () => {
  const { store, options, advance } = harness();
  const def = defineCommand<SendArgs, SendResult>("message look", async (ctx) => {
    await ctx.step("look", () => ["@alice  hi"], { readOnly: true });
    await ctx.step("look again", () => 2, { readOnly: true });
    await ctx.ask("go", { question: "Go on?", options: { y: "Yes" } });
    return { status: "cancelled" };
  });
  const resumeWith = { ...options, commands: [def], checkLine: () => 'raft message read --target "#ops"' };
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  assert.deepEqual((await store.get(id))?.journal.map((entry) => entry.kind === "step" && entry.readOnly), [true, true]);
  advance(DEFAULT_CONTINUATION_TTL_MS + 1);
  assert.deepEqual(errorOf(await resume(id, { choice: "y" }, resumeWith)), {
    code: "EXPIRED", id, command: "message look", args: ARGS, createdAt: T0, expiresAt: T0 + DEFAULT_CONTINUATION_TTL_MS,
    mayHaveTakenEffect: false, check: null,
  });
});

test("a failed step before the question counts as a write unless declared read-only, and keeps its flag", async () => {
  const { store, options, advance } = harness();
  const failing = (readOnly: boolean) => defineCommand<SendArgs, SendResult>(`message try ${readOnly}`, async (ctx) => {
    try {
      await ctx.step("send", () => {
        throw Object.assign(new Error("service unavailable"), { code: "UNAVAILABLE" });
      }, { readOnly });
    } catch {
      await ctx.ask("retry", { question: "Sending failed. Try again?", options: { y: "Try again", n: "Give up" } });
    }
    return { status: "cancelled" };
  });
  const CHECK = 'raft message read --target "#ops"';
  const writes = failing(false);
  const reads = failing(true);
  const resumeWith = { ...options, commands: [writes, reads], checkLine: () => CHECK };
  const wrote = await pausedId(start(writes, { ...options, args: ARGS }));
  const read = await pausedId(start(reads, { ...options, args: ARGS }));
  const failure = { name: "Error", message: "service unavailable", code: "UNAVAILABLE" };
  assert.deepEqual((await store.get(wrote))?.journal, [{ kind: "step", id: "send", error: failure }], "readOnly: false is not kept");
  assert.deepEqual((await store.get(read))?.journal, [{ kind: "step", id: "send", error: failure, readOnly: true }]);

  advance(DEFAULT_CONTINUATION_TTL_MS + 1);
  const refusal = async (id: ContinuationId) => {
    const error = errorOf(await resume(id, { choice: "y" }, resumeWith));
    return error?.code === "EXPIRED" ? [error.mayHaveTakenEffect, error.check] : error;
  };
  assert.deepEqual(await refusal(wrote), [true, CHECK]);
  assert.deepEqual(await refusal(read), [false, null]);
});

test("a step's read-only flag survives the journal's round trips: the claim, each replay, the outcome", async () => {
  const { store, options } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  assert.deepEqual(await resume(id, { choice: "a" }, { ...options, commands: [def] }), { kind: "done", result: { status: "sent", body: ARGS.body } });
  const journal = (await store.get(id))?.journal ?? [];
  assert.deepEqual(journal.map((entry) => [entry.kind, entry.id, "readOnly" in entry ? entry.readOnly : "absent"]), [
    ["step", "check", true],
    ["ask", "fresh", "absent"],
    ["step", "send", "absent"],
  ]);
});

test("whether a journal may have taken effect is read defensively: only a step declared read-only is known not to have", () => {
  assert.equal(journalMayHaveTakenEffect([]), false);
  assert.equal(journalMayHaveTakenEffect([{ kind: "step", id: "a", result: 1, readOnly: true }, { kind: "step", id: "b", error: { name: "Error", message: "x" }, readOnly: true }]), false);
  for (const journal of [
    [{ kind: "step", id: "a", result: 1 }],
    [{ kind: "step", id: "a", result: 1, readOnly: "yes" }],
    [{ kind: "step", id: "a", result: 1, readOnly: false }],
    [{ kind: "ask", id: "go", answer: { choice: "y" } }],
    [{ kind: "something new", id: "x", readOnly: true }],
    [null],
    ["step"],
    undefined,
    { 0: { kind: "step", readOnly: true } },
  ]) {
    assert.equal(journalMayHaveTakenEffect(journal), true, JSON.stringify(journal));
  }
});

test("a record of another format is refused as FORMAT_CHANGED and left alone", async () => {
  const { store, options } = harness();
  const def = messageSend(fakeServer(["@alice  hi"]));
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  const record = (await store.get(id))!;
  await store.update({ ...record, formatVersion: 2, revision: 1 }, 0);
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...options, commands: [def] })), {
    code: "FORMAT_CHANGED", id, recorded: 2, current: CONTINUATION_FORMAT_VERSION, mayHaveTakenEffect: false, check: null,
  });
  assert.equal((await store.get(id))?.formatVersion, 2);
});

test("a tombstone carries the format; one of another format is refused as FORMAT_CHANGED, not read", async () => {
  const { store, options, advance } = harness();
  const def = messageSend(fakeServer(["@alice  hi"]));
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  await resume(id, { choice: "a" }, resumeWith);
  assert.equal((await store.getTombstone(id))?.formatVersion, CONTINUATION_FORMAT_VERSION);

  advance(DEFAULT_CONTINUATION_RESULT_RETENTION_MS + 1);
  await start(messageSend(fakeServer()), { ...options, args: ARGS });
  const tombstone = (await store.getTombstone(id))!;
  await store.putTombstone({ ...tombstone, formatVersion: 2 });
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, resumeWith)), {
    code: "FORMAT_CHANGED", id, recorded: 2, current: CONTINUATION_FORMAT_VERSION, mayHaveTakenEffect: true, check: null,
  });
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...resumeWith, ownerAgentId: "agent-2" })), { code: "NOT_YOURS", id });
});

test("UNKNOWN for an id nothing stored; UNKNOWN_COMMAND when the program no longer has the command", async () => {
  const { options } = harness();
  const def = messageSend(fakeServer(["@alice  hi"]));
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  const ghost = asContinuationId("nothing999");
  assert.deepEqual(errorOf(await resume(ghost, { choice: "a" }, { ...options, commands: [def] })), { code: "UNKNOWN", id: ghost });
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...options, commands: [] })), { code: "UNKNOWN_COMMAND", id, command: "message send", mayHaveTakenEffect: false, check: null });
});

test("a replay that does not follow the journal is refused as REPLAY_DIVERGED", async () => {
  const { options } = harness();
  // Reading outside state outside a step breaks the replay rule on purpose.
  let path: "one" | "two" | "none" = "one";
  const def = defineCommand<SendArgs, SendResult>("drifting", async (ctx) => {
    if (path === "none") return { status: "cancelled" };
    await ctx.step(path, () => path, { readOnly: true });
    await ctx.ask("go", { question: "Go?", options: { y: "Yes" } });
    return { status: "cancelled" };
  });
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));

  path = "two";
  const diverged = {
    code: "REPLAY_DIVERGED", id, command: "drifting", args: ARGS, position: 0,
    expected: { kind: "step", id: "one" }, actual: { kind: "step", id: "two" }, mayHaveTakenEffect: false, check: null,
  };
  assert.deepEqual(errorOf(await resume(id, { choice: "y" }, resumeWith)), diverged);
  // The run let go of the answer: a retry takes it over and replays (and diverges) again instead of
  // waiting. Having taken over, it cannot tell what the run before it did.
  assert.deepEqual(errorOf(await resume(id, { choice: "y" }, resumeWith)), { ...diverged, mayHaveTakenEffect: true });

  path = "none";
  assert.deepEqual(errorOf(await resume(id, { choice: "y" }, resumeWith)), { ...diverged, actual: null, mayHaveTakenEffect: true });
});

test("a crash after an external write: the retry repeats the step with the same key and the write lands once", async () => {
  const { store, options } = harness();
  const server = fakeServer(["@alice  hi"]);
  let notes = 0;
  const def = defineCommand<SendArgs, SendResult>("message send", async (ctx, args) => {
    await ctx.step("check", () => server.newReplies(), { readOnly: true });
    await ctx.ask("fresh", FRESH_ASK);
    await ctx.step("note", () => { notes += 1; return notes; });
    const sent = await ctx.step("send", ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
    return { status: "sent", body: sent.body };
  });
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));

  server.afterWrite = () => {
    server.afterWrite = undefined;
    throw new Error("connection reset after the write");
  };
  await assert.rejects(resume(id, { choice: "a" }, resumeWith), /connection reset/);
  assert.deepEqual((await store.get(id))?.journal.map((entry) => entry.id), ["check", "fresh", "note"], "steps before the crash were stored");

  assert.deepEqual(await resume(id, { choice: "a" }, resumeWith), { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.deepEqual(server.sendKeys, ["continuation:id1:send", "continuation:id1:send"]);
  assert.deepEqual([...server.written], [["continuation:id1:send", ARGS.body]]);
  assert.equal(notes, 1, "a stored step is not run again");
});

test("a step failure the command catches is journaled, so it can ask and resume down the same path", async () => {
  const { store, options } = harness();
  const server = fakeServer();
  const caught: unknown[] = [];
  const def = defineCommand<SendArgs, SendResult>("message send", async (ctx, args) => {
    try {
      const sent = await ctx.step("send", ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
      return { status: "sent", body: sent.body };
    } catch (error) {
      caught.push(error);
      const answer = await ctx.ask("retry", { question: "Sending failed. Try again?", options: { y: "Try again", n: "Give up" } });
      if (answer.choice === "n") return { status: "cancelled" };
      const sent = await ctx.step("send#2", ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
      return { status: "sent", body: sent.body };
    }
  });
  server.beforeWrite = () => {
    server.beforeWrite = undefined;
    throw Object.assign(new Error("service unavailable"), { code: "UNAVAILABLE", responseBody: "the draft: Fixed in #11290" });
  };

  const id = await pausedId(start(def, { ...options, args: ARGS }));
  const failure = { name: "Error", message: "service unavailable", code: "UNAVAILABLE" };
  // Name, message and code only: no stack, no response body.
  assert.deepEqual((await store.get(id))?.journal, [{ kind: "step", id: "send", error: failure }]);

  assert.deepEqual(await resume(id, { choice: "y" }, { ...options, commands: [def] }), { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.deepEqual(server.sendKeys, ["continuation:id1:send", "continuation:id1:send#2"], "the replay did not call the failed step again");
  assert.deepEqual([...server.written.keys()], ["continuation:id1:send#2"]);
  assert.equal(caught.length, 2);
  for (const error of caught) {
    assert.ok(error instanceof ContinuationStepError);
    assert.equal(error.stepId, "send");
    assert.deepEqual(error.failure, failure);
    assert.equal(error.message, "service unavailable");
  }
  assert.ok((caught[0] as Error).cause instanceof Error, "the first run keeps the original error for diagnostics");
  assert.equal((caught[1] as Error).cause, undefined);
});

test("an answer claimed 1 ms before the deadline finishes, even when another command's sweep runs past the deadline mid-run", async () => {
  const { store, options, advance } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  advance(DEFAULT_CONTINUATION_TTL_MS - 1);

  const reached = deferred();
  const gate = deferred();
  server.afterWrite = async () => {
    server.afterWrite = undefined;
    reached.resolve();
    await gate.promise;
  };
  const running = resume(id, { choice: "a" }, resumeWith);
  await reached.promise;
  advance(2);
  await start(messageSend(fakeServer()), { ...options, args: ARGS });
  assert.equal((await store.get(id))?.status, "answered", "the sweep kept the answered record");

  gate.resolve();
  assert.deepEqual(await running, { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.deepEqual(await resume(id, { choice: "a" }, resumeWith), { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.equal(server.runs, 2);
}, GATED_TEST_TIMEOUT_MS);

test("past the answer deadline the same answer still gets the stored result; once that is gone, RESULT_EXPIRED and never a new run", async () => {
  const { options, advance } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  const sweep = () => start(messageSend(fakeServer()), { ...options, args: ARGS });
  advance(DEFAULT_CONTINUATION_TTL_MS - 1);
  const done = await resume(id, { choice: "a" }, resumeWith);

  // Past the answer deadline, within the retention after the outcome.
  advance(2);
  await sweep();
  assert.deepEqual(await resume(id, { choice: "a" }, resumeWith), done);
  advance(DEFAULT_CONTINUATION_TTL_MS);
  await sweep();
  assert.deepEqual(await resume(id, { choice: "a" }, resumeWith), done, "a deadline's length later, still within the retention");

  advance(DEFAULT_CONTINUATION_RESULT_RETENTION_MS - DEFAULT_CONTINUATION_TTL_MS);
  await sweep();
  const gone = { code: "RESULT_EXPIRED", id, rootId: id, command: "message send", finishedAt: T0 + DEFAULT_CONTINUATION_TTL_MS - 1, check: null };
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, resumeWith)), gone);
  assert.deepEqual(errorOf(await resume(id, { choice: "c" }, resumeWith)), gone);
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, { ...resumeWith, ownerAgentId: "agent-2" })), { code: "NOT_YOURS", id });
  assert.equal(server.runs, 2, "nothing ran again");
  assert.equal(server.sendKeys.length, 1);

  advance(CONTINUATION_TOMBSTONE_MS);
  await sweep();
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, resumeWith)), { code: "UNKNOWN", id });
});

test("the tombstone keeps the check line the program rendered when the run started; RESULT_EXPIRED names it", async () => {
  const { store, options, advance } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const rendered: Array<[string, unknown]> = [];
  const checkLine = (command: string, args: unknown) => {
    rendered.push([command, args]);
    return `raft message read --target "${(args as SendArgs).target}"`;
  };
  const resumeWith = { ...options, commands: [def], checkLine };
  const sweep = () => start(messageSend(fakeServer()), { ...options, args: ARGS });

  const id = await pausedId(start(def, { ...options, args: ARGS }));
  await resume(id, { choice: "a" }, resumeWith);
  assert.deepEqual(rendered, [["message send", ARGS]], "rendered once, from the command and its arguments");
  assert.equal((await store.getTombstone(id))?.check, 'raft message read --target "#ops"');

  advance(DEFAULT_CONTINUATION_RESULT_RETENTION_MS + 1);
  await sweep();
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, resumeWith)), {
    code: "RESULT_EXPIRED", id, rootId: id, command: "message send", finishedAt: T0, check: 'raft message read --target "#ops"',
  });

  // A renderer that throws or gives nothing keeps no line, and the run is not affected.
  for (const broken of [() => { throw new Error("no target"); }, () => undefined, () => ""]) {
    const other = await pausedId(start(def, { ...options, args: ARGS }));
    assert.equal((await resume(other, { choice: "a" }, { ...resumeWith, checkLine: broken })).kind, "done");
    const tombstone = await store.getTombstone(other);
    assert.ok(tombstone && !("check" in tombstone), JSON.stringify(tombstone));
  }
});

test("an answered run that never reached an outcome leaves a tombstone without finishedAt", async () => {
  const { options, advance } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));
  server.afterWrite = () => {
    throw new Error("connection reset after the write");
  };
  await assert.rejects(resume(id, { choice: "a" }, resumeWith), /connection reset/);

  advance(CONTINUATION_RUN_LEASE_MS + DEFAULT_CONTINUATION_RESULT_RETENTION_MS + 1);
  await start(messageSend(fakeServer()), { ...options, args: ARGS });
  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, resumeWith)), {
    code: "RESULT_EXPIRED", id, rootId: id, command: "message send", finishedAt: null, check: null,
  });
});

test("a run whose process died is taken over once its lease runs out; the stale run can no longer write", async () => {
  const { options, advance } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));

  const reached = deferred();
  const hang = deferred();
  server.afterWrite = async () => {
    server.afterWrite = undefined;
    reached.resolve();
    await hang.promise;
  };
  const stale = resume(id, { choice: "a" }, resumeWith);
  await reached.promise;

  assert.deepEqual(errorOf(await resume(id, { choice: "a" }, resumeWith)), { code: "IN_PROGRESS", id });
  advance(CONTINUATION_RUN_LEASE_MS);
  assert.deepEqual(await resume(id, { choice: "a" }, resumeWith), { kind: "done", result: { status: "sent", body: ARGS.body } });

  hang.resolve();
  assert.deepEqual(errorOf(await stale), { code: "IN_PROGRESS", id });
  assert.deepEqual(await resume(id, { choice: "a" }, resumeWith), { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.equal(server.written.size, 1);
}, GATED_TEST_TIMEOUT_MS);

test("the lease is renewed before each step, so a slow step after slow local work is not taken over", async () => {
  const { options, advance } = harness();
  const reached = deferred();
  const gate = deferred();
  let uploads = 0;
  let localWork: (() => void) | undefined = () => advance(20_000);
  const def = defineCommand<SendArgs, SendResult>("upload", async (ctx) => {
    await ctx.ask("go", { question: "Upload?", options: { y: "Yes" } });
    await ctx.step("prepare", () => 1);
    localWork?.();
    localWork = undefined;
    await ctx.step("upload", async () => {
      uploads += 1;
      if (uploads === 1) {
        reached.resolve();
        await gate.promise;
      }
      return 2;
    });
    return { status: "cancelled" };
  });
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));

  const holder = resume(id, { choice: "y" }, resumeWith);
  await reached.promise;
  // 35 s since "prepare" was stored, 15 s since "upload" began.
  advance(15_000);
  assert.deepEqual(errorOf(await resume(id, { choice: "y" }, resumeWith)), { code: "IN_PROGRESS", id });
  gate.resolve();
  assert.deepEqual(await holder, { kind: "done", result: { status: "cancelled" } });
  assert.equal(uploads, 1);
}, GATED_TEST_TIMEOUT_MS);

test("a store failure while a run writes its progress stops the run; the command never sees it as the step's error", async () => {
  const { store, options } = harness();
  const server = fakeServer();
  let updates = 0;
  // The third update of the resume (claim, before "send", after "send") fails once.
  const flaky: ContinuationStore = {
    ...store,
    update(record, expectedRevision) {
      updates += 1;
      if (updates === 3) throw new Error("disk full");
      return store.update(record, expectedRevision);
    },
  };
  const caught: unknown[] = [];
  const def = defineCommand<SendArgs, SendResult>("message send", async (ctx, args) => {
    await ctx.ask("go", { question: "Send?", options: { y: "Yes" } });
    try {
      const sent = await ctx.step("send", ({ idempotencyKey }) => server.send(idempotencyKey, args.body));
      return { status: "sent", body: sent.body };
    } catch (error) {
      caught.push(error);
      return { status: "cancelled" };
    }
  });
  const resumeWith = { ...options, store: flaky, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));

  await assert.rejects(resume(id, { choice: "y" }, resumeWith), /disk full/);
  // A catch-all sees only the signal that unwinds a stopped run (as for a pause), and its return is ignored.
  assert.equal(caught.length, 1);
  assert.ok(!(caught[0] instanceof ContinuationStepError) && !String(caught[0]).includes("disk full"), String(caught[0]));
  // The run let go of the answer: a retry replays the unstored step under the same key.
  assert.deepEqual(await resume(id, { choice: "y" }, resumeWith), { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.deepEqual(server.sendKeys, ["continuation:id1:send", "continuation:id1:send"]);
  assert.equal(server.written.size, 1);
});

test("concurrent resumes: only one runs the command", async () => {
  const { options } = harness();
  const server = fakeServer(["@alice  hi"]);
  const def = messageSend(server);
  const resumeWith = { ...options, commands: [def] };
  const id = await pausedId(start(def, { ...options, args: ARGS }));

  const gate = deferred();
  server.afterWrite = () => gate.promise;
  const first = resume(id, { choice: "a" }, resumeWith);
  const sameAnswer = resume(id, { choice: "a" }, resumeWith);
  const otherAnswer = resume(id, { choice: "c" }, resumeWith);
  assert.deepEqual(errorOf(await sameAnswer), { code: "IN_PROGRESS", id });
  assert.deepEqual(errorOf(await otherAnswer), {
    code: "ALREADY_ANSWERED", id, command: "message send", args: ARGS, previous: { choice: "a" }, answeredAt: T0,
  });
  gate.resolve();
  assert.deepEqual(await first, { kind: "done", result: { status: "sent", body: ARGS.body } });
  assert.equal(server.sendKeys.length, 1);
}, GATED_TEST_TIMEOUT_MS);

test("a command that swallows the pause still pauses; a call id used twice is a bug in the command", async () => {
  const { options } = harness();
  const swallowing = defineCommand<SendArgs, SendResult>("swallow", async (ctx) => {
    try {
      await ctx.ask("go", { question: "Go?", options: { y: "Yes" } });
    } catch {
      // A command must not do this; the runtime pauses anyway.
    }
    await ctx.step("after", () => 1).catch(() => 0);
    return { status: "cancelled" };
  });
  assert.equal((await start(swallowing, { ...options, args: ARGS })).kind, "paused");

  const twice = defineCommand<SendArgs, SendResult>("twice", async (ctx) => {
    await ctx.step("load", () => 1);
    await ctx.step("load", () => 2);
    return { status: "cancelled" };
  });
  await assert.rejects(start(twice, { ...options, args: ARGS }), /"load" is used twice/);
});

test("command definitions of any argument and result types resume together", () => {
  const defs: readonly CommandDefinition[] = [messageSend(fakeServer()), defineCommand<{ n: number }, number>("count", async (_ctx, { n }) => n)];
  assert.deepEqual(defs.map((def) => def.name), ["message send", "count"]);
});
