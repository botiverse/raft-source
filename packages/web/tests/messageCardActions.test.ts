import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test, vi } from "vitest";

// The stores these modules read (authStore) touch localStorage as they load;
// the unit suite has no DOM, so a Map stands in before any import runs.
vi.hoisted(() => {
  if (typeof (globalThis as { localStorage?: Storage }).localStorage?.getItem === "function") return;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      length: 0,
    } as Storage,
  });
});
import {
  applyMessageCardActions, deriveMessageCardFallback, MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON, MESSAGE_CARD_EXECUTE_CAPABILITY, parseMessageCard,
} from "@botiverse/raft-shared";
import { toast } from "@botiverse/raft-ui";
import api from "../src/api/client";
import { LinkPreviewConsentPrompt } from "../src/components/message/LinkPreviewConsentPrompt";
import { MessageCardBody } from "../src/components/message/MessageCardBody";
import { linkCardViewKey, pressLinkCardButton, resetLinkCardActionsForTests, useLinkCardActionStore } from "../src/components/message/linkCardExecute";
import type { LinkCardButton, LinkCardMessageView } from "../src/components/message/linkCardExecute";
import { LINK_CARD_READ_CAPABILITIES, parseMessageCardReadAnswer } from "../src/components/message/linkCardRead";
import type { MessageCardRead } from "../src/components/message/linkCardRead";
import {
  MESSAGE_CARD_RESUME_PRESS_MS, messageCardActionResult, messageCardActionUrls, messageCardButtonState, messageCardPressResumes, messageCardViewsBusy,
} from "../src/components/message/messageCardActions";
import type { MessageCardActionsRead } from "../src/components/message/messageCardActions";
import { readMessageCard } from "../src/components/message/messageCardRead";
import { messageCardFallbackText } from "../src/utils/messageCardFallbackText";
import { TestIntlProvider } from "./helpers/intl";

// RFC 086 step 1, the web's part: an App's card message has acting buttons
// one person presses. What each button draws comes from the stored card and
// this viewer's answer to the link card read; a press is a link card press
// whose identity is the message and the button's fallback page.

const APPROVE_URL = "https://vault.example.test/requests/42";
const DENY_URL = "https://vault.example.test/requests/42/deny";
const ACTIONS = {
  approve: { kind: "execute", action_id: "approve", confirm: "prepare" },
  deny: { kind: "execute", action_id: "deny", undoWindowMs: 5000 },
};

/** The metadata Raft stores for a send with `actions`: the card through the shared send path (so its acting buttons carry Raft's reason). */
function storedMetadata(revision = 3) {
  const parsed = parseMessageCard({
    version: 1,
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["title", "row"] },
      title: { type: "Text", props: { text: "Atlas asks to use the Stripe key" } },
      row: { type: "Stack", props: { direction: "row" }, children: ["deny", "approve", "open"] },
      deny: { type: "Button", props: { label: "Deny", variant: "ghost", action: { kind: "navigate", url: DENY_URL } } },
      approve: { type: "Button", props: { label: "Approve", action: { kind: "navigate", url: APPROVE_URL } } },
      open: { type: "Button", props: { label: "Open in Vault", variant: "ghost", action: { kind: "navigate", url: "https://vault.example.test/" } } },
    },
  });
  assert.ok(parsed.ok);
  const applied = applyMessageCardActions(parsed.card, ACTIONS);
  assert.ok(applied.ok);
  return { kind: "message-card", card: applied.card, revision, updatedAt: "2026-11-13T08:00:00.000Z", actions: applied.actions, for: "user-alice" };
}

function acting(revision = 3) {
  const read = readMessageCard(storedMetadata(revision));
  assert.ok(read?.acting);
  return read.acting;
}

const APP = { id: "app-vault", name: "Vault", icon: null };
function answer(patch: Record<string, unknown> = {}): MessageCardRead {
  const read = parseMessageCardReadAnswer({ items: [], prompts: [], message_card: { card_revision: "3", actions: [], ...patch } });
  assert.ok(read, "the answer is one this client reads");
  return read;
}
const HANDLES = [
  { element_id: "approve", action_id: "approve", url: APPROVE_URL, ticket: "t-approve", handle: "h-approve" },
  { element_id: "deny", action_id: "deny", url: DENY_URL, ticket: "t-deny", handle: "h-deny" },
];
const stateOf = (input: Partial<Parameters<typeof messageCardButtonState>[0]> & { answer: MessageCardRead | null }) =>
  messageCardButtonState({ acting: acting(), elementId: "approve", loading: false, ...input });

