// `raft message send --card <file>` (RFC 082 §4.1): the card is checked with
// the shared schema before any request (path and limit), the text on stdin is
// optional (the Server derives the fallback), mentions need written text, a
// card carries no files, the Server's card refusals carry their next step,
// a held card send keeps its card in the draft, and an answer that stored no
// card (no `messageCard`: an older Server) says the text went out alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, test } from "vitest";

import { createCommandContext } from "../../core/context";
import { getSavedDraft } from "./_continueDraftState";
import { formatHeldSendOutput, messageSendCommand } from "./send";

const AGENT = "agent-send-message-card";
const ENV_KEYS = ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR", "SLOCK_CLI_TRANSPORT_DIR", "RAFT_HOME"] as const;
let prior: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let root = "";

beforeEach(() => {
  prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-send-message-card-"));
  for (const key of ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR"] as const) {
    process.env[key] = path.join(root, "state");
  }
  process.env.RAFT_HOME = root;
  delete process.env.SLOCK_CLI_TRANSPORT_DIR;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

const CARD = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["title", "state"] },
    title: { type: "Text", props: { text: "Raft App 1.19.0 (11900001)" } },
    state: { type: "Badge", props: { text: "In review", tone: "review" } },
  },
};

function cardFile(card: unknown = CARD, name = "card.json"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof card === "string" ? card : JSON.stringify(card, null, 2));
  return file;
}

type Reply = { ok: boolean; status: number; error: string | null; data: unknown; errorCode?: string; errorBody?: unknown };

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
    loadAgentContext: () => ({ agentId: AGENT, serverUrl: "http://stub.local", clientMode: "self-hosted-runner", profileSlug: "t" }) as never,
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: Record<string, unknown>) => {
        requests.push({ method, path: requestPath, body: body ?? {} });
        const reply = replies.shift();
        if (!reply) throw new Error("missing test response");
        return reply;
      },
    }) as never,
  });
  return { ctx, requests, out: () => stdout.join(""), err: () => stderr.join("") };
}

const MESSAGE_ID = "1a2b3c4d-1111-4222-8333-444455556666";
const sent: Reply = { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: MESSAGE_ID, messageSeq: 7, messageCard: { revision: 1 } } };
/** A Server older than card messages: it ignores `card`, posts the text and answers with no `messageCard`. */
const sentWithoutCard: Reply = { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: MESSAGE_ID, messageSeq: 7 } };
const TEXT_ONLY = "Sent as text only: this Server stored no card (it may be older than card messages). The card wasn't shown; send it again where card messages are on.";

function refusal(status: number, code: string, error: string, extra: Record<string, unknown> = {}): Reply {
  const body = { error, code, ...extra };
  return { ok: false, status, error, data: null, errorCode: code, errorBody: body };
}

test("a card from a file is sent on v2 with the text on stdin as its fallback, and the receipt says how to update it", async () => {
  const run = harness([sent], ["Raft App 1.19.0 (11900001): in review\n"]);
  await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile() });
  assert.equal(run.requests.length, 1);
  assert.match(run.requests[0]!.path, /\/v2\/send$/);
  assert.deepEqual(run.requests[0]!.body.card, CARD, "the card as written (the Server fills defaults in)");
  assert.equal(run.requests[0]!.body.content, "Raft App 1.19.0 (11900001): in review\n");
  assert.equal(
    run.out(),
    `Message sent to #builds. Message ID: ${MESSAGE_ID}. Thread: "#builds:1a2b3c4d"\n`
      + "To update this card later (up to 14 days; notifies no one): raft message update-card --message-id 1a2b3c4d --card <file> --expected-revision 1\n",
  );
});

test("an answer without messageCard is still a success: the receipt says the message went out as text only, with no update hint", async () => {
  const run = harness([sentWithoutCard], ["Raft App 1.19.0 (11900001): in review\n"]);
  await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile() });
  assert.equal(
    run.out(),
    `Message sent to #builds. Message ID: ${MESSAGE_ID}. Thread: "#builds:1a2b3c4d"\n${TEXT_ONLY}\n`,
  );
  assert.equal(run.err(), "", "not an error: the text was sent");
  assert.equal(getSavedDraft(AGENT, "#builds"), null, "the send committed: no draft is kept");

  // --json prints the receipt as the Server answered it: no messageCard.
  const json = harness([sentWithoutCard], ["text\n"]);
  await messageSendCommand.handler(json.ctx, [], { target: "#builds", card: cardFile(), json: true });
  assert.equal(Object.hasOwn(JSON.parse(json.out()) as object, "messageCard"), false);

  // A text send says nothing about cards.
  const text = harness([sentWithoutCard], ["just text\n"]);
  await messageSendCommand.handler(text.ctx, [], { target: "#builds" });
  assert.doesNotMatch(text.out(), /card/i);
});

