// F1: the card a `feedback:submit` card is sent with, now that it is a form
// card (feedbackCardForm.ts): the S1 card with its button opening the
// dialog's form, the form itself (prepared and executed), what a client
// without form.v1 makes of it, and the card it keeps when the form cannot
// carry the draft. Also the client facts a form send files.
import assert from "node:assert/strict";
import {
  ACTION_CARD_MESSAGES,
  ACTION_CARD_SPEC_CAPABILITIES,
  ACTION_CARD_SPEC_LIMITS,
  DISPLAY_LOCALES,
  FEEDBACK_SUBMIT_FORM_ID,
  buildActionCardPresentation,
  buildParsedActionCardSpec,
  displayLocaleTag,
  parseActionCardSpec,
  stripActionCardSpec,
  type ActionCardAction,
  type ActionCardMessageEntry,
  type ActionCardResult,
  type ActionCardSpecCard,
  type ActionCardSpecMsg,
} from "@botiverse/raft-shared";
import { actionCardFormHandlerFor } from "./actionCardForms";
import { actionCardPresentationFor, actionCardSpecFor } from "./actionCardPresentation";
import { feedbackFormMetadata } from "./feedbackCardForm";
import { normalizeProductFeedbackMetadata } from "./productFeedbackService";

type Feedback = Extract<ActionCardAction, { type: "feedback:submit" }>;
const action: Feedback = {
  type: "feedback:submit",
  feedbackType: "problem",
  message: "Search misses messages older than a week.\nSteps: search for 'launch'.",
  draftHint: "You hit this twice today.",
};
const result: ActionCardResult = { kind: "product-feedback", ticketId: "33333333-3333-4333-8333-333333333333", reference: "FB-7" };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isMsg = (value: unknown): value is ActionCardSpecMsg => typeof value === "object" && value !== null && "key" in value && "text" in value;
/** The card with each Msg as `{ $msg: key, ...params }` (its text is the table's, checked below). */
function compact(value: unknown): Json {
  if (Array.isArray(value)) return value.map(compact);
  if (isMsg(value)) return { $msg: value.key, ...(compact(value.params ?? {}) as Record<string, Json>) };
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child)]));
  return value as Json;
}
function msgsOf(value: unknown, out: ActionCardSpecMsg[] = []): ActionCardSpecMsg[] {
  if (isMsg(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => msgsOf(item, out));
  else if (typeof value === "object" && value !== null) Object.values(value).forEach((child) => msgsOf(child, out));
  return out;
}
const served = (draft: Feedback, ctx: { result?: ActionCardResult } = {}) => {
  const card = actionCardSpecFor(draft, ctx);
  assert.ok(card, "the feedback card is sent");
  return card;
};
/** What a client reads (JSON, read mode) and renders with `capabilities`. */
function rendered(card: ActionCardSpecCard, capabilities: readonly string[]) {
  const read = parseActionCardSpec(JSON.parse(JSON.stringify(card)), { mode: "read" });
  assert.ok(read.ok, "every client reads the card");
  return stripActionCardSpec(read.card, capabilities);
}
const buttonActions = (card: { spec: { elements: Record<string, { type: string; props?: unknown }> } }) =>
  Object.entries(card.spec.elements).filter(([, node]) => node.type === "Button")
    .map(([id, node]) => [id, (node.props as { action: unknown }).action]);

/** The form, as the snapshot of what F1 adds to the card. */
const FORM = {
  [FEEDBACK_SUBMIT_FORM_ID]: {
    title: { $msg: "actionCard.feedback.dialogTitle" },
    submitLabel: { $msg: "actionCard.feedback.submit" },
    description: { $msg: "actionCard.feedback.form.description" },
    fields: [
      {
        type: "Select", name: "type", label: { $msg: "actionCard.field.feedbackType" }, required: true,
        options: [
          { value: "idea", label: { $msg: "actionCard.feedbackType.idea" } },
          { value: "problem", label: { $msg: "actionCard.feedbackType.problem" } },
        ],
        default: "problem",
      },
      {
        type: "TextArea", name: "message", label: { $msg: "actionCard.field.feedback" }, required: true,
        maxLength: 8000, rows: 6, default: action.message,
      },
    ],
  },
};

test("feedback:submit is a form card that also completes by its dialog", () => {
  const handler = actionCardFormHandlerFor("feedback:submit");
  assert.ok(handler, "registered in production");
  assert.ok(handler.deliver, "it files with Hands before execute's transaction");
  assert.equal(handler.completesWithoutForm, true);
});

test("prepared: the S1 card, its button opening the dialog's form, prefilled with the draft", () => {
  const card = served(action);
  const s1 = buildParsedActionCardSpec(action);
  assert.ok(s1.ok);
  // Everything but the button and the form is the card S1 builds.
  const { forms, spec, ...envelope } = card;
  const { spec: s1Spec, ...s1Envelope } = s1.card;
  assert.deepEqual(envelope, s1Envelope);
  assert.deepEqual(Object.keys(spec.elements), Object.keys(s1Spec.elements));
  for (const [id, node] of Object.entries(spec.elements)) {
    if (id === "submitFeedback") continue;
    assert.deepEqual(node, s1Spec.elements[id], id);
  }
  assert.deepEqual(compact(spec.elements.submitFeedback), {
    type: "Button",
    props: { label: { $msg: "actionCard.verb.submitFeedback" }, emphasis: "primary", action: { kind: "open_form", form: "feedback" } },
  });
  assert.deepEqual(compact(forms), FORM);
  assert.equal(card.confirms, undefined);
  assert.equal(card.result, undefined);
});

/**
 * A card's layout without its copy: each element's type, the props that
 * place or style it (direction, wrap, role, tone; the button's emphasis), and its
 * children, from the root down.
 */
function layout(card: ActionCardSpecCard, id = card.spec.root): Json {
  const node = card.spec.elements[id];
  assert.ok(node, id);
  const props = node.props as Record<string, unknown>;
  const style = Object.fromEntries(["direction", "wrap", "role", "tone", "emphasis"].filter((key) => key in props).map((key) => [key, props[key] as Json]));
  return { id, type: node.type, ...style, ...(node.type === "Stack" ? { children: (node.children ?? []).map((child) => layout(card, child)) } : {}) };
}
const withoutProperties = (tree: Json) => ({ ...(tree as Record<string, Json>), children: ((tree as { children: Json[] }).children).filter((child) => (child as { id: string }).id !== "properties") });

/** Under its properties, every card with a reason: the hint group, then its one button alone in the actions row, last. */
const templateLayout = (button: string) => ({ id: "root", type: "Stack", direction: "column", wrap: false, children: [
  { id: "reason", type: "Stack", direction: "column", wrap: false, role: "reason", children: [
    { id: "reasonLabel", type: "Text", tone: "muted" },
    { id: "reasonText", type: "Text", tone: "default" },
  ] },
  { id: "actions", type: "Stack", direction: "row", wrap: true, role: "actions", children: [{ id: button, type: "Button", emphasis: "primary" }] },
] });

test("the reason and the button are the shared template's: the hint group and the actions row, as on channel:create", () => {
  const channel = actionCardSpecFor({ type: "channel:create", name: "launch", visibility: "public", draftHint: "You asked for it." });
  assert.ok(channel);
  const feedback = served(action);
  assert.deepEqual(withoutProperties(layout(channel)), templateLayout("createChannel"));
  assert.deepEqual(withoutProperties(layout(feedback)), templateLayout("submitFeedback"));
  const reasonText = feedback.spec.elements.reasonText;
  assert.ok(reasonText?.type === "Text" && reasonText.props.text === action.draftHint, "the agent's reason, as data");
});

test("executed: the same card with the result: where it went, and the sender's View in Settings (S0.3)", () => {
  const card = served(action, { result });
  assert.deepEqual(compact(card.forms), FORM);
  assert.deepEqual(compact(card.result), {
    root: "root",
    elements: {
      root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["summary", "actions"] },
      actions: { type: "Stack", props: { direction: "row", wrap: true, role: "actions" }, children: ["openTicket"] },
      summary: { type: "Text", props: { text: { $msg: "actionCard.result.feedbackSentToRaft" }, tone: "default", mono: false } },
      openTicket: { type: "Button", props: { label: { $msg: "actionCard.result.feedbackSubmitted" }, emphasis: "secondary", action: { kind: "open", intent: "feedback_ticket" } } },
    },
  });
  // A client that does not declare the intent (an older web build or App) gets Open in web there.
  assert.deepEqual(rendered(card, ACTION_CARD_SPEC_CAPABILITIES)!.result?.elements.openTicket, card.result?.elements.openTicket);
  for (const capabilities of [ACTION_CARD_SPEC_CAPABILITIES.filter((cap) => cap !== "intent.feedback_ticket"), ["card.v1", "confirm.v1"]]) {
    const button = rendered(card, capabilities)!.result?.elements.openTicket;
    assert.deepEqual(button?.type === "Button" ? button.props.action : null, { kind: "open_web" });
  }
});