afterEach(() => {
  resetLinkCardActionsForTests();
  vi.restoreAllMocks();
});

test("the web declares card.execute.v1, the capability Raft answers a card message's handles to", () => {
  assert.equal(MESSAGE_CARD_EXECUTE_CAPABILITY, "card.execute.v1");
  assert.ok((LINK_CARD_READ_CAPABILITIES as readonly string[]).includes("card.execute.v1"));
});

test("the stored card names its acting buttons: element, fallback page, label and action; a card without actions has none", () => {
  const stored = acting();
  assert.equal(stored.revision, 3);
  assert.deepEqual(stored.buttons.map((button) => [button.elementId, button.url, button.label, button.action.action_id]), [
    ["approve", APPROVE_URL, "Approve", "approve"],
    ["deny", DENY_URL, "Deny", "deny"],
  ]);
  assert.deepEqual(messageCardActionUrls(stored), [APPROVE_URL, DENY_URL]);
  const { actions: _actions, for: _for, ...plain } = storedMetadata();
  assert.equal(readMessageCard(plain)?.acting, null, "buttons that only navigate");
});

test("a handle for the button: enabled (ready); a handle for another button only: unavailable", () => {
  assert.deepEqual(stateOf({ answer: answer({ app: APP, actions: HANDLES }) }), { kind: "ready" });
  assert.deepEqual(stateOf({ answer: answer({ app: APP, actions: [HANDLES[1]] }) }), { kind: "unavailable" });
  assert.deepEqual(stateOf({ answer: answer({ app: APP, actions: [{ ...HANDLES[0], url: DENY_URL }] }) }), { kind: "unavailable" }, "a handle for another fallback page is not this button's");
});

test("waiting_for: disabled with the person's name, whatever else the answer says", () => {
  assert.deepEqual(stateOf({ answer: answer({ waiting_for: { id: "user-alice", name: "Alice" } }) }), { kind: "waiting", name: "Alice" });
  assert.deepEqual(stateOf({ answer: answer({ waiting_for: { id: "user-alice", name: "Alice" }, consent: "needed", app: APP }) }), { kind: "waiting", name: "Alice" });
});

test("consent needed: enabled, the first press asks; declined: disabled with the App to allow", () => {
  assert.deepEqual(stateOf({ answer: answer({ consent: "needed", app: APP }) }), { kind: "consent", app: APP });
  assert.deepEqual(stateOf({ answer: answer({ consent: "declined", app: APP }) }), { kind: "declined", app: APP });
  assert.deepEqual(stateOf({ answer: answer({ consent: "needed", app: APP }), declinedHere: true }), { kind: "declined", app: APP }, "Don't Allow answered in this session");
  assert.deepEqual(stateOf({ answer: answer({ consent: "needed", app: APP }), loading: true }), { kind: "loading" }, "allowed since: the card is being read again");
  assert.deepEqual(stateOf({ answer: answer({ consent: "declined", app: APP }), loading: true }), { kind: "loading" }, "allowed again after a decline");
});

test("no answer: loading while it is read, then Raft's neutral unavailable, never ready", () => {
  assert.deepEqual(stateOf({ answer: null, loading: true }), { kind: "loading" });
  assert.deepEqual(stateOf({ answer: null }), { kind: "unavailable" });
  assert.equal(parseMessageCardReadAnswer({ items: [], prompts: [] }), null, "an older Server's answer has no message_card");
  assert.equal(parseMessageCardReadAnswer({ message_card: { card_revision: "3", actions: [], consent: "later" } }), null, "an answer this client can't read is no answer");
});

test("an answer for another revision gives no handle: it is read again (loading), then unavailable; nothing to press", () => {
  const other = answer({ card_revision: "2", app: APP, actions: HANDLES });
  assert.deepEqual(stateOf({ answer: other, retrying: true }), { kind: "loading" });
  assert.deepEqual(stateOf({ answer: other }), { kind: "unavailable" });
  assert.equal(messageCardActionResult(APPROVE_URL, acting(), { answer: other, readAt: 1 }), null);
  assert.deepEqual(messageCardButtonState({ acting: acting(2), elementId: "approve", answer: other, loading: false }), { kind: "ready" }, "the same answer is current for revision 2");
});