test("the update hint starts from the revision the receipt names (a replay after the card was updated)", async () => {
  const replayed: Reply = { ...sent, data: { ...(sent.data as object), messageCard: { revision: 3 } } };
  const run = harness([replayed], ["text\n"]);
  await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile() });
  assert.match(run.out(), /raft message update-card --message-id 1a2b3c4d --card <file> --expected-revision 3\n$/);
});

test("a lost answer reconciled as committed: the card line comes from the reconciliation's messageCard", async () => {
  const lost: Reply = { ok: false, status: 503, error: "upstream unavailable", data: null };
  const committed = (extra: Record<string, unknown>): Reply => ({
    ok: true, status: 200, error: null,
    data: { ok: true, state: "committed", messageId: MESSAGE_ID, messageSeq: 7, reconciliation: true, receiptComplete: false, ...extra },
  });
  const stored = harness([lost, committed({ messageCard: { revision: 1 } })], ["text\n"]);
  await messageSendCommand.handler(stored.ctx, [], { target: "#builds", card: cardFile() });
  assert.equal(stored.requests[1]!.body.reconcileOnly, true);
  assert.match(stored.out(), /^Message commit confirmed for #builds\. Message ID: /);
  assert.match(stored.out(), /no message was replayed\.\nTo update this card later \(up to 14 days; notifies no one\): raft message update-card --message-id 1a2b3c4d --card <file> --expected-revision 1\n$/);

  const textOnly = harness([lost, committed({})], ["text\n"]);
  await messageSendCommand.handler(textOnly.ctx, [], { target: "#builds", card: cardFile() });
  assert.ok(textOnly.out().endsWith(`no message was replayed.\n${TEXT_ONLY}\n`), textOnly.out());
  assert.doesNotMatch(textOnly.out(), /update-card/);
});

test("without text on stdin no content is sent: the Server derives the fallback from the card", async () => {
  const run = harness([sent], []);
  await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile() });
  assert.equal("content" in run.requests[0]!.body, false);
  assert.deepEqual(run.requests[0]!.body.card, CARD);
});

test("a card that breaks a rule is refused with its path and limit before any request or stdin read", async () => {
  const cases: Array<[unknown, RegExp, string, string]> = [
    [
      { ...CARD, elements: { ...CARD.elements, open: { type: "Button", props: { label: "Open", action: { kind: "navigate", url: "http://example.com/x" } } } } },
      /^Card invalid at card\.elements\.open\.props\.action\.url \(url\): A button's URL must be a public https: URL/,
      "card.elements.open.props.action.url",
      "url",
    ],
    [
      { version: 1, root: "e0", elements: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`e${i}`, { type: "Text", props: { text: "x" } }])) },
      /^Card invalid at card\.elements \(elements\): The card has 17 elements; at most 16/,
      "card.elements",
      "elements",
    ],
    ["{ not json", /^Card invalid at card \(shape\): The card file is not JSON/, "card", "shape"],
  ];
  for (const [card, message, cardPath, limit] of cases) {
    const stdin = Readable.from(["text\n"]);
    const run = harness([], stdin);
    await assert.rejects(
      async () => { await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile(card) }); },
      (err: { code?: string; message?: string; details?: Record<string, unknown>; suggestedNextAction?: string }) => {
        assert.equal(err.code, "CARD_INVALID");
        assert.match(err.message ?? "", message);
        assert.match(err.message ?? "", /fix it and run the same command again\. Nothing was sent\.$/);
        assert.deepEqual(err.details, { path: cardPath, limit });
        assert.match(err.suggestedNextAction ?? "", new RegExp(`^Fix ${cardPath.replace(/[.[\]]/g, "\\$&")} in `));
        return true;
      },
    );
    assert.equal(run.requests.length, 0);
    assert.equal(stdin.readableEnded, false, "stdin was not read");
  }
});

