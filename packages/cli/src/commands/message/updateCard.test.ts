// `raft message update-card` (RFC 082 §4.2): the card is checked before any
// request; the answer says nobody was notified; each refusal says what to do
// next; and the retry rule: a 409 for `--expected-revision` reads the current
// card and reports success when it is what this run sent.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, test } from "vitest";

import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import { formatUpdateCardCommand, messageUpdateCardCommand, parseExpectedRevision } from "./updateCard";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-update-card-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const MESSAGE_ID = "1a2b3c4d-1111-4222-8333-444455556666";
const CARD = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["title", "state"] },
    title: { type: "Text", props: { text: "Raft App 1.19.0 (11900001)" } },
    state: { type: "Badge", props: { text: "Ready for testing", tone: "done" } },
  },
};
/** CARD as the Server stores it: defaults filled in, keys in another order. */
const STORED_CARD = {
  elements: {
    state: { props: { tone: "done", text: "Ready for testing" }, type: "Badge" },
    title: { props: { mono: false, text: "Raft App 1.19.0 (11900001)", tone: "default" }, type: "Text" },
    root: { children: ["title", "state"], props: { direction: "column", wrap: false }, type: "Stack" },
  },
  root: "root",
  version: 1,
};

function cardFile(card: unknown = CARD): string {
  const file = path.join(root, "card.json");
  fs.writeFileSync(file, JSON.stringify(card));
  return file;
}

type Reply = { ok: boolean; status: number; error: string | null; data: unknown; errorCode?: string; errorBody?: unknown } | Error;

function harness(replies: Reply[], stdin: string[] | Readable = []) {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createCommandContext({
    io: {
      stdin: stdin instanceof Readable ? stdin : Readable.from(stdin),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    } as never,
    env: {},
    loadAgentContext: () => ({ agentId: "agent-update-card", serverUrl: "http://stub.local", clientMode: "self-hosted-runner", profileSlug: "t" }) as never,
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: Record<string, unknown>) => {
        requests.push({ method, path: requestPath, body: body ?? {} });
        const reply = replies.shift();
        if (!reply) throw new Error("missing test response");
        if (reply instanceof Error) throw reply;
        return reply;
      },
    }) as never,
  });
  return { ctx, requests, out: () => stdout.join(""), err: () => stderr.join("") };
}

function updated(revision: number, unnotified: string[] = []): Reply {
  const notice = unnotified.length === 0
    ? "Updating notifies no one. To tell someone, send a new message."
    : `Updating notifies no one. ${unnotified.join(" and ")} in the new text ${unnotified.length === 1 ? "was" : "were"} not notified; to tell them, send a new message.`;
  return {
    ok: true,
    status: 200,
    error: null,
    data: { ok: true, messageId: MESSAGE_ID, revision, updatedAt: "2026-11-03T12:03:00.000Z", unnotifiedMentionHandles: unnotified, notice },
  };
}

function refusal(status: number, code: string, error: string, extra: Record<string, unknown> = {}): Reply {
  return { ok: false, status, error, data: null, errorCode: code, errorBody: { error, code, ...extra } };
}

const CONFLICT = refusal(409, "card_revision_conflict", "The card is at revision 3, not 2: it was updated since you read it, and nothing changed now. Read it again if you need to, then run the same command again with --expected-revision 3.", { currentRevision: 3 });

const resolved: Reply = {
  ok: true,
  status: 200,
  error: null,
  data: { message: { message_id: MESSAGE_ID, channel_type: "channel", channel_name: "builds", sender_type: "agent", sender_name: "hands", content: "x", timestamp: "2026-11-03T12:00:00.000Z" } },
};

function history(card: unknown, content: string, revision = 3): Reply {
  return {
    ok: true,
    status: 200,
    error: null,
    data: {
      target: "#builds",
      messages: [{ id: MESSAGE_ID, seq: 7, content, actionMetadata: { kind: "message-card", card, revision, updatedAt: "2026-11-03T12:03:00.000Z" } }],
      has_more: false,
      has_older: false,
      has_newer: false,
    },
  };
}

async function failure(run: ReturnType<typeof harness>, opts: Record<string, unknown>): Promise<CliError> {
  try {
    await messageUpdateCardCommand.handler(run.ctx, opts);
  } catch (err) {
    assert.ok(err instanceof CliError, String(err));
    return err;
  }
  throw new Error("expected the command to fail");
}

