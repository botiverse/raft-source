// The continuation pilot for `raft message send` (the Server's
// continuations_pilot_v0 flag, which the CLI reads from the agent context
// when a send is held), through the real `raft` program (buildRaftProgram)
// against a fake server that books one message per idempotency key, with the
// CLI trace sink captured. Off, a held send is today's draft flow; on, it asks.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";

import { CONTINUATION_RUN_LEASE_MS, type ContinuationStore } from "@botiverse/raft-shared/src/continuations/index";

import type { AgentContext } from "../../auth/env";
import type { ApiResponse } from "../../client";
import { CliExit } from "../../core/errors";
import { buildRaftProgram } from "../../program";
import { __setCliTraceSinkForTest, type CliTraceSpanRecord } from "../../transportTrace";
import { resolveStateDbPath } from "../../state/agentLedger";
import { createCliContinuationStore } from "../../state/continuationStore";
import { getConsumedSeq } from "./_consumedSeqState";
import { getSavedDraft } from "./_continueDraftState";

/** Reaches the command or the server's reply; none of it may reach a span. */
const PRIVATE = { body: "PRIVATE-PILOT-BODY", reply: "PRIVATE-PILOT-REPLY", held: "PRIVATE-HELD-CONTEXT" };
const T0 = Date.UTC(2026, 9, 26, 13, 2);
const PROGRAM = { name: "raft", version: "1.0.0" };
const TARGET = "#ops";

let root = "";
let agents = 0;
let agentId = "";
let now = T0;
let spans: CliTraceSpanRecord[] = [];
const savedEnv = { SLOCK_CLI_STATE_DIR: process.env.SLOCK_CLI_STATE_DIR, RAFT_HOME: process.env.RAFT_HOME };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-send-continuation-"));
  // The send's ledger (drafts, read cursors) resolves from process.env; the continuation store from the command's env. Same place.
  process.env.SLOCK_CLI_STATE_DIR = path.join(root, "state");
  process.env.RAFT_HOME = path.join(root, "home");
  agentId = `agent-send-continuation-${++agents}`;
  now = T0;
  spans = [];
  __setCliTraceSinkForTest((record) => spans.push(record));
});

afterEach(() => {
  __setCliTraceSinkForTest(null);
  const shipped = JSON.stringify(spans);
  for (const [what, value] of Object.entries(PRIVATE)) assert.ok(!shipped.includes(value), `a span carries the ${what}: ${shipped}`);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const agentContext = (): AgentContext => ({
  agentId,
  serverUrl: "http://stub.local",
  serverId: "server-pilot",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
});

const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, status: 200, error: null, errorCode: null, data });

/**
 * What the agent context says of the pilot: on, off (no field, as a Server
 * with the flag off answers), from an older Server (no `features` at all), or
 * a read that fails.
 */
type PilotFlag = "on" | "off" | "older-server" | "failing";

function contextBody(pilot: PilotFlag): Record<string, unknown> {
  return {
    agent: { id: agentId, name: "pilot", displayName: "Pilot", description: null, runtime: "claude", external: false },
    server: { id: "server-pilot", slug: "pilot", name: "Pilot" },
    credential: { capabilities: ["read", "send"] },
    prompt: null,
    ...(pilot === "older-server" ? {} : {
      features: { reminderApp: false, vaultApp: false, enabledApps: [], ...(pilot === "on" ? { continuationsPilot: true } : {}) },
    }),
  };
}

/**
 * A message server: holds while its script says so (never a send that asks
 * to go anyway), suggests sending anyway from the third rehold (as the server
 * does), and books each idempotency key once, replaying the receipt after. It
 * answers the agent context with the pilot flag as `pilot` says, and counts
 * the reads.
 */