test("v2.0: a card with a header, Markdown, Fields and a Divider is sent as written; Markdown outside the subset is refused before any request, naming the node", async () => {
  const v2 = {
    version: 1,
    header: { title: "Play rejected this submission: 1.20.0", tags: [{ text: "Failed", tone: "danger" }] },
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["facts", "rule", "notes"] },
      facts: { type: "Fields", props: { items: [{ label: "Version", value: "1.20.0", mono: true }] } },
      rule: { type: "Divider", props: {} },
      notes: { type: "Markdown", props: { content: "Raise **targetSdk** to 35." } },
    },
  };
  const ok = harness([sent]);
  await messageSendCommand.handler(ok.ctx, [], { target: "#builds", card: cardFile(v2) });
  assert.deepEqual(ok.requests[0]!.body.card, v2);
  assert.equal("content" in ok.requests[0]!.body, false, "the Server derives the fallback, the header first");

  const heading = { ...v2, elements: { ...v2.elements, notes: { type: "Markdown", props: { content: "## Notes" } } } };
  const run = harness([]);
  await assert.rejects(
    async () => { await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile(heading) }); },
    (err: { code?: string; message?: string; details?: Record<string, unknown> }) => {
      assert.equal(err.code, "CARD_INVALID");
      assert.match(err.message ?? "", /^Card invalid at card\.elements\.notes\.props\.content \(markdown\): Markdown has a heading at line 1, column 1/);
      assert.deepEqual(err.details, { path: "card.elements.notes.props.content", limit: "markdown", node: "heading" });
      return true;
    },
  );
  assert.equal(run.requests.length, 0);

  // The Server's refusal (a CLI older than the subset sent it) keeps the node too.
  const server = harness([refusal(400, "card_invalid", "Card invalid at card.elements.notes.props.content (markdown): Markdown has a table …", { path: "card.elements.notes.props.content", limit: "markdown", node: "table" })], ["text\n"]);
  await assert.rejects(
    async () => { await messageSendCommand.handler(server.ctx, [], { target: "#builds", card: cardFile(v2) }); },
    { code: "CARD_INVALID", details: { path: "card.elements.notes.props.content", limit: "markdown", node: "table" } },
  );
});

test("no text and nothing on the card to derive one from is refused before any request", async () => {
  const onlyButton = { version: 1, root: "open", elements: { open: { type: "Button", props: { label: "Open", action: { kind: "navigate", url: "https://example.com/x" } } } } };
  const run = harness([]);
  await assert.rejects(
    async () => { await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile(onlyButton) }); },
    { code: "CARD_INVALID", details: { path: "card", limit: "fallback" } },
  );
  assert.equal(run.requests.length, 0);
});

test("--mention without text is refused: a derived fallback mentions no one", async () => {
  const run = harness([]);
  await assert.rejects(
    async () => {
      await messageSendCommand.handler(run.ctx, [], {
        target: "#builds",
        card: cardFile(),
        mention: ["agent:00000000-1111-4222-8333-444455556666:hands"],
      });
    },
    { code: "MESSAGE_CARD_MENTIONS_WITHOUT_CONTENT" },
  );
  assert.equal(run.requests.length, 0);
});

test("--card with --attachment-id is refused before any request or stdin read: a card message carries no files", async () => {
  // Whatever the ids are: a well-formed one, or one that is not an id at all.
  for (const attachmentId of [["1a2b3c4d-1111-4222-8333-444455556666"], ["not-an-attachment-id"]]) {
    const stdin = Readable.from(["text\n"]);
    const run = harness([], stdin);
    await assert.rejects(
      async () => { await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile(), attachmentId }); },
      (err: { code?: string; message?: string; suggestedNextAction?: string }) => {
        assert.equal(err.code, "MESSAGE_CARD_WITH_ATTACHMENTS");
        assert.equal(err.message, "A card message carries no files: --card cannot be used with --attachment-id. Nothing was sent.");
        assert.equal(err.suggestedNextAction, "Send the card without --attachment-id, and send the files in a separate message.");
        return true;
      },
    );
    assert.equal(run.requests.length, 0);
    assert.equal(stdin.readableEnded, false, "stdin was not read");
  }
});

test("a card file that cannot be read, or --card -, is refused before any request", async () => {
  const missing = harness([]);
  await assert.rejects(
    async () => { await messageSendCommand.handler(missing.ctx, [], { target: "#builds", card: path.join(root, "nope.json") }); },
    { code: "CARD_FILE_UNREADABLE" },
  );
  const dash = harness([]);
  await assert.rejects(
    async () => { await messageSendCommand.handler(dash.ctx, [], { target: "#builds", card: "-" }); },
    (err: { code?: string; message?: string }) => err.code === "INVALID_ARG" && /stdin is the message text/.test(err.message ?? ""),
  );
  assert.equal(missing.requests.length + dash.requests.length, 0);
});