test("the form's copy is the table's, in all 7 locales; the agent's draft stays a plain string", () => {
  const fuzz = "{x} {{y}} } {z";
  const card = served({ ...action, message: fuzz, draftHint: fuzz });
  const fields = card.forms![FEEDBACK_SUBMIT_FORM_ID]!.fields;
  assert.equal(fields[1]?.type === "TextArea" ? fields[1].default : null, fuzz, "the draft is the default as written");
  const table = ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>;
  for (const message of msgsOf(card.forms)) {
    assert.ok(Object.hasOwn(table, message.key), message.key);
    assert.deepEqual(message.text, table[message.key]!.text, message.key);
    assert.deepEqual(Object.keys(message.text).sort(), [...DISPLAY_LOCALES].sort(), `${message.key} has every display locale`);
  }
});

test("the legacy presentation refuses a generic approve and points to the web", () => {
  const { card, ...legacy } = actionCardPresentationFor(action);
  assert.ok(card);
  assert.deepEqual(legacy, {
    ...buildActionCardPresentation(action),
    genericApprovalAllowed: false,
    warning: "Open this card on the web to fill in its form.",
  });
});

test("a client without form.v1 or a field type gets Open in web", () => {
  const card = served(action);
  const all = ACTION_CARD_SPEC_CAPABILITIES;
  const without = (...caps: string[]) => all.filter((cap) => !caps.includes(cap));
  const openWeb = [["submitFeedback", { kind: "open_web" }]];

  assert.deepEqual(buttonActions(rendered(card, all)!), [["submitFeedback", { kind: "open_form", form: "feedback" }]], "the App with form.v1 opens the form");
  assert.deepEqual(buttonActions(rendered(card, without("form.v1"))!), openWeb);
  assert.deepEqual(buttonActions(rendered(card, without("field.text_area"))!), openWeb);
  assert.deepEqual(buttonActions(rendered(card, without("field.select"))!), openWeb);
  // An App that knows the native intent but not forms: Open in web, never the dialog's intent silently.
  assert.deepEqual(buttonActions(rendered(card, ["card.v1", "intent.feedback_form"])!), openWeb);
  // A client with card.v1 and confirm.v1 alone (as the web declared before its
  // form sheet): Open in web. The web now declares form.v1 and every field
  // (actionCardSpecRead.ts) and opens the form.
  assert.deepEqual(buttonActions(rendered(card, ["card.v1", "confirm.v1"])!), openWeb);
  assert.equal(rendered(card, []), null, "no card.v1: the legacy presentation");
});