function messageView(): LinkCardMessageView & { beginExecute: ReturnType<typeof vi.fn> } {
  return { key: "viewer-1:server-1|message-1", messageId: "message-1", reread: vi.fn(async () => ({ kind: "failed" as const })), beginExecute: vi.fn() };
}
const format = ((descriptor: { id: string }) => descriptor.id) as Parameters<typeof pressLinkCardButton>[0]["format"];

test("the operation's identity is the message and the button's fallback page; prepare claims the stored revision with the button's handle", async () => {
  const view = messageView();
  const result = messageCardActionResult(APPROVE_URL, acting(), { answer: answer({ app: APP, actions: HANDLES }), readAt: Date.now() }, view);
  assert.ok(result);
  assert.equal(result.url, APPROVE_URL);
  assert.equal(linkCardViewKey(view, result.url), `viewer-1:server-1|message-1|${APPROVE_URL}`);
  assert.equal(result.businessRevision, "3");
  assert.deepEqual(result.actions, [{ action_id: "approve", handle: "h-approve" }], "only the handles of this fallback page");
  assert.deepEqual(result.app, { name: "Vault", icon: null });
  const button = result.cardV2?.elements.approve;
  assert.ok(button?.type === "Button");

  const post = vi.spyOn(api, "post").mockResolvedValue({ data: { status: "refused" } });
  await pressLinkCardButton({ result, button: button.props as LinkCardButton, owner: "card-1", format });
  assert.equal(post.mock.calls.length, 1);
  assert.equal(post.mock.calls[0]![0], "/link-cards/prepare");
  assert.deepEqual(post.mock.calls[0]![1], { handle: "h-approve", claimed: { business_revision: "3" } });
});

test("an App Raft hasn't reviewed keeps reviewed: false on the press, so Raft's dialog asks before an undo-window button", async () => {
  const view = messageView();
  const result = messageCardActionResult(DENY_URL, acting(), { answer: answer({ app: { ...APP, reviewed: false }, actions: HANDLES }), readAt: Date.now() }, view);
  assert.ok(result);
  assert.equal(result.app.reviewed, false);
  const button = result.cardV2?.elements.deny;
  assert.ok(button?.type === "Button");
  const post = vi.spyOn(api, "post");
  await pressLinkCardButton({ result, button: button.props as LinkCardButton, owner: "card-1", format });
  const state = useLinkCardActionStore.getState().views[linkCardViewKey(view, DENY_URL)];
  assert.equal(state?.confirm?.kind, "run");
  assert.equal(state?.confirm?.unreviewed, true);
  assert.equal(post.mock.calls.length, 0, "nothing is sent before the confirm");
});

test("after Allow the press goes on only where Raft's dialog still asks, in time, for the same revision", () => {
  const [approve, deny] = acting().buttons;
  const at = { allowedAt: 1000, allowedRevision: 3, revision: 3, now: 2000 };
  assert.equal(messageCardPressResumes({ button: approve!, reviewed: true, ...at }), true, "confirm: prepare");
  assert.equal(messageCardPressResumes({ button: deny!, reviewed: true, ...at }), false, "an undo-window button would run with Allow as its last click");
  assert.equal(messageCardPressResumes({ button: deny!, reviewed: false, ...at }), true, "an unreviewed App's dialog asks first");
  assert.equal(messageCardPressResumes({ button: approve!, reviewed: true, ...at, revision: 4 }), false, "the card was replaced");
  assert.equal(messageCardPressResumes({ button: approve!, reviewed: true, ...at, now: 1000 + MESSAGE_CARD_RESUME_PRESS_MS + 1 }), false, "too late");
});

test("text made from a card message reads an acting button as its label, never Raft's stored reason for older clients", () => {
  const stored = storedMetadata();
  const fallback = `${deriveMessageCardFallback(stored.card)}\n\n@alice`;
  assert.ok(fallback.includes(`Approve (disabled: ${MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON})`), "the stored fallback is the card as an older client reads it");
  const text = messageCardFallbackText(fallback);
  assert.ok(!text.includes(MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON));
  assert.ok(!text.includes("(disabled"));
  assert.ok(/Deny · Approve · \[Open in Vault\]/.test(text), text);
  assert.ok(text.endsWith("\n\n@alice"));
  // A fallback cut at its length limit inside the wording keeps none of it.
  assert.equal(messageCardFallbackText("Review · Approve (disabled: Update Raft to use th…"), "Review · Approve…");
  assert.equal(messageCardFallbackText("Review · Approve (disabled…"), "Review · Approve…");
  // Any other text stays as written, a sender's own disabled button included.
  assert.equal(messageCardFallbackText("Merge (disabled: Checks are running)"), "Merge (disabled: Checks are running)");
  assert.equal(messageCardFallbackText("See you (disabled people welcome)…"), "See you (disabled people welcome)…");
});

