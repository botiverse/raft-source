import assert from "node:assert/strict";
import {
  buildActionCardPresentation, buildActionCardSpec, parseActionCardSpec, withActionCardForms, type ActionCardAction, type ActionCardMetadata, type ActionCardSpecCard,
} from "@botiverse/raft-shared";
import { setActionCardFormHandlerForTest } from "./actionCardForms";
import {
  actionCardPresentationFor,
  messageWithoutAgentHiddenActionCardSpec,
  setActionCardSpecBuilderForTest,
  storedActionCardSpecNames,
  withoutAgentHiddenActionCardSpec,
  withStoredActionCardSpec,
} from "./actionCardPresentation";

const ALICE = "0b1e7c4e-1d2a-4f6b-9c3d-5e7f8a9b0c1d";
const action: ActionCardAction = { type: "channel:create", name: "launch", visibility: "public", initialHumans: [ALICE] };

function metadata(presentation: ActionCardMetadata["presentation"]): ActionCardMetadata {
  return { kind: "action-card", action, presentation, state: "prepared", result: null };
}

test("the presentation is the legacy fields, unchanged, plus the card", () => {
  const presentation = actionCardPresentationFor(action, { names: { users: { [ALICE]: "alice" } } });
  const { card, ...legacy } = presentation;
  assert.deepEqual(legacy, buildActionCardPresentation(action));
  assert.equal(card?.catalog, "action-card.v1");
  assert.deepEqual(storedActionCardSpecNames(presentation), { users: { [ALICE]: "alice" } });
});

test("a builder that throws or builds an invalid card leaves the card out, logged once per type", () => {
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  setActionCardSpecBuilderForTest(() => { throw new Error("injected"); });
  try {
    assert.deepEqual(actionCardPresentationFor(action), buildActionCardPresentation(action));
    assert.deepEqual(actionCardPresentationFor(action), buildActionCardPresentation(action));
    assert.equal(warnings.length, 1, "once per type");
    assert.match(JSON.stringify(warnings[0]), /channel:create/);
    assert.match(JSON.stringify(warnings[0]), /injected/);
  } finally {
    setActionCardSpecBuilderForTest(null);
    console.warn = warn;
  }
});

test("a stored card without presentation.card gets one, built from the row alone", () => {
  const legacy = buildActionCardPresentation(action);
  const read = withStoredActionCardSpec(metadata(legacy));
  assert.ok(read.presentation?.card);
  const { card: _card, ...readLegacy } = read.presentation;
  assert.deepEqual(readLegacy, legacy);
  // No names on the row: the id's first 8 characters.
  assert.match(JSON.stringify(read.presentation.card), new RegExp(`"fallback":"${ALICE.slice(0, 8)}"`));
  // A card that has one is left as stored.
  const withCard = metadata(actionCardPresentationFor(action, { names: { users: { [ALICE]: "alice" } } }));
  assert.equal(withStoredActionCardSpec(withCard), withCard);
  const notACard = { kind: "forwarded-bundle", presentation: {} };
  assert.equal(withStoredActionCardSpec(notACard), notACard);
  // A row whose action no builder knows keeps the legacy fields only.
  const unknown = { kind: "action-card", action: { type: "channel:archive" }, presentation: legacy };
  assert.equal(withStoredActionCardSpec(unknown), unknown);
});

// Cards stored with no presentation at all (May to July 2026, #proj-apps:#40).
test("a stored card with no presentation gets the whole envelope, as a card written today has", () => {
  const { presentation: _absent, ...noKey } = metadata(null);
  for (const stored of [metadata(null), noKey as ActionCardMetadata]) {
    const read = withStoredActionCardSpec(stored);
    assert.notEqual(read, stored);
    // The legacy fields older clients read and the card, together: never half an envelope.
    assert.deepEqual(read.presentation, actionCardPresentationFor(action, { result: null }));
    const { card, ...legacy } = read.presentation!;
    assert.deepEqual(legacy, buildActionCardPresentation(action));
    assert.ok(card && parseActionCardSpec(card, { mode: "read" }).ok, "the web reads the card");
    // The rest of the row is unchanged.
    assert.deepEqual({ ...read, presentation: undefined }, { ...stored, presentation: undefined });
  }
});

test("a stored card with no presentation whose card does not build keeps none (no half envelope)", () => {
  // A type no builder knows: not even the legacy fields alone.
  const unknown = { kind: "action-card", action: { type: "migration:export" }, presentation: null, state: "prepared", result: null };
  assert.equal(withStoredActionCardSpec(unknown), unknown);
  const warn = console.warn;
  console.warn = () => {};
  setActionCardSpecBuilderForTest(() => { throw new Error("injected"); });
  try {
    const bare = metadata(null);
    assert.equal(withStoredActionCardSpec(bare), bare);
  } finally {
    setActionCardSpecBuilderForTest(null);
    console.warn = warn;
  }
});

test("an agent's view of a card has the legacy presentation and no card", () => {
  const stored = metadata(actionCardPresentationFor(action));
  const agentView = withoutAgentHiddenActionCardSpec(stored);
  assert.deepEqual(agentView.presentation, buildActionCardPresentation(action));
  assert.ok(stored.presentation?.card, "the stored metadata is not changed");
  const message = { id: "m1", content: "x", actionMetadata: stored };
  const agentMessage = messageWithoutAgentHiddenActionCardSpec(message);
  assert.equal(JSON.stringify(agentMessage).includes("action-card.v1"), false);
  assert.equal(agentMessage.content, "x");
  // Anything else passes through untouched.
  const plain = { id: "m2", actionMetadata: { kind: "forwarded-bundle", forwardedItems: [] } };
  assert.equal(messageWithoutAgentHiddenActionCardSpec(plain), plain);
  assert.equal(withoutAgentHiddenActionCardSpec(null), null);
});

