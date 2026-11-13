// Card messages (RFC 082) as agent operations (the SDK's messages.send with a
// card and messages.updateCard): the card is checked before any request, the
// Server's card refusals keep its sentence, an update is keyed and says
// nobody was notified, and a revision conflict names the current revision.
import assert from "node:assert/strict";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import type { MessageCardInput } from "../messageCard";
import { hashRaftSendContent, sendMessage, updateMessageCard } from "./index";

const MESSAGE_ID = "1a2b3c4d-1111-4222-8333-444455556666";
const CARD: MessageCardInput = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["title", "state"] },
    title: { type: "Text", props: { text: "Raft App 1.19.0 (11900001)" } },
    state: { type: "Badge", props: { text: "In review", tone: "review" } },
  },
};

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };

function client(script: (call: Call) => Response | Promise<Response>, calls: Call[] = []): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const call = { method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
        calls.push(call);
        return script(call);
      },
    },
  });
}

const sent = () => Response.json({ ok: true, state: "sent", messageId: MESSAGE_ID, messageSeq: 7, messageCard: { revision: 1 } });
const TEXT_ONLY = "Sent as text only: this Server stored no card (it may be older than card messages). The card wasn't shown; send it again where card messages are on.";
const updated = (revision: number, unnotified: string[] = []) => Response.json({
  ok: true,
  messageId: MESSAGE_ID,
  revision,
  updatedAt: "2026-11-03T12:03:00.000Z",
  unnotifiedMentionHandles: unnotified,
  notice: unnotified.length === 0
    ? "Updating notifies no one. To tell someone, send a new message."
    : `Updating notifies no one. ${unnotified[0]} in the new text was not notified; to tell them, send a new message.`,
});

test("messages.send with a card and no content sends the card on v2 and no content (the Server derives it)", async () => {
  const calls: Call[] = [];
  const outcome = await sendMessage(client(() => sent(), calls), { target: "#builds", card: CARD });
  assert.equal(outcome.ok && outcome.state, "sent");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.path, /\/v2\/send$/);
  assert.deepEqual(calls[0]!.body!.card, CARD);
  assert.equal("content" in calls[0]!.body!, false);

  const withText = await sendMessage(client(() => sent(), calls), { target: "#builds", card: CARD, content: "1.19.0: in review" });
  assert.equal(withText.ok, true);
  assert.equal(calls[1]!.body!.content, "1.19.0: in review");
});

test("messages.send with a card passes the stored card through; an answer without one says the message went out as text only", async () => {
  const stored = await sendMessage(client(() => sent()), { target: "#builds", card: CARD });
  assert.equal(stored.ok && stored.state, "sent");
  assert.deepEqual(stored.ok && stored.state === "sent" ? stored.data.messageCard : null, { revision: 1 });
  assert.equal(stored.ok ? stored.text : "", `Message sent to #builds. Message ID: ${MESSAGE_ID}`);

  // A Server older than card messages ignores `card` and posts the text with the same success.
  const older = () => Response.json({ ok: true, state: "sent", messageId: MESSAGE_ID, messageSeq: 7 });
  const textOnly = await sendMessage(client(older), { target: "#builds", card: CARD, content: "1.19.0: in review" });
  assert.equal(textOnly.ok && textOnly.state, "sent", "still a success: the text was sent");
  assert.equal(textOnly.ok && textOnly.state === "sent" ? Object.hasOwn(textOnly.data, "messageCard") : null, false);
  assert.equal(textOnly.ok ? textOnly.text : "", `Message sent to #builds. Message ID: ${MESSAGE_ID}\n${TEXT_ONLY}`);

  // A text send says nothing about cards, whatever the answer.
  const plain = await sendMessage(client(older), { target: "#builds", content: "just text" });
  assert.equal(plain.ok ? plain.text : "", `Message sent to #builds. Message ID: ${MESSAGE_ID}`);
  assert.equal(plain.ok && plain.state === "sent" ? Object.hasOwn(plain.data, "messageCard") : null, false);
});

test("a card that breaks a rule, a card with nothing to derive text from, or mentions without content: refused before any request", async () => {
  const calls: Call[] = [];
  const api = client(() => sent(), calls);
  const tooDeep = await sendMessage(api, {
    target: "#builds",
    card: { ...CARD, elements: { ...CARD.elements, open: { type: "Button", props: { label: "Open", action: { kind: "navigate", url: "http://example.com" } } } } },
  });
  assert.equal(!tooDeep.ok && tooDeep.error.code, "INVALID_REQUEST");
  assert.match(!tooDeep.ok ? tooDeep.error.message : "", /^Card invalid at card\.elements\.open\.props\.action\.url \(url\): .* Nothing was sent\.$/);
  assert.equal(!tooDeep.ok && tooDeep.error.nextAction, "Fix card.elements.open.props.action.url, then send the same request again.");

  const onlyButton: MessageCardInput = { version: 1, root: "b", elements: { b: { type: "Button", props: { label: "Open", action: { kind: "navigate", url: "https://example.com/x" } } } } };
  const nothing = await sendMessage(api, { target: "#builds", card: onlyButton });
  assert.match(!nothing.ok ? nothing.error.message : "", /^Card invalid at card \(fallback\)/);

  const mentions = await sendMessage(api, { target: "#builds", card: CARD, mentions: [{ type: "agent", id: "00000000-1111-4222-8333-444455556666", name: "hands" }] });
  assert.match(!mentions.ok ? mentions.error.message : "", /^mentions need the content they appear in/);

  const update = await updateMessageCard(api, { messageId: MESSAGE_ID, card: { version: 1, root: "x", elements: {} } });
  assert.equal(!update.ok && update.error.code, "INVALID_REQUEST");
  assert.equal(calls.length, 0);
});

