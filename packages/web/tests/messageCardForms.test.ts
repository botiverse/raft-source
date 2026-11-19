import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
      get length() { return values.size; },
    } as Storage,
  });
});
// The real sealing, counted: a test can tell nothing was sealed at all.
vi.mock("@botiverse/raft-shared/src/sealedInputs", async (original) => {
  const actual = await original<typeof import("@botiverse/raft-shared/src/sealedInputs")>();
  return { ...actual, sealInputs: vi.fn(actual.sealInputs) };
});
import { MESSAGE_CARD_FORM_CAPABILITY, MESSAGE_CARD_SECRET_INPUT_CAPABILITY } from "@botiverse/raft-shared";
import type { MessageCardActingButton, MessageCardForm } from "@botiverse/raft-shared";
import { createSealedInputsMemory, openSealedInputs, sealInputs } from "@botiverse/raft-shared/src/sealedInputs";
import { SEALED_INPUTS_VECTOR_PATH } from "@botiverse/raft-shared/src/sealedInputsVectors.testkit";
import type { SealedInputsVectors } from "@botiverse/raft-shared/src/sealedInputsVectors.testkit";
import api from "../src/api/client";
import { linkCardFormInputs, linkCardFormProblem, linkCardFormProblems } from "../src/components/message/linkCardForm";
import {
  cancelLinkCardAction,
  confirmLinkCardAction,
  linkCardViewKey,
  pressLinkCardButton,
  resetLinkCardActionsForTests,
  useLinkCardActionStore,
} from "../src/components/message/linkCardExecute";
import type { LinkCardButton, LinkCardMessageView } from "../src/components/message/linkCardExecute";
import { LINK_CARD_READ_CAPABILITIES, parseMessageCardReadAnswer } from "../src/components/message/linkCardRead";
import type { MessageCardRead } from "../src/components/message/linkCardRead";
import { messageCardActionResult, messageCardButtonState } from "../src/components/message/messageCardActions";
import type { MessageCardActing } from "../src/components/message/messageCardActions";

// RFC 086 §5.1 / §5.4, web part 1: forms on an App-sent card's acting button.
// TextInput values are filled in Raft's dialog and ride only in the execute
// request (`inputs`), never in prepare, and nothing of them is kept in the
// view's store or the local records. Web part 2: SecretInput values are
// sealed on the device to the App's key from the handle read
// (linkCardSeal.ts) and ride only in execute's `sealed_inputs`; a key that
// changed while the dialog was open fails closed, nothing sent.

const URL_ = "https://vault.example.test/keys/new";
const MARKER = "marker-value-7f3c";
const TEXT_FORM: MessageCardForm = {
  fields: [
    { type: "TextInput", id: "name", label: "Name", default: "deploy-key", maxLength: 20, required: true },
    { type: "TextInput", id: "note", label: "Note" },
  ],
};
const SECRET_FORM: MessageCardForm = { fields: [{ type: "TextInput", id: "name", label: "Name" }, { type: "SecretInput", id: "value", label: "Value", required: true }] };
const UUID_ = "6b0a3c1e-2f4d-4a8b-9c7e-1d2e3f4a5b6c";

const format = ((descriptor: { id: string }) => descriptor.id) as Parameters<typeof pressLinkCardButton>[0]["format"];

function messageView() {
  return {
    key: "viewer-1:server-1|message-1",
    messageId: "message-1",
    reread: vi.fn(async () => ({ kind: "failed" as const })),
    beginExecute: vi.fn(),
  } satisfies LinkCardMessageView;
}

function acting(action: MessageCardActingButton["action"]): MessageCardActing {
  return { revision: 3, buttons: [{ elementId: "save", url: URL_, label: "Save", action }] };
}

const PLAIN_ANSWER = { card_revision: "3", app: { id: "app-1", name: "Vault", icon: null }, actions: [{ element_id: "save", action_id: "save_key", url: URL_, ticket: "t", handle: "h-save" }] } as unknown as MessageCardRead;

