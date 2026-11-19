import assert from "node:assert/strict";
import {
  agentMessageCardMarker, deriveMessageCardFallback, isMessageCardMetadata, messageCardMetadataAfterUpdate, messageCardMetadataAtSend,
  messageCardSchema, messageCardStoredContent, parseMessageCard, renderMessageCardMarkdown, type MessageCard, type MessageCardInput,
} from "./messageCard";
import { linkCardExecuteActionSchema } from "./appLinkPreview";
import {
  applyMessageCardActions, MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON, MESSAGE_CARD_CAPABILITIES, MESSAGE_CARD_EXECUTE_CAPABILITY, MESSAGE_CARD_FORM_LIMITS,
  MESSAGE_CARD_SECRET_INPUT_UNDO_REFUSAL, messageCardActingButtons, messageCardActionCapabilities, messageCardActionHasSecretInput,
  messageCardExecuteActionSchema, messageCardForUser, messageCardFormSchema, messageCardFormSubmissionFits, MESSAGE_CARD_SEALED_INPUTS_PATTERN,
} from "./messageCardActions";
import { extractRaftMentionHandles } from "./raftRefs";

// RFC 086 step 1: an App's card message with acting buttons, as the shared
// module reads it: the actions against the card, the card Raft stores (which
// every client reads with the strict schema it already has), and what agents
// read of an acting button.

const request: MessageCardInput = {
  version: 1,
  header: { title: "Access request: deploy key" },
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["what", "row"] },
    what: { type: "Text", props: { text: "builder-bot asks to use the deploy key until 18:00 UTC." } },
    row: { type: "Stack", props: { direction: "row" }, children: ["approve", "deny", "open"] },
    approve: { type: "Button", props: { label: "Approve", action: { kind: "navigate", url: "https://vault.example.com/requests/42" } } },
    deny: { type: "Button", props: { label: "Deny", variant: "ghost", action: { kind: "navigate", url: "https://vault.example.com/requests/42" } } },
    open: { type: "Button", props: { label: "Open in Vault", action: { kind: "navigate", url: "https://vault.example.com/requests/42" } } },
  },
};
const actions = {
  approve: { kind: "execute", action_id: "approve", confirm: "prepare" },
  deny: { kind: "execute", action_id: "deny", undoWindowMs: 5000 },
} as const;
const forUser = "0b4c3a1e-6c55-4b8e-9d0a-2f9f3c1d7e21";

function parsed(card: unknown = request): MessageCard {
  const result = parseMessageCard(card);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.problem));
  return result.card;
}

test("applyMessageCardActions: each acting Button gets Raft's disabledReason over the sender's, the other Buttons stay as sent", () => {
  const sent = parsed({ ...request, elements: { ...request.elements, deny: { type: "Button", props: { label: "Deny", action: { kind: "navigate", url: "https://vault.example.com/requests/42" }, disabledReason: "the sender's" } } } });
  const applied = applyMessageCardActions(sent, actions);
  assert.ok(applied.ok);
  assert.deepEqual(applied.actions, actions);
  for (const id of ["approve", "deny"]) {
    const element: MessageCard["elements"][string] = applied.card.elements[id]!;
    assert.equal(element.type, "Button");
    assert.equal(element.type === "Button" && element.props.disabledReason, MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON, id);
    assert.equal(element.type === "Button" && element.props.action.url, "https://vault.example.com/requests/42", `${id}: the fallback page stays its navigate URL`);
  }
  assert.deepEqual(applied.card.elements.open, sent.elements.open);
  assert.equal(sent.elements.approve!.type === "Button" && sent.elements.approve!.props.disabledReason, undefined, "the parsed card is not changed in place");
});