test("the Server's card refusals keep their code and say what to do next", async () => {
  const cases: Array<[Reply, string, RegExp]> = [
    [
      refusal(400, "message_cards_disabled", "Card messages are not enabled on this Server (flag message_cards); nothing was posted. Send it without the card, as text."),
      "MESSAGE_CARDS_DISABLED",
      /^Send the message as text: the same command without --card/,
    ],
    // An older Server's joint channel refusal (before RFC 082 v1.8; a current Server takes the card there).
    [
      refusal(400, "message_card_unsupported_target", "This conversation is a joint channel shared with another Server (or a thread in one); card messages are not supported there yet. Nothing was posted; send it as text.", { reason: "joint_channel" }),
      "MESSAGE_CARD_UNSUPPORTED_TARGET",
      /^Send the message as text/,
    ],
    [
      refusal(400, "message_card_with_attachments", "A card message carries no files; nothing was posted. Send the card without attachmentIds, and send the files in a separate message."),
      "MESSAGE_CARD_WITH_ATTACHMENTS",
      /send the files in a separate message\.$/,
    ],
    [
      refusal(400, "card_invalid", "Card invalid at card.elements.title.props.text (text): Text text is 1-500 characters (Unicode code points); this one has 501; fix it and run the same command again.", { path: "card.elements.title.props.text", limit: "text" }),
      "CARD_INVALID",
      /^Fix card\.elements\.title\.props\.text in .*card\.json, then run the same command again\.$/,
    ],
  ];
  for (const [reply, code, next] of cases) {
    const run = harness([reply], ["text\n"]);
    await assert.rejects(
      async () => { await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile() }); },
      (err: { code?: string; message?: string; suggestedNextAction?: string; details?: Record<string, unknown> }) => {
        assert.equal(err.code, code);
        assert.equal(err.message, (reply.errorBody as { error: string }).error);
        assert.match(err.suggestedNextAction ?? "", next);
        if (code === "CARD_INVALID") assert.deepEqual(err.details, { path: "card.elements.title.props.text", limit: "text" });
        return true;
      },
    );
  }
});

test("a held card send keeps the card in its draft, and --send-draft sends it with the card", async () => {
  const file = cardFile();
  const held = harness([{
    ok: true,
    status: 200,
    error: null,
    data: { ok: true, state: "held", newMessageCount: 1, heldMessages: [], seenUpToSeq: 9 },
  }]);
  await assert.rejects(
    async () => { await messageSendCommand.handler(held.ctx, [], { target: "#builds", card: file }); },
    { code: "SEND_HELD_AS_DRAFT" },
  );
  assert.deepEqual(getSavedDraft(AGENT, "#builds")?.card, CARD);
  assert.equal(getSavedDraft(AGENT, "#builds")?.content, "");
  assert.ok(held.out().includes(`raft message send --target "#builds" --card ${file} <<'RAFTMSG'\n  revised message (optional with --card)\n`), held.out());

  const again = harness([sent]);
  await messageSendCommand.handler(again.ctx, [], { target: "#builds", sendDraft: true });
  assert.deepEqual(again.requests[0]!.body.card, CARD);
  assert.equal("content" in again.requests[0]!.body, false);
  assert.equal(again.requests[0]!.body.sendDraft, true);
  assert.equal(getSavedDraft(AGENT, "#builds"), null);
});

test("--card with --send-draft or --discard-draft is refused: the draft keeps the card it was saved with", async () => {
  for (const flag of ["sendDraft", "discardDraft"] as const) {
    const run = harness([]);
    await assert.rejects(
      async () => { await messageSendCommand.handler(run.ctx, [], { target: "#builds", card: cardFile(), [flag]: true }); },
      { code: "CARD_WITH_SAVED_DRAFT_UNSUPPORTED" },
    );
    assert.equal(run.requests.length, 0);
  }
});

test("a held text send's instructions are unchanged; a held card's name the card", () => {
  const data = { newMessageCount: 1, heldMessages: [] };
  const text = formatHeldSendOutput("#builds", data);
  assert.ok(text.includes(`raft message send --target "#builds" <<'RAFTMSG'\n  revised message\n`));
  assert.ok(!text.includes("--card"));
  const card = formatHeldSendOutput("#builds", data, false, true, { file: null });
  assert.ok(card.includes(`raft message send --target "#builds" --card <file> <<'RAFTMSG'\n  revised message (optional with --card)\n`));
  const unsaved = formatHeldSendOutput("#builds", data, false, false, { file: "my card.json" });
  assert.ok(unsaved.includes(`raft message send --target "#builds" --card 'my card.json' <<'RAFTMSG'\n  message (optional with --card)\n`));
});