// The App's key as the handle read answers it (TEST-ONLY keys from the shared vectors), and a second one it rotated to.
const vectors = JSON.parse(readFileSync(SEALED_INPUTS_VECTOR_PATH, "utf8")) as SealedInputsVectors;
const [KEY_A, KEY_B] = vectors.keys;
const CLIENT_KEY = "app_test_vault";
const HANDLE_EXP = Math.floor(Date.now() / 1000) + 600;
function secretAnswer(key = KEY_A!.publicJwk, handleExp = HANDLE_EXP): MessageCardRead {
  return {
    card_revision: "3",
    app: { id: "app-1", name: "Vault", icon: null, encryption_key: key, client_key: CLIENT_KEY },
    actions: [{ element_id: "save", action_id: "save_key", url: URL_, ticket: "t", handle: "h-save", handle_exp: handleExp }],
  } as unknown as MessageCardRead;
}

function pressed(actingButtons: MessageCardActing, view: LinkCardMessageView, answer: MessageCardRead = PLAIN_ANSWER) {
  const result = messageCardActionResult(URL_, actingButtons, { answer, readAt: Date.now() }, view);
  const node = result?.cardV2?.elements.save;
  return { result, button: node?.type === "Button" ? (node.props as LinkCardButton) : null };
}

afterEach(() => {
  resetLinkCardActionsForTests();
  vi.restoreAllMocks();
});

test("the web declares card.form.v1 and card.form.secret.v1", () => {
  const declared = LINK_CARD_READ_CAPABILITIES as readonly string[];
  assert.ok(declared.includes(MESSAGE_CARD_FORM_CAPABILITY));
  assert.ok(declared.includes(MESSAGE_CARD_SECRET_INPUT_CAPABILITY));
});

test("the read keeps what a SecretInput is sealed with; a key that doesn't read is no key, and the rest of the answer stands", () => {
  const raw = (app: Record<string, unknown>, handleExp: unknown) => ({ message_card: {
    card_revision: "3", app: { id: "app-1", name: "Vault", icon: null, ...app },
    actions: [{ element_id: "save", action_id: "save_key", url: URL_, ticket: "t", handle: "h-save", handle_exp: handleExp }],
  } });
  const read = parseMessageCardReadAnswer(raw({ encryption_key: KEY_A!.publicJwk, client_key: CLIENT_KEY }, HANDLE_EXP));
  assert.deepEqual(read?.app?.encryption_key, KEY_A!.publicJwk);
  assert.equal(read?.app?.client_key, CLIENT_KEY);
  assert.equal(read?.actions[0]?.handle_exp, HANDLE_EXP);
  const bad = parseMessageCardReadAnswer(raw({ encryption_key: { ...KEY_A!.publicJwk, alg: "RSA-OAEP" }, client_key: CLIENT_KEY }, "soon"));
  assert.ok(bad && bad.actions.length === 1, "the answer still reads");
  assert.equal(bad.app?.encryption_key, undefined);
  assert.equal(bad.app?.client_key, undefined, "a client key without a key is dropped with it");
  assert.equal(bad.actions[0]?.handle_exp, undefined);
});

test("a SecretInput button is pressed only with everything the read gives to seal with: the key, the client key and handle_exp", () => {
  const secretActing = acting({ kind: "execute", action_id: "save_key", confirm: "prepare", form: SECRET_FORM });
  const { result } = pressed(secretActing, messageView(), secretAnswer());
  assert.deepEqual(result?.sealsTo?.save_key, { key: KEY_A!.publicJwk, clientKey: CLIENT_KEY, handleExp: HANDLE_EXP, revision: "3" });
  const full = secretAnswer();
  const missing = [
    { ...full, app: { ...full.app!, encryption_key: undefined } },
    { ...full, app: { ...full.app!, client_key: undefined } },
    { ...full, actions: full.actions.map(({ handle_exp: _exp, ...action }) => action) },
  ] as MessageCardRead[];
  for (const answer of missing) {
    assert.equal(pressed(secretActing, messageView(), answer).result, null, "nothing to seal to: never pressed");
    assert.equal(messageCardButtonState({ acting: secretActing, elementId: "save", answer, loading: false }).kind, "unavailable");
  }
  const undoWindow = acting({ kind: "execute", action_id: "save_key", undoWindowMs: 1000, form: SECRET_FORM });
  assert.equal(pressed(undoWindow, messageView(), full).result, null, "a SecretInput only ever on a prepared action");
  const { result: plain } = pressed(acting({ kind: "execute", action_id: "save_key", confirm: "prepare", form: TEXT_FORM }), messageView());
  assert.ok(plain && !plain.sealsTo, "a TextInput form needs no key");
});

