// `cli.draft.resolved`: one span per held draft, through the real `raft`
// program (buildRaftProgram), with the CLI trace sink captured.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { AgentContext } from "../../auth/env";
import type { ApiResponse } from "../../client";
import { buildRaftProgram } from "../../program";
import { __setCliTraceSinkForTest, type CliTraceSpanRecord } from "../../transportTrace";
import { recordConsumedSeqs } from "./_consumedSeqState";
import { getSavedDraft, lookupSavedDraft, setSavedDraft, type SavedDraft } from "./_continueDraftState";
import { draftTraceId } from "./_draftResolvedTrace";

const SERVER_ID = "server-draft-trace";
const CHANNEL = "#secretchannel";
const DM = "dm:@secretpeer";
const THREAD = "#secretchannel:shortzz9";

/** Every value here reaches the command; none may reach the span. */
const PRIVATE = {
  draftBody: "PRIVATE-DRAFT-BODY",
  newBody: "PRIVATE-NEW-BODY",
  heldContext: "PRIVATE-HELD-CONTEXT",
  draftKey: "PRIVATE-DRAFT-KEY",
  messageId: "PRIVATE-MESSAGE-ID",
  channel: "secretchannel",
  peer: "secretpeer",
  threadShortId: "shortzz9",
};

// A fresh agent and state per test: read records persist, and a thread read
// in one test would hold a channel send in the next.
let agentId = "";
let testIndex = 0;
const agentContext = (): AgentContext => ({
  agentId,
  serverUrl: "http://stub.local",
  serverId: SERVER_ID,
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
});

type SendReply = "sent" | "held" | "rejected";

const SENT: ApiResponse<unknown> = {
  ok: true,
  status: 200,
  error: null,
  errorCode: null,
  data: { ok: true, state: "sent", messageId: PRIVATE.messageId },
};
const HELD: ApiResponse<unknown> = {
  ok: true,
  status: 200,
  error: null,
  errorCode: null,
  data: {
    state: "held",
    newMessageCount: 1,
    shownMessageCount: 1,
    omittedMessageCount: 0,
    seenUpToSeq: 78,
    heldMessages: [{ seq: 78, id: "msg78", senderName: "alice", content: PRIVATE.heldContext }],
  },
};
const REJECTED: ApiResponse<unknown> = { ok: false, status: 403, error: "not a member", errorCode: null, data: null };

let spans: CliTraceSpanRecord[] = [];
const originalEnv = { ...process.env };

beforeEach(() => {
  spans = [];
  __setCliTraceSinkForTest((record) => spans.push(record));
  agentId = `agent-draft-trace-${testIndex++}`;
  process.env.RAFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-draft-trace-home-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-draft-trace-"));
});

afterEach(() => {
  __setCliTraceSinkForTest(null);
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

async function runRaft(
  argv: string[],
  options: { stdin?: string; reply?: SendReply; env?: NodeJS.ProcessEnv } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sendBodies: Array<Record<string, unknown>> = [];
  const replies: Record<SendReply, ApiResponse<unknown>> = { sent: SENT, held: HELD, rejected: REJECTED };
  const program = buildRaftProgram({
    io: {
      stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
    env: options.env ?? {},
    loadAgentContext: agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string, body?: Record<string, unknown>): Promise<ApiResponse<unknown>> => {
        if (!requestPath.includes("send")) {
          return { ok: false, status: 404, error: "not stubbed", errorCode: null, data: null };
        }
        sendBodies.push(body ?? {});
        return replies[options.reply ?? "sent"];
      },
    }) as never,
  });
  let error: unknown = null;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (caught) {
    error = caught;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), sendBodies, error };
}

function seedHeldDraft(target: string, overrides: Partial<SavedDraft> = {}): SavedDraft {
  const draft: SavedDraft = {
    content: `${PRIVATE.draftBody}\n`,
    attachmentIds: [],
    idempotencyKey: PRIVATE.draftKey,
    savedAt: Date.now() - 5_000,
    reholdCount: 1,
    ...overrides,
  };
  setSavedDraft(agentId, target, draft);
  return draft;
}

