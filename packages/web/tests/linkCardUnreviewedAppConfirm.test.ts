import assert from "node:assert/strict";
import { afterEach, vi } from "vitest";

// The stores this module reads (authStore) touch localStorage as they load;
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
import api from "../src/api/client";
import { LINK_CARD_READ_CAPABILITIES } from "../src/components/message/linkCardRead";
import {
  cancelLinkCardAction,
  linkCardViewKey,
  pressLinkCardButton,
  resetLinkCardActionsForTests,
  useLinkCardActionStore,
} from "../src/components/message/linkCardExecute";
import type { LinkCardButton, LinkCardMessageView } from "../src/components/message/linkCardExecute";
import type { AppLinkResult } from "../src/components/message/useAppLinkPreviews";

// RFC 076 §17 (Tenny, #proj-apps:#60): an App made on this Server acts here
// under its admins' confirmation, and the read marks it `app.reviewed: false`
// for a client that declares unreviewed_app.v1. Raft's dialog is the one place
// the person learns Raft hasn't reviewed it, so the screen is the safeguard:
// every acting button of such an App asks there first, undo-window buttons
// included, and nothing is sent or read before the confirm. The server pairs
// the capability with this dialog (execute refuses a handle without it), so
// the web must declare the capability only together with it.
// (The DOM tests that drew the dialog went with the web DOM test prune; this
// keeps the decision itself.)

type CardResult = Extract<AppLinkResult, { kind: "card" }>;

const URL_ = "https://drafts.example.test/r/1";
const UNDO_BUTTON: LinkCardButton = { label: "Approve", action: { kind: "execute", action_id: "approve", undoWindowMs: 1000 } } as LinkCardButton;

function card(reviewed: boolean, view: LinkCardMessageView): CardResult {
  return {
    kind: "card",
    url: URL_,
    app: reviewed ? { name: "Acme Drafts", icon: null } : { name: "Acme Drafts", icon: null, reviewed: false },
    title: "Draft 1",
    actions: [{ action_id: "approve", handle: "h-approve-1" }] as CardResult["actions"],
    readAt: Date.now(),
    view,
  };
}

function messageView() {
  const view = {
    key: "viewer-1:server-1|message-1",
    messageId: "message-1",
    reread: vi.fn(async () => ({ kind: "failed" as const })),
    beginExecute: vi.fn(),
  };
  return view;
}

const format = ((descriptor: { id: string }) => descriptor.id) as Parameters<typeof pressLinkCardButton>[0]["format"];

afterEach(() => resetLinkCardActionsForTests());

test("the web declares unreviewed_app.v1, the capability the server pairs with Raft's dialog", () => {
  assert.ok(LINK_CARD_READ_CAPABILITIES.includes("unreviewed_app.v1"));
});

test("an App Raft hasn't reviewed: its undo-window button opens Raft's dialog first, and nothing is sent or read", async () => {
  const post = vi.spyOn(api, "post");
  const get = vi.spyOn(api, "get");
  const view = messageView();
  await pressLinkCardButton({ result: card(false, view), button: UNDO_BUTTON, owner: "chip-1", format });

  const state = useLinkCardActionStore.getState().views[linkCardViewKey(view, URL_)];
  assert.equal(state?.busy, "confirming", "the view waits on Raft's dialog");
  assert.equal(state?.confirm?.kind, "run");
  assert.equal(state?.confirm?.unreviewed, true, "the dialog says Raft hasn't reviewed the App");
  assert.equal(state?.confirm?.kind === "run" ? state.confirm.label : null, "Approve", "titled with the button's label");
  assert.equal(post.mock.calls.length + get.mock.calls.length, 0, "nothing is sent before the confirm");
  assert.equal(view.reread.mock.calls.length, 0, "nor read");

  cancelLinkCardAction(linkCardViewKey(view, URL_));
  assert.equal(useLinkCardActionStore.getState().views[linkCardViewKey(view, URL_)], undefined, "Cancel leaves nothing behind");
  assert.equal(post.mock.calls.length, 0, "and sends nothing");
});

test("a reviewed App's undo-window button asks nothing first: its undo window starts", async () => {
  const view = messageView();
  await pressLinkCardButton({ result: card(true, view), button: UNDO_BUTTON, owner: "chip-1", format });

  const state = useLinkCardActionStore.getState().views[linkCardViewKey(view, URL_)];
  assert.equal(state?.busy, "holding", "the undo window runs, as before");
  assert.equal(state?.confirm, undefined, "no dialog");
});