test("values are checked as Raft checks them: required, one line, maxLength in code points, a secret in UTF-8 bytes", () => {
  const [name, note] = TEXT_FORM.fields;
  assert.equal(linkCardFormProblem(name!, ""), "required");
  assert.equal(linkCardFormProblem(note!, ""), null);
  assert.equal(linkCardFormProblem(name!, "a b"), "oneLine");
  assert.equal(linkCardFormProblem(name!, "😀".repeat(20)), null, "20 code points fit a maxLength of 20 (40 UTF-16 units)");
  assert.equal(linkCardFormProblem(name!, "😀".repeat(21)), "tooLong");
  const secret = SECRET_FORM.fields[1]!;
  assert.equal(linkCardFormProblem(secret, "a".repeat(4096)), null);
  assert.equal(linkCardFormProblem(secret, "é".repeat(2049)), "tooLong", "2049 characters, 4098 bytes");
  assert.deepEqual(linkCardFormProblems(TEXT_FORM, new Map([["name", ""]])), { name: "required" });
});

test("inputs carry the filled TextInputs, leave empty optional ones out, and never carry a SecretInput's value", () => {
  assert.deepEqual(linkCardFormInputs(TEXT_FORM, new Map([["name", "k"], ["note", ""]])), { name: "k" }, "an empty optional TextInput is left out, never \"\"");
  assert.deepEqual(linkCardFormInputs(TEXT_FORM, new Map([["name", "k"], ["note", "n"]])), { name: "k", note: "n" });
  assert.equal(linkCardFormInputs({ fields: [TEXT_FORM.fields[1]!] }, new Map([["note", ""]])), null, "nothing filled: no inputs at all");
  assert.deepEqual(linkCardFormInputs(SECRET_FORM, new Map([["name", "k"], ["value", MARKER]])), { name: "k" });
  assert.equal(linkCardFormInputs({ fields: [SECRET_FORM.fields[1]!] }, new Map([["value", MARKER]])), null);
});

test("confirm: prepare with a form: prepare carries no inputs, the dialog gets the form, execute carries the values", async () => {
  const bodies: Array<[string, unknown]> = [];
  const stored = vi.spyOn(localStorage, "setItem");
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    bodies.push([url, body]);
    if (url === "/link-cards/prepare") {
      return { data: { prepared_action_id: UUID_, prepared_digest: "a".repeat(64), description: { title: "Save key", confirm_label: "Save", cancel_label: "Cancel" } } };
    }
    return { data: { operation_id: UUID_, state: "done" } };
  });
  const view = messageView();
  const { result, button } = pressed(acting({ kind: "execute", action_id: "save_key", confirm: "prepare", form: TEXT_FORM }), view);
  assert.ok(result && button);
  await pressLinkCardButton({ result, button, owner: "row-1", format });

  const viewKey = linkCardViewKey(view, URL_);
  const confirm = useLinkCardActionStore.getState().views[viewKey]?.confirm;
  assert.equal(confirm?.kind, "prepared");
  assert.deepEqual(confirm?.form, TEXT_FORM, "Raft's dialog draws the form");
  assert.deepEqual(bodies.map(([url]) => url), ["/link-cards/prepare"]);
  assert.ok(!Object.hasOwn(bodies[0]![1] as object, "inputs"), "prepare never carries inputs");

  await confirmLinkCardAction(viewKey, { name: MARKER });
  const execute = bodies.find(([url]) => url === "/link-cards/execute")?.[1] as Record<string, unknown> | undefined;
  assert.deepEqual(execute?.inputs, { name: MARKER });
  assert.ok(!JSON.stringify(useLinkCardActionStore.getState()).includes(MARKER), "nothing of the values stays in the view's store");
  assert.ok(stored.mock.calls.length > 0, "the local operation record was written");
  assert.ok(!stored.mock.calls.some((call) => call.join("\n").includes(MARKER)), "without any of the values");
});