test("applyMessageCardActions refuses: not an object, none, a key naming no Button or no element, an action that doesn't validate, an action_id twice", () => {
  const card = parsed();
  const problems: Array<[unknown, string]> = [
    [[], "actions"],
    ["approve", "actions"],
    [{}, "actions"],
    [{ what: actions.approve }, "actions.what"],
    [{ missing: actions.approve }, "actions.missing"],
    [{ __proto__: actions.approve }, "actions"],
    [{ approve: { kind: "navigate", url: "https://vault.example.com/" } }, "actions.approve"],
    [{ approve: { kind: "execute", action_id: "approve" } }, "actions.approve"],
    [{ approve: { kind: "execute", action_id: "approve", confirm: "prepare", undoWindowMs: 5000 } }, "actions.approve"],
    [{ approve: { kind: "execute", action_id: "approve", undoWindowMs: 500 } }, "actions.approve"],
    [{ approve: { kind: "execute", action_id: "Approve!", confirm: "prepare" } }, "actions.approve"],
    [{ approve: actions.approve, deny: { kind: "execute", action_id: "approve", undoWindowMs: 5000 } }, "actions.deny.action_id"],
  ];
  for (const [raw, path] of problems) {
    const applied = applyMessageCardActions(card, raw);
    assert.equal(applied.ok, false, JSON.stringify(raw));
    assert.equal(!applied.ok && applied.problem.path, path, JSON.stringify(raw));
  }
});

test("the stored card is valid for every client in use: an older client's strict schema and parse read it, and its metadata is still a card message's", () => {
  const applied = applyMessageCardActions(parsed(), actions);
  assert.ok(applied.ok);
  const metadata = messageCardMetadataAtSend(applied.card, new Date("2026-11-13T10:00:00Z"), { actions: applied.actions, for: forUser });
  // Through JSON, as clients get it.
  const wire = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(wire).sort(), ["actions", "card", "for", "kind", "revision", "updatedAt"]);
  assert.ok(isMessageCardMetadata(wire), "isMessageCardMetadata ignores the keys it doesn't know");
  assert.ok(messageCardSchema.safeParse(wire.card).success, "the strict stored-card schema (web, desktop) reads the card");
  const reparsed = parseMessageCard(wire.card);
  assert.ok(reparsed.ok, "parseMessageCard reads it too");
  assert.deepEqual(JSON.parse(JSON.stringify(reparsed.card)), wire.card);
  // An older client renders it as before: disabled, its reason, never the link.
  assert.equal(
    renderMessageCardMarkdown(reparsed.card),
    "**Access request: deploy key**\n\nbuilder-bot asks to use the deploy key until 18:00 UTC.\n\n"
      + "Approve (disabled: Update Raft to use this button) · Deny (disabled: Update Raft to use this button) · [Open in Vault](https://vault.example.com/requests/42)",
  );
});

test("agents read an acting button as in Raft (for @name when the card is for one person); an ordinary card reads byte for byte as before", () => {
  const applied = applyMessageCardActions(parsed(), actions);
  assert.ok(applied.ok);
  const sentAt = new Date("2026-11-13T10:00:00Z");
  const head = "**Access request: deploy key**\n\nbuilder-bot asks to use the deploy key until 18:00 UTC.\n\n";
  const open = "[Open in Vault](https://vault.example.com/requests/42)";

  const forOne = messageCardMetadataAtSend(applied.card, sentAt, { actions: applied.actions, for: forUser });
  assert.equal(agentMessageCardMarker(forOne, { forName: "alice" })?.text, `${head}Approve (in Raft, for \`@alice\`) · Deny (in Raft, for \`@alice\`) · ${open}`);
  assert.equal(agentMessageCardMarker(forOne)?.text, `${head}Approve (in Raft, for one person) · Deny (in Raft, for one person) · ${open}`, "no name found");
  const forAnyone = messageCardMetadataAtSend(applied.card, sentAt, { actions: applied.actions });
  assert.equal(agentMessageCardMarker(forAnyone, { forName: "alice" })?.text, `${head}Approve (in Raft) · Deny (in Raft) · ${open}`);
  for (const metadata of [forOne, forAnyone]) {
    assert.deepEqual(extractRaftMentionHandles(agentMessageCardMarker(metadata, { forName: "alice" })!.text!), [], "the card's text mentions no one");
  }
  // The renderer itself: only the Buttons named act; with none named it is the renderer it was.
  assert.equal(renderMessageCardMarkdown(applied.card, { actingButtons: { ids: new Set(["deny"]) } }),
    `${head}Approve (disabled: Update Raft to use this button) · Deny (in Raft) · ${open}`);
  const ordinary = parsed();
  assert.equal(renderMessageCardMarkdown(ordinary, { actingButtons: { ids: new Set() } }), renderMessageCardMarkdown(ordinary));
  assert.equal(agentMessageCardMarker(messageCardMetadataAtSend(ordinary, sentAt), { forName: "alice" })?.text, renderMessageCardMarkdown(ordinary));
  // Derived without naming the acting buttons, the fallback is the card as an older client reads it.
  assert.equal(deriveMessageCardFallback(applied.card), renderMessageCardMarkdown(applied.card));
});