/** The `cli.draft.resolved` spans written (a hold also writes `cli.draft.held`). */
const resolvedSpans = (): CliTraceSpanRecord[] => spans.filter((span) => span.name === "cli.draft.resolved");

/** The only `cli.draft.resolved` span written, carrying nothing private. */
function onlyResolvedSpan(): CliTraceSpanRecord {
  const resolved = resolvedSpans();
  assert.equal(resolved.length, 1, `expected one resolved span, got ${JSON.stringify(resolved.map((span) => span.attrs.outcome))}`);
  const [span] = resolved;
  assert.equal(span!.name, "cli.draft.resolved");
  assert.equal(span!.surface, "cli");
  assert.equal(span!.kind, "internal");
  assert.equal(span!.status, "ok", "a resolution is not a failure: the observed-failure summary counts status=error");
  assertNothingPrivate(span!);
  return span!;
}

function assertNothingPrivate(span: CliTraceSpanRecord): void {
  const serialized = JSON.stringify(span);
  for (const [what, value] of Object.entries(PRIVATE)) {
    assert.ok(!serialized.includes(value), `span carries the ${what}: ${serialized}`);
  }
}

function assertHeldMs(span: CliTraceSpanRecord, atLeastMs: number): void {
  const heldMs = span.attrs.held_ms;
  assert.equal(typeof heldMs, "number");
  assert.ok((heldMs as number) >= atLeastMs && (heldMs as number) < atLeastMs + 60_000, `held_ms ${heldMs}`);
}

test("--send-draft that is sent resolves the draft as sent_unchanged", async () => {
  seedHeldDraft(CHANNEL);

  const result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL]);

  assert.equal(result.error, null, result.stderr);
  assert.match(result.stdout, /Message sent/);
  assert.equal(result.sendBodies[0]!.idempotencyKey, PRIVATE.draftKey);
  const span = onlyResolvedSpan();
  assert.deepEqual(span.attrs, {
    producer: "cli",
    outcome: "sent_unchanged",
    // Seeded without a cause, as an older CLI saved it: read as held.
    cause: "held",
    draft_id: draftTraceId(PRIVATE.draftKey),
    target_kind: "channel",
    held_ms: span.attrs.held_ms,
    rehold_count: 1,
    serverId: SERVER_ID,
    agentId,
  });
  assertHeldMs(span, 5_000);
  assert.match(String(span.attrs.draft_id), /^[0-9a-f]{16}$/);
});

test("a normal send that replaces a held draft and is sent resolves the old draft as replaced_and_sent", async () => {
  seedHeldDraft(DM, { reholdCount: 2, savedAt: Date.now() - 30_000 });

  const result = await runRaft(["message", "send", "--target", DM], { stdin: `${PRIVATE.newBody}\n` });

  assert.equal(result.error, null, result.stderr);
  assert.match(result.stdout, /Message sent/);
  const span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "replaced_and_sent");
  assert.equal(span.attrs.target_kind, "dm");
  assert.equal(span.attrs.rehold_count, 2);
  // The id is the replaced draft's, not the new send's.
  assert.equal(span.attrs.draft_id, draftTraceId(PRIVATE.draftKey));
  const newKey = String(result.sendBodies[0]!.idempotencyKey);
  assert.notEqual(span.attrs.draft_id, draftTraceId(newKey));
  assert.ok(!JSON.stringify(span).includes(newKey), "span carries the new send's idempotency key");
  assertHeldMs(span, 30_000);
});

test("a normal send that replaces a held draft and is held again supersedes it; the new draft lives on", async () => {
  seedHeldDraft(THREAD);

  const result = await runRaft(["message", "send", "--target", THREAD], { stdin: `${PRIVATE.newBody}\n`, reply: "held" });

  assert.match(result.stderr, /Code: SEND_HELD_AS_DRAFT/);
  const span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "superseded");
  assert.equal(span.attrs.target_kind, "thread");
  assert.equal(span.attrs.draft_id, draftTraceId(PRIVATE.draftKey));
  assert.equal(span.attrs.rehold_count, 1);
  assert.equal(span.attrs.cause, "held");
  const newDraft = getSavedDraft(agentId, THREAD);
  assert.equal(newDraft?.content, `${PRIVATE.newBody}\n`);
  assert.equal(newDraft?.reholdCount, 2);
  assert.equal(newDraft?.cause, "held");
  assert.notEqual(newDraft?.idempotencyKey, PRIVATE.draftKey);
});