test("the card and its new text replace the card by message id, with a key for the run; the answer names who was not notified", async () => {
  const run = harness([updated(2, ["@alice"])], ["Ready for testing, @alice\n"]);
  await messageUpdateCardCommand.handler(run.ctx, { messageId: "1a2b3c4d", card: cardFile(), expectedRevision: "1" });
  assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0]!.method, "PUT");
  assert.match(run.requests[0]!.path, /\/internal\/agent-api\/messages\/1a2b3c4d\/card$/);
  const body = run.requests[0]!.body;
  assert.deepEqual(body.card, CARD);
  assert.equal(body.content, "Ready for testing, @alice\n");
  assert.equal(body.expectedRevision, 1);
  assert.match(String(body.idempotencyKey), /^[0-9a-f-]{36}$/);
  assert.equal(
    run.out(),
    "Card updated: message 1a2b3c4d is now at revision 2 (next update: --expected-revision 2).\n"
      + "Updating notifies no one. @alice in the new text was not notified; to tell them, send a new message.\n",
  );
});

test("without text on stdin no content is sent (the Server derives it); --idempotency-key is sent as given; --json prints the answer", async () => {
  const run = harness([updated(4)]);
  await messageUpdateCardCommand.handler(run.ctx, { messageId: MESSAGE_ID, card: cardFile(), idempotencyKey: "build-11900001-r4", json: true });
  const body = run.requests[0]!.body;
  assert.equal("content" in body, false);
  assert.equal("expectedRevision" in body, false);
  assert.equal(body.idempotencyKey, "build-11900001-r4");
  assert.deepEqual(JSON.parse(run.out()), (updated(4) as { data: unknown }).data);
});

test("a card that breaks a rule is refused with its path and limit before any request", async () => {
  const run = harness([]);
  const err = await failure(run, {
    messageId: MESSAGE_ID,
    card: cardFile({ ...CARD, elements: { ...CARD.elements, title: { type: "Text", props: { text: "" } } } }),
  });
  assert.equal(err.code, "CARD_INVALID");
  assert.match(err.message, /^Card invalid at card\.elements\.title\.props\.text \(text\): Text text is 1-500 characters/);
  assert.deepEqual(err.details, { path: "card.elements.title.props.text", limit: "text" });
  assert.equal(run.requests.length, 0);
});

test("409 card_revision_conflict when the card is not what this run sent: the exact command to run again", async () => {
  const other = { ...CARD, elements: { ...CARD.elements, state: { type: "Badge", props: { text: "Expired", tone: "closed" } } } };
  const file = cardFile();
  const run = harness([CONFLICT, resolved, history(other, "Raft App 1.19.0 (11900001) · Expired")], ["Ready\n"]);
  const err = await failure(run, { messageId: "1a2b3c4d", card: file, expectedRevision: "2" });
  assert.equal(err.code, "CARD_REVISION_CONFLICT");
  assert.match(err.message, /^The card is at revision 3, not 2/);
  assert.deepEqual(err.details, { currentRevision: 3 });
  assert.equal(
    err.suggestedNextAction,
    `Read the message if you need to, then run: raft message update-card --message-id 1a2b3c4d --card ${file} --expected-revision 3 (with the same text on stdin)`,
  );
  // The read-back: resolve, then that one message, without consuming it.
  assert.deepEqual([run.requests[1]!.method, run.requests[1]!.path], ["GET", "/internal/agent-api/messages/1a2b3c4d/resolve"]);
  assert.match(run.requests[2]!.path, /\/history\?/);
  const query = new URL(`http://x${run.requests[2]!.path}`).searchParams;
  assert.equal(query.get("channel"), "#builds");
  assert.equal(query.get("around"), MESSAGE_ID);
  assert.equal(query.get("limit"), "1");
  assert.equal(query.get("consume"), "false");
});

test("the retry rule: a 409 whose current card and text are what this run sent reports success (an earlier run landed)", async () => {
  const run = harness([CONFLICT, resolved, history(STORED_CARD, "Ready for testing, @alice\n")], ["Ready for testing, @alice\n"]);
  await messageUpdateCardCommand.handler(run.ctx, { messageId: "1a2b3c4d", card: cardFile(), expectedRevision: "2" });
  assert.equal(
    run.out(),
    "Card already updated: message 1a2b3c4d is at revision 3 with this card and text. An earlier run made the change; nothing changed now (next update: --expected-revision 3).\n"
      + "Updating notifies no one. @alice in the new text was not notified; to tell them, send a new message.\n",
  );
  assert.equal(run.requests.length, 3);
});

test("the retry rule compares the card alone when no text was sent: the Server derives the text, maybe differently from this CLI", async () => {
  // A Server before the markdown rendering derived the " · " form of the same card (RFC 082 §4.2: compared on what was sent).
  const derived = "Raft App 1.19.0 (11900001) · Ready for testing";
  const run = harness([CONFLICT, resolved, history(STORED_CARD, derived)]);
  await messageUpdateCardCommand.handler(run.ctx, { messageId: MESSAGE_ID, card: cardFile(), expectedRevision: "2", json: true });
  const out = JSON.parse(run.out());
  assert.equal(out.alreadyApplied, true);
  assert.equal(out.revision, 3);
  assert.deepEqual(out.unnotifiedMentionHandles, []);
});