// form.v1 (S2): a form card's card, whatever button its type had.
const FORMS = {
  fill: {
    title: { key: "actionCard.test.form.title", text: { en: "Fill in" } },
    submitLabel: { key: "actionCard.test.form.submit", text: { en: "Send" } },
    fields: [{ type: "TextInput" as const, name: "note", label: { key: "actionCard.test.form.note", text: { en: "Note" } }, maxLength: 40 }],
  },
};
const buttonsOf = (card: ActionCardSpecCard) => Object.entries(card.spec.elements).flatMap(([id, node]) => node.type === "Button" ? [{ id, action: node.props.action, label: node.props.label.text.en }] : []);

test("withActionCardForms: an execute with a confirm opens the form (the confirm goes); a card with no button gets one", () => {
  // No first-party builder sends a confirm now (the install card's dialog is the client's own, Q1):
  // the install card's execute, put behind a confirm here.
  const plain = buildActionCardSpec({
    type: "integration:install_marketplace_app", clientId: "c4b6c9f0-1a2b-4c3d-8e9f-0a1b2c3d4e5f", clientKey: "vault", clientName: "Vault", clientNameSha256: "a".repeat(64),
    agentId: ALICE, agentName: "scout", scopes: ["identity:read"], installScopes: ["identity:read"], installGroups: ["channel"],
  });
  const installButton = plain.spec.elements.installApp;
  assert.ok(installButton?.type === "Button");
  const install: ActionCardSpecCard = {
    ...plain,
    spec: { ...plain.spec, elements: { ...plain.spec.elements, installApp: { ...installButton, props: { ...installButton.props, action: { kind: "execute", confirm: "install" } } } } },
    confirms: {
      install: {
        title: { key: "actionCard.test.confirm.title", text: { en: "Install?" } },
        confirmLabel: { key: "actionCard.test.confirm.label", text: { en: "Install" } },
        spec: { root: "body", elements: { body: { type: "Text", props: { text: "Vault gets access.", tone: "default", mono: false } } } },
      },
    },
  };
  assert.ok(parseActionCardSpec(install, { mode: "emit" }).ok, "control: a valid card whose execute has a confirm");
  const installForm = withActionCardForms(install, FORMS);
  assert.deepEqual(buttonsOf(installForm).map((button) => button.action), [{ kind: "open_form", form: "fill" }]);
  assert.equal(installForm.confirms, undefined);
  assert.ok(parseActionCardSpec(installForm, { mode: "emit" }).ok);

  const mcp = buildActionCardSpec({ type: "integration:connect_mcp", mcpServerId: "c4b6c9f0-1a2b-4c3d-8e9f-0a1b2c3d4e5f", agentId: ALICE, reason: "login_required", revision: 1 });
  assert.deepEqual(buttonsOf(mcp), [], "control: connect_mcp has no button");
  const mcpForm = withActionCardForms(mcp, FORMS);
  assert.deepEqual(buttonsOf(mcpForm), [{ id: "openForm", action: { kind: "open_form", form: "fill" }, label: "Send" }]);
  // In the actions row, last, as every card's button.
  assert.equal(mcpForm.spec.elements.root?.type === "Stack" ? mcpForm.spec.elements.root.children?.at(-1) : null, "actions");
  assert.deepEqual(mcpForm.spec.elements.actions, { type: "Stack", props: { direction: "row", wrap: true, role: "actions" }, children: ["openForm"] });
  // The row is found by its role, whatever its id: the form button joins it.
  const renamed = structuredClone(mcp);
  const root = renamed.spec.elements.root;
  assert.ok(root?.type === "Stack");
  root.children = [...(root.children ?? []), "buttons"];
  renamed.spec.elements.buttons = { type: "Stack", props: { direction: "row", wrap: true, role: "actions" }, children: [] };
  const joined = withActionCardForms(renamed, FORMS);
  assert.deepEqual(joined.spec.elements.buttons, { type: "Stack", props: { direction: "row", wrap: true, role: "actions" }, children: ["openForm"] });
  assert.equal(joined.spec.elements.actions, undefined, "no second row");
  assert.ok(parseActionCardSpec(mcpForm, { mode: "emit" }).ok);
  // No forms: a card with a button that acts is refused (it would end in FORM_REQUIRED); one without is sent as built.
  assert.throws(() => withActionCardForms(install, {}), /no forms/);
  assert.deepEqual(withActionCardForms(mcp, {}), mcp);
});

test("a form card whose forms fail the emit parse is left out (legacy only, still no generic approve)", () => {
  const warn = console.warn;
  console.warn = () => {};
  setActionCardFormHandlerForTest("channel:create", {
    buildForm: () => ({ fill: { ...FORMS.fill, fields: [{ ...FORMS.fill.fields[0]!, name: "Not A Field Name" }] } }),
    validate: async () => ({ input: null }),
    execute: async () => { throw new Error("not reached"); },
  });
  try {
    const presentation = actionCardPresentationFor(action);
    assert.equal(presentation.card, undefined);
    assert.equal(presentation.genericApprovalAllowed, false);
  } finally {
    setActionCardFormHandlerForTest("channel:create", null);
    console.warn = warn;
  }
});