test("an undo-window button with a form asks in Raft's dialog first, for a reviewed App too; Cancel sends nothing", async () => {
  const post = vi.spyOn(api, "post");
  const view = messageView();
  const { result, button } = pressed(acting({ kind: "execute", action_id: "save_key", undoWindowMs: 1000, form: TEXT_FORM }), view);
  assert.ok(result && button);
  await pressLinkCardButton({ result, button, owner: "row-1", format });

  const viewKey = linkCardViewKey(view, URL_);
  const state = useLinkCardActionStore.getState().views[viewKey];
  assert.equal(state?.busy, "confirming");
  assert.equal(state?.confirm?.kind, "run");
  assert.equal(state?.confirm?.unreviewed, false, "a reviewed App: no not-reviewed notice");
  assert.deepEqual(state?.confirm?.form, TEXT_FORM);

  cancelLinkCardAction(viewKey);
  assert.equal(useLinkCardActionStore.getState().views[viewKey], undefined);
  assert.equal(post.mock.calls.length, 0);
});

test("the undo-window path: after the dialog's confirm the window runs, then execute carries the inputs (empty optionals left out)", async () => {
  const bodies: Array<[string, unknown]> = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    bodies.push([url, body]);
    return { data: { operation_id: UUID_, state: "done" } };
  });
  const view = messageView();
  const { result, button } = pressed(acting({ kind: "execute", action_id: "save_key", undoWindowMs: 1000, form: TEXT_FORM }), view);
  assert.ok(result && button);
  await pressLinkCardButton({ result, button, owner: "row-1", format });
  const viewKey = linkCardViewKey(view, URL_);

  // What the dialog hands over on confirm: linkCardFormInputs of what was typed.
  await confirmLinkCardAction(viewKey, linkCardFormInputs(TEXT_FORM, new Map([["name", MARKER], ["note", ""]])));
  assert.equal(useLinkCardActionStore.getState().views[viewKey]?.busy, "holding", "the undo window runs");
  assert.equal(bodies.length, 0, "nothing is sent during the window");

  await vi.waitFor(() => assert.ok(bodies.some(([url]) => url === "/link-cards/execute")), { timeout: 3000, interval: 50 });
  const execute = bodies.find(([url]) => url === "/link-cards/execute")?.[1] as Record<string, unknown>;
  assert.deepEqual(execute.inputs, { name: MARKER }, "the typed value, and no \"\" for the empty optional");
  assert.deepEqual(bodies.map(([url]) => url), ["/link-cards/execute"], "no prepare on this path");
});

/** Prepare, then Raft's dialog with the SecretInput form; every request's body is kept. */
async function pressSecret(view: LinkCardMessageView, answer = secretAnswer()) {
  const bodies: Array<[string, Record<string, unknown>]> = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    bodies.push([url, body as Record<string, unknown>]);
    if (url === "/link-cards/prepare") {
      return { data: { prepared_action_id: UUID_, prepared_digest: "a".repeat(64), description: { title: "Save key", confirm_label: "Save", cancel_label: "Cancel" } } };
    }
    return { data: { operation_id: UUID_, state: "done" } };
  });
  const secretActing = acting({ kind: "execute", action_id: "save_key", confirm: "prepare", form: SECRET_FORM });
  const { result, button } = pressed(secretActing, view, answer);
  assert.ok(result && button);
  await pressLinkCardButton({ result, button, owner: "row-1", format });
  return { bodies, secretActing, viewKey: linkCardViewKey(view, URL_) };
}