test("the retry rule compares the text this run wrote: the same card with another text is still a conflict", async () => {
  const run = harness([CONFLICT, resolved, history(STORED_CARD, "Ready for testing, @bob\n")], ["Ready for testing, @alice\n"]);
  const err = await failure(run, { messageId: "1a2b3c4d", card: cardFile(), expectedRevision: "2" });
  assert.equal(err.code, "CARD_REVISION_CONFLICT");
});

test("404: the one answer for every case, and the next step is a new message", async () => {
  const text = "No card message with this id that you can update. Updating works only on a card message you sent in the last 14 days, that is not deleted or retracted, in a conversation you can still post in; an unknown id gets this same answer. To show the new state, send a new message.";
  const file = cardFile();
  const err = await failure(harness([refusal(404, "message_card_not_found", text, { suggestedNextAction: "send a new message" })]), { messageId: MESSAGE_ID, card: file });
  assert.equal(err.code, "MESSAGE_CARD_NOT_FOUND");
  assert.equal(err.message, text);
  assert.equal(err.suggestedNextAction, `To show the new state, send a new message: raft message send --target <target> --card ${file}`);
});

test("429: how many seconds to wait; the flag off: send text instead; a reused key: a new key", async () => {
  const limited = await failure(harness([refusal(429, "RATE_LIMITED", "This card was updated too often: at most 10 updates a minute per message. Wait 12 seconds, then run the same command again.", { retry_after: 12 })]), { messageId: MESSAGE_ID, card: cardFile() });
  assert.equal(limited.code, "RATE_LIMITED");
  assert.equal(limited.retryable, true);
  assert.equal(limited.suggestedNextAction, "Wait 12 seconds, then run the same command again.");
  assert.deepEqual(limited.details, { retryAfterSeconds: 12 });

  const off = await failure(harness([refusal(400, "message_cards_disabled", "Card messages are not enabled on this Server (flag message_cards); the card was not updated. Send a new message as text.")]), { messageId: MESSAGE_ID, card: cardFile() });
  assert.equal(off.code, "MESSAGE_CARDS_DISABLED");
  assert.equal(off.suggestedNextAction, "Send a new message as text with raft message send.");

  const reused = await failure(harness([refusal(409, "idempotency_key_reused", "idempotencyKey was already used for an update of this card with a different card or content; nothing changed now. Use a new idempotencyKey for a different update.")]), { messageId: MESSAGE_ID, card: cardFile(), idempotencyKey: "k1" });
  assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");
});

test("a request that may not have reached the Server is sent once more under the same key; still unknown, the error names the key to run again with", async () => {
  const transport = () => new CliError({ code: "CHECK_FAILED", message: "transport request failed", faultDomain: "agent_api_transport" });
  const retried = harness([transport(), updated(2)]);
  await messageUpdateCardCommand.handler(retried.ctx, { messageId: MESSAGE_ID, card: cardFile() });
  assert.equal(retried.requests.length, 2);
  assert.equal(retried.requests[1]!.body.idempotencyKey, retried.requests[0]!.body.idempotencyKey);
  assert.match(retried.out(), /^Card updated: message 1a2b3c4d is now at revision 2 \(next update: --expected-revision 2\)\./);

  const unknown = harness([transport(), transport()]);
  const err = await failure(unknown, { messageId: "1a2b3c4d", card: cardFile() });
  const key = String(unknown.requests[0]!.body.idempotencyKey);
  assert.equal(err.retryable, true);
  assert.match(err.suggestedNextAction ?? "", new RegExp(`^It is not known whether the card was updated\\. Run the same command again with this key: raft message update-card --message-id 1a2b3c4d --card \\S+ --idempotency-key ${key}\\. `));
});

test("flags: --message-id and --card are required; --expected-revision is a positive whole number", async () => {
  await assert.rejects(async () => { await messageUpdateCardCommand.handler(harness([]).ctx, { card: cardFile() }); }, { code: "INVALID_ARG" });
  await assert.rejects(async () => { await messageUpdateCardCommand.handler(harness([]).ctx, { messageId: MESSAGE_ID }); }, { code: "INVALID_ARG" });
  assert.equal(parseExpectedRevision("3"), 3);
  for (const bad of ["0", "-1", "r3", "1.5", ""]) assert.throws(() => parseExpectedRevision(bad), { code: "INVALID_ARG" });
  assert.equal(
    formatUpdateCardCommand({ messageId: "1a2b3c4d", file: "my card.json", expectedRevision: 4, idempotencyKey: "k-1", withText: false }),
    "raft message update-card --message-id 1a2b3c4d --card 'my card.json' --expected-revision 4 --idempotency-key k-1",
  );
});
