// RFC 086 §5.1 / §5.3, web part 1: the form in Raft's dialog on an App-sent
// card's acting button. The screen is the safeguard here (docs/development,
// "Web DOM test prune": keep a DOM test when the UI is the safeguard):
// - a SecretInput is one masked line that is never prefilled or echoed, with
//   autocomplete, spellcheck, autocapitalize, autocorrect and page
//   translation off, and Raft's line saying where the value goes;
// - a TextInput shows what is typed;
// - for an App Raft hasn't reviewed, the not-reviewed notice is above the
//   form, read before anything is typed;
// - a SecretInput stops at its 4096 UTF-8 bytes as it is filled (part 2);
// - Cancel drops what was typed: nothing of it stays in the page, the view's
//   store or localStorage, and the dialog opens empty again.
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { MessageCardForm } from "@botiverse/raft-shared";
import { renderWithIntl } from "./helpers/intl";
import { LinkCardConfirmDialog } from "../src/components/message/LinkCardActions";
import api from "../src/api/client";
import { linkCardViewKey, pressLinkCardButton, resetLinkCardActionsForTests, useLinkCardActionStore } from "../src/components/message/linkCardExecute";
import type { LinkCardButton } from "../src/components/message/linkCardExecute";
import { messageCardActionResult } from "../src/components/message/messageCardActions";
import type { LinkCardMessageView } from "../src/components/message/linkCardExecute";
import type { AppLinkResult } from "../src/components/message/useAppLinkPreviews";

type CardResult = Extract<AppLinkResult, { kind: "card" }>;

const URL_ = "https://vault.example.test/keys/new";
const OWNER = "row-1";
const MARKER_TEXT = "marker-name-41d2";
const MARKER_SECRET = "marker-secret-9b7e";
const FORM: MessageCardForm = {
  fields: [
    { type: "TextInput", id: "name", label: "Name", default: "deploy-key" },
    { type: "SecretInput", id: "value", label: "Value", placeholder: "Paste the key", required: true },
  ],
};

const view: LinkCardMessageView = {
  key: "viewer-1:server-1|message-1",
  messageId: "message-1",
  reread: async () => ({ kind: "failed" }),
  beginExecute: () => {},
};
const viewKey = linkCardViewKey(view, URL_);
const result: CardResult = { kind: "card", url: URL_, app: { name: "Vault", icon: null, reviewed: false }, title: "Save", view };

function open() {
  act(() => {
    useLinkCardActionStore.setState({
      views: { [viewKey]: { busy: "confirming", actionId: "save_key", confirm: { kind: "run", owner: OWNER, label: "Save", unreviewed: true, executing: false, form: FORM } } },
    });
  });
}

function fields() {
  const text = document.querySelector<HTMLInputElement>('[data-link-card-form-field="TextInput"]');
  const secret = document.querySelector<HTMLInputElement>('[data-link-card-form-field="SecretInput"]');
  assert.ok(text && secret, "both fields are drawn");
  return { text, secret };
}