test("a thread-context confirmation that replaces a held draft supersedes it", async () => {
  seedHeldDraft(CHANNEL);
  recordConsumedSeqs(agentId, { [THREAD]: 105 });

  const result = await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n` });

  assert.match(result.stderr, /Code: THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED/);
  assert.equal(result.sendBodies.length, 0);
  const span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "superseded");
  assert.equal(span.attrs.cause, "held", "the replaced draft was held by the server");
  assert.equal(span.attrs.target_kind, "channel");
  assert.equal(span.attrs.draft_id, draftTraceId(PRIVATE.draftKey));
  // The confirmation draft inherits the rehold count, and says why it waits.
  const confirmation = getSavedDraft(agentId, CHANNEL);
  assert.equal(confirmation?.reholdCount, 1);
  assert.equal(confirmation?.cause, "thread_confirmation");
});

test("a confirmation draft ends with cause thread_confirmation: superseded by a re-run, then expired", async () => {
  seedHeldDraft(CHANNEL);
  recordConsumedSeqs(agentId, { [THREAD]: 105 });
  await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n` });
  const firstConfirmation = getSavedDraft(agentId, CHANNEL)!;
  spans = [];

  // The parent send again, still unconfirmed: a second confirmation replaces the first.
  let result = await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n` });
  assert.match(result.stderr, /Code: THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED/);
  let span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "superseded");
  assert.equal(span.attrs.cause, "thread_confirmation");
  assert.equal(span.attrs.draft_id, draftTraceId(firstConfirmation.idempotencyKey!));
  assert.equal(span.attrs.rehold_count, 1);

  // Left unconfirmed past the TTL.
  const secondConfirmation = getSavedDraft(agentId, CHANNEL)!;
  assert.equal(secondConfirmation.cause, "thread_confirmation");
  setSavedDraft(agentId, CHANNEL, { ...secondConfirmation, savedAt: Date.now() - 11 * 60 * 1000 });
  spans = [];
  result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL]);
  assert.match(result.stderr, /Code: SEND_DRAFT_EXPIRED/);
  span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "expired");
  assert.equal(span.attrs.cause, "thread_confirmation");
  assert.equal(span.attrs.draft_id, draftTraceId(secondConfirmation.idempotencyKey!));
});

test("a confirmed confirmation draft is sent_unchanged with its cause; one the server then holds becomes held", async () => {
  seedHeldDraft(CHANNEL);
  recordConsumedSeqs(agentId, { [THREAD]: 105 });
  let result = await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n` });
  assert.match(result.stderr, /Code: THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED/);
  spans = [];

  result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL]);
  assert.match(result.stdout, /Message sent/);
  let span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "sent_unchanged");
  assert.equal(span.attrs.cause, "thread_confirmation");

  seedHeldDraft(CHANNEL);
  result = await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n` });
  assert.match(result.stderr, /Code: THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED/);
  spans = [];
  result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL], { reply: "held" });
  assert.match(result.stderr, /Code: SEND_HELD_AS_DRAFT/);
  assert.deepEqual(resolvedSpans(), [], "held again, the same draft lives on");
  assert.equal(getSavedDraft(agentId, CHANNEL)?.cause, "held");
  result = await runRaft(["message", "send", "--discard-draft", "--target", CHANNEL]);
  span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "discarded");
  assert.equal(span.attrs.cause, "held");
  assert.equal(span.attrs.rehold_count, 2);
});

test("a failed replacing send leaves a draft with the cause of the one it replaced", async () => {
  seedHeldDraft(CHANNEL);
  recordConsumedSeqs(agentId, { [THREAD]: 105 });
  let result = await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n` });
  assert.match(result.stderr, /Code: THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED/);

  // Confirmed, but refused: its pre-send copy stays, with the lineage's count and cause.
  result = await runRaft(["message", "send", "--target-confirmed", "--target", CHANNEL], {
    stdin: `${PRIVATE.newBody}\n`,
    reply: "rejected",
  });
  assert.match(result.stderr, /Code: SEND_FAILED/);
  const leftover = getSavedDraft(agentId, CHANNEL)!;
  assert.equal(leftover.idempotencyKey, result.sendBodies[0]!.idempotencyKey);
  assert.equal(leftover.cause, "thread_confirmation");
  spans = [];

  result = await runRaft(["message", "send", "--discard-draft", "--target", CHANNEL]);
  const span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "discarded");
  assert.equal(span.attrs.cause, "thread_confirmation");
  assert.equal(span.attrs.draft_id, draftTraceId(leftover.idempotencyKey!));
});