const NO_VIEW = { key: "viewer-1:server-1|message-1", messageId: "message-1", reread: async () => ({ kind: "failed" as const }), beginExecute: () => {} };
function draw(read: Partial<MessageCardActionsRead> | null): string {
  const card = readMessageCard(storedMetadata());
  assert.ok(card?.acting);
  const actions = read ? { acting: card.acting, answer: null, readAt: 0, loading: false, view: NO_VIEW, retry: () => {}, ...read } : null;
  return renderToStaticMarkup(createElement(TestIntlProvider, null, createElement(MessageCardBody, { read: card, actions })));
}
const button = (html: string, element: string) => new RegExp(`<button[^>]*data-message-card-action-element="${element}"[^>]*>`).exec(html)?.[0] ?? "";

test("the card draws each state: enabled with a handle, Waiting for {name} in view, unavailable in Raft's words, never the stored reason", () => {
  const ready = draw({ answer: answer({ app: APP, actions: HANDLES }) });
  assert.ok(button(ready, "approve").includes('data-message-card-action="ready"'));
  assert.ok(!/\sdisabled=""|aria-disabled="true"/.test(button(ready, "approve")), "a button with a handle is enabled");
  assert.ok(ready.includes('data-message-card-button="navigate"'), "the card's link stays a link");

  const waiting = draw({ answer: answer({ waiting_for: { id: "user-alice", name: "Alice" } }) });
  assert.ok(/data-message-card-action-status="waiting"[^>]*>.*Waiting for Alice/.test(waiting), "the reason is text in the row, not only a tooltip");
  assert.ok(/aria-disabled="true"|\sdisabled=""/.test(button(waiting, "approve")));
  assert.ok(/aria-disabled="true"|\sdisabled=""/.test(button(waiting, "deny")));

  const consent = draw({ answer: answer({ consent: "needed", app: APP }) });
  assert.ok(button(consent, "approve").includes('data-message-card-action="consent"'));
  assert.ok(!/\sdisabled=""|aria-disabled="true"/.test(button(consent, "approve")), "enabled: the first press asks");

  const declined = draw({ answer: answer({ consent: "declined", app: APP }) });
  assert.ok(declined.includes("You turned off Vault."));
  assert.ok(/data-message-card-action-allow="app-vault"[^>]*>Allow Vault</.test(declined), "with the way to change it");

  for (const html of [draw({ answer: null }), draw(null)]) {
    assert.ok(html.includes("These buttons aren’t available right now"), html);
    assert.ok(/aria-disabled="true"|\sdisabled=""/.test(button(html, "approve")));
  }
  for (const html of [ready, waiting, consent, declined, draw({ answer: null }), draw({ answer: null, loading: true }), draw(null)]) {
    assert.ok(!html.includes(MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON), "the stored reason is for clients older than this one");
  }
});

test("the prompt a card button opens asks in a button's words, with Not now in place of Don't allow; the link-preview prompt is as it was", () => {
  const noop = () => {};
  const base = { app: APP, state: "idle" as const, onAllow: noop, onDecline: noop };
  const linkPrompt = renderToStaticMarkup(createElement(TestIntlProvider, null, createElement(LinkPreviewConsentPrompt, base)));
  assert.ok(linkPrompt.includes("wants to show link previews here"));
  assert.ok(linkPrompt.includes("After you allow, Vault will know which of its links you view."));
  assert.ok(linkPrompt.includes("Don’t allow"));
  assert.ok(!linkPrompt.includes("Not now"));
  const cardPrompt = renderToStaticMarkup(createElement(TestIntlProvider, null, createElement(LinkPreviewConsentPrompt, {
    ...base, title: "Allow Vault?", body: "Vault will know it’s you.", secondaryLabel: "Not now", onSecondary: noop,
  })));
  assert.ok(cardPrompt.includes("Allow Vault?"));
  assert.ok(cardPrompt.includes("Vault will know it’s you."));
  assert.ok(cardPrompt.includes("Not now"));
  assert.ok(!cardPrompt.includes("Don’t allow") && !cardPrompt.includes("link previews"));
});