const cardBytes = (card: ActionCardSpecCard) => new TextEncoder().encode(JSON.stringify(card)).length;

test("a draft the form cannot carry keeps the dialog's card instead of no card", () => {
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const longest = served({ ...action, message: "a".repeat(8000) });
    assert.ok(longest.forms, "8000 code points: the form takes it");
    assert.ok(cardBytes(longest) <= ACTION_CARD_SPEC_LIMITS.maxBytes);

    for (const [label, message] of [
      ["one code point past the TextArea", `${"a".repeat(7999)}😀😀`],
      ["the dialog's limit", "a".repeat(10_000)],
      ["past 24 KiB (CJK)", "反".repeat(6000)],
    ] as const) {
      const card = served({ ...action, message });
      assert.equal(card.forms, undefined, label);
      assert.deepEqual(buttonActions(card), [["submitFeedback", { kind: "open", intent: "feedback_form" }]], label);
      assert.ok(parseActionCardSpec(card, { mode: "emit" }).ok, label);
      assert.deepEqual(withoutProperties(layout(card)), templateLayout("submitFeedback"), label);
    }
    assert.equal(warnings.length, 1, "logged once per type");
    assert.match(String(warnings[0]?.[0]), /forms left out/);
    assert.equal(JSON.stringify(warnings).includes("反"), false, "never the text");
  } finally {
    console.warn = warn;
  }
});