test("the Server's card refusal keeps its sentence, code and next step", async () => {
  const sentence = "Card messages are not enabled on this Server (flag message_cards); nothing was posted. Send it without the card, as text.";
  const outcome = await sendMessage(
    client(() => Response.json({ error: sentence, code: "message_cards_disabled", suggestedNextAction: "send it again without the card, as text" }, { status: 400 })),
    { target: "#builds", card: CARD, content: "x" },
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, "HTTP_ERROR");
  assert.equal(outcome.error.serverCode, "message_cards_disabled");
  assert.equal(outcome.error.message, sentence);
  assert.equal(outcome.error.nextAction, "send it again without the card, as text");
});

test("messages.updateCard: keyed (generated when omitted), says nobody was notified, retries a request that never arrived under the same key", async () => {
  const calls: Call[] = [];
  let attempt = 0;
  const outcome = await updateMessageCard(client(() => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("fetch failed");
    return updated(2, ["@alice"]);
  }, calls), { messageId: "1a2b3c4d", card: CARD, content: "In review, @alice", expectedRevision: 1 });
  assert.equal(outcome.ok && outcome.state, "updated");
  if (!outcome.ok) return;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [["PUT", "/internal/agent-api/messages/1a2b3c4d/card"], ["PUT", "/internal/agent-api/messages/1a2b3c4d/card"]]);
  assert.equal(calls[1]!.body!.idempotencyKey, calls[0]!.body!.idempotencyKey);
  assert.equal(outcome.data.idempotencyKey, calls[0]!.body!.idempotencyKey);
  assert.deepEqual(calls[0]!.body, { card: CARD, content: "In review, @alice", expectedRevision: 1, idempotencyKey: outcome.data.idempotencyKey });
  assert.deepEqual(outcome.data.unnotifiedMentionHandles, ["@alice"]);
  assert.equal(
    outcome.text,
    "Card updated: message 1a2b3c4d is now at revision 2 (next update: --expected-revision 2).\nUpdating notifies no one. @alice in the new text was not notified; to tell them, send a new message.",
  );
});

test("messages.updateCard: a revision conflict is CONFLICT with the current revision to update with; the one 404 keeps its sentence", async () => {
  const conflict = await updateMessageCard(client(() => Response.json({
    error: "The card is at revision 3, not 2: it was updated since you read it, and nothing changed now. Read it again if you need to, then run the same command again with --expected-revision 3.",
    code: "card_revision_conflict",
    currentRevision: 3,
    suggestedNextAction: "run the same command again with --expected-revision 3",
  }, { status: 409 })), { messageId: MESSAGE_ID, card: CARD, expectedRevision: 2, idempotencyKey: "k-1" });
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.error.code, "CONFLICT");
  assert.equal(conflict.error.message, "The card is at revision 3, not 2: it was updated since you read it, and nothing changed now.");
  assert.equal(conflict.error.nextAction, "Read the message if you need to, then update it again with expectedRevision 3.");
  assert.deepEqual(conflict.next, { kind: "retry_with_revision", args: { expectedRevision: 3 }, why: conflict.error.nextAction });

  const text = "No card message with this id that you can update. Updating works only on a card message you sent in the last 14 days, that is not deleted or retracted, in a conversation you can still post in; an unknown id gets this same answer. To show the new state, send a new message.";
  const missing = await updateMessageCard(client(() => Response.json({ error: text, code: "message_card_not_found", suggestedNextAction: "send a new message" }, { status: 404 })), { messageId: MESSAGE_ID, card: CARD });
  assert.equal(!missing.ok && missing.error.code, "NOT_FOUND");
  assert.equal(!missing.ok && missing.error.message, text);
  assert.equal(!missing.ok && missing.error.nextAction, "send a new message");

  const limited = await updateMessageCard(client(() => Response.json({
    error: "This card was updated too often: at most 10 updates a minute per message. Wait 12 seconds, then run the same command again.",
    code: "RATE_LIMITED",
    retry_after: 12,
    details: { operation: "messageCardUpdate", limit: 10, windowSeconds: 60, retryAfterSeconds: 12 },
  }, { status: 429 })), { messageId: MESSAGE_ID, card: CARD, idempotencyKey: "k-2" });
  assert.equal(!limited.ok && limited.error.serverCode, "RATE_LIMITED");
  assert.equal(!limited.ok && limited.error.retryAfterSeconds, 12);
  assert.equal(!limited.ok && limited.error.retryable, true);
  assert.deepEqual(!limited.ok && limited.next?.args, { idempotencyKey: "k-2" }, "retry the same update with the same key");
});

test("a send's identity includes its card by value; a message without one hashes as it always did", async () => {
  const reordered = { elements: CARD.elements, root: CARD.root, version: CARD.version } as MessageCardInput;
  const plain = await hashRaftSendContent("#builds", "x", []);
  assert.equal(plain, await hashRaftSendContent("#builds", "x"));
  assert.notEqual(await hashRaftSendContent("#builds", "x", [], CARD), plain);
  assert.equal(await hashRaftSendContent("#builds", "x", [], CARD), await hashRaftSendContent("#builds", "x", [], reordered));
});