test("the fallback Raft derives for a card with acting buttons reads them as in Raft, never the disabled reason; a navigate-only card's is byte for byte what it was", () => {
  const applied = applyMessageCardActions(parsed(), actions);
  assert.ok(applied.ok);
  const head = "**Access request: deploy key**\n\nbuilder-bot asks to use the deploy key until 18:00 UTC.\n\n";
  const acting = new Set(Object.keys(applied.actions));
  const derived = deriveMessageCardFallback(applied.card, { actingButtons: acting });
  assert.equal(derived, `${head}Approve (in Raft) · Deny (in Raft) · [Open in Vault](https://vault.example.com/requests/42)`);
  assert.ok(!derived.includes("Update Raft"), derived);
  assert.equal(messageCardStoredContent(applied.card, undefined, acting), derived, "what a send without content stores");
  assert.equal(messageCardStoredContent(applied.card, "Vault: one request", acting), "Vault: one request", "a sender's content is untouched");
  // A navigate-only card: the same bytes as before, with or without an (empty) set.
  const ordinary = parsed();
  const before = renderMessageCardMarkdown(ordinary, { maxCodePoints: 500 });
  assert.equal(deriveMessageCardFallback(ordinary), before);
  assert.equal(deriveMessageCardFallback(ordinary, { actingButtons: new Set() }), before);
  assert.equal(before, `${head}[Approve](https://vault.example.com/requests/42) · [Deny](https://vault.example.com/requests/42) · [Open in Vault](https://vault.example.com/requests/42)`);
});

test("messageCardActingButtons and messageCardForUser read stored metadata leniently", () => {
  const applied = applyMessageCardActions(parsed(), actions);
  assert.ok(applied.ok);
  const metadata = messageCardMetadataAtSend(applied.card, new Date(), { actions: applied.actions, for: forUser });
  assert.deepEqual(messageCardActingButtons(metadata), [
    { elementId: "approve", url: "https://vault.example.com/requests/42", label: "Approve", action: actions.approve },
    { elementId: "deny", url: "https://vault.example.com/requests/42", label: "Deny", action: actions.deny },
  ]);
  assert.equal(messageCardForUser(metadata), forUser);
  // A key naming no Button, or an action that doesn't read, is left out.
  const odd = { ...metadata, actions: { ...metadata.actions, what: actions.approve, open: { kind: "navigate" } } } as unknown as typeof metadata;
  assert.deepEqual(messageCardActingButtons(odd).map((button) => button.elementId), ["approve", "deny"]);
  assert.deepEqual(messageCardActingButtons(messageCardMetadataAtSend(applied.card, new Date())), []);
  assert.equal(messageCardForUser({ kind: "message-card" }), null);
  assert.equal(MESSAGE_CARD_EXECUTE_CAPABILITY, "card.execute.v1");
});

test("an update's metadata: its actions replace the card's (none: they end); for stays the send's", () => {
  const applied = applyMessageCardActions(parsed(), actions);
  assert.ok(applied.ok);
  const sent = messageCardMetadataAtSend(applied.card, new Date("2026-11-13T10:00:00Z"), { actions: applied.actions, for: forUser });
  const ended = messageCardMetadataAfterUpdate(sent, parsed(), new Date("2026-11-13T10:01:00Z"));
  assert.deepEqual({ revision: ended.revision, actions: ended.actions, for: ended.for }, { revision: 2, actions: undefined, for: forUser });
  assert.ok(!("actions" in ended));
  const again = messageCardMetadataAfterUpdate(ended, applied.card, new Date("2026-11-13T10:02:00Z"), { deny: actions.deny });
  assert.deepEqual({ revision: again.revision, actions: again.actions, for: again.for }, { revision: 3, actions: { deny: actions.deny }, for: forUser });
  const plain = messageCardMetadataAfterUpdate(messageCardMetadataAtSend(parsed(), new Date()), parsed(), new Date());
  assert.deepEqual(Object.keys(plain).sort(), ["card", "kind", "revision", "updatedAt"], "an ordinary card's metadata is as it was");
});