test("a SecretInput: prepare carries neither inputs nor sealed_inputs; execute carries the JWE, never the value, and it opens for this request only", async () => {
  const view = messageView();
  const stored = vi.spyOn(localStorage, "setItem");
  const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
  const { bodies, secretActing, viewKey } = await pressSecret(view);
  view.reread.mockImplementation(async () => ({ kind: "read", result: messageCardActionResult(URL_, secretActing, { answer: secretAnswer(), readAt: Date.now() }) }) as never);
  assert.deepEqual(bodies.map(([url]) => url), ["/link-cards/prepare"]);
  assert.ok(!Object.hasOwn(bodies[0]![1], "inputs") && !Object.hasOwn(bodies[0]![1], "sealed_inputs"), "prepare carries neither");

  const secrets = new Map([["value", MARKER]]);
  await confirmLinkCardAction(viewKey, { name: "deploy-key" }, secrets);
  assert.equal(view.reread.mock.calls.length, 1, "the key is read again right before sealing");
  assert.equal(secrets.size, 0, "the value is dropped once sealed");
  const execute = bodies.find(([url]) => url === "/link-cards/execute")?.[1];
  assert.ok(execute);
  const jwe = execute.sealed_inputs;
  assert.equal(typeof jwe, "string");
  assert.deepEqual(execute.inputs, { name: "deploy-key" }, "the TextInput's value as typed, beside it");
  assert.ok(!JSON.stringify(execute).includes(MARKER), "the value is not in the request in plain text");

  // The App's reference check, against the claims Raft's execute JWT carries for this request.
  const claims = {
    aud: `urn:raft:card-action:${CLIENT_KEY}`, sub: "viewer-1", server_id: "server-1", handle_sha256: createHash("sha256").update("h-save").digest("hex"),
    action_id: "save_key", prepared_action_id: UUID_, prepared_digest: "a".repeat(64), client_request_id: execute.client_request_id, handle_exp: HANDLE_EXP,
  };
  const opened = await openSealedInputs({ jwe: jwe as string, keys: [KEY_A!.privateJwk], claims, remember: createSealedInputsMemory().remember });
  assert.deepEqual(opened, { ok: true, values: { value: MARKER } });
  const elsewhere = await openSealedInputs({ jwe: jwe as string, keys: [KEY_A!.privateJwk], claims: { ...claims, client_request_id: "another" }, remember: createSealedInputsMemory().remember });
  assert.deepEqual(elsewhere, { ok: false, reason: "crq_mismatch" }, "bound to this request");

  const kept = [JSON.stringify(useLinkCardActionStore.getState()), ...stored.mock.calls.map((call) => call.join("\n")), ...logged.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")))];
  for (const secret of [MARKER, jwe as string]) assert.ok(!kept.some((where) => where.includes(secret)), "neither the value nor the JWE is stored or logged");
});

test("a key changed while the dialog was open: nothing is sealed to the old key, nothing is sent, the person presses again", async () => {
  const view = messageView();
  const { bodies, secretActing, viewKey } = await pressSecret(view);
  // The App rotated its key: the read right before sealing answers the new one.
  view.reread.mockImplementation(async () => ({ kind: "read", result: messageCardActionResult(URL_, secretActing, { answer: secretAnswer(KEY_B!.publicJwk), readAt: Date.now() }) }) as never);
  const sealed = vi.mocked(sealInputs).mock.calls.length;
  const secrets = new Map([["value", MARKER]]);
  await confirmLinkCardAction(viewKey, null, secrets);
  assert.equal(vi.mocked(sealInputs).mock.calls.length, sealed, "never sealed, to the old key or the new one");
  assert.deepEqual(bodies.map(([url]) => url), ["/link-cards/prepare"], "no execute");
  assert.equal(secrets.size, 0, "the value is dropped");
  assert.equal(useLinkCardActionStore.getState().views[viewKey], undefined, "the dialog closed: the person presses again");

  // Its client key changed, or the read failed: the same.
  for (const reread of [
    { kind: "read", result: messageCardActionResult(URL_, secretActing, { answer: { ...secretAnswer(), app: { ...secretAnswer().app!, client_key: "another_app" } } as MessageCardRead, readAt: Date.now() }) },
    { kind: "failed" },
  ]) {
    const again = await pressSecret(view);
    view.reread.mockImplementation(async () => reread as never);
    await confirmLinkCardAction(again.viewKey, null, new Map([["value", MARKER]]));
    assert.ok(!again.bodies.some(([url]) => url === "/link-cards/execute"), `no execute after ${reread.kind}`);
  }
});

test("a handle expiring before the value is sealed: nothing is read, sealed or sent", async () => {
  const view = messageView();
  const { bodies, viewKey } = await pressSecret(view, secretAnswer(KEY_A!.publicJwk, Math.floor(Date.now() / 1000) + 2));
  const secrets = new Map([["value", MARKER]]);
  await confirmLinkCardAction(viewKey, null, secrets);
  assert.equal(view.reread.mock.calls.length, 0);
  assert.deepEqual(bodies.map(([url]) => url), ["/link-cards/prepare"]);
  assert.equal(secrets.size, 0);
});