function fakeServer(script: Array<"held" | "sent"> = [], pilot: PilotFlag = "on") {
  const server = {
    pilot,
    contextReads: 0,
    bodies: [] as Array<Record<string, unknown>>,
    booked: new Map<string, string>(),
    /** Runs after a message is booked, before the reply (a hang there). */
    afterBook: undefined as (() => Promise<void>) | undefined,
    /** Runs when a send arrives, while the CLI waits for the reply. */
    onSend: undefined as ((body: Record<string, unknown>) => void) | undefined,
    request: async (_method: string, requestPath: string, body?: Record<string, unknown>): Promise<ApiResponse<unknown>> => {
      if (requestPath === "/internal/agent-api/context") {
        server.contextReads += 1;
        if (server.pilot === "failing") return { ok: false, status: 503, error: "unavailable", errorCode: null, data: null };
        return ok(contextBody(server.pilot));
      }
      if (!requestPath.includes("send")) return { ok: false, status: 404, error: "not stubbed", errorCode: null, data: null };
      const sent = body ?? {};
      server.bodies.push(sent);
      server.onSend?.(sent);
      const key = String(sent.idempotencyKey);
      const bookedId = server.booked.get(key);
      if (bookedId) return ok({ ok: true, state: "sent", messageId: bookedId });
      if (sent.continueAnyway !== true && (script.shift() ?? "sent") === "held") {
        const holds = server.bodies.filter((b) => b.reconcileOnly !== true).length;
        return ok({
          state: "held",
          newMessageCount: 1,
          shownMessageCount: 1,
          omittedMessageCount: 0,
          seenUpToSeq: 77 + holds,
          holdReasons: ["unread_messages"],
          continueAnywaySuggested: Number(sent.draftReholdCount ?? 0) >= 3,
          heldMessages: [{ seq: 77 + holds, id: `m${77 + holds}`, senderName: "alice", content: PRIVATE.held }],
        });
      }
      const messageId = `msg-${server.booked.size + 1}`;
      server.booked.set(key, messageId);
      await server.afterBook?.();
      return ok({ ok: true, state: "sent", messageId });
    },
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runRaft(
  argv: string[],
  server: Server,
  options: { stdin?: string; store?: () => ContinuationStore; runtime?: string } = {},
): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildRaftProgram({
    io: {
      stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
    env: {
      SLOCK_CLI_STATE_DIR: process.env.SLOCK_CLI_STATE_DIR,
      RAFT_HOME: process.env.RAFT_HOME,
      RAFT_CURRENT_RUNTIME: options.runtime ?? "claude",
    },
    loadAgentContext: agentContext,
    createApiClient: () => ({ request: server.request }) as never,
    continuations: { program: PROGRAM, now: () => now, stdinWindowMs: 50, ...(options.store ? { store: options.store } : {}) },
  });
  let exitCode = 0;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    exitCode = error.exitCode;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}

const send = (server: Server, options: { stdin?: string; store?: () => ContinuationStore } = {}) =>
  runRaft(["message", "send", "--target", TARGET], server, { stdin: `${PRIVATE.body}\n`, ...options });
const cont = (server: Server, id: string, choice: string, stdin?: string) => runRaft(["__continue", id, choice], server, { stdin });

function continuationIdOf(run: Run): string {
  assert.equal(run.exitCode, 10, run.stderr);
  const id = /\(continuation ([0-9a-z]{10}), expires at/.exec(run.stdout)?.[1];
  assert.ok(id, run.stdout);
  return id;
}

const spansNamed = (name: string) => spans.filter((span) => span.name === name);

/**
 * Break the saved copy's ledger row while its send is in flight, so removing
 * it when the send is held fails (its compare-and-clear reads the row as JSON).
 */
function breakSavedCopy(): void {
  const db = new DatabaseSync(resolveStateDbPath(agentId, process.env));
  try {
    db.prepare("UPDATE drafts SET payload = 'not json' WHERE target = ?").run(TARGET);
  } finally {
    db.close();
  }
}
const options = (id: string, withAnyway = false, cardOnly = false) => [
  cardOnly
    ? "  a) Don't send it: what's shown above makes it unnecessary"
    : "  a) Don't send it: what's shown above already says it (for example, someone already answered), or makes it unnecessary",
  `     cont ${id} a`,
  "  b) Write a new message (your text on stdin)",
  `     cont ${id} b <<'RAFTMSG'`,
  "     <your text>",
  "     RAFTMSG",
  "  c) Send your message as it is",
  `     cont ${id} c`,
  ...(withAnyway ? ["  d) Send it anyway, without reading the new messages", `     cont ${id} d`] : []),
];

test("pilot off, unknown or unreadable: a held send keeps today's draft flow, its held text byte for byte", async () => {
  const off = fakeServer(["held"], "off");
  const held = await send(off);
  assert.equal(held.exitCode, 1);
  expect(held.stdout).toMatchSnapshot();
  assert.match(held.stderr, /Code: SEND_HELD_AS_DRAFT/);
  assert.equal(getSavedDraft(agentId, TARGET)?.content, `${PRIVATE.body}\n`);
  assert.equal(off.contextReads, 1, "read once, when the send was held");

  // An older Server (no features in the context) and a context read that fails: off as well.
  for (const pilot of ["older-server", "failing"] as const) {
    agentId = `${agentId}-${pilot}`;
    const server = fakeServer(["held"], pilot);
    const run = await send(server);
    assert.equal(run.exitCode, 1, pilot);
    assert.equal(run.stdout, held.stdout, `${pilot}: today's held text`);
    assert.equal(run.stderr, held.stderr, `${pilot}: today's error`);
    assert.equal(getSavedDraft(agentId, TARGET)?.content, `${PRIVATE.body}\n`);
    assert.equal(server.contextReads, 1);
  }
  assert.equal(spansNamed("cli.continuation.created").length, 0);
});

test("the flag is read once, only when a send is held: none for a send that goes through, none for cont", async () => {
  const quiet = fakeServer([]);
  const sent = await send(quiet);
  assert.equal(sent.exitCode, 0, sent.stderr);
  assert.equal(quiet.contextReads, 0, "not held: nothing to decide");

  const server = fakeServer(["held", "held"]);
  const id = continuationIdOf(await send(server));
  assert.equal(server.contextReads, 1, "one read for the held send");
  const again = await cont(server, id, "c");
  continuationIdOf(again);
  assert.equal(server.contextReads, 1, "cont answers the continuation whatever the flag says now");

  // Turned off while a continuation waits: it can still be answered.
  const flip = fakeServer(["held"]);
  const flipId = continuationIdOf(await send(flip));
  flip.pilot = "off";
  const answered = await cont(flip, flipId, "c");
  assert.equal(answered.exitCode, 0, answered.stderr);
  assert.equal(flip.booked.size, 1);
  assert.equal(flip.contextReads, 1, "only the send that was held read it");
});

test("on: a held send asks what to do and keeps the message in the continuation, not a draft (exit 10)", async () => {
  const server = fakeServer(["held"]);
  const run = await send(server);
  const id = continuationIdOf(run);
  assert.equal(run.stdout, [
    `New messages arrived in ${TARGET} since you last read it.`,
    "  1 unread message.",
    "  ├ Latest 1 ────────────────────────────",
    `  │ @alice  ${PRIVATE.held}`,
    "  └ ────────────────────────────────────────",
    `Answer with one of these (continuation ${id}, expires at 13:12 UTC):`,
    ...options(id),
    "",
  ].join("\n"));
  assert.equal(run.stderr, "");
  assert.equal(getSavedDraft(agentId, TARGET), null, "no held draft");
  assert.equal(server.bodies.length, 1, "the held send was not sent again");
  assert.match(String(server.bodies[0]!.idempotencyKey), /^[0-9a-f-]{36}$/, "today's send, under today's key: it is the continuation's first step");
  assert.equal(server.bodies[0]!.content, `${PRIVATE.body}\n`);
  assert.equal(server.contextReads, 1);

  const [created] = spansNamed("cli.continuation.created");
  assert.equal(created?.attrs.pilot, true);
  assert.equal(created?.attrs.command, "message send");
  assert.equal(created?.attrs.ask_kind, "choice_with_input");
  assert.equal(spansNamed("cli.draft.resolved").length, 0, "no drafts, no draft spans");
  assert.equal(spansNamed("cli.draft.held").length, 0, "the message lives in the continuation, not a held draft");
});

test("c: the same message is sent once, under its step's key, attesting what the hold showed; the same answer again only reports it", async () => {
  const server = fakeServer(["held"]);
  const id = continuationIdOf(await send(server));
  const sent = await cont(server, id, "c");
  assert.equal(sent.exitCode, 0, sent.stderr);
  assert.match(sent.stdout, /^Message sent to #ops\. Message ID: msg-1\. Thread: "#ops:msg-1"\n/);
  const retry = server.bodies[1]!;
  assert.equal(retry.idempotencyKey, `continuation:${id}:send#2`);
  assert.equal(retry.content, `${PRIVATE.body}\n`);
  assert.equal(retry.sendDraft, true, "as `--send-draft` sends the held message");
  assert.equal(retry.draftReholdCount, 1);
  assert.equal(retry.seenUpToSeq, 78, "the held message shown with the question counts as read");

  const again = await cont(server, id, "c");
  assert.equal(again.exitCode, 0, again.stderr);
  assert.equal(again.stdout, "Message sent to #ops. Message ID: msg-1\n");
  assert.equal(server.booked.size, 1);
  assert.equal(server.bodies.length, 2, "nothing was sent again");
  assert.equal(getSavedDraft(agentId, TARGET), null);
});

test("b sends the new message from stdin; a sends nothing and says so", async () => {
  const server = fakeServer(["held"]);
  const rewritten = continuationIdOf(await send(server));
  const sent = await cont(server, rewritten, "b", `${PRIVATE.reply}\n`);
  assert.equal(sent.exitCode, 0, sent.stderr);
  const body = server.bodies.at(-1)!;
  assert.equal(body.content, `${PRIVATE.reply}\n`);
  assert.equal(body.draftReplacedExisting, true, "as a normal send replacing a held draft");
  assert.equal(body.sendDraft, undefined);
  assert.equal(server.booked.size, 1);

  const quiet = fakeServer(["held"]);
  const dropped = continuationIdOf(await send(quiet));
  const notSent = await cont(quiet, dropped, "a");
  assert.deepEqual(notSent, { stdout: "Not sent.\n", stderr: "", exitCode: 0 });
  assert.equal(quiet.bodies.length, 1, "nothing more was sent");
  assert.equal(quiet.booked.size, 0);
});

test("held again: a new continuation with the same options; from the third rehold, d sends anyway", async () => {
  const server = fakeServer(["held", "held", "held", "held"]);
  const first = continuationIdOf(await send(server));
  const secondRun = await cont(server, first, "c");
  const second = continuationIdOf(secondRun);
  assert.notEqual(second, first);
  assert.ok(secondRun.stdout.includes(options(second).join("\n")), secondRun.stdout);
  assert.ok(!secondRun.stdout.includes(" d) "), "not yet");
  const third = continuationIdOf(await cont(server, second, "c"));
  const fourthRun = await cont(server, third, "c");
  const fourth = continuationIdOf(fourthRun);
  assert.ok(fourthRun.stdout.includes(options(fourth, true).join("\n")), fourthRun.stdout);
  assert.deepEqual(server.bodies.map((body) => body.draftReholdCount), [0, 1, 2, 3]);

  const anyway = await cont(server, fourth, "d");
  assert.equal(anyway.exitCode, 0, anyway.stderr);
  const last = server.bodies.at(-1)!;
  assert.equal(last.continueAnyway, true);
  assert.equal(last.sendDraft, true, "as `--send-draft --anyway`");
  assert.equal(last.idempotencyKey, `continuation:${first}:send#5`, "every attempt in the chain keys from its root");
  assert.equal(server.booked.size, 1);
  assert.deepEqual(spansNamed("cli.continuation.answered").map((span) => [span.attrs.choice, span.attrs.outcome]), [
    ["c", "paused_again"], ["c", "paused_again"], ["c", "paused_again"], ["d", "done"],
  ]);
});

test("past its deadline: the send already ran (it was held), so EXPIRED says what to check, never to run the send again", async () => {
  const server = fakeServer(["held"]);
  const id = continuationIdOf(await send(server));
  now += 10 * 60_000 + 1;
  const expired = await cont(server, id, "c");
  assert.equal(expired.exitCode, 1);
  assert.equal(expired.stderr, [
    `Continuation ${id} expired at 13:12 UTC (10 minutes to answer); nothing after its question ran. Part of this command already ran and may have taken effect, so check before running anything again:`,
    `  raft message read --target "${TARGET}"`,
    "",
  ].join("\n"));
  assert.ok(!expired.stderr.includes("raft message send"), "no rerun line");
  assert.ok(!expired.stderr.includes(PRIVATE.body));
  assert.equal(server.bodies.length, 1);
});

test("--send-draft finds no draft while the message waits in the continuation; cont then sends it, once", async () => {
  const server = fakeServer(["held"]);
  const id = continuationIdOf(await send(server));
  const draft = await runRaft(["message", "send", "--send-draft", "--target", TARGET], server);
  assert.equal(draft.exitCode, 1);
  assert.match(draft.stderr, /Code: SEND_DRAFT_NOT_FOUND/);
  assert.equal(server.bodies.length, 1, "--send-draft sent nothing");

  assert.equal((await cont(server, id, "c")).exitCode, 0);
  assert.equal(server.booked.size, 1);
  assert.equal((await runRaft(["message", "send", "--send-draft", "--target", TARGET], server)).exitCode, 1);
  assert.equal(server.booked.size, 1, "still one message");
});

test("a send step run twice (its first run taken over) books one message: both runs pass the step's key", async () => {
  const server = fakeServer(["held"]);
  const id = continuationIdOf(await send(server));
  let reached!: () => void;
  const atBook = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const hang = new Promise<void>((resolve) => { release = resolve; });
  server.afterBook = async () => {
    server.afterBook = undefined;
    reached();
    await hang;
  };
  const stale = cont(server, id, "c");
  await atBook;
  assert.equal((await cont(server, id, "c")).exitCode, 1, "in progress");

  now += CONTINUATION_RUN_LEASE_MS;
  const takeover = await cont(server, id, "c");
  assert.equal(takeover.exitCode, 0, takeover.stderr);
  assert.match(takeover.stdout, /^Message sent to #ops\. Message ID: msg-1\. Thread: "#ops:msg-1"\n/);
  release();
  assert.equal((await stale).exitCode, 1, "the run taken over can no longer write its outcome");

  const stepKey = `continuation:${id}:send#2`;
  assert.equal(server.bodies.filter((body) => body.idempotencyKey === stepKey).length, 2, "the step ran twice");
  assert.equal(server.booked.size, 1, "and the server booked one message");
}, 10_000);

test("a later attempt held with a copy it cannot remove: the question still holds the message, and the same cont sends it once, under the same key", async () => {
  const server = fakeServer(["held", "held"]);
  const id = continuationIdOf(await send(server));
  const stepKey = `continuation:${id}:send#2`;
  server.onSend = (body) => {
    if (body.idempotencyKey !== stepKey) return;
    server.onSend = undefined;
    breakSavedCopy();
  };
  const failed = await cont(server, id, "c");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stdout, "");
  assert.ok(failed.stderr.startsWith(
    `Error: Your message could not be cleared from this computer's saved copy, so it is still kept for this question. Answer again with the same command: cont ${id} c\nCode: LOCAL_WRITE_FAILED\n`,
  ), failed.stderr);
  assert.equal(server.booked.size, 0);

  const again = await cont(server, id, "c");
  assert.equal(again.exitCode, 0, again.stderr);
  assert.equal(server.bodies.filter((body) => body.idempotencyKey === stepKey).length, 2, "the retry ran the same step, under the same key");
  assert.equal(server.booked.size, 1, "one message");

  // An answer with text: the same command is the same text again.
  const withText = fakeServer(["held", "held"]);
  const rewritten = continuationIdOf(await send(withText));
  withText.onSend = (body) => {
    if (body.idempotencyKey !== `continuation:${rewritten}:send#2`) return;
    withText.onSend = undefined;
    breakSavedCopy();
  };
  const refused = await cont(withText, rewritten, "b", `${PRIVATE.reply}\n`);
  assert.ok(refused.stderr.includes(`Answer again with the same command: cont ${rewritten} b <<'RAFTMSG'\n<the same text>\nRAFTMSG\n`), refused.stderr);
  assert.equal((await cont(withText, rewritten, "b", `${PRIVATE.reply}\n`)).exitCode, 0);
  assert.equal(withText.booked.size, 1);
});

test("the first send held with a copy it cannot remove keeps no question: today's wording", async () => {
  const server = fakeServer(["held"]);
  server.onSend = () => {
    server.onSend = undefined;
    breakSavedCopy();
  };
  const failed = await send(server);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stdout, "");
  assert.ok(failed.stderr.startsWith(
    "Error: Message held: no target delivery occurred, and its local copy could not be removed, so it was not kept for an answer.\nCode: LOCAL_WRITE_FAILED\n",
  ), failed.stderr);
  assert.equal(spansNamed("cli.continuation.created").length, 0);
});

test("a question that could not be saved showed nothing: the held messages stay unread, and the next send holds for them again", async () => {
  const server = fakeServer(["held", "held"]);
  const ledger = createCliContinuationStore(agentId, process.env);
  const unsaved = await send(server, { store: () => ({ ...ledger, put: () => { throw new Error("database is locked"); } }) });
  assert.equal(unsaved.exitCode, 1);
  assert.equal(unsaved.stdout, "", "no question was printed");
  assert.ok(unsaved.stderr.startsWith(
    `The command could not save its question on this computer; steps before it may already have taken effect. Check before running it again:\n  raft message read --target "${TARGET}"\n`,
  ), unsaved.stderr);
  assert.equal(getConsumedSeq(agentId, TARGET), undefined, "the held messages were not recorded as read");

  const next = await send(server);
  assert.equal(server.bodies[1]!.seenUpToSeq, undefined, "the next send does not attest them");
  assert.ok(next.stdout.includes(PRIVATE.held), "and shows them");
  continuationIdOf(next);
  assert.equal(getConsumedSeq(agentId, TARGET), 79, "once shown with a question, they are");
});

test("JSON, reviewer isolation and --send-draft keep the draft flow with the pilot on", async () => {
  const server = fakeServer(["held"]);
  const json = await runRaft(["message", "send", "--json", "--target", TARGET], server, { stdin: `${PRIVATE.body}\n` });
  assert.equal(json.exitCode, 1);
  assert.equal(server.contextReads, 0, "a JSON send cannot pause, so the flag is not read");
  assert.match(json.stderr, /"code":"SEND_HELD_AS_DRAFT"/);
  assert.equal(getSavedDraft(agentId, TARGET)?.content, `${PRIVATE.body}\n`);
  assert.equal(spansNamed("cli.continuation.created").length, 0);
});

test("a codex agent keeps the draft flow with the pilot on: it reads exit 10 as a failure (#wg-ax:#5)", async () => {
  const server = fakeServer(["held"]);
  const run = await runRaft(["message", "send", "--target", TARGET], server, { stdin: `${PRIVATE.body}\n`, runtime: "codex" });
  assert.equal(run.exitCode, 1);
  assert.equal(server.contextReads, 0, "the runtime decides before the flag is read");
  assert.match(run.stderr, /SEND_HELD_AS_DRAFT/);
  assert.equal(getSavedDraft(agentId, TARGET)?.content, `${PRIVATE.body}\n`, "the message survives as a draft");
  assert.equal(spansNamed("cli.continuation.created").length, 0);
});

test("held for a channel description alone: the question says so, the description is the preview, and anyway is never offered", async () => {
  const card = { id: "c-ops", name: "ops", type: "channel", description: "Release coordination. Post go/no-go here." };
  const server = fakeServer();
  const request = server.request;
  server.request = async (method, requestPath, body) => (
    requestPath.includes("send") && server.bodies.length === 0
      ? (server.bodies.push(body ?? {}), ok({ state: "held", newMessageCount: 0, heldMessages: [], holdReasons: ["channel_card"], channelCard: card, continueAnywaySuggested: true }))
      : request(method, requestPath, body)
  );
  const run = await send(server);
  const id = continuationIdOf(run);
  assert.equal(run.stdout, [
    "The description of #ops is not in your current context yet.",
    "  Channel #ops (public): Release coordination. Post go/no-go here.",
    '  Equivalent: raft channel info "#ops"',
    `Answer with one of these (continuation ${id}, expires at 13:12 UTC):`,
    ...options(id, false, true),
    "",
  ].join("\n"));
  assert.equal((await cont(server, id, "c")).exitCode, 0);
  assert.equal(server.booked.size, 1);
});