// RFC 086 step 2 (§5.1): a form on an acting button, TextInput and SecretInput fields.
const name = { type: "TextInput", id: "name", label: "Name", default: "deploy-key-prod", maxLength: 64 } as const;
const value = { type: "SecretInput", id: "value", label: "Value", placeholder: "Paste the key", required: true } as const;
const keyForm = { fields: [name, value] };

test("a form: 1 to 4 TextInput or SecretInput fields, strict, bounded, each id once; a SecretInput is never prefilled", () => {
  assert.ok(messageCardFormSchema.safeParse(keyForm).success);
  assert.ok(messageCardFormSchema.safeParse({ fields: [{ type: "SecretInput", id: "token", label: "Token" }] }).success, "the least a SecretInput needs");
  const four = { fields: ["a", "b", "c", "d"].map((id) => ({ type: "TextInput", id, label: id })) };
  assert.ok(messageCardFormSchema.safeParse(four).success, `${MESSAGE_CARD_FORM_LIMITS.maxFields} fields`);
  const refused: Array<[string, unknown]> = [
    ["no fields", { fields: [] }],
    ["five fields", { fields: [...four.fields, { type: "TextInput", id: "e", label: "e" }] }],
    ["a member a form has no place for", { ...keyForm, title: "New key" }],
    ["a list, not { fields }", [name, value]],
    ["a SecretInput's default", { fields: [{ ...value, default: "sk-live-123" }] }],
    ["a SecretInput's value", { fields: [{ ...value, value: "sk-live-123" }] }],
    ["a SecretInput's maxLength", { fields: [{ ...value, maxLength: 100 }] }],
    ["an unknown member on a TextInput", { fields: [{ ...name, autocomplete: "on" }] }],
    ["an unknown field type", { fields: [{ type: "TextArea", id: "notes", label: "Notes" }] }],
    ["an id twice", { fields: [name, { ...value, id: "name" }] }],
    ["an id that isn't one", { fields: [{ ...value, id: "Value!" }] }],
    ["a reserved id", { fields: [{ ...value, id: "constructor" }] }],
    ["an empty label", { fields: [{ ...value, label: "" }] }],
    ["a label over 40 characters", { fields: [{ ...value, label: "x".repeat(41) }] }],
    ["a label on two lines", { fields: [{ ...value, label: "Value\nhere" }] }],
    ["a placeholder over 120 characters", { fields: [{ ...value, placeholder: "x".repeat(121) }] }],
    ["a TextInput maxLength over 500", { fields: [{ ...name, maxLength: 501 }] }],
    ["a default past maxLength", { fields: [{ ...name, maxLength: 4, default: "deploy" }] }],
    ["a default past the 500 a TextInput takes", { fields: [{ type: "TextInput", id: "name", label: "Name", default: "x".repeat(501) }] }],
    ["a default on two lines", { fields: [{ ...name, default: "a\nb" }] }],
  ];
  for (const [why, form] of refused) assert.equal(messageCardFormSchema.safeParse(form).success, false, why);
  assert.equal(MESSAGE_CARD_FORM_LIMITS.secretInputMaxBytes, 4096, "the declared cap of a SecretInput's value, in UTF-8 bytes");
});