test("--discard-draft resolves the draft as discarded", async () => {
  seedHeldDraft(CHANNEL, { reholdCount: 3 });

  const result = await runRaft(["message", "send", "--discard-draft", "--target", CHANNEL]);

  assert.equal(result.error, null, result.stderr);
  assert.match(result.stdout, /Discarded the saved draft/);
  const span = onlyResolvedSpan();
  assert.equal(span.attrs.outcome, "discarded");
  assert.equal(span.attrs.rehold_count, 3);
  assert.equal(span.attrs.draft_id, draftTraceId(PRIVATE.draftKey));
  assert.deepEqual(lookupSavedDraft(agentId, CHANNEL), { status: "missing" });
});

test("a draft found past its TTL resolves as expired, whichever command finds it", async () => {
  const runs: Array<{ argv: string[]; stdin?: string; result: RegExp; stream: "stdout" | "stderr" }> = [
    { argv: ["message", "send", "--send-draft", "--target", CHANNEL], result: /Code: SEND_DRAFT_EXPIRED/, stream: "stderr" },
    { argv: ["message", "send", "--target", CHANNEL], stdin: `${PRIVATE.newBody}\n`, result: /Message sent/, stream: "stdout" },
    { argv: ["message", "send", "--discard-draft", "--target", CHANNEL], result: /No saved draft/, stream: "stdout" },
  ];
  for (const run of runs) {
    spans = [];
    seedHeldDraft(CHANNEL, { savedAt: Date.now() - 11 * 60 * 1000, reholdCount: 2 });

    const result = await runRaft(run.argv, run.stdin === undefined ? {} : { stdin: run.stdin });

    assert.match(result[run.stream], run.result, run.argv.join(" "));
    // An expired draft is gone: a send that follows replaces nothing.
    const span = onlyResolvedSpan();
    assert.equal(span.attrs.outcome, "expired", run.argv.join(" "));
    assert.equal(span.attrs.rehold_count, 2);
    assert.equal(span.attrs.draft_id, draftTraceId(PRIVATE.draftKey));
    assertHeldMs(span, 11 * 60 * 1000);
  }
});

test("drafts the server never held, and drafts that stay unresolved, emit no resolution", async () => {
  // A plain send: its pre-send copy is not a held draft.
  let result = await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n` });
  assert.match(result.stdout, /Message sent/);
  assert.deepEqual(resolvedSpans(), []);

  // A failed send's leftover (rehold count 0), then sent with --send-draft.
  seedHeldDraft(CHANNEL, { reholdCount: 0 });
  result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL]);
  assert.match(result.stdout, /Message sent/);
  assert.deepEqual(resolvedSpans(), []);

  // --send-draft held again: the same draft lives on.
  seedHeldDraft(CHANNEL);
  result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL], { reply: "held" });
  assert.match(result.stderr, /Code: SEND_HELD_AS_DRAFT/);
  assert.equal(getSavedDraft(agentId, CHANNEL)?.reholdCount, 2);
  assert.deepEqual(resolvedSpans(), []);

  // A replacing send the server refuses: nothing was resolved.
  seedHeldDraft(CHANNEL);
  result = await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n`, reply: "rejected" });
  assert.match(result.stderr, /Code: SEND_FAILED/);
  assert.deepEqual(resolvedSpans(), []);
});