/** What the dialog's route files for a client's header and `metadata` (routes/productFeedback.ts). */
const dialogFiles = (trustedClientKind: string | undefined, metadata: Record<string, string>) => normalizeProductFeedbackMetadata({
  trustedClientKind,
  clientKind: metadata.client_kind,
  platform: metadata.platform,
  clientVersion: metadata.client_version,
  webVersion: metadata.web_version,
  locale: metadata.locale,
  browser: metadata.browser,
  osVersion: metadata.os_version,
  viewport: metadata.viewport,
});

test("a form send files what the same client's dialog or page sends, from the request and the account", () => {
  // The App's feedback page (standalone/main.tsx: X-Raft-Client-Kind and hostMetadata).
  for (const kind of ["android", "ios"] as const) {
    assert.deepEqual(
      feedbackFormMetadata({ platform: kind, raftVersion: "1.13.0" }, "zh-cn"),
      dialogFiles(kind, { client_kind: kind, platform: kind, client_version: "1.13.0", locale: "zh-CN" }),
      kind,
    );
  }
  // The account's display language, as the tag the App's page sends.
  for (const locale of DISPLAY_LOCALES) {
    assert.equal(feedbackFormMetadata({ platform: "ios", raftVersion: "1.13.0" }, locale).locale, displayLocaleTag(locale), locale);
  }
  // The desktop app's dialog (desktopFeedbackMetadata; its os_version is not in the request).
  assert.deepEqual(feedbackFormMetadata({ platform: "desktop_app", raftVersion: "0.1.22" }, "ja"), dialogFiles(undefined, { client_version: "Raft Desktop 0.1.22" }));
  assert.deepEqual(feedbackFormMetadata({ platform: "desktop_app" }, null), dialogFiles(undefined, { client_version: "Raft Desktop" }));
  // A browser's dialog sends no metadata; HarmonyOS stays web until its App is checked.
  for (const platform of ["web", "mobile_web", "pwa", "harmonyos", "unknown"] as const) {
    assert.deepEqual(feedbackFormMetadata({ platform, raftVersion: "1.13.0" }, "zh-cn"), dialogFiles(undefined, {}), platform);
  }
});

test("the App without a version or a display language is still the App, filed without them", () => {
  const filed = (metadata: object) => JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
  assert.deepEqual(filed(feedbackFormMetadata({ platform: "android" }, null)), { clientKind: "android", platform: "android" });
  assert.deepEqual(filed(feedbackFormMetadata({ platform: "ios" }, "ko")), { clientKind: "ios", platform: "ios", locale: "ko" });
  // A stored language with no catalog is left out, never passed on.
  assert.equal(feedbackFormMetadata({ platform: "ios", raftVersion: "1.13.0" }, "fr").locale, undefined);
  // The dialog still requires the App's version in its metadata.
  assert.throws(() => dialogFiles("android", { client_kind: "android", platform: "android" }));
});