test("an acting button's form: on a confirm button any field, on an undo-window button TextInput only (a SecretInput there has its own sentence); a link card's execute action takes no form", () => {
  const card = parsed();
  const withForms = {
    approve: { ...actions.approve, form: keyForm },
    deny: { ...actions.deny, form: { fields: [{ type: "TextInput" as const, id: "reason", label: "Reason" }] } },
  };
  const applied = applyMessageCardActions(card, withForms);
  assert.ok(applied.ok, JSON.stringify(!applied.ok && applied.problem));
  assert.deepEqual(applied.actions, withForms);
  assert.equal(messageCardActionHasSecretInput(applied.actions.approve!), true);
  assert.equal(messageCardActionHasSecretInput(applied.actions.deny!), false);
  assert.deepEqual(messageCardActionCapabilities(applied.actions.approve!), ["card.execute.v1", "card.form.v1", "card.form.secret.v1"]);
  assert.deepEqual(messageCardActionCapabilities(applied.actions.deny!), ["card.execute.v1", "card.form.v1"]);
  assert.deepEqual(messageCardActionCapabilities(actions.approve), ["card.execute.v1"]);
  assert.deepEqual([...MESSAGE_CARD_CAPABILITIES], ["card.execute.v1", "card.form.v1", "card.form.secret.v1"]);
  // Stored and read back: the acting buttons carry their forms.
  const metadata = messageCardMetadataAtSend(applied.card, new Date(), { actions: applied.actions });
  assert.deepEqual(messageCardActingButtons(JSON.parse(JSON.stringify(metadata))).map((button) => button.action), [withForms.approve, withForms.deny]);

  const undoSecret = applyMessageCardActions(card, { deny: { ...actions.deny, form: { fields: [value] } } });
  assert.equal(undoSecret.ok, false);
  assert.deepEqual(!undoSecret.ok && undoSecret.problem, { path: "actions.deny.form", message: MESSAGE_CARD_SECRET_INPUT_UNDO_REFUSAL });
  assert.equal(messageCardExecuteActionSchema.safeParse({ ...actions.deny, form: { fields: [value] } }).success, false, "the schema refuses it too");
  const badForm = applyMessageCardActions(card, { approve: { ...actions.approve, form: { fields: [{ ...value, default: "sk-live-123" }] } } });
  assert.equal(badForm.ok, false);
  assert.equal(!badForm.ok && badForm.problem.path, "actions.approve.form");
  assert.ok(!badForm.ok && !badForm.problem.message.includes("sk-live-123"), "the refusal never quotes what was sent");
  assert.equal(linkCardExecuteActionSchema.safeParse({ ...actions.approve, form: keyForm }).success, false, "RFC 076 link cards: no forms");
});

test("RFC 086 §5.4: execute's form values fit the button's form: sealed_inputs exactly when it holds a SecretInput, inputs only its TextInputs, within their bounds, required ones filled", () => {
  const form = messageCardFormSchema.parse({ fields: [
    { type: "TextInput", id: "name", label: "Name", required: true, maxLength: 10 },
    { type: "TextInput", id: "note", label: "Note" },
    { type: "SecretInput", id: "value", label: "Value", required: true },
  ] });
  const textOnly = messageCardFormSchema.parse({ fields: [{ type: "TextInput", id: "reason", label: "Reason" }] });
  const sealed = "aGVhZGVy..aXY.Y2lwaGVy.dGFn";
  assert.ok(MESSAGE_CARD_SEALED_INPUTS_PATTERN.test(sealed));
  const fits = (f: typeof form | undefined, sealedInputs: string | null, inputs: Record<string, string> | null) => messageCardFormSubmissionFits(f, { sealedInputs, inputs });

  assert.equal(fits(form, sealed, { name: "prod" }), true);
  assert.equal(fits(form, sealed, { name: "prod", note: "" }), true, "an optional field may be empty");
  assert.equal(fits(form, sealed, { name: "é".repeat(10) }), true, "maxLength counts code points");
  assert.equal(fits(form, null, { name: "prod" }), false, "a SecretInput needs sealed_inputs");
  assert.equal(fits(form, sealed, null), false, "a required TextInput must be there");
  assert.equal(fits(form, sealed, { name: "" }), false, "and not empty");
  assert.equal(fits(form, sealed, { name: "x".repeat(11) }), false, "within its maxLength");
  assert.equal(fits(form, sealed, { name: "two\nlines" }), false, "one line");
  assert.equal(fits(form, sealed, { name: "prod", value: "sk-live" }), false, "a SecretInput's value never travels in plain text");
  assert.equal(fits(form, sealed, { name: "prod", other: "x" }), false, "only the form's own fields");
  assert.equal(fits(textOnly, null, null), true, "an optional TextInput may be left out");
  assert.equal(fits(textOnly, null, { reason: "x".repeat(500) }), true, "500 code points without a maxLength");
  assert.equal(fits(textOnly, null, { reason: "x".repeat(501) }), false);
  assert.equal(fits(textOnly, sealed, { reason: "x" }), false, "no sealed_inputs without a SecretInput");
  assert.equal(fits(undefined, null, null), true, "a button without a form takes neither");
  assert.equal(fits(undefined, sealed, null), false);
  assert.equal(fits(undefined, null, {}), false);
});