afterEach(() => {
  cleanup();
  resetLinkCardActionsForTests();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

test("a SecretInput is a masked line with every suggestion and translation off; a TextInput shows what is typed", async () => {
  renderWithIntl(<LinkCardConfirmDialog result={result} owner={OWNER} finalFocus={{ current: null }} />);
  open();
  const { text, secret } = fields();

  assert.equal(secret.type, "password");
  assert.equal(secret.getAttribute("autocomplete"), "off");
  assert.equal(secret.getAttribute("spellcheck"), "false");
  assert.equal(secret.getAttribute("autocapitalize"), "off");
  assert.equal(secret.getAttribute("autocorrect"), "off");
  assert.equal(secret.getAttribute("translate"), "no");
  assert.ok(secret.classList.contains("notranslate"));
  assert.equal(secret.getAttribute("data-1p-ignore"), "true", "password managers are told to ignore it");
  assert.equal(secret.value, "", "never prefilled");
  assert.equal(secret.getAttribute("aria-required"), "true");
  assert.ok(secret.closest("form") === null && text.closest("form") === null, "no <form> around the fields: no submit, no navigation");
  await waitFor(() => assert.ok(document.activeElement === text, "the first field has focus when the dialog opens"));

  fireEvent.change(secret, { target: { value: MARKER_SECRET } });
  assert.equal(secret.getAttribute("value"), null, "never echoed into the DOM");
  assert.ok(!document.body.innerHTML.includes(MARKER_SECRET));

  assert.equal(text.type, "text", "a TextInput is never masked");
  assert.equal(text.value, "deploy-key", "prefilled with the App's default");

  screen.getByText("This value is encrypted for Vault and sent only to it. Raft can't read it.");
  const notice = document.querySelector('[data-link-card-confirm-source="unreviewed"]');
  assert.ok(notice, "the not-reviewed notice is drawn");
  assert.ok(notice.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING, "above the form, before anything is typed");
});

test("Cancel drops what was typed: nothing stays in the page, the store or storage, and the dialog opens empty", () => {
  renderWithIntl(<LinkCardConfirmDialog result={result} owner={OWNER} finalFocus={{ current: null }} />);
  open();
  const first = fields();
  fireEvent.change(first.text, { target: { value: MARKER_TEXT } });
  fireEvent.change(first.secret, { target: { value: MARKER_SECRET } });

  const cancel = document.querySelector<HTMLElement>("[data-link-card-confirm-cancel]");
  assert.ok(cancel);
  fireEvent.click(cancel);

  assert.ok(document.querySelector("[data-link-card-form]") === null, "the dialog closed");
  assert.equal(useLinkCardActionStore.getState().views[viewKey], undefined, "Cancel leaves nothing in the view's store");
  const leftovers = [document.body.innerHTML, JSON.stringify(useLinkCardActionStore.getState()), JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
  for (const marker of [MARKER_TEXT, MARKER_SECRET]) assert.ok(!leftovers.some((where) => where.includes(marker)), `${marker} is gone`);

  open();
  const again = fields();
  assert.equal(again.secret.value, "", "the secret is not there when the dialog opens again");
  assert.equal(again.text.value, "deploy-key", "the TextInput starts from the App's default again");
});

test("a SecretInput's encryption line stays when it is invalid, with the error under it; nothing is sent", () => {
  const post = vi.spyOn(api, "post");
  renderWithIntl(<LinkCardConfirmDialog result={result} owner={OWNER} finalFocus={{ current: null }} />);
  open();
  const confirm = document.querySelector<HTMLElement>("[data-link-card-confirm-action]");
  assert.ok(confirm);
  fireEvent.click(confirm);

  const line = screen.getByText("This value is encrypted for Vault and sent only to it. Raft can't read it.");
  const error = screen.getByText("Enter a value.");
  assert.ok(line.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING, "the error goes under the line, not in its place");
  assert.equal(post.mock.calls.length, 0);
});

test("a validation failure blocks the send; Enter in a field confirms once the form is valid", async () => {
  const post = vi.spyOn(api, "post");
  const form: MessageCardForm = { fields: [{ type: "TextInput", id: "name", label: "Name", required: true }, { type: "TextInput", id: "note", label: "Note" }] };
  const acting = { revision: 3, buttons: [{ elementId: "save", url: URL_, label: "Save", action: { kind: "execute" as const, action_id: "save_key", undoWindowMs: 1000, form } }] };
  const pressedResult = messageCardActionResult(URL_, acting, {
    answer: { card_revision: "3", app: { id: "app-1", name: "Vault", icon: null }, actions: [{ element_id: "save", action_id: "save_key", url: URL_, ticket: "t", handle: "h-save" }] },
    readAt: Date.now(),
  }, view);
  const node = pressedResult?.cardV2?.elements.save;
  assert.ok(pressedResult && node?.type === "Button");
  renderWithIntl(<LinkCardConfirmDialog result={pressedResult} owner={OWNER} finalFocus={{ current: null }} />);
  await act(async () => {
    await pressLinkCardButton({ result: pressedResult, button: node.props as LinkCardButton, owner: OWNER, format: ((d: { id: string }) => d.id) as never });
  });
  const name = document.querySelector<HTMLInputElement>('[data-link-card-form-field-id="name"]');
  assert.ok(name, "the undo-window button's form opens in Raft's dialog");

  const confirm = document.querySelector<HTMLElement>("[data-link-card-confirm-action]");
  assert.ok(confirm);
  fireEvent.click(confirm);
  screen.getByText("Enter a value.");
  assert.equal(useLinkCardActionStore.getState().views[viewKey]?.busy, "confirming", "an invalid form doesn't go on");
  assert.equal(post.mock.calls.length, 0, "and sends nothing");

  fireEvent.change(name, { target: { value: MARKER_TEXT } });
  fireEvent.keyDown(name, { key: "Enter", keyCode: 229 });
  assert.equal(useLinkCardActionStore.getState().views[viewKey]?.busy, "confirming", "an IME's Enter (keyCode 229) picks a candidate, it doesn't confirm");
  await act(async () => { fireEvent.keyDown(name, { key: "Enter" }); });
  await waitFor(() => assert.equal(useLinkCardActionStore.getState().views[viewKey]?.busy, "holding", "Enter confirmed: the undo window runs"));
  assert.ok(document.querySelector("[data-link-card-form]") === null, "the dialog closed");
  assert.equal(post.mock.calls.length, 0, "nothing sent during the window");
});

test("a SecretInput stops at 4096 UTF-8 bytes as it is filled: what would cross it is refused whole, and the field says why", () => {
  renderWithIntl(<LinkCardConfirmDialog result={result} owner={OWNER} finalFocus={{ current: null }} />);
  open();
  const { secret } = fields();
  const insert = (data: string) => {
    const event = new InputEvent("beforeinput", { inputType: "insertFromPaste", data, bubbles: true, cancelable: true });
    act(() => { secret.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  assert.equal(insert("a".repeat(4096)), false, "4096 bytes fit");
  fireEvent.change(secret, { target: { value: "a".repeat(4094) } });
  secret.setSelectionRange(4094, 4094);
  assert.equal(insert("é"), false, "two more bytes fit exactly");
  assert.equal(insert("éa"), true, "three more don't: refused, not cut short");
  screen.getByText("Use at most 4096 bytes. Some characters take more than one.");
});

test("a SecretInput form never goes on through an undo window: only a prepared action's execute carries it, sealed", () => {
  const post = vi.spyOn(api, "post");
  renderWithIntl(<LinkCardConfirmDialog result={result} owner={OWNER} finalFocus={{ current: null }} />);
  open();
  const { secret } = fields();
  fireEvent.change(secret, { target: { value: MARKER_SECRET } });
  const confirm = document.querySelector<HTMLElement>("[data-link-card-confirm-action]");
  assert.ok(confirm);
  fireEvent.click(confirm);
  assert.equal(useLinkCardActionStore.getState().views[viewKey]?.busy, "confirming", "nothing goes on");
  assert.equal(post.mock.calls.length, 0, "and nothing is sent");
});