test("Not now leaves consent needed: only a recorded decline turns the App off", () => {
  const needed = answer({ consent: "needed", app: APP });
  // Not now saves nothing, so the consent store has no answer for the App: the button still asks.
  assert.deepEqual(stateOf({ answer: needed, declinedHere: false }), { kind: "consent", app: APP });
  const html = draw({ answer: needed });
  assert.ok(button(html, "approve").includes('data-message-card-action="consent"'));
  assert.ok(!html.includes("You turned off Vault."));
});

// Vault's Approve and Deny on one fallback page: one view, so one open operation for both.
function sharedPage() {
  const metadata = storedMetadata();
  const elements = { ...metadata.card.elements, deny: { ...metadata.card.elements.deny!, props: { ...metadata.card.elements.deny!.props, action: { kind: "navigate", url: APPROVE_URL } } } };
  const card = readMessageCard({ ...metadata, card: { ...metadata.card, elements } });
  assert.ok(card?.acting);
  return card;
}
const SHARED_HANDLES = [HANDLES[0], { ...HANDLES[1], url: APPROVE_URL, ticket: "t-approve" }];

test("two acting buttons on one fallback page share one view: while its operation is open both wait, and both come back when it ends", () => {
  const card = sharedPage();
  assert.deepEqual(messageCardActionUrls(card.acting!), [APPROVE_URL]);
  const view = messageView();
  const read = { acting: card.acting!, answer: answer({ app: APP, actions: SHARED_HANDLES }), readAt: Date.now(), loading: false, view, retry: () => {} };
  const result = messageCardActionResult(APPROVE_URL, card.acting!, read, view);
  assert.deepEqual(result?.actions?.map((action) => action.action_id), ["approve", "deny"], "both handles act through the one view");
  // The drawing asks the store for the card's views, one per fallback page: here one for both buttons.
  const busy = () => messageCardViewsBusy(messageCardActionUrls(card.acting!).map((url) => useLinkCardActionStore.getState().views[linkCardViewKey(view, url)]));
  assert.deepEqual(busy(), { holding: false, blocked: false, pending: false });
  useLinkCardActionStore.setState({ views: { [linkCardViewKey(view, APPROVE_URL)]: { operation: { id: "op-1", state: "accepted" } } } });
  assert.deepEqual(busy(), { holding: false, blocked: true, pending: true }, "Approve's open operation holds Deny too");
  useLinkCardActionStore.setState({ views: {} });
  assert.deepEqual(busy(), { holding: false, blocked: false, pending: false }, "the operation ended: both are back");
  // Two pages: an operation on one still holds the other's button (one open operation per card).
  assert.equal(messageCardViewsBusy([undefined, { busy: "preparing", actionId: "deny" }]).blocked, true);
});

test("VIEW_PENDING to a card button's press: no warning, the view shows the open operation (a link card's press still warns)", async () => {
  const card = sharedPage();
  const pending = Object.assign(new Error("conflict"), { response: { status: 409, data: { code: "VIEW_PENDING" } } });
  const operation = { operation_id: "0b0e6f4e-1c1a-4a7e-9d2b-3f5a6c7d8e9f", state: "accepted", receipt_revision: 1 };
  for (const quietViewPending of [true, false]) {
    resetLinkCardActionsForTests();
    const view = messageView();
    const result = messageCardActionResult(APPROVE_URL, card.acting!, { answer: answer({ app: APP, actions: SHARED_HANDLES }), readAt: Date.now() }, view);
    const deny = result?.cardV2?.elements.deny;
    assert.ok(result && deny?.type === "Button");
    vi.spyOn(api, "post").mockRejectedValue(pending);
    vi.spyOn(api, "get").mockResolvedValue({ data: { operations: [operation] } });
    const warning = vi.spyOn(toast, "warning").mockImplementation(() => "");
    // Deny has an undo window; pressing Approve (prepare) is the request Raft answers 409 to.
    const approve = result.cardV2!.elements.approve!;
    await pressLinkCardButton({ result, button: (approve as { props: LinkCardButton }).props, owner: "card-1", format, ...(quietViewPending ? { quietViewPending } : {}) });
    const state = useLinkCardActionStore.getState().views[linkCardViewKey(view, APPROVE_URL)];
    assert.equal(state?.operation?.id, operation.operation_id, "the earlier operation is the view's pending one");
    assert.equal(warning.mock.calls.length, quietViewPending ? 0 : 1);
    vi.restoreAllMocks();
  }
});