test("a send the server holds writes cli.draft.held for the draft it saves; held again, the same draft_id with a higher count", async () => {
  let result = await runRaft(["message", "send", "--target", CHANNEL], { stdin: `${PRIVATE.newBody}\n`, reply: "held" });
  assert.match(result.stderr, /Code: SEND_HELD_AS_DRAFT/);
  const saved = getSavedDraft(agentId, CHANNEL);
  assert.ok(saved?.idempotencyKey);
  const [held] = spans.filter((span) => span.name === "cli.draft.held");
  assert.ok(held, JSON.stringify(spans.map((span) => span.name)));
  assert.equal(held.status, "ok");
  assert.deepEqual(held.attrs, {
    producer: "cli",
    cause: "held",
    draft_id: draftTraceId(saved.idempotencyKey),
    target_kind: "channel",
    rehold_count: 1,
    serverId: SERVER_ID,
    agentId,
  });
  assertNothingPrivate(held);

  spans = [];
  result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL], { reply: "held" });
  assert.match(result.stderr, /Code: SEND_HELD_AS_DRAFT/);
  assert.deepEqual(spans.map((span) => [span.name, span.attrs.draft_id, span.attrs.rehold_count]), [["cli.draft.held", draftTraceId(saved.idempotencyKey), 2]]);

  // Sent: no new hold, and the draft ends.
  spans = [];
  result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL]);
  assert.match(result.stdout, /Message sent/);
  assert.deepEqual(spans.map((span) => span.name), ["cli.draft.resolved"]);
});

test("the span carries the runtime the daemon reports, and omits one that is unset or not an id", async () => {
  const runs: Array<{ env: NodeJS.ProcessEnv; runtime: string | undefined }> = [
    { env: { RAFT_CURRENT_RUNTIME: "codex" }, runtime: "codex" },
    { env: { RAFT_CURRENT_RUNTIME: "kimi-sdk" }, runtime: "kimi-sdk" },
    // An older daemon sets nothing; the agent's shell can set anything.
    { env: {}, runtime: undefined },
    { env: { RAFT_CURRENT_RUNTIME: `${PRIVATE.draftBody} in #${PRIVATE.channel}` }, runtime: undefined },
  ];
  for (const run of runs) {
    spans = [];
    seedHeldDraft(CHANNEL);

    const result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL], { env: run.env });

    assert.equal(result.error, null, result.stderr);
    const span = onlyResolvedSpan();
    assert.equal(span.attrs.outcome, "sent_unchanged");
    assert.equal(span.attrs.runtime, run.runtime, JSON.stringify(run.env));
    assert.equal("runtime" in span.attrs, run.runtime !== undefined);
  }
});

test("the span is appended to the daemon-shipped CLI trace file as a valid ok span", async () => {
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-draft-trace-dir-"));
  seedHeldDraft(CHANNEL);

  const result = await runRaft(["message", "send", "--discard-draft", "--target", CHANNEL], {
    env: { SLOCK_CLI_TRANSPORT_TRACE_DIR: traceDir },
  });

  assert.equal(result.error, null, result.stderr);
  const span = onlyResolvedSpan();
  // The daemon's uploader takes `traces/daemon-trace-*.jsonl` whole; its sink
  // budgets this file under the CLI family by the `cli-transport` prefix.
  const files = fs.readdirSync(traceDir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^daemon-trace-cli-transport-.+\.jsonl$/);
  const lines = fs.readFileSync(path.join(traceDir, files[0]!), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const written = JSON.parse(lines[0]!) as CliTraceSpanRecord;
  assert.deepEqual(written, span);
  assert.equal(written.type, "span");
  assert.equal(written.schema_version, 1);
  assert.match(written.trace_id, /^[0-9a-f]{32}$/);
  assert.match(written.span_id, /^[0-9a-f]{16}$/);
  assert.equal(written.start_time, written.end_time);
  assert.ok(Number.isFinite(Date.parse(written.start_time)));
});

test("a failing trace sink never changes the command result", async () => {
  __setCliTraceSinkForTest(() => {
    throw new Error("trace sink down");
  });
  seedHeldDraft(CHANNEL);

  const result = await runRaft(["message", "send", "--send-draft", "--target", CHANNEL]);

  assert.equal(result.error, null, result.stderr);
  assert.match(result.stdout, /Message sent/);
  assert.equal(getSavedDraft(agentId, CHANNEL), null);
});
