import assert from "node:assert/strict";
import { ACTION_CARD_MESSAGES, actionCardMsg, actionCardPluralMsg, type ActionCardMessageEntry } from "./actionCardMessages";
import {
  ACTION_CARD_SPEC_CAPABILITIES, ACTION_CARD_SPEC_LIMITS, actionCardSpecIssues, checkActionCardFormValues, parseActionCardSpec, renderActionCardMsg, stripActionCardSpec, type ActionCardSpecCard,
  type ActionCardSpecEntityRef, type ActionCardSpecForm, type ActionCardSpecMsg,
} from "./actionCardSpec";
import {
  actionCardSpecNames, actionCardSpecWithoutComputerNames, buildActionCardSpec, buildAgentApproveCallForms, buildAssistantOwnerActionForms, buildFeedbackSubmitForms, buildParsedActionCardSpec, buildQuestionAskCard, buildQuestionAskForms, measureQuestionCard, mergeActionCardSpecNames,
  FEEDBACK_SUBMIT_FORM_ID, QUESTION_ASK_FORM_ID, QUESTION_ASK_INLINE_LIMITS, questionAskPlacement, withActionCardForms, type ActionCardSpecBuildContext,
} from "./actionCardSpecBuilder";
import {
  ACTION_CARD_ACTION_TYPES, buildActionCardPresentation, QUESTION_ASK_LIMITS, QUESTION_CARD_SIZE_THRESHOLD, storedQuestionAskActionSchema, type ActionCardQuestionAnswer, type ActionCardAction, type ActionCardActionType, type ActionCardResult,
  type QuestionAskAction, type SeatsAddAction, type StoredActionCardAction,
} from "./actionCards";
import { DISPLAY_LOCALES } from "./displayLocales";

const ID = {
  alice: "0b1e7c4e-1d2a-4f6b-9c3d-5e7f8a9b0c1d",
  bob: "1c2f8d5f-2e3b-4a7c-8d4e-6f8a9b0c1d2e",
  scout: "2d3a9e6a-3f4c-4b8d-9e5f-7a9b0c1d2e3f",
  general: "3e4b0f7b-4a5d-4c9e-8f6a-8b0c1d2e3f4a",
  mac: "4f5c1a8c-5b6e-4d0f-9a7b-9c1d2e3f4a5b",
  created: "5a6d2b9d-6c7f-4e1a-8b8c-0d2e3f4a5b6c",
  client: "6b7e3c0e-7d8a-4f2b-9c9d-1e3f4a5b6c7d",
  request: "7c8f4d1f-8e9b-4a3c-8d0e-2f4a5b6c7d8e",
  mcp: "8d9a5e2a-9f0c-4b4d-9e1f-3a5b6c7d8e9f",
  revision: "9e0b6f3b-0a1d-4c5e-8f2a-4b6c7d8e9f0a",
};

const names = {
  users: { [ID.alice]: "Alice", [ID.bob]: "bob" },
  agents: { [ID.scout]: "scout" },
  channels: { [ID.general]: "general" },
};

/** One realistic card per type, prepared, and the result it gets when it is done (none: never executed). */
const FIXTURES: Record<ActionCardActionType, { action: StoredActionCardAction; result: ActionCardResult | null; ctx?: ActionCardSpecBuildContext }> = {
  "channel:create": {
    action: { type: "channel:create", name: "launch-plan", visibility: "private", description: "Where we plan the October launch.", initialHumans: [ID.alice, ID.bob], initialAgents: [ID.scout], draftHint: "Alice asked for a private room for the launch." },
    result: { kind: "channel", id: ID.created, name: "launch-plan" },
  },
  "agent:create": {
    action: { type: "agent:create", name: "scribe", description: "Takes meeting notes.", suggestedComputer: ID.mac, draftHint: "You asked for a note taker." },
    result: { kind: "agent", id: ID.created, name: "scribe" },
  },
  "agent:migrate": {
    // As prepare stores it: the preparing agent's id added to what it sent.
    action: { type: "agent:migrate", agentId: ID.scout, suggestedComputer: ID.mac, draftHint: "My computer has been offline since 07:40, so I can't run tonight's eval." },
    result: { kind: "agent-migration", agentId: ID.scout, targetMachineId: ID.mac },
  },
  "channel:add_member": {
    action: { type: "channel:add_member", channel: ID.general, humans: [ID.alice], agents: [ID.scout], draftHint: "They work on the launch." },
    // The person also added bob in the dialog, so the result lists who was added.
    result: { kind: "channel-members", channelId: ID.general, channelName: "general", addedHumanIds: [ID.alice, ID.bob], addedAgentIds: [ID.scout] },
  },
  "integration:approve_agent_login": {
    action: { type: "integration:approve_agent_login", requestId: ID.request, agentId: ID.scout, agentName: "scout", clientId: ID.client, clientKey: "stamp", clientName: "Stamp", scopes: ["identity:read", "messages:read"], draftHint: "scout wants to sign in to Stamp." },
    result: { kind: "agent-integration-login", requestId: ID.request, agentId: ID.scout, agentName: "scout", clientId: ID.client, clientKey: "stamp", clientName: "Stamp", scopes: ["identity:read"], grantId: null },
  },
  "integration:install_marketplace_app": {
    action: {
      type: "integration:install_marketplace_app", clientId: ID.client, clientKey: "vault", clientName: "Vault", clientNameSha256: "a".repeat(64),
      agentId: ID.scout, agentName: "scout", scopes: ["identity:read"], installScopes: ["identity:read", "messages:read"], installGroups: ["channel"],
      setupUrl: "https://vault.example/setup", setupDescription: "Pick the vault to share.", setupRevision: 2,
      draftHint: "scout requested Vault, which is public in the Raft Marketplace but is not installed on this Server.",
    },
    result: { kind: "marketplace-app-installation", clientId: ID.client, clientKey: "vault", clientName: "Vault", serverId: ID.revision, agentId: ID.scout, agentName: "scout", scopes: ["identity:read"], setupUrl: "https://vault.example/setup" },
  },
  "integration:register_app": {
    action: { type: "integration:register_app", name: "Reminder", clientKey: "reminder", returnUrl: "https://reminder.example/callback", homepageUrl: "https://reminder.example", scopes: ["identity:read"], unsafeDemoUrlOverride: true, draftHint: "To send reminders." },
    result: { kind: "integration-app-registration", mode: "register", clientId: ID.client, clientKey: "reminder", clientName: "Reminder", returnUrl: "https://reminder.example/callback", homepageUrl: "https://reminder.example", agentManifestUrl: null, scopes: ["identity:read"] },
  },
  "integration:update_app_registration": {
    action: { type: "integration:update_app_registration", clientKey: "reminder", name: "Reminder 2", returnUrl: "https://reminder.example/cb2", scopes: ["identity:read"] },
    result: null,
  },
  "integration:recover_app_owner": {
    action: { type: "integration:recover_app_owner", clientKey: "reminder", targetAgent: ID.scout, draftHint: "The owner agent was deleted." },
    result: { kind: "integration-app-owner-recovery", clientId: ID.client, clientKey: "reminder", clientName: "Reminder", ownerAgentId: ID.scout, ownerAgentName: "scout" },
  },
  "integration:connect_mcp": {
    action: { type: "integration:connect_mcp", mcpServerId: ID.mcp, agentId: ID.scout, reason: "login_required", revision: 3 },
    result: { kind: "mcp-connection", mcpServerId: ID.mcp, agentId: ID.scout },
    ctx: { names: { ...names, mcpApp: "Notion" } },
  },
  "feedback:submit": {
    action: { type: "feedback:submit", feedbackType: "problem", message: "Search misses messages older than a week.\nSteps: search for 'launch'.", draftHint: "You hit this twice today." },
    result: { kind: "product-feedback", ticketId: "T-123", reference: "FB-9" },
  },
  "plan:upgrade": {
    action: { type: "plan:upgrade", reason: "You need the March messages for the audit.", gate: "history_30d" },
    result: null,
    ctx: { serverName: "Botiverse" },
  },
  "question:ask": {
    // As an agent sends it (no addressee yet: no For row); the form and its button are the server's (withActionCardForms).
    action: { type: "question:ask", to: "@alice", reason: "Before I deploy.", expiresInMinutes: 60, questions: [{ id: "window", kind: "single", text: "Which window?", required: true, options: [{ value: "tue", label: "Tue" }, { value: "wed", label: "Wed" }] }] },
    result: { kind: "question-answers", ref: null, answeredBy: { userId: ID.alice, handle: "alice" }, answeredAt: "2026-10-30T10:51:00.000Z", answers: { window: { kind: "choice", selected: ["tue"] } } },
  },
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isMsg = (value: unknown): value is ActionCardSpecMsg =>
  typeof value === "object" && value !== null && "key" in value && "text" in value;

/** The card with each Msg as `{ $msg: key, ...params }`: its text is the table's (checked below), so the snapshot shows the structure. */
function compact(value: unknown): Json {
  if (Array.isArray(value)) return value.map(compact);
  if (isMsg(value)) return { $msg: value.key, ...(compact(value.params ?? {}) as Record<string, Json>) };
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child)]));
  return value as Json;
}

function walk(value: unknown, visit: (node: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (typeof value === "object" && value !== null) Object.values(value).forEach((child) => walk(child, visit));
}
const msgsOf = (card: unknown) => { const out: ActionCardSpecMsg[] = []; walk(card, (node) => { if (isMsg(node)) out.push(node); }); return out; };
const buttonsOf = (card: ActionCardSpecCard) => [card.spec, card.result, ...Object.values(card.confirms ?? {}).map((confirm) => confirm.spec)]
  .flatMap((tree) => (tree ? Object.values(tree.elements) : []))
  .filter((node) => node.type === "Button");

/** A card's title as English reads it: `renderActionCardMsg` with each reference as its fallback. */
function renderedEnglish(title: ActionCardSpecCard["title"]): string {
  return typeof title === "string" ? title : renderActionCardMsg(title, "en").map((segment) => ("text" in segment ? segment.text : segment.ref.fallback)).join("");
}

function built(action: StoredActionCardAction, ctx: ActionCardSpecBuildContext = {}): ActionCardSpecCard {
  const outcome = buildParsedActionCardSpec(action, ctx);
  assert.ok(outcome.ok, `${action.type}: ${JSON.stringify(outcome.ok ? null : outcome.issues)}`);
  return outcome.card;
}

const cases = Object.entries(FIXTURES).flatMap(([type, fixture]) => [
  { name: `${type} prepared`, action: fixture.action, ctx: { names, ...fixture.ctx } },
  ...(fixture.result ? [{ name: `${type} executed`, action: fixture.action, ctx: { names, ...fixture.ctx, result: fixture.result } }] : []),
]);

test("there is a fixture for every action type", () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...ACTION_CARD_ACTION_TYPES].sort());
});

test("each type's header icon is the one the web shows for it (ActionCardSpecCard's SPEC_ICONS)", () => {
  const web: Record<ActionCardActionType, string> = {
    "channel:create": "hash", // Hash
    "agent:create": "bot", // Bot
    "agent:migrate": "bot", // Bot
    "channel:add_member": "user_plus", // UserPlus
    "integration:approve_agent_login": "key", // KeyRound
    "integration:install_marketplace_app": "package", // Package
    "integration:register_app": "app", // AppWindow
    "integration:update_app_registration": "app", // AppWindow
    "integration:recover_app_owner": "shield", // ShieldAlert
    "integration:connect_mcp": "plug", // Plug
    "feedback:submit": "message", // MessageIcon (raft-ui)
    "plan:upgrade": "credit_card", // CreditCard
    "question:ask": "message", // MessageIcon (raft-ui)
  };
  for (const [type, { action, ctx }] of Object.entries(FIXTURES)) assert.equal(built(action, ctx).icon, web[type as ActionCardActionType], type);
});

test("the feedback text shows at most 6 lines, as the web clamps it", () => {
  const feedback = built(FIXTURES["feedback:submit"].action).spec.elements.feedback;
  assert.ok(feedback?.type === "Field" && feedback.props.clamp === 6);
  // No other row is clamped (the web clamps only this one).
  for (const { action, ctx } of cases) {
    for (const [id, node] of Object.entries(built(action, ctx).spec.elements)) {
      if (node.type === "Field" && id !== "feedback") assert.equal(node.props.clamp, undefined, `${action.type} ${id}`);
    }
  }
});

describe("each type, prepared and executed", () => {
  for (const { name, action, ctx } of cases) {
    test(name, () => {
      const card = built(action, ctx);
      // The stored card is the emit parse's output, so parsing it again changes nothing.
      const again = parseActionCardSpec(card, { mode: "emit" });
      assert.ok(again.ok);
      assert.deepEqual(again.card, card);
      assert.equal("result" in card, Boolean(ctx.result));
      expect(compact(card)).toMatchSnapshot();
    });
  }
});

test("the legacy presentation fields are what they were: buildActionCardPresentation does not add a card", () => {
  for (const { action } of cases) {
    const presentation = buildActionCardPresentation(action);
    assert.equal("card" in presentation, false);
    expect(presentation).toMatchSnapshot(action.type);
  }
});

test("every Msg a builder makes is the table's copy for its key, English included", () => {
  const table = ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>;
  let count = 0;
  for (const { action, ctx } of cases) {
    for (const message of msgsOf(built(action, ctx))) {
      count++;
      assert.ok(Object.hasOwn(table, message.key), `${message.key} is not in the table`);
      const entry = table[message.key]!;
      assert.equal(typeof entry.text.en, "string");
      // A plural Msg may take another branch's template in a locale whose rules pick it.
      const base = entry.branch ? message.key.slice(0, -entry.branch.length - 1) : null;
      for (const [locale, template] of Object.entries(message.text)) {
        const allowed = base
          ? Object.entries(table).filter(([key, other]) => key.startsWith(`${base}.`) && other.branch).map(([, other]) => (other.text as Record<string, string>)[locale])
          : [(entry.text as Record<string, string>)[locale]];
        assert.ok(allowed.includes(template), `${message.key} ${locale}: ${template}`);
      }
    }
  }
  assert.ok(count > 50);
});

test("every table entry has English, and only display locales", () => {
  for (const [key, entry] of Object.entries(ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>)) {
    assert.match(key, /^actionCard(\.[A-Za-z0-9_]{1,64}){1,6}$/);
    assert.ok(entry.text.en.length > 0, key);
    for (const locale of Object.keys(entry.text)) assert.ok((DISPLAY_LOCALES as readonly string[]).includes(locale), `${key}: ${locale}`);
  }
});

test("a plural Msg takes each locale's own branch", () => {
  const one = actionCardPluralMsg("actionCard.title.addMembers", "count", 1, { target: "#general" });
  assert.equal(one.key, "actionCard.title.addMembers.one");
  assert.equal(one.text.en, "Add {count} member to {target}");
  assert.deepEqual(one.params, { target: "#general", count: 1 });
  const zero = actionCardPluralMsg("actionCard.title.addMembers", "count", 0, { target: "#general" });
  assert.equal(zero.key, "actionCard.title.addMembers.other");
  assert.equal(zero.text.en, "Add {count} members to {target}");
  // Portuguese counts 0 as one; Korean has only other.
  assert.equal(zero.text["pt-br"], ACTION_CARD_MESSAGES["actionCard.title.addMembers.one"].text["pt-br"]);
  assert.equal(zero.text.ko, ACTION_CARD_MESSAGES["actionCard.title.addMembers.other"].text.ko);
  assert.deepEqual(Object.keys(zero.text).sort(), [...DISPLAY_LOCALES].sort());
});

test("actionCardMsg copies the table, so a card never shares objects with it", () => {
  const message = actionCardMsg("actionCard.reason");
  (message.text as Record<string, string>).en = "changed";
  assert.equal(ACTION_CARD_MESSAGES["actionCard.reason"].text.en, "Reason");
});

const EVIL = "https://evil.example/x";

test("no button ever navigates to a URL, whatever URLs an agent or App put on the card", () => {
  const urls: Record<ActionCardActionType, { action: StoredActionCardAction; result: ActionCardResult | null }> = {
    ...FIXTURES,
    "channel:create": { action: { ...FIXTURES["channel:create"].action, description: EVIL, draftHint: EVIL } as ActionCardAction, result: FIXTURES["channel:create"].result },
    "integration:install_marketplace_app": {
      action: { ...FIXTURES["integration:install_marketplace_app"].action, setupUrl: EVIL, setupDescription: EVIL, clientName: EVIL, draftHint: EVIL } as ActionCardAction,
      result: { ...FIXTURES["integration:install_marketplace_app"].result!, setupUrl: EVIL, clientName: EVIL } as ActionCardResult,
    },
    "integration:register_app": {
      action: { ...FIXTURES["integration:register_app"].action, returnUrl: EVIL, homepageUrl: EVIL, agentManifestUrl: EVIL, setupUrl: EVIL, setupDescription: EVIL, name: EVIL } as ActionCardAction,
      result: { ...FIXTURES["integration:register_app"].result!, returnUrl: EVIL, homepageUrl: EVIL, agentManifestUrl: EVIL, setupUrl: EVIL, clientName: EVIL } as ActionCardResult,
    },
    "integration:update_app_registration": {
      action: { ...FIXTURES["integration:update_app_registration"].action, returnUrl: EVIL, homepageUrl: EVIL, agentManifestUrl: EVIL, setupUrl: EVIL } as ActionCardAction,
      result: { kind: "integration-app-registration", mode: "update", clientId: ID.client, clientKey: "reminder", clientName: EVIL, returnUrl: EVIL, homepageUrl: EVIL, agentManifestUrl: EVIL, setupUrl: EVIL, scopes: [] },
    },
    "integration:approve_agent_login": {
      action: { ...FIXTURES["integration:approve_agent_login"].action, clientName: EVIL } as ActionCardAction,
      result: { ...FIXTURES["integration:approve_agent_login"].result!, clientName: EVIL } as ActionCardResult,
    },
    "feedback:submit": { action: { ...FIXTURES["feedback:submit"].action, message: EVIL } as ActionCardAction, result: FIXTURES["feedback:submit"].result },
    "plan:upgrade": { action: { type: "plan:upgrade", reason: EVIL }, result: null },
    "agent:migrate": { action: { ...FIXTURES["agent:migrate"].action, suggestedComputer: EVIL, draftHint: EVIL } as StoredActionCardAction, result: FIXTURES["agent:migrate"].result },
  };
  for (const { action, result } of Object.values(urls)) {
    for (const ctx of [{ names }, { names, result }]) {
      const card = built(action, ctx);
      for (const button of buttonsOf(card)) {
        assert.equal("url" in button.props.action, false, `${action.type}: ${JSON.stringify(button.props.action)}`);
      }
      // The URL is still shown, as text.
      if (JSON.stringify(action).includes(EVIL)) assert.ok(JSON.stringify(card).includes(EVIL), action.type);
    }
  }
});

test("agent and App text never becomes a template: braces in it stay plain text", () => {
  const fuzz = "{x} {{y}} } {z";
  const actions: ActionCardAction[] = [
    { type: "channel:create", name: fuzz, visibility: "public", description: fuzz, draftHint: fuzz },
    { type: "agent:create", name: fuzz, description: fuzz, hosting: "antiproton", model: fuzz, draftHint: fuzz },
    { type: "channel:add_member", channel: fuzz, humans: [fuzz], draftHint: fuzz },
    { ...FIXTURES["integration:approve_agent_login"].action, agentName: fuzz, clientName: fuzz, clientKey: fuzz, scopes: [fuzz], draftHint: fuzz } as ActionCardAction,
    { ...FIXTURES["integration:install_marketplace_app"].action, agentName: fuzz, clientName: fuzz, setupDescription: fuzz, installScopes: [fuzz], installGroups: [fuzz], draftHint: fuzz } as ActionCardAction,
    { type: "integration:register_app", name: fuzz, clientKey: fuzz, returnUrl: fuzz, setupDescription: fuzz, scopes: [], draftHint: fuzz },
    { type: "integration:update_app_registration", clientKey: fuzz, name: fuzz, setupDescription: fuzz, draftHint: fuzz },
    { type: "integration:recover_app_owner", clientKey: fuzz, targetAgent: fuzz, draftHint: fuzz },
    { ...FIXTURES["integration:connect_mcp"].action, draftHint: fuzz } as ActionCardAction,
    { type: "feedback:submit", feedbackType: "idea", message: fuzz, draftHint: fuzz },
    { type: "plan:upgrade", reason: fuzz, gate: "joint_channel_host_limit" },
    { type: "agent:migrate", suggestedComputer: fuzz, draftHint: fuzz },
  ];
  const results: ActionCardResult[] = [
    { kind: "channel", id: fuzz, name: fuzz },
    { kind: "channel-members", channelId: ID.general, channelName: fuzz, addedHumanIds: [fuzz], addedAgentIds: [] },
    { kind: "integration-app-owner-recovery", clientId: ID.client, clientKey: fuzz, clientName: fuzz, ownerAgentId: ID.scout, ownerAgentName: fuzz },
  ];
  const tables = new Set(Object.values(ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>).flatMap((entry) => Object.values(entry.text)));
  for (const action of actions) {
    for (const ctx of [{ serverName: fuzz }, ...results.map((result) => ({ result }))]) {
      const card = built(action, ctx);
      assert.ok(JSON.stringify(card).includes(JSON.stringify(fuzz).slice(1, -1)), `${action.type}: the text is shown`);
      for (const message of msgsOf(card)) {
        for (const template of Object.values(message.text)) assert.ok(tables.has(template), `${action.type}: ${template} is not table copy`);
      }
    }
  }
});

/**
 * The largest card of each type: every list at its schema maximum (64 humans
 * and 64 agents, 64 scopes), `groups` install data groups, keys and URLs at
 * their maximum, scope and group ids of `scope` characters, names of `name`
 * and agent prose of `prose` CJK characters (3 bytes each), all 7 locales.
 */
function biggest(name: number, prose: number, scope: number, groups: number): Record<ActionCardActionType, { action: ActionCardAction; result: ActionCardResult | null; ctx: ActionCardSpecBuildContext }> {
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i.toString(16).padStart(4, "0")}-1d2a-4f6b-9c3d-5e7f8a9b0c1d`);
  const humans = many("0b1e", 64);
  const agentIds = many("2d3a", 64);
  const cjk = (n: number) => "名".repeat(n);
  const named = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, cjk(name)]));
  const ctx = { names: { users: named(humans), agents: named([...agentIds, ID.scout]), channels: named([ID.general]) }, serverName: cjk(name) };
  const url = `https://${"a".repeat(60)}.example/${"p".repeat(1900)}`;
  const scopes = Array.from({ length: 64 }, (_, i) => `s${i.toString().padStart(2, "0")}:${"r".repeat(scope - 4)}`);
  const text = (max: number) => cjk(Math.min(prose, max));
  const big = {
    "channel:create": {
      action: { type: "channel:create", name: cjk(Math.min(name, 80)), visibility: "public", description: text(500), initialHumans: humans, initialAgents: agentIds, draftHint: text(2000) },
      result: { kind: "channel", id: ID.created, name: cjk(Math.min(name, 80)) },
    },
    "agent:create": {
      action: { type: "agent:create", name: cjk(Math.min(name, 60)), description: text(500), requiredComputer: ID.mac, hosting: undefined, draftHint: text(2000) },
      result: { kind: "agent", id: ID.created, name: cjk(Math.min(name, 60)) },
    },
    "channel:add_member": {
      action: { type: "channel:add_member", channel: ID.general, humans, agents: agentIds, draftHint: text(2000) },
      result: { kind: "channel-members", channelId: ID.general, channelName: cjk(name), addedHumanIds: humans, addedAgentIds: agentIds },
    },
    "integration:approve_agent_login": {
      action: { ...FIXTURES["integration:approve_agent_login"].action, agentName: cjk(name), clientName: cjk(name), clientKey: "k".repeat(120), scopes, draftHint: text(2000) },
      result: { ...FIXTURES["integration:approve_agent_login"].result!, clientName: cjk(name), agentName: cjk(name), scopes },
    },
    "integration:install_marketplace_app": {
      action: {
        ...FIXTURES["integration:install_marketplace_app"].action, clientName: cjk(name), agentName: cjk(name), clientKey: "k".repeat(120),
        scopes, installScopes: scopes, installGroups: scopes.slice(0, groups).map((scope) => scope.replace(":", "_")),
        setupUrl: url, setupDescription: text(1000), draftHint: text(2000),
      },
      result: { ...FIXTURES["integration:install_marketplace_app"].result!, clientName: cjk(name), setupUrl: url, scopes },
    },
    "integration:register_app": {
      action: { type: "integration:register_app", name: cjk(name), clientKey: "k".repeat(120), returnUrl: url, homepageUrl: url, agentManifestUrl: url, setupUrl: url, setupDescription: text(500), scopes, unsafeDemoUrlOverride: true, draftHint: text(2000) },
      result: { kind: "integration-app-registration", mode: "register", clientId: ID.client, clientKey: "k".repeat(120), clientName: cjk(name), returnUrl: url, homepageUrl: url, agentManifestUrl: url, scopes },
    },
    "integration:update_app_registration": {
      action: { type: "integration:update_app_registration", clientKey: "k".repeat(120), name: cjk(name), description: text(1000), returnUrl: url, homepageUrl: url, agentManifestUrl: url, setupUrl: url, setupDescription: text(500), scopes, unsafeDemoUrlOverride: true, draftHint: text(2000) },
      result: { kind: "integration-app-registration", mode: "update", clientId: ID.client, clientKey: "k".repeat(120), clientName: cjk(name), returnUrl: url, homepageUrl: url, agentManifestUrl: url, scopes },
    },
    "integration:recover_app_owner": {
      action: { type: "integration:recover_app_owner", clientKey: "k".repeat(120), targetAgent: ID.scout, draftHint: text(2000) },
      result: { kind: "integration-app-owner-recovery", clientId: ID.client, clientKey: "k".repeat(120), clientName: cjk(name), ownerAgentId: ID.scout, ownerAgentName: cjk(name) },
    },
    "integration:connect_mcp": { action: { ...FIXTURES["integration:connect_mcp"].action, draftHint: text(2000) }, result: FIXTURES["integration:connect_mcp"].result },
    "feedback:submit": { action: { type: "feedback:submit", feedbackType: "idea", message: text(10_000), draftHint: text(2000) }, result: FIXTURES["feedback:submit"].result },
    "plan:upgrade": { action: { type: "plan:upgrade", reason: text(200), gate: "joint_channel_over_limit" }, result: null },
    "agent:migrate": { action: { ...FIXTURES["agent:migrate"].action, draftHint: text(2000) }, result: FIXTURES["agent:migrate"].result },
  } as Record<ActionCardActionType, { action: ActionCardAction; result: ActionCardResult | null }>;
  return Object.fromEntries(Object.entries(big).map(([type, fixture]) => [type, { ...fixture, ctx }])) as ReturnType<typeof biggest>;
}
const cardBytes = (card: ActionCardSpecCard) => new TextEncoder().encode(JSON.stringify(card)).length;

test("the biggest realistic card of each type, prepared and executed, is under 24 KiB with every locale", () => {
  // Realistic: names of 24 characters, a paragraph (500 characters) where an agent
  // writes prose, scope ids as long as Raft's longest (agent:action_request:write),
  // as many data groups as a ScopeList carries (Raft has 5).
  for (const { action, result, ctx } of Object.values(biggest(24, 500, 26, 32))) {
    for (const card of [built(action, ctx), built(action, { ...ctx, result })]) {
      assert.ok(cardBytes(card) < ACTION_CARD_SPEC_LIMITS.maxBytes, `${action.type}: ${cardBytes(card)} bytes`);
    }
  }
});

test("a card at every schema maximum is either under 24 KiB or not sent, never an error", () => {
  for (const { action, result, ctx } of Object.values(biggest(120, 10_000, 120, 64))) {
    for (const withResult of [ctx, { ...ctx, result }]) {
      const outcome = buildParsedActionCardSpec(action, withResult);
      if (outcome.ok) assert.ok(cardBytes(outcome.card) <= ACTION_CARD_SPEC_LIMITS.maxBytes, action.type);
      else assert.deepEqual(outcome.issues.map((issue) => issue.message.replace(/\d+/g, "N")), ["The card is N bytes, over N"], action.type);
    }
  }
});

test("names: a card keeps the names its references show, and the server's names win", () => {
  const card = built(FIXTURES["channel:create"].action, { names });
  const found = actionCardSpecNames(card);
  assert.equal(found.users?.[ID.alice], "Alice");
  assert.equal(found.agents?.[ID.scout], "scout");
  // A reference without a name (its short id) is not a name.
  const unnamed = actionCardSpecNames(built(FIXTURES["channel:create"].action));
  assert.deepEqual(unnamed, {});
  assert.deepEqual(mergeActionCardSpecNames({ users: { a: "kept" } }, { users: { a: "dropped", b: "added" } }), { users: { a: "kept", b: "added" } });
});

test("without a name the server knows, a reference falls back to the id's first 8 characters", () => {
  const card = built(FIXTURES["channel:create"].action);
  const humans = card.spec.elements.humans;
  assert.equal(humans?.type, "Field");
  assert.deepEqual(humans.type === "Field" ? humans.props.value : null, [
    { kind: "user", id: ID.alice, fallback: ID.alice.slice(0, 8) },
    { kind: "user", id: ID.bob, fallback: ID.bob.slice(0, 8) },
  ]);
});

test("an uppercase UUID on the action is a lowercase reference", () => {
  const card = built({ type: "channel:add_member", channel: ID.general.toUpperCase(), humans: [ID.alice.toUpperCase()] }, { names });
  assert.ok(JSON.stringify(card).includes(ID.alice));
  assert.equal(JSON.stringify(card).includes(ID.alice.toUpperCase()), false);
});

test("a builder that throws is a refusal, not an exception", () => {
  const outcome = buildParsedActionCardSpec(FIXTURES["feedback:submit"].action, {}, () => { throw new Error("boom"); });
  assert.equal(outcome.ok, false);
  const invalid = buildParsedActionCardSpec(FIXTURES["feedback:submit"].action, {}, (action, ctx) => ({ ...buildActionCardSpec(action, ctx), icon: "nope" as never }));
  assert.equal(invalid.ok, false);
  assert.ok(!invalid.ok && invalid.issues.length > 0);
});

test("a done member card lists who was really added; its result only says, in every locale, when the dialog changed the agent's list", () => {
  const { action } = FIXTURES["channel:add_member"];
  const listed = (card: ActionCardSpecCard, id: string) => {
    const node = card.spec.elements[id];
    return node?.type === "Field" && Array.isArray(node.props.value) ? node.props.value.map((ref) => ref.id) : null;
  };
  // As asked: the list as asked, no result to add (the title and the list say who and how many).
  const asPrepared = built(action, { names, result: { kind: "channel-members", channelId: ID.general, channelName: "general", addedHumanIds: [ID.alice], addedAgentIds: [ID.scout] } });
  assert.deepEqual(listed(asPrepared, "humans"), [ID.alice]);
  assert.equal(asPrepared.result, undefined);
  // Changed (bob added too): the body's one list is who was added, never a second Humans or Agents row, and a muted line says so.
  const changed = built(action, { names, result: FIXTURES["channel:add_member"].result! });
  assert.deepEqual(listed(changed, "humans"), [ID.alice, ID.bob]);
  assert.deepEqual(listed(changed, "agents"), [ID.scout]);
  assert.deepEqual(Object.values(changed.result?.elements ?? {}).filter((node) => node.type === "Field"), []);
  const note = changed.result?.elements.changed;
  assert.ok(note?.type === "Text" && note.props.tone === "muted" && typeof note.props.text === "object");
  assert.equal(note.props.text.key, "actionCard.result.changedBeforeAdding");
  assert.equal(note.props.text.text.en, "Changed before adding");
  assert.deepEqual(Object.keys(note.props.text.text).sort(), [...DISPLAY_LOCALES].sort());
  // Someone removed in the dialog is not listed (no row at all when none of a kind was added).
  const fewer = built(action, { names, result: { kind: "channel-members", channelId: ID.general, channelName: "general", addedHumanIds: [ID.alice], addedAgentIds: [], changed: true } });
  assert.equal(listed(fewer, "agents"), null);
  assert.ok(fewer.result?.elements.changed);
});

test("a done member card says it was changed before adding when the server recorded so, and on an older card only when someone unasked was added", () => {
  const { action } = FIXTURES["channel:add_member"];
  const note = (result: Partial<Extract<ActionCardResult, { kind: "channel-members" }>>) => {
    const card = built(action, { names, result: { kind: "channel-members", channelId: ID.general, channelName: "general", addedHumanIds: [ID.alice], addedAgentIds: [ID.scout], ...result } });
    const node = card.result?.elements.changed;
    return node?.type === "Text" && typeof node.props.text === "object" ? node.props.text.key : null;
  };
  // Recorded true: the person removed or added someone, whatever the lists look like.
  assert.equal(note({ addedAgentIds: [], changed: true }), "actionCard.result.changedBeforeAdding");
  assert.equal(note({ changed: true }), "actionCard.result.changedBeforeAdding");
  // Recorded false: alice was a member already, so the dialog left her out and only scout was added. Not a change.
  assert.equal(note({ addedHumanIds: [], changed: false }), null);
  // The record wins over the lists either way.
  assert.equal(note({ addedHumanIds: [ID.alice, ID.bob], changed: false }), null);
  // Not recorded (a card executed before it was): only someone added who wasn't asked for says so ...
  assert.equal(note({ addedHumanIds: [ID.alice, ID.bob] }), "actionCard.result.changedBeforeAdding");
  assert.equal(note({ addedAgentIds: [ID.scout, ID.request] }), "actionCard.result.changedBeforeAdding");
  // ... never someone asked for and missing, who may have been a member already.
  assert.equal(note({ addedHumanIds: [] }), null);
  assert.equal(note({ addedHumanIds: [], addedAgentIds: [] }), null);
  assert.equal(note({}), null);
  // Ids compare without case.
  assert.equal(note({ addedHumanIds: [ID.alice.toUpperCase()] }), null);
});

test("a done connect card says whom access was granted to, as a reference, and nothing of the Connection", () => {
  const { action, result } = FIXTURES["integration:connect_mcp"];
  for (const ctx of [{ names, result }, { result }]) {
    const card = built(action, ctx);
    // The first item of the result: the folded done card's line.
    assert.deepEqual(compact(card.result), {
      root: "root",
      elements: {
        root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["summary"] },
        summary: {
          type: "Text",
          props: {
            text: { $msg: "actionCard.result.mcpConnectionGranted", agent: { kind: "agent", id: ID.scout, fallback: ctx.names ? "scout" : ID.scout.slice(0, 8) } },
            tone: "default",
            mono: false,
          },
        },
      },
    });
    // The result names no Connection (it has none to name); nor does the card name the App's id.
    assert.equal(JSON.stringify(card).includes(ID.mcp), false);
  }
  // In every display locale, with the Agent as its one param (a client shows it as a mention, so no @).
  const copy = ACTION_CARD_MESSAGES["actionCard.result.mcpConnectionGranted"].text as Record<string, string | undefined>;
  for (const locale of DISPLAY_LOCALES) {
    const template = copy[locale];
    assert.ok(template, locale);
    assert.deepEqual(template.match(/\{[^}]+\}/gu), ["{agent}"], locale);
    assert.equal(template.includes("@"), false, locale);
  }
});

test("a connect card's title names the App and the Agent, a name and a reference, in every display locale", () => {
  const { action, result } = FIXTURES["integration:connect_mcp"];
  const card = built(action, { names: { mcpApp: "Notion", agents: { [ID.scout]: "Kai" } } });
  assert.deepEqual(compact(card.title), { $msg: "actionCard.title.connectMcp", app: "Notion", agent: { kind: "agent", id: ID.scout, fallback: "Kai" } });
  assert.equal(renderedEnglish(card.title), "Authorize Notion for Kai");
  // Translated everywhere (the table's own copy, no web id), with both params and no @: a client shows the reference by name.
  const entry: ActionCardMessageEntry = ACTION_CARD_MESSAGES["actionCard.title.connectMcp"];
  assert.equal(entry.source, null);
  for (const locale of DISPLAY_LOCALES) {
    const template = entry.text[locale];
    assert.ok(template, locale);
    assert.deepEqual(template.match(/\{[^}]+\}/gu)?.sort(), ["{agent}", "{app}"], locale);
    assert.equal(template.includes("@"), false, locale);
  }
  // Done, the title stays and the line says whom access went to, by the same name.
  const done = built(action, { names: { mcpApp: "Notion", agents: { [ID.scout]: "Kai" } }, result });
  assert.equal(renderedEnglish(done.title), "Authorize Notion for Kai");
  assert.equal(JSON.stringify(compact(done.result)).includes(`"fallback":"Kai"`), true);
});

test("a connect card built without the App's name (one stored before cards named it) keeps the fixed title", () => {
  const { action, result } = FIXTURES["integration:connect_mcp"];
  for (const ctx of [{}, { names }, { names: { ...names, mcpApp: "   " } }, { names, result }]) {
    assert.deepEqual(compact(built(action, ctx).title), { $msg: "actionCard.verb.connectMcp" });
  }
});

test("an App's name is data on a connect card's title: cut to a param's limit, never read as a template", () => {
  const { action } = FIXTURES["integration:connect_mcp"];
  const card = built(action, { names: { mcpApp: `{agent} ${"n".repeat(600)}` } });
  const app = (card.title as ActionCardSpecMsg).params?.app;
  assert.ok(typeof app === "string" && Array.from(app).length === 500 && app.startsWith("{agent} ") && app.endsWith("…"));
});

test("a connect card rebuilt from its stored card keeps the App and the Agent it names, and a stored one without them stays without", () => {
  const { action, result } = FIXTURES["integration:connect_mcp"];
  const stored = built(action, { names: { mcpApp: "Notion", agents: { [ID.scout]: "Kai" } } });
  const found = actionCardSpecNames(stored);
  assert.deepEqual(found, { mcpApp: "Notion", agents: { [ID.scout]: "Kai" } });
  assert.equal(renderedEnglish(built(action, { names: found, result }).title), "Authorize Notion for Kai");
  // Only this title's `app`: another card's params are not an App.
  assert.equal(actionCardSpecNames(built(FIXTURES["channel:create"].action)).mcpApp, undefined);
  assert.equal(actionCardSpecNames({ title: { key: "actionCard.title.createAgent", params: { app: "Notion" } } }).mcpApp, undefined);
  assert.deepEqual(compact(built(action, { names: actionCardSpecNames(built(action)), result }).title), { $msg: "actionCard.verb.connectMcp" });
});

test("a connect card carries no notice in any state (the DS keeps one for standing facts), and needs no body without a reason", () => {
  const { action, result } = FIXTURES["integration:connect_mcp"];
  for (const ctx of [{}, { result }]) {
    const card = built(action, ctx);
    assert.deepEqual(Object.values(card.spec.elements).filter((node) => node.type === "Notice"), []);
    assert.deepEqual(card.spec.elements[card.spec.root], { type: "Stack", props: { direction: "column", wrap: false }, children: [] });
  }
  // A reason is all its body has.
  const reasoned = built({ ...action, draftHint: "I need Notion for the launch plan." } as StoredActionCardAction);
  assert.deepEqual(Object.keys(reasoned.spec.elements).sort(), ["reason", "reasonLabel", "reasonText", "root"]);
});

test("an agent:create card's title names the agent to be without an @, in every display locale", () => {
  const { action } = FIXTURES["agent:create"];
  assert.equal(renderedEnglish(built(action).title), "Create agent scribe");
  // An agent that wrote the handle's @ gets the same title (the dialog's field refuses one).
  assert.equal(renderedEnglish(built({ ...action, name: "@scribe" } as StoredActionCardAction).title), "Create agent scribe");
  const copy = ACTION_CARD_MESSAGES["actionCard.title.createAgent"].text as Record<string, string | undefined>;
  for (const locale of DISPLAY_LOCALES) {
    assert.ok(copy[locale]?.includes("{name}"), locale);
    assert.equal(copy[locale]?.includes("@"), false, locale);
  }
});

test("no card copy writes an @ before a name, in any display locale: the @ is for mentions", () => {
  for (const [key, entry] of Object.entries(ACTION_CARD_MESSAGES) as [string, ActionCardMessageEntry][]) {
    for (const [locale, template] of Object.entries(entry.text)) assert.equal(template?.includes("@{"), false, `${key} ${locale}: ${template}`);
  }
});

test("login and install cards name the agent by reference, the stored name as its fallback: no @, and not as machine text", () => {
  const agentField = (card: ActionCardSpecCard) => {
    const field = card.spec.elements.agent;
    assert.ok(field?.type === "Field");
    return field.props;
  };
  const summary = (card: ActionCardSpecCard) => {
    const line = card.result?.elements.summary;
    assert.ok(line?.type === "Text" && typeof line.props.text !== "string");
    return line.props.text;
  };
  const kai = { kind: "agent", id: ID.scout, fallback: "Kai" };
  const login = FIXTURES["integration:approve_agent_login"];
  const loginCard = built({ ...login.action, agentName: "Kai" } as StoredActionCardAction);
  assert.deepEqual(compact(loginCard.title), { $msg: "actionCard.title.approveLogin", client: "Stamp", agent: kai });
  assert.equal(renderedEnglish(loginCard.title), "Approve Stamp for Kai");
  assert.deepEqual(agentField(loginCard).value, [kai]);
  assert.equal(agentField(loginCard).mono, undefined);
  // Done, the line names the agent the same way, by the name the result holds.
  const loginDone = built(login.action, { result: { ...login.result, agentName: "Kai" } as ActionCardResult });
  assert.deepEqual(compact(summary(loginDone)), { $msg: "actionCard.result.integrationLogin", client: "Stamp", agent: kai });
  assert.equal(renderedEnglish(summary(loginDone)), "Stamp approved for Kai");

  const { action, result } = FIXTURES["integration:install_marketplace_app"];
  const installCard = built({ ...action, agentName: "Kai" } as StoredActionCardAction);
  assert.deepEqual(compact(installCard.title), { $msg: "actionCard.title.installApp", client: "Vault", agent: kai });
  assert.equal(renderedEnglish(installCard.title), "Install Vault for Kai");
  assert.deepEqual(agentField(installCard).value, [kai]);
  assert.equal(agentField(installCard).mono, undefined);
  // Its done line names no agent: nothing there to go stale.
  assert.deepEqual(compact(summary(built(action, { result }))), { $msg: "actionCard.result.marketplaceInstalled", client: "Vault" });
});

test("login and install cards keep the stored name as the fallback, whatever other names the build is given", () => {
  const cards = [FIXTURES["integration:approve_agent_login"], FIXTURES["integration:install_marketplace_app"]];
  for (const { action, result } of cards) {
    const stored = { ...action, agentName: "Kai" } as StoredActionCardAction;
    const agentOf = (card: ActionCardSpecCard) => (card.title as ActionCardSpecMsg).params?.agent;
    // A rebuild's names (and the result's, stored at execute) don't replace it, so the card's fallback is what was stored.
    const rebuilt = built(stored, { names: { agents: { [ID.scout]: "Renamed" } }, result: { ...result, agentName: "Renamed" } as ActionCardResult });
    assert.deepEqual(agentOf(rebuilt), { kind: "agent", id: ID.scout, fallback: "Kai" });
    assert.deepEqual(agentOf(built(stored, { names: actionCardSpecNames(rebuilt) })), { kind: "agent", id: ID.scout, fallback: "Kai" });
    // An id as stored in capitals is still the entity's canonical id.
    assert.deepEqual(agentOf(built({ ...stored, agentId: ID.scout.toUpperCase() } as StoredActionCardAction)), { kind: "agent", id: ID.scout, fallback: "Kai" });
  }
});

test("login and install cards stored with an id that is no UUID name the agent as text, in the title, the row and the line", () => {
  const login = FIXTURES["integration:approve_agent_login"];
  const install = FIXTURES["integration:install_marketplace_app"];
  for (const { action, title } of [
    { action: login.action, title: "Approve Stamp for Kai" },
    { action: install.action, title: "Install Vault for Kai" },
  ]) {
    const card = built({ ...action, agentId: "not-a-uuid", agentName: "Kai" } as StoredActionCardAction);
    assert.equal(renderedEnglish(card.title), title);
    assert.equal((card.title as ActionCardSpecMsg).params?.agent, "Kai");
    const row = card.spec.elements.agent;
    assert.ok(row?.type === "Field");
    assert.equal(row.props.value, "Kai");
  }
  const done = built(login.action, { result: { ...login.result, agentId: "not-a-uuid", agentName: "Kai" } as ActionCardResult }).result?.elements.summary;
  assert.ok(done?.type === "Text" && typeof done.props.text !== "string");
  assert.equal(done.props.text.params?.agent, "Kai");
});

test("a recover card's title names the target by reference, so a handle the agent wrote never shows as its name", () => {
  const { action, result } = FIXTURES["integration:recover_app_owner"];
  const card = built(action, { names: { agents: { [ID.scout]: "Kai" } } });
  assert.deepEqual(compact(card.title), { $msg: "actionCard.title.recoverOwner", clientKey: "reminder", agent: { kind: "agent", id: ID.scout, fallback: "Kai" } });
  assert.equal(renderedEnglish(card.title), "Recover reminder for Kai");
  // Built on read, with no names: still a reference, which a client names.
  assert.deepEqual(compact(built(action).title), { $msg: "actionCard.title.recoverOwner", clientKey: "reminder", agent: { kind: "agent", id: ID.scout, fallback: ID.scout.slice(0, 8) } });
  // Not a UUID: nothing to look up, so the name if the card has one (as its row).
  const unresolved = { ...action, targetAgent: "kai-handle-id" } as StoredActionCardAction;
  assert.equal(renderedEnglish(built(unresolved, { names: { agents: { "kai-handle-id": "Kai" } } }).title), "Recover reminder for Kai");
  // Done, the result's line has the same name without an @.
  const done = built(action, { names: { agents: { [ID.scout]: "Kai" } }, result: { ...result, ownerAgentName: "Kai" } as ActionCardResult });
  const line = done.result?.elements.summary;
  assert.ok(line?.type === "Text" && typeof line.props.text !== "string");
  assert.equal(renderedEnglish(line.props.text).endsWith("recovered to Kai"), true);
});

test("an agent:create card done with an id that is no UUID names the agent as text, without an @", () => {
  const { action } = FIXTURES["agent:create"];
  const field = built(action, { result: { kind: "agent", id: "not-a-uuid", name: "scribe" } }).result?.elements.agent;
  assert.ok(field?.type === "Field");
  assert.equal(field.props.value, "scribe");
});

test("the create cards (channel, members, agent), prepared and executed, carry Raft's copy in every display locale", () => {
  const variants: [StoredActionCardAction, ActionCardResult][] = (["channel:create", "channel:add_member", "agent:create"] as const)
    .map((type) => [FIXTURES[type].action as StoredActionCardAction, FIXTURES[type].result!]);
  // agent:create's other rows: a required Computer, hosting with and without a model.
  const hosted = { type: "agent:create", name: "scribe", requiredComputer: ID.mac, hosting: "antiproton", model: "opus" } as const;
  variants.push([hosted, FIXTURES["agent:create"].result!], [{ ...hosted, model: undefined }, FIXTURES["agent:create"].result!]);
  const keys = new Set<string>();
  for (const [action, result] of variants) {
    for (const card of [built(action, { names }), built(action, { names, result })]) {
      for (const message of msgsOf(card)) {
        keys.add(message.key);
        assert.deepEqual(Object.keys(message.text).sort(), [...DISPLAY_LOCALES].sort(), `${message.key}: every display locale`);
      }
    }
  }
  // The result buttons among them, which a reader presses to reach what the card made.
  assert.ok(keys.has("actionCard.result.openAgent") && keys.has("actionCard.channel.edit.returnToChannel"), [...keys].join(", "));
  // Open, not "return to the original channel": the channel is the one the card just made.
  assert.equal(ACTION_CARD_MESSAGES["actionCard.channel.edit.returnToChannel"].text["zh-cn"], "打开频道");
});

test("every button label and confirm verb on a built card is sentence case in English (the web's clickable-label rule)", () => {
  // A later word keeps its capital only for a product, plan or registered view name, or an acronym (web clickableLabelTitleCase).
  const NAMES = new Set(["Raft", "Pro", "Settings"]);
  const labels = new Map<string, string>();
  for (const { action, ctx } of cases) {
    const card = built(action, ctx);
    for (const button of buttonsOf(card)) labels.set(button.props.label.key, button.props.label.text.en);
    for (const confirm of Object.values(card.confirms ?? {})) labels.set(confirm.confirmLabel.key, confirm.confirmLabel.text.en);
  }
  // The create cards' result buttons are among them.
  assert.ok(labels.has("actionCard.result.openAgent") && labels.has("actionCard.channel.edit.returnToChannel"), [...labels.keys()].join(", "));
  // Known, card-only and out of this change's scope: the question card's button and sheet title (a follow-up).
  const KNOWN_TITLE_CASE = new Set(["actionCard.question.answer.one", "actionCard.question.answer.other"]);
  for (const [key, text] of labels) {
    if (KNOWN_TITLE_CASE.has(key)) continue;
    const later = text.split(/\s+/).slice(1).filter((word) => /^\p{Lu}/u.test(word) && !NAMES.has(word) && word !== word.toUpperCase());
    assert.deepEqual(later, [], `${key}: "${text}" is sentence case`);
  }
});

test("an install card prepared before the server bound its permissions cannot be installed: its button says why", () => {
  const { installScopes: _scopes, installGroups: _groups, ...unbound } = FIXTURES["integration:install_marketplace_app"].action as Extract<ActionCardAction, { type: "integration:install_marketplace_app" }>;
  const card = built(unbound, { names });
  const install = card.spec.elements.installApp;
  assert.ok(install?.type === "Button" && install.props.disabledReason?.key === "actionCard.installDialog.unbound");
});

test("the install card carries no confirm: the client's own install dialog shows the App from the server, never this card's fields (Q1)", () => {
  // A plain execute for that dialog to run; a confirm tree here would be built from the card's fields.
  const card = built(FIXTURES["integration:install_marketplace_app"].action, { names });
  const install = card.spec.elements.installApp;
  assert.ok(install?.type === "Button");
  assert.deepEqual(install.props.action, { kind: "execute" });
  assert.equal(card.confirms, undefined);
  assert.equal("confirms" in card, false);
});

test("the feedback form (F1) is the dialog's: Idea / Problem and the message, prefilled with the draft as plain text", () => {
  const action = { ...FIXTURES["feedback:submit"].action, message: "{x} }} draft" } as Extract<ActionCardAction, { type: "feedback:submit" }>;
  const forms = buildFeedbackSubmitForms(action);
  assert.deepEqual(compact(forms), {
    [FEEDBACK_SUBMIT_FORM_ID]: {
      title: { $msg: "actionCard.feedback.dialogTitle" },
      submitLabel: { $msg: "actionCard.feedback.submit" },
      description: { $msg: "actionCard.feedback.form.description" },
      fields: [
        {
          type: "Select", name: "type", label: { $msg: "actionCard.field.feedbackType" }, required: true,
          options: [{ value: "idea", label: { $msg: "actionCard.feedbackType.idea" } }, { value: "problem", label: { $msg: "actionCard.feedbackType.problem" } }],
          default: "problem",
        },
        { type: "TextArea", name: "message", label: { $msg: "actionCard.field.feedback" }, required: true, maxLength: 8000, rows: 6, default: "{x} }} draft" },
      ],
    },
  });
  for (const message of msgsOf(forms)) {
    assert.deepEqual(message.text, (ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>)[message.key]?.text, message.key);
    assert.deepEqual(Object.keys(message.text).sort(), [...DISPLAY_LOCALES].sort(), `${message.key}: every display locale`);
  }
  // A valid form for the catalog (the server wires its button: services/feedbackCardForm.ts).
  assert.ok(parseActionCardSpec({ ...built(action), forms }, { mode: "emit" }).ok);
  const form = forms[FEEDBACK_SUBMIT_FORM_ID]!;
  assert.deepEqual(checkActionCardFormValues(form, { type: "idea", message: "Pinned threads vanish." }, { mode: "server" }), []);
  assert.deepEqual(checkActionCardFormValues(form, { type: "bug", message: " " }, { mode: "server" }).map((issue) => [issue.field, issue.code]),
    [["type", "invalid_option"], ["message", "required"]]);
});

test("a done feedback card (S0.3): where it went, and the sender's View in Settings, which opens the ticket from the result, never with its id", () => {
  const { action } = FIXTURES["feedback:submit"];
  for (const result of [
    { kind: "product-feedback", ticketId: ID.created, reference: "FB-9", source: "android" },
    { kind: "product-feedback", ticketId: null, reference: null, source: "web" },
    { kind: "product-feedback", ticketId: "T-123", reference: "FB-9" },
  ] as ActionCardResult[]) {
    const card = built(action, { result });
    assert.deepEqual(compact(card.result), {
      root: "root",
      elements: {
        root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["summary", "actions"] },
        actions: { type: "Stack", props: { direction: "row", wrap: true, role: "actions" }, children: ["openTicket"] },
        summary: { type: "Text", props: { text: { $msg: "actionCard.result.feedbackSentToRaft" }, tone: "default", mono: false } },
        openTicket: { type: "Button", props: { label: { $msg: "actionCard.result.feedbackSubmitted" }, emphasis: "secondary", action: { kind: "open", intent: "feedback_ticket" } } },
      },
    }, JSON.stringify(result));
    // The card carries nothing of the result: a client reads metadata.result.
    for (const value of [ID.created, "FB-9", "T-123", "android"]) assert.equal(JSON.stringify(card).includes(value), false, value);
  }
  // The label fits a Button (24 code points) and the summary a Text Msg (500), in every display locale.
  const label = ACTION_CARD_MESSAGES["actionCard.result.feedbackSubmitted"].text;
  const summary = ACTION_CARD_MESSAGES["actionCard.result.feedbackSentToRaft"].text;
  for (const locale of DISPLAY_LOCALES) {
    const own = (label as Record<string, string | undefined>)[locale];
    assert.ok(own && [...own].length <= 24, `${locale}: ${own}`);
    assert.ok((summary as Record<string, string | undefined>)[locale], `${locale}: summary`);
  }
  // The short line is the first sentence of the line cards done before S0.3 keep.
  const before = ACTION_CARD_MESSAGES["actionCard.result.feedbackSent"].text;
  assert.equal(summary.en, "Sent to the Raft team.");
  assert.equal(summary["zh-cn"], "已发给 Raft 团队。");
  for (const locale of DISPLAY_LOCALES) {
    const short = (summary as Record<string, string>)[locale]!;
    assert.ok((before as Record<string, string>)[locale]!.startsWith(short.slice(0, -1)), `${locale}: ${short}`);
  }
});

test("a person's seat request (seats:add): what it is for and why, and Add Seats opening the owner's flow; an ended one keeps neither", () => {
  const seats = (purpose: SeatsAddAction["purpose"], reason?: string): SeatsAddAction => ({
    type: "seats:add", seats: 2, purpose, ...(reason ? { reason } : {}), expiresAt: "2026-11-03T00:00:00.000Z",
  });
  const ctx = { serverName: "Lumen", requesterUserId: ID.alice, names };
  const invite = built(seats({ kind: "invite", emails: ["grace@lumen.test", "alan@lumen.test"] }, "They start Monday."), ctx);
  assert.equal(invite.icon, "credit_card", "Plan & Billing's icon");
  assert.deepEqual(compact(invite.title), { $msg: "actionCard.title.addSeats.other", count: 2 });
  assert.deepEqual(compact(invite.spec), {
    root: "root",
    elements: {
      root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["notice", "properties", "reason", "actions"] },
      notice: { type: "Notice", props: { text: { $msg: "actionCard.seats.notice.invite", server: "Lumen" }, tone: "info" } },
      properties: { type: "Stack", props: { direction: "column", wrap: false }, children: ["for"] },
      for: { type: "Field", props: { label: { $msg: "actionCard.field.for" }, value: { $msg: "actionCard.seats.purpose.invite", emails: "grace@lumen.test, alan@lumen.test" } } },
      reason: { type: "Stack", props: { direction: "column", wrap: false, role: "reason" }, children: ["reasonLabel", "reasonText"] },
      reasonLabel: { type: "Text", props: { text: { $msg: "actionCard.reason" }, tone: "muted", mono: false } },
      reasonText: { type: "Text", props: { text: "They start Monday.", tone: "default", mono: false } },
      actions: { type: "Stack", props: { direction: "row", wrap: true, role: "actions" }, children: ["addSeats"] },
      addSeats: { type: "Button", props: { label: { $msg: "actionCard.verb.addSeats" }, emphasis: "primary", action: { kind: "open", intent: "add_seats" } } },
    },
  });
  // An agent or assistant waits on the requester, named by reference; a promotion names the role in its own copy.
  const agent = built(seats({ kind: "agent:create", name: "nova" }), ctx);
  assert.deepEqual(compact(agent.spec.elements.notice), {
    type: "Notice", props: { text: { $msg: "actionCard.seats.notice.requester", server: "Lumen", requester: { kind: "user", id: ID.alice, fallback: "Alice" } }, tone: "info" },
  });
  const promote = built(seats({ kind: "member:promote", userId: ID.bob, name: "bob", role: "admin" }), ctx);
  assert.deepEqual(msgsOf(promote.spec).map((message) => message.key), [
    "actionCard.seats.notice.promoteAdmin", "actionCard.field.for", "actionCard.seats.purpose.promoteAdmin", "actionCard.verb.addSeats",
  ]);
  // Someone a full link turned away: named, and they open the link again (task #10 E8).
  const join = built(seats({ kind: "join", userId: ID.bob, name: "Grace" }), ctx);
  assert.deepEqual(compact(join.spec.elements.notice), {
    type: "Notice", props: { text: { $msg: "actionCard.seats.notice.join", server: "Lumen", name: "Grace" }, tone: "info" },
  });
  assert.deepEqual(compact(join.spec.elements.for), {
    type: "Field", props: { label: { $msg: "actionCard.field.for" }, value: { $msg: "actionCard.seats.purpose.join", name: "Grace" } },
  });
  // Ended (purpose and reason cleared): the title and the button only; the frame shows the state.
  const ended = built(seats(null), ctx);
  assert.deepEqual(ended.spec.elements.root, { type: "Stack", props: { direction: "column", wrap: false }, children: ["actions"] });
  // Every Msg is the table's copy, in English and Simplified Chinese.
  for (const card of [invite, agent, promote, join, ended]) {
    for (const message of msgsOf(card)) {
      const entry = (ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>)[message.key];
      assert.ok(entry, message.key);
      assert.ok(message.text.en && message.text["zh-cn"], `${message.key}: en and zh-cn`);
    }
  }
  // Twenty long addresses still make a card that is sent (the row's text is cut at 500).
  const many = built(seats({ kind: "invite", emails: Array.from({ length: 20 }, (_, i) => `${"x".repeat(300)}${i}@lumen.test`) }, "r".repeat(500)), ctx);
  assert.ok(cardBytes(many) < ACTION_CARD_SPEC_LIMITS.maxBytes);
});

test("every reason group is a `reason` Stack and every button row an `actions` Stack (schemaVersion 6), whatever its id", () => {
  for (const { action, ctx } of cases) {
    const card = built(action, ctx);
    for (const tree of [card.spec, card.result].filter((t) => t !== undefined)) {
      for (const [id, node] of Object.entries(tree.elements)) {
        if (node.type === "Button") {
          const row = Object.values(tree.elements).find((parent) => parent.type === "Stack" && parent.children?.includes(id));
          assert.ok(row?.type === "Stack" && row.props.role === "actions" && row.props.direction === "row", `${action.type}: ${id} in an actions row`);
        }
        if (node.type === "Stack" && node.children?.some((child) => child === "reasonText")) {
          assert.equal(node.props.role, "reason", `${action.type}: ${id}`);
          assert.equal(node.props.direction, "column", `${action.type}: ${id}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The question card (question:ask, question-card spec §2.4, §5).

const RAW_KEY = "actionCard.text.raw";
const question = (input: Record<string, unknown>): QuestionAskAction => storedQuestionAskActionSchema.parse({ type: "question:ask", ...input });
const QUESTION = question({
  to: "@alice",
  reason: "I'm preparing this week's deploy and need your call before I start.",
  ref: "deploy-window-1030",
  questions: [
    { id: "window", kind: "single", text: "Which window should we deploy in?", description: "All times are UTC.",
      options: [{ value: "tue_am", label: "Tue 10:00" }, { value: "wed_pm", label: "Wed 15:00" }, { value: "thu_am", label: "Thu 10:00" }] },
    { id: "envs", kind: "multiple", text: "Which environments first?", minItems: 1, maxItems: 2, other: { placeholder: "Name the environment", maxLength: 200 },
      options: [{ value: "staging", label: "staging" }, { value: "canary", label: "canary (5%)" }, { value: "prod", label: "all of prod" }] },
    { id: "notes", kind: "text", text: "Anything else I should watch for?", required: false },
  ],
  addressee: { kind: "user", userId: ID.alice, handle: "alice" },
  expiresAt: "2026-11-09T10:00:00.000Z",
});
const questionCtx: ActionCardSpecBuildContext = { names, requesterAgentId: ID.scout };
/** The card as the server sends it: its forms, and the button opening the first (withActionCardForms). */
function questionCard(action: QuestionAskAction, ctx: ActionCardSpecBuildContext = questionCtx): ActionCardSpecCard {
  const outcome = buildParsedActionCardSpec(action, ctx, (built, builtCtx) => buildQuestionAskCard(built as QuestionAskAction, builtCtx));
  assert.ok(outcome.ok, JSON.stringify(outcome.ok ? null : { issues: outcome.issues, error: String(outcome.error) }));
  return outcome.card;
}
const answersOf = (card: ActionCardSpecCard): ActionCardSpecForm => card.forms![QUESTION_ASK_FORM_ID]!;
const ANSWERED: ActionCardResult = {
  kind: "question-answers",
  ref: "deploy-window-1030",
  answeredBy: { userId: ID.alice, handle: "alice" },
  answeredAt: "2026-10-30T10:51:00Z",
  answers: { window: { kind: "choice", selected: ["tue_am"] }, envs: { kind: "choice", selected: ["staging", "canary"], other: "preview-eu" }, notes: { kind: "skipped" } },
};

test("a question card: For, each question, the agent's reason and Answer Questions; Raft's copy in every locale", () => {
  const card = questionCard(QUESTION);
  assert.equal(card.icon, "message");
  assert.deepEqual(compact(card.title), { $msg: "actionCard.question.title.other", count: 3 });
  assert.deepEqual(compact(card.spec), {
    root: "root",
    elements: {
      root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["properties", "reason", "actions"] },
      properties: { type: "Stack", props: { direction: "column", wrap: false }, children: ["for", "q_window", "q_envs", "q_notes"] },
      for: { type: "Field", props: { label: { $msg: "actionCard.question.for" }, value: [{ kind: "user", id: ID.alice, fallback: "Alice" }] } },
      q_window: { type: "Field", props: { label: { $msg: "actionCard.question.questionN", n: 1 }, value: "Which window should we deploy in?" } },
      q_envs: { type: "Field", props: { label: { $msg: "actionCard.question.questionN", n: 2 }, value: "Which environments first?" } },
      q_notes: { type: "Field", props: { label: { $msg: "actionCard.question.questionN", n: 3 }, value: "Anything else I should watch for?" } },
      reason: { type: "Stack", props: { direction: "column", wrap: false, role: "reason" }, children: ["reasonLabel", "reasonText"] },
      reasonLabel: { type: "Text", props: { text: { $msg: "actionCard.reason" }, tone: "muted", mono: false } },
      reasonText: { type: "Text", props: { text: "I'm preparing this week's deploy and need your call before I start.", tone: "default", mono: false } },
      actions: { type: "Stack", props: { direction: "row", wrap: true, role: "actions" }, children: ["answer"] },
      answer: { type: "Button", props: { label: { $msg: "actionCard.question.answer.other", count: 3 }, emphasis: "primary", action: { kind: "open_form", form: "answers" } } },
    },
  });
  // The body's own button executes: the server's form handler makes it open the form.
  const body = buildActionCardSpec(QUESTION, questionCtx);
  assert.deepEqual((body.spec.elements.answer as { props: { action: unknown } }).props.action, { kind: "execute" });
  // Without a name the server knows, the handle it resolved names the person.
  const handleOnly = questionCard(QUESTION, { requesterAgentId: ID.scout });
  assert.deepEqual(compact(handleOnly.spec.elements.for), { type: "Field", props: { label: { $msg: "actionCard.question.for" }, value: [{ kind: "user", id: ID.alice, fallback: "alice" }] } });
  // Raft's copy is the table's, in all seven locales; the agent's text is never a template.
  const table = ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>;
  for (const message of msgsOf(card)) {
    if (message.key === RAW_KEY) {
      assert.deepEqual(message.text, { en: "{t}" });
      continue;
    }
    assert.ok(Object.hasOwn(table, message.key), message.key);
    assert.deepEqual(Object.keys(message.text).sort(), [...DISPLAY_LOCALES].sort(), `${message.key}: every display locale`);
  }
});

test("a question card's form: a Choice per choice question (Other… always), a text area per text question, paged a question a page", () => {
  const form = answersOf(questionCard(QUESTION));
  const raw = (t: string) => ({ $msg: RAW_KEY, t });
  assert.deepEqual(compact(form), {
    title: { $msg: "actionCard.question.form.title.other", count: 3 },
    submitLabel: { $msg: "actionCard.question.form.submit" },
    description: { $msg: "actionCard.question.form.visibility", agent: { kind: "agent", id: ID.scout, fallback: "scout" } },
    steps: [{ fields: ["window"] }, { fields: ["envs"] }, { fields: ["notes"] }],
    fields: [
      {
        type: "Choice", name: "window", label: raw("Which window should we deploy in?"), description: raw("All times are UTC."), required: true, multiple: false,
        options: [
          { value: "tue_am", label: raw("Tue 10:00") }, { value: "wed_pm", label: raw("Wed 15:00") }, { value: "thu_am", label: raw("Thu 10:00") },
        ],
        // Raft's short label only: no description, and no Raft placeholder (the client shows its own).
        other: { label: { $msg: "actionCard.question.other" }, maxLength: 500 },
      },
      {
        type: "Choice", name: "envs", label: raw("Which environments first?"), required: true, multiple: true, minItems: 1, maxItems: 2,
        options: [{ value: "staging", label: raw("staging") }, { value: "canary", label: raw("canary (5%)") }, { value: "prod", label: raw("all of prod") }],
        other: { label: { $msg: "actionCard.question.other" }, placeholder: raw("Name the environment"), maxLength: 200 },
      },
      { type: "TextArea", name: "notes", label: raw("Anything else I should watch for?"), required: false, maxLength: 1000, rows: 4 },
    ],
  });
  // What the form takes back.
  assert.deepEqual(checkActionCardFormValues(form, { window: { selected: ["tue_am"] }, envs: { selected: ["staging"], other: "preview-eu" } }, { mode: "server" }), []);
  assert.deepEqual(checkActionCardFormValues(form, { window: { selected: [] }, envs: { selected: ["staging", "canary"], other: "x" }, notes: "ok" }, { mode: "server" })
    .map((issue) => [issue.field, issue.code]), [["window", "required"], ["envs", "too_many"]]);
  // A reader without field.choice opens it in the web; the server never sends open_web or a read marker.
  const card = questionCard(QUESTION);
  assert.equal(/open_web|unsupported/.test(JSON.stringify(card)), false);
  const readBack = parseActionCardSpec(card, { mode: "read" });
  assert.ok(readBack.ok);
  const stripped = stripActionCardSpec(readBack.card, ACTION_CARD_SPEC_CAPABILITIES.filter((capability) => capability !== "field.choice"));
  assert.deepEqual((stripped!.spec.elements.answer as { props: { action: unknown } }).props.action, { kind: "open_web" });
});

test("a confirm (a question of one option, single or multiple): a single Choice of that option without Other…, on the card; its answer shows the option's label", () => {
  const raw = (t: string) => ({ $msg: RAW_KEY, t });
  const confirm = question({
    to: "@alice",
    questions: [
      { id: "ack", kind: "single", text: "Read the runbook?", options: [{ value: "ok", label: "Got it" }] },
      { id: "also", kind: "multiple", text: "And the checklist?", required: false, minItems: 1, maxItems: 1, options: [{ value: "yes", label: "Done" }] },
      // Two or more options beside it: as before, with Other….
      { id: "window", kind: "single", text: "Which window?", options: [{ value: "tue", label: "Tue" }, { value: "wed", label: "Wed" }] },
    ],
    addressee: { kind: "user", userId: ID.alice, handle: "alice" },
  });
  const form = answersOf(questionCard(confirm));
  assert.equal(form.placement, "inline");
  assert.deepEqual(compact(form.fields), [
    { type: "Choice", name: "ack", label: raw("Read the runbook?"), required: true, multiple: false, options: [{ value: "ok", label: raw("Got it") }] },
    // A multiple one too: one option is one press, so no boxes and no bounds.
    { type: "Choice", name: "also", label: raw("And the checklist?"), required: false, multiple: false, options: [{ value: "yes", label: raw("Done") }] },
    { type: "Choice", name: "window", label: raw("Which window?"), required: true, multiple: false, options: [{ value: "tue", label: raw("Tue") }, { value: "wed", label: raw("Wed") }],
      other: { label: { $msg: "actionCard.question.other" }, maxLength: 500 } },
  ]);
  // What the form takes back: the option, or (optional) nothing; never the person's own text.
  assert.deepEqual(checkActionCardFormValues(form, { ack: { selected: ["ok"] }, window: { selected: ["tue"] } }, { mode: "server" }), []);
  assert.deepEqual(checkActionCardFormValues(form, { ack: { selected: [], other: "No" }, also: { selected: ["yes"] }, window: { selected: ["tue"] } }, { mode: "server" })
    .map((issue) => [issue.field, issue.code]), [["ack", "invalid_format"]]);
  assert.deepEqual(checkActionCardFormValues(form, { window: { selected: ["tue"] } }, { mode: "server" }).map((issue) => [issue.field, issue.code]), [["ack", "required"]]);
  // Answered: the option's label, as any choice; an optional one left out reads No answer.
  const answered = questionCard(confirm, { ...questionCtx, result: { ...ANSWERED, answers: { ack: { kind: "choice", selected: ["ok"] }, also: { kind: "skipped" }, window: { kind: "choice", selected: ["wed"] } } } as ActionCardResult });
  assert.equal(answered.forms, undefined);
  assert.deepEqual(compact(answered.result!.elements.a_ack), { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: "Got it" } });
  assert.deepEqual(compact(answered.result!.elements.a_also), { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: { $msg: "actionCard.question.skipped" }, muted: true } });
  // A card of one confirm alone: one question, on the card, and within the gate.
  const alone = question({ questions: [{ id: "ack", kind: "single", text: "Read the runbook?", options: [{ value: "ok", label: "Got it" }] }], addressee: { kind: "anyone" } });
  assert.equal(questionAskPlacement(alone), "inline");
  assert.equal(measureQuestionCard(alone, AGENT_CTX).ok, true);
});

test("a question card's pages: the agent's pages, else a question a page, none for one page; one-line text is a TextInput", () => {
  const paged = answersOf(questionCard({ ...QUESTION, pages: [["window", "envs"], ["notes"]] }));
  assert.deepEqual(paged.steps, [{ fields: ["window", "envs"] }, { fields: ["notes"] }]);
  assert.equal("steps" in answersOf(questionCard({ ...QUESTION, pages: [["window", "envs", "notes"]] })), false);
  const one = question({ to: "anyone", addressee: { kind: "anyone" }, questions: [{ id: "owner", kind: "text", text: "Who owns billing?", multiline: false, maxLength: 120 }] });
  const card = questionCard(one);
  assert.deepEqual(compact(card.title), { $msg: "actionCard.question.title.one", count: 1 });
  assert.deepEqual(compact(card.spec.elements.for), { type: "Field", props: { label: { $msg: "actionCard.question.for" }, value: { $msg: "actionCard.question.anyone" } } });
  assert.deepEqual(compact(card.spec.elements.q_owner), { type: "Field", props: { label: { $msg: "actionCard.question.question" }, value: "Who owns billing?" } });
  assert.deepEqual(compact(card.spec.elements.answer), { type: "Button", props: { label: { $msg: "actionCard.question.answer.one", count: 1 }, emphasis: "primary", action: { kind: "open_form", form: "answers" } } });
  const form = answersOf(card);
  assert.equal("steps" in form, false);
  assert.deepEqual(compact(form.title), { $msg: "actionCard.question.form.title.one", count: 1 });
  assert.deepEqual(compact(form.fields), [{ type: "TextInput", name: "owner", label: { $msg: RAW_KEY, t: "Who owns billing?" }, required: true, maxLength: 120 }]);
  // No reason, no For before the server resolved `to`: neither row.
  const bare = buildActionCardSpec(question({ questions: [{ id: "q", kind: "text", text: "?" }] }), questionCtx);
  assert.deepEqual(bare.spec.elements.root, { type: "Stack", props: { direction: "column", wrap: false }, children: ["properties", "actions"] });
  assert.deepEqual(bare.spec.elements.properties, { type: "Stack", props: { direction: "column", wrap: false }, children: ["q_q"] });
});

test("a question card is answered on the card (placement inline) only when it is short: at most 3 choice questions, labels within 32 columns, no pages (spec §5.9)", () => {
  const choice = (id: string, kind: "single" | "multiple", labels: string[]) => ({ id, kind, text: `${id}?`, options: labels.map((label, i) => ({ value: `v${i}`, label })) });
  const placed = (questions: unknown[], extra: Record<string, unknown> = {}) => {
    const action = question({ to: "anyone", addressee: { kind: "anyone" }, questions, ...extra });
    const form = answersOf(questionCard(action));
    assert.equal(form.placement ?? "sheet", questionAskPlacement(action), "the form says what questionAskPlacement decides");
    // The sheet is the default: it is never written.
    assert.notEqual(form.placement, "sheet");
    return form.placement ?? "sheet";
  };
  const one = choice("window", "single", ["Tue 10:00", "Wed 15:00"]);
  assert.equal(placed([one]), "inline");
  // Multiple choice, and Other… (every choice question has it) still fit; so do 3 questions.
  assert.equal(placed([one, choice("envs", "multiple", ["staging", "canary"]), choice("go", "single", ["yes", "no"])]), "inline");
  // A 4th question, a text question, or pages the agent asked for: the sheet.
  assert.equal(placed([one, choice("b", "single", ["x", "y"]), choice("c", "single", ["x", "y"]), choice("d", "single", ["x", "y"])]), "sheet");
  assert.equal(placed([one, { id: "notes", kind: "text", text: "Anything else?", required: false }]), "sheet");
  assert.equal(placed([one], { pages: [["window"]] }), "sheet");
  // 32 columns: 32 ASCII characters fit, 33 do not; a CJK character takes two (16 fit, 17 do not).
  assert.equal(placed([choice("w", "single", ["a".repeat(32), "b"])]), "inline");
  assert.equal(placed([choice("w", "single", ["a".repeat(33), "b"])]), "sheet");
  assert.equal(placed([choice("w", "single", ["周".repeat(16), "b"])]), "inline");
  assert.equal(placed([choice("w", "single", ["周".repeat(17), "b"])]), "sheet");
  assert.equal(QUESTION_ASK_INLINE_LIMITS.optionLabelColumns, 32);
  // The spec's other two conditions hold for every question card: at most 5 options, and options take no description.
  assert.ok(QUESTION_ASK_LIMITS.options.max <= 5);
  assert.throws(() => question({ questions: [{ id: "w", kind: "single", text: "?", options: [{ value: "a", label: "a", description: "d" }, { value: "b", label: "b" }] }] }));
  // The paged sheet stays for clients that do not know placement: an inline card's form still has its steps.
  assert.deepEqual(answersOf(questionCard(question({ questions: [one, choice("go", "single", ["yes", "no"])] }))).steps, [{ fields: ["window"] }, { fields: ["go"] }]);
});

test("a form's placement: emit takes sheet or inline and refuses any other; a read keeps a known one and drops another (the sheet)", () => {
  const card = questionCard(question({ questions: [{ id: "w", kind: "single", text: "?", options: [{ value: "a", label: "a" }, { value: "b", label: "b" }] }] }));
  assert.equal(answersOf(card).placement, "inline");
  const withPlacement = (placement: unknown) => ({ ...card, forms: { [QUESTION_ASK_FORM_ID]: { ...answersOf(card), placement } } });
  for (const placement of ["sheet", "inline"]) {
    const emitted = parseActionCardSpec(withPlacement(placement), { mode: "emit" });
    assert.ok(emitted.ok, placement);
    assert.equal(answersOf(emitted.card).placement, placement);
  }
  assert.equal(parseActionCardSpec(withPlacement("popover"), { mode: "emit" }).ok, false);
  const readForm = (raw: unknown) => {
    const read = parseActionCardSpec(raw, { mode: "read" });
    assert.ok(read.ok);
    return read.card.forms![QUESTION_ASK_FORM_ID]!;
  };
  assert.equal("placement" in readForm(withPlacement("popover")), false, "an unknown placement opens the sheet");
  assert.equal(readForm(card).placement, "inline");
});

test("a question card's form names the agent that asked: without it the card is not built, never an exception", () => {
  const outcome = buildParsedActionCardSpec(QUESTION, { names }, (built, ctx) => ({ ...buildActionCardSpec(built, ctx), forms: buildQuestionAskForms(built as QuestionAskAction, ctx) }));
  assert.equal(outcome.ok, false);
  assert.throws(() => buildQuestionAskForms(QUESTION, {}), /requesterAgentId/);
});

test("an answered question card: each question then its answer; the body no longer lists them, and it keeps no form and no Answer button", () => {
  const card = questionCard(QUESTION, { ...questionCtx, result: ANSWERED });
  assert.deepEqual(card.spec.elements.root, { type: "Stack", props: { direction: "column", wrap: false }, children: ["properties", "reason"] });
  assert.equal(card.forms, undefined, "nobody opens the form of an answered card");
  assert.equal(Object.values(card.spec.elements).some((node) => node.type === "Button"), false, "no button: none would open a form");
  assert.deepEqual(buildQuestionAskForms(QUESTION, { result: ANSWERED }), {}, "answered: no form, and no agent needed for one");
  assert.deepEqual(card.spec.elements.properties, { type: "Stack", props: { direction: "column", wrap: false }, children: ["for"] });
  assert.deepEqual(compact(card.result), {
    root: "root",
    elements: {
      root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["q_window", "a_window", "q_envs", "a_envs", "q_notes", "a_notes"] },
      q_window: { type: "Field", props: { label: { $msg: "actionCard.question.questionN", n: 1 }, value: "Which window should we deploy in?" } },
      a_window: { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: "Tue 10:00" } },
      q_envs: { type: "Field", props: { label: { $msg: "actionCard.question.questionN", n: 2 }, value: "Which environments first?" } },
      a_envs: { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: { $msg: "actionCard.question.choicesAndOwnAnswer", choices: "staging, canary (5%)", text: "preview-eu" } } },
      q_notes: { type: "Field", props: { label: { $msg: "actionCard.question.questionN", n: 3 }, value: "Anything else I should watch for?" } },
      a_notes: { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: { $msg: "actionCard.question.skipped" }, muted: true } },
    },
  });
  // Other… alone, and a text answer.
  const own = questionCard(QUESTION, { ...questionCtx, result: { ...ANSWERED, answers: { window: { kind: "choice", selected: [], other: "Fri 09:00" }, envs: { kind: "choice", selected: ["prod"] }, notes: { kind: "text", text: "Watch the queue." } } } as ActionCardResult });
  assert.deepEqual(compact(own.result!.elements.a_window), { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: { $msg: "actionCard.question.ownAnswer", text: "Fri 09:00" } } });
  assert.deepEqual(compact(own.result!.elements.a_envs), { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: "all of prod" } });
  assert.deepEqual(compact(own.result!.elements.a_notes), { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: "Watch the queue." } });
  // The person's text is a param, never a template.
  const fuzz = questionCard(QUESTION, { ...questionCtx, result: { ...ANSWERED, answers: { window: { kind: "choice", selected: [], other: "{x} }} {{" } } } as ActionCardResult });
  assert.deepEqual(compact(fuzz.result!.elements.a_window), { type: "Field", props: { label: { $msg: "actionCard.question.answerLabel" }, value: { $msg: "actionCard.question.ownAnswer", text: "{x} }} {{" } } });
});

test("an answer shows cut to QUESTION_ASK_LIMITS.shownAnswer, the same with or without Other, as plain one-line text; the result keeps it whole", () => {
  const max = QUESTION_ASK_LIMITS.shownAnswer;
  const half = Math.floor(max / 2);
  const long = "名".repeat(2000);
  const answerOf = (answer: unknown) => {
    const card = questionCard(QUESTION, { ...questionCtx, result: { ...ANSWERED, answers: { window: answer } } as ActionCardResult });
    const node = card.result!.elements.a_window;
    assert.ok(node?.type === "Field");
    return node.props.value;
  };
  const cut = (text: string, n: number) => `${[...text].slice(0, n - 1).join("")}…`;
  const longLabels = question({ ...QUESTION, questions: [{ ...QUESTION.questions[0]!, options: Array.from({ length: QUESTION_ASK_LIMITS.options.max }, (_, i) => ({ value: `o${i}`, label: "名".repeat(20) })) }], pages: undefined });
  const labelsCard = questionCard(longLabels, { ...questionCtx, result: { ...ANSWERED, answers: { window: { kind: "choice", selected: Array.from({ length: QUESTION_ASK_LIMITS.options.max }, (_, i) => `o${i}`) } } } as ActionCardResult });
  const labels = Array.from({ length: QUESTION_ASK_LIMITS.options.max }, () => "名".repeat(20)).join(", ");
  assert.deepEqual((labelsCard.result!.elements.a_window as { props: { value: unknown } }).props.value, cut(labels, max), "options alone: shownAnswer");
  assert.deepEqual(compact(answerOf({ kind: "choice", selected: [], other: long })), { $msg: "actionCard.question.ownAnswer", text: cut(long, max) }, "Other alone: shownAnswer");
  assert.deepEqual(compact(answerOf({ kind: "choice", selected: ["tue_am"], other: long })), { $msg: "actionCard.question.choicesAndOwnAnswer", choices: "Tue 10:00", text: cut(long, half) }, "both share it");
  assert.equal(answerOf({ kind: "text", text: long }), cut(long, max), "a text answer: shownAnswer");
  assert.equal(answerOf({ kind: "text", text: "line one\nline\u0007 two\ud800" }), "line one line two", "plain one-line text");
});

// ---------------------------------------------------------------------------
// The size gate (measureQuestionCard): prepare refuses a card over QUESTION_CARD_SIZE_THRESHOLD.

const AGENT_CTX: ActionCardSpecBuildContext = { requesterAgentId: ID.scout };

/** The most multiple-choice questions of the most options, every field at its limit in `char` (QUESTION_ASK_LIMITS), or at `lengths`. */
function maxQuestion(char: string, lengths: Partial<Record<"text" | "description" | "optionLabel" | "placeholder" | "reason", number>> = {}): QuestionAskAction {
  const L = { ...QUESTION_ASK_LIMITS, ...lengths };
  const text = (n: number) => char.repeat(n);
  return question({
    to: "@alice", reason: text(L.reason), ref: "r".repeat(QUESTION_ASK_LIMITS.ref),
    questions: Array.from({ length: QUESTION_ASK_LIMITS.questions.max }, (_, q) => ({
      id: `q${q}`.padEnd(QUESTION_ASK_LIMITS.id, "x"), kind: "multiple", text: text(L.text), description: text(L.description), minItems: 1,
      maxItems: QUESTION_ASK_LIMITS.options.max + 1, other: { placeholder: text(L.placeholder), maxLength: QUESTION_ASK_LIMITS.otherMaxLength },
      options: Array.from({ length: QUESTION_ASK_LIMITS.options.max }, (_, o) => ({ value: `o${o}`.padEnd(QUESTION_ASK_LIMITS.optionValue, "v"), label: text(L.optionLabel) })),
    })),
    addressee: { kind: "user", userId: ID.alice, handle: "alice" },
  });
}

/** A card the server would store: built and emit-parsed, its bytes as the 24 KiB check measures them (Infinity when refused). */
function storedBytes(action: QuestionAskAction, ctx: ActionCardSpecBuildContext): number {
  const outcome = buildParsedActionCardSpec(action, ctx, (built, builtCtx) => buildQuestionAskCard(built as QuestionAskAction, builtCtx));
  return outcome.ok ? cardBytes(outcome.card) : Number.POSITIVE_INFINITY;
}

const doneWith = (answers: Record<string, ActionCardQuestionAnswer>): ActionCardResult =>
  ({ kind: "question-answers", ref: null, answeredBy: { userId: ID.alice, handle: "alice" }, answeredAt: "2026-10-30T10:51:00.000Z", answers });

test("the gate measures the card in every state with the real builders, and names what each question costs", () => {
  const measured = measureQuestionCard(QUESTION, AGENT_CTX);
  assert.equal(measured.threshold, QUESTION_CARD_SIZE_THRESHOLD);
  assert.equal(QUESTION_CARD_SIZE_THRESHOLD, 20_890, "24576 less 15%");
  assert.ok(measured.ok);
  assert.deepEqual(Object.keys(measured.states).sort(), ["answered", "expired", "unanswered", "withdrawn"]);
  assert.equal(measured.bytes, Math.max(...Object.values(measured.states)));
  assert.equal(measured.states.withdrawn, measured.states.unanswered, "the frame paints withdrawn and expired");
  // The unanswered state is the card prepare would store, names at their longest.
  assert.ok(measured.states.unanswered >= storedBytes(QUESTION, { ...AGENT_CTX, names }));
  assert.deepEqual(measured.perQuestion.map((each) => each.id), ["window", "envs", "notes"]);
  assert.ok(measured.perQuestion.every((each) => each.bytes > 0 && each.bytes < measured.bytes));
  // A longer question costs more, and only it.
  const longer = measureQuestionCard({ ...QUESTION, questions: [{ ...QUESTION.questions[0]!, text: "名".repeat(QUESTION_ASK_LIMITS.text) }, ...QUESTION.questions.slice(1)] }, AGENT_CTX);
  assert.ok(longer.perQuestion[0]!.bytes > measured.perQuestion[0]!.bytes);
  assert.deepEqual(longer.perQuestion.slice(1), measured.perQuestion.slice(1));
  // Pure, and it never throws: without the agent it still measures (as the worst name).
  assert.deepEqual(measureQuestionCard(QUESTION, AGENT_CTX), measured);
  assert.ok(measureQuestionCard(QUESTION).ok);
});

test("the gate: max-length English passes, and every state it can reach is within 24 KiB", () => {
  const action = maxQuestion("x");
  const measured = measureQuestionCard(action, AGENT_CTX);
  assert.ok(measured.ok, JSON.stringify(measured.states));
  assert.ok(measured.bytes <= ACTION_CARD_SPEC_LIMITS.maxBytes);
  // Answered with what shows the most: every option and Other, in 4-byte characters.
  const all = doneWith(Object.fromEntries(action.questions.map((each) => [each.id, { kind: "choice", selected: (each.options ?? []).map((option) => option.value), other: "😀".repeat(2000) }])));
  assert.ok(storedBytes(action, { ...AGENT_CTX, names, result: all }) <= measured.bytes);
});

test("the gate: every field at its limit passes, in Chinese and in emoji (an answered card keeps no form); over the threshold is refused, naming each question", () => {
  // At 4 questions of 4 options, with no form on an answered card (PR2), the largest state of any
  // schema-valid card is the unanswered one, and even every field at its limit in emoji (4 bytes a
  // character) fits under the gate. CARD_TOO_LARGE stays as the backstop (Raft's copy may grow).
  for (const char of ["名", "😀"]) {
    const action = maxQuestion(char);
    const measured = measureQuestionCard(action, AGENT_CTX);
    assert.ok(measured.ok, `${char}: ${JSON.stringify(measured.states)}`);
    assert.ok(measured.states.answered < measured.states.unanswered, `${char}: answered without its form is smaller: ${JSON.stringify(measured.states)}`);
    for (const answer of [{ kind: "choice", selected: ["o0".padEnd(16, "v")], other: char.repeat(500) }, { kind: "skipped" }] as ActionCardQuestionAnswer[]) {
      const bytes = storedBytes(action, { ...AGENT_CTX, result: doneWith(Object.fromEntries(action.questions.map((each) => [each.id, answer]))) });
      assert.ok(bytes <= ACTION_CARD_SPEC_LIMITS.maxBytes && bytes <= measured.bytes, `${char}: ${bytes}`);
    }
  }
  // Over a threshold: refused, with what each question costs.
  const emoji = measureQuestionCard(maxQuestion("😀"), AGENT_CTX);
  const refused = measureQuestionCard(maxQuestion("😀"), AGENT_CTX, emoji.bytes - 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.threshold, emoji.bytes - 1);
  assert.equal(refused.bytes, emoji.bytes);
  assert.equal(refused.perQuestion.length, QUESTION_ASK_LIMITS.questions.max);
});

test("guard: Raft's copy on a question card has not grown (its overhead alone, 4 questions of 4 one-character options)", () => {
  // Raft's per-card and per-question copy (seven locales each) with the agent's text at one character.
  // Measured at 11966 bytes; growing past this tightens what agents can fit under the gate.
  const measured = measureQuestionCard(maxQuestion("x", { text: 1, description: 1, optionLabel: 1, placeholder: 1, reason: 1 }), AGENT_CTX);
  assert.ok(measured.bytes <= 11_966, `Raft's question-card copy grew: ${measured.bytes} bytes; recheck QUESTION_ASK_LIMITS and the gate`);
});

/** A deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: for every random valid card the gate accepts, the cards it can become (answered any way, withdrawn, expired) are within 24 KiB", () => {
  const random = prng(0x9e57);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  /** Half the time the maximum; a `full` round writes every field, each at its limit: cards near and over the threshold, not only small ones. */
  let full = false;
  const upTo = (min: number, max: number) => (full || random() < 0.5 ? max : int(min, max));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  const CHARS = ["a", "Z", "名", "語", "😀", "🚀", "é", "\"", "\\", "{", "}", "<", " "];
  const text = (min: number, max: number) => {
    const n = upTo(min, max);
    // Mostly the card's script, as people write, with the other characters mixed in (a full round: only its script).
    let out = main;
    while ([...out].length < n) out += full || random() < 0.8 ? main : pick(CHARS);
    return [...out].slice(0, n).join("").trim() || "x";
  };
  const L = QUESTION_ASK_LIMITS;
  let accepted = 0;
  let refused = 0;
  let main = "a";
  for (let round = 0; round < 120; round++) {
    main = pick(["a", "名", "😀"]);
    full = random() < 0.25;
    const count = upTo(1, L.questions.max);
    const questions = Array.from({ length: count }, (_, q) => {
      const kind = full ? "multiple" : pick(["single", "multiple", "multiple", "text"] as const);
      const base = { id: `q${q}`, kind, text: text(1, L.text), required: random() < 0.7, ...(full || random() < 0.8 ? { description: text(1, L.description) } : {}) };
      if (kind === "text") return { ...base, multiline: random() < 0.7, maxLength: int(1, 500) };
      const n = upTo(L.options.min, L.options.max);
      const options = Array.from({ length: n }, (_, o) => ({ value: `o${o}`, label: text(1, L.optionLabel) }));
      // One option is a confirm: no Other…, one item.
      if (n === 1) return { ...base, options, ...(kind === "multiple" && random() < 0.5 ? { maxItems: 1 } : {}) };
      return {
        ...base, options,
        ...(kind === "multiple" && random() < 0.5 ? { maxItems: int(1, n + 1) } : {}),
        ...(full || random() < 0.7 ? { other: { placeholder: text(1, L.placeholder), maxLength: int(1, L.otherMaxLength) } } : {}),
      };
    });
    const action = question({
      ...(full || random() < 0.8 ? { reason: text(1, L.reason) } : {}), questions,
      addressee: random() < 0.8 ? { kind: "user", userId: ID.alice, handle: "alice" } : { kind: "anyone" },
    });
    const measured = measureQuestionCard(action, AGENT_CTX);
    if (!measured.ok) { refused++; continue; }
    accepted++;
    // The real names, of any length, and answers of every shape and length (people's answers are not limited).
    const ctx: ActionCardSpecBuildContext = { requesterAgentId: ID.scout, names: { users: { [ID.alice]: text(1, 200) }, agents: { [ID.scout]: text(1, 200) } } };
    const unanswered = storedBytes(action, ctx);
    assert.ok(unanswered <= measured.bytes && unanswered <= ACTION_CARD_SPEC_LIMITS.maxBytes, `round ${round}: unanswered ${unanswered}`);
    for (let k = 0; k < 4; k++) {
      const answers = Object.fromEntries(action.questions.map((each): [string, ActionCardQuestionAnswer] => {
        if (each.kind === "text") return [each.id, random() < 0.2 ? { kind: "skipped" } : { kind: "text", text: text(1, 2000) + "\u0001\ud800" }];
        // A valid answer, as the form's checks let through: a single question takes one item, a multiple one up to
        // maxItems (Other counts as one), in any order.
        // A confirm (one option) is answered with its option or, optional, left out; it has no Other….
        if ((each.options ?? []).length === 1) return [each.id, each.required || random() < 0.7 ? { kind: "choice", selected: [each.options![0]!.value] } : { kind: "skipped" }];
        const max = each.kind === "single" ? 1 : each.maxItems ?? (each.options ?? []).length + 1;
        const withOther = random() < 0.5;
        const values = (each.options ?? []).map((option) => option.value).filter(() => random() < 0.6).sort(() => random() - 0.5)
          .slice(0, Math.max(0, max - (withOther ? 1 : 0)));
        return [each.id, { kind: "choice", selected: values, ...(withOther || values.length === 0 ? { other: text(1, 500) } : {}) }];
      }));
      const answered = storedBytes(action, { ...ctx, result: doneWith(answers) });
      assert.ok(answered <= measured.bytes, `round ${round}.${k}: answered ${answered} over the gate's ${measured.bytes}`);
      assert.ok(answered <= ACTION_CARD_SPEC_LIMITS.maxBytes, `round ${round}.${k}: answered ${answered}`);
    }
  }
  // No schema-valid card reaches the gate now (the gate test above): every random one is accepted, and must fit once answered.
  assert.ok(accepted >= 40, `accepted ${accepted}, refused ${refused}`);
});

test("assistant:owner_action: a card with its own copy (moveAgent) is in the viewer's language; one without keeps Raft's English", () => {
  const base = {
    type: "assistant:owner_action" as const,
    assistantAgentId: ID.scout,
    assistantName: "Ottie",
    ownerUserId: ID.alice,
    actionKey: "agentMigrate",
    tool: "move_agent",
    phrase: "move @sage to box-b",
    done: "Moved @sage to box-b",
    description: "Moves @sage from box-a to box-b.",
    request: { method: "POST" as const, path: `/api/agents/${ID.bob}/migrate`, body: { targetComputer: "box-b" } },
    paramsKey: "a".repeat(64),
    args: { agent: "@sage", computer: "box-b" },
    createdAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2026-11-06T10:00:00.000Z",
  };
  const msgsOf = (card: ActionCardSpecCard): ActionCardSpecMsg[] => {
    const found: ActionCardSpecMsg[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        if (typeof v.key === "string" && v.text && typeof v.text === "object") found.push(v as unknown as ActionCardSpecMsg);
        Object.values(v).forEach(walk);
      }
    };
    walk(card);
    return found;
  };

  const localized = buildActionCardSpec({ ...base, view: { kind: "moveAgent", agent: "Sage", from: "box-a", to: "box-b" } });
  const keys = msgsOf(localized).map((msg) => msg.key);
  assert.ok(keys.includes("actionCard.title.assistantOwnerAction.moveAgent"));
  assert.ok(keys.includes("actionCard.assistantOwnerAction.moveAgent.description"));
  assert.ok(!keys.includes("actionCard.title.assistantOwnerAction"));
  for (const msg of msgsOf(localized)) {
    if (!msg.key.includes("assistantOwnerAction") && !msg.key.includes("OwnerAction")) continue;
    for (const locale of DISPLAY_LOCALES) assert.ok(msg.text[locale], `${msg.key} has ${locale}`);
  }
  const title = msgsOf(localized).find((msg) => msg.key === "actionCard.title.assistantOwnerAction.moveAgent")!;
  assert.deepEqual(title.params, { assistant: "Ottie", agent: "Sage", to: "box-b" });

  const noSource = buildActionCardSpec({ ...base, view: { kind: "moveAgent", agent: "Sage", from: null, to: "box-b" } });
  assert.ok(msgsOf(noSource).some((msg) => msg.key === "actionCard.assistantOwnerAction.moveAgent.descriptionNoSource"));

  const legacy = buildActionCardSpec(base);
  const legacyTitle = msgsOf(legacy).find((msg) => msg.key === "actionCard.title.assistantOwnerAction")!;
  assert.deepEqual(legacyTitle.params, { assistant: "Ottie", phrase: "move @sage to box-b" });
  assert.ok(JSON.stringify(legacy).includes("Moves @sage from box-a to box-b."), "the stored English description");

  // An old card (no view) is all English for a zh-cn viewer: the frame, the warning, the button and the form too.
  const legacyMsgs = [...msgsOf(legacy), ...msgsOfForms(buildAssistantOwnerActionForms(base))];
  assert.ok(legacyMsgs.length >= 8, `found ${legacyMsgs.length} messages`);
  for (const msg of legacyMsgs) assert.deepEqual(Object.keys(msg.text), ["en"], `${msg.key} is English only`);
  // A card with its own copy keeps every locale, the form included.
  const localizedForm = msgsOfForms(buildAssistantOwnerActionForms({ ...base, view: { kind: "moveAgent", agent: "Sage", from: "box-a", to: "box-b" } }));
  for (const msg of [...msgsOf(localized), ...localizedForm]) assert.ok(msg.text["zh-cn"], `${msg.key} has zh-cn`);
  assert.equal(localizedForm.find((msg) => msg.key === "actionCard.assistantOwnerAction.form.submit")!.text["zh-cn"], "发送");
  // The localized card, its forms included, parses as the server emits it: every locale's text
  // within its limit (a 25-character ru button label once dropped the form, so Confirm was refused).
  for (const view of [{ kind: "moveAgent" as const, agent: "Sage", from: "box-a", to: "box-b" }, { kind: "moveAgent" as const, agent: "Sage", from: null, to: "box-b" }]) {
    const action = { ...base, view };
    const card = { ...buildActionCardSpec(action), forms: buildAssistantOwnerActionForms(action) };
    assert.ok(parseActionCardSpec(card, { mode: "emit" }).ok, JSON.stringify(actionCardSpecIssues(card, { mode: "emit" })));
  }
});

test("assistant:owner_action result: a card with its own copy shows how it ended in the viewer's language; an old card or result keeps Raft's English line", () => {
  const base = {
    type: "assistant:owner_action" as const,
    assistantAgentId: ID.scout,
    assistantName: "Ottie",
    ownerUserId: ID.alice,
    actionKey: "agentMigrate",
    tool: "move_agent",
    phrase: "move @sage to box-b",
    done: "Moved @sage to box-b",
    description: "Moves @sage from box-a to box-b.",
    request: { method: "POST" as const, path: `/api/agents/${ID.bob}/migrate`, body: { targetComputer: "box-b" } },
    paramsKey: "a".repeat(64),
    args: { agent: "@sage", computer: "box-b" },
    createdAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2026-11-06T10:00:00.000Z",
  };
  const withView = { ...base, view: { kind: "moveAgent" as const, agent: "Sage", from: "box-a", to: "box-b" } };
  const ended = (line: Extract<ActionCardResult, { kind: "assistant-owner-action" }>["line"], over: Partial<Extract<ActionCardResult, { kind: "assistant-owner-action" }>> = {}): ActionCardResult => ({
    kind: "assistant-owner-action", decision: "confirmed", status: 202, ok: true, summary: "Raft's English line.", decidedAt: "2026-11-05T10:05:00.000Z", ...(line ? { line } : {}), ...over,
  });
  const resultMsgs = (card: ActionCardSpecCard) => msgsOfForms({ result: card.result } as unknown as Record<string, ActionCardSpecForm>);

  const started = buildActionCardSpec(withView, { result: ended({ kind: "moveStarted", agent: "Sage", to: "box-b", arrivalAt: "2026-11-05T10:20:00.000Z" }) });
  const startedMsg = resultMsgs(started).find((msg) => msg.key === "actionCard.result.assistantOwnerAction.moveStarted")!;
  assert.deepEqual(startedMsg.params, { agent: "Sage", to: "box-b" });
  assert.ok(resultMsgs(started).some((msg) => msg.key === "actionCard.result.assistantOwnerAction.arrivesBy"));
  assert.ok(JSON.stringify(started.result).includes("2026-11-05T10:20:00.000Z"), "the arrival as a RelativeTime");
  assert.ok(!JSON.stringify(started.result).includes("Raft's English line."));
  const noArrival = buildActionCardSpec(withView, { result: ended({ kind: "moveStarted", agent: "Sage", to: "box-b", arrivalAt: null }) });
  assert.ok(!resultMsgs(noArrival).some((msg) => msg.key === "actionCard.result.assistantOwnerAction.arrivesBy"));

  const declined = buildActionCardSpec(withView, { result: ended({ kind: "declined" }, { decision: "declined", status: null }) });
  assert.ok(resultMsgs(declined).some((msg) => msg.key === "actionCard.result.assistantOwnerAction.declined"));
  const unknown = buildActionCardSpec(withView, { result: ended({ kind: "unknown" }, { ok: false, unknown: true }) });
  assert.ok(resultMsgs(unknown).some((msg) => msg.key === "actionCard.result.assistantOwnerAction.unknown"));
  const failed = buildActionCardSpec(withView, { result: ended({ kind: "failed", error: "box-b is offline." }, { ok: false, status: 409 }) });
  const failedMsg = resultMsgs(failed).find((msg) => msg.key === "actionCard.result.assistantOwnerAction.failed")!;
  assert.deepEqual(failedMsg.params, { error: "box-b is offline." });
  assert.ok(JSON.stringify(failed.result).includes("warning"), "a failure keeps its warning tone");

  for (const card of [started, declined, unknown, failed]) {
    for (const msg of resultMsgs(card)) for (const locale of DISPLAY_LOCALES) assert.ok(msg.text[locale], `${msg.key} has ${locale}`);
  }
  assert.equal(resultMsgs(started).find((msg) => msg.key === "actionCard.result.assistantOwnerAction.moveStarted")!.text["zh-cn"], "已开始把 {agent} 迁移到 {to}，{agent} 会在那里重新开始。");

  // An old card (no view) keeps Raft's English line even with a line; so does an old result (no line).
  for (const card of [buildActionCardSpec(base, { result: ended({ kind: "declined" }, { decision: "declined", status: null }) }), buildActionCardSpec(withView, { result: ended(undefined) })]) {
    assert.ok(JSON.stringify(card.result).includes("Raft's English line."));
    assert.ok(!resultMsgs(card).some((msg) => msg.key.startsWith("actionCard.result.assistantOwnerAction.")));
  }
});

function msgsOfForms(forms: Record<string, ActionCardSpecForm>): ActionCardSpecMsg[] {
  const found: ActionCardSpecMsg[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (typeof v.key === "string" && v.text && typeof v.text === "object") found.push(v as unknown as ActionCardSpecMsg);
      Object.values(v).forEach(walk);
    }
  };
  walk(forms);
  return found;
}

describe("every catalog text fits the field it is shown in, in every display locale", () => {
  // A text over its field's limit (a Button label 24, a title 80, ...) in ONE locale fails the
  // emit parse of the whole card, and the server then drops the card and its forms silently
  // (v1.21.54: a 25-character ru button label on the owner-action card refused every Confirm).
  // Each card below is built as the server sends it, forms included; then every Msg on it gets
  // the catalog's text in every display locale (a plural, each locale's longest branch) and the
  // card is parsed again, so the limit checked is the one of the field the text is actually in.
  // An English-only card (an old owner-action card) is checked with its full catalog text too.
  const catalog = ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>;
  const PLURAL_BRANCH = /\.(zero|one|two|few|many|other)$/;
  const fullText = (key: string): Record<string, string> | null => {
    const branch = PLURAL_BRANCH.exec(key);
    const base = branch ? key.slice(0, branch.index) : null;
    const siblings = base && catalog[`${base}.other`]
      ? Object.keys(catalog).filter((other) => other.startsWith(`${base}.`) && PLURAL_BRANCH.test(other.slice(base.length)) && other.slice(base.length + 1).indexOf(".") === -1)
      : [key];
    if (!siblings.every((sibling) => catalog[sibling])) return null;
    const text: Record<string, string> = {};
    for (const locale of DISPLAY_LOCALES) {
      for (const sibling of siblings) {
        const candidate = (catalog[sibling]!.text as Record<string, string | undefined>)[locale];
        if (candidate !== undefined && candidate.length > (text[locale]?.length ?? -1)) text[locale] = candidate;
      }
    }
    return text;
  };
  const withFullText = (value: unknown, used: Set<string>): unknown => {
    if (Array.isArray(value)) return value.map((item) => withFullText(item, used));
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) out[key] = withFullText(nested, used);
    if (typeof out.key === "string" && out.text && typeof out.text === "object") {
      const text = fullText(out.key);
      if (text) {
        used.add(out.key);
        out.text = text;
      }
    }
    return out;
  };

  const owner = {
    type: "assistant:owner_action" as const, assistantAgentId: ID.scout, assistantName: "Ottie", ownerUserId: ID.alice,
    actionKey: "agentMigrate", tool: "move_agent", phrase: "move @sage to box-b", done: "Moved @sage to box-b",
    description: "Moves @sage from box-a to box-b.", request: { method: "POST" as const, path: `/api/agents/${ID.bob}/migrate`, body: { targetComputer: "box-b" } },
    paramsKey: "a".repeat(64), args: { agent: "@sage", computer: "box-b" }, createdAt: "2026-11-05T10:00:00.000Z", expiresAt: "2026-11-06T10:00:00.000Z",
  };
  const ownerViews = [owner, { ...owner, view: { kind: "moveAgent" as const, agent: "Sage", from: "box-a", to: "box-b" } }, { ...owner, view: { kind: "moveAgent" as const, agent: "Sage", from: null, to: "box-b" } }];
  const approveCall = {
    type: "agent:approve_call" as const, approvalId: ID.request, agentId: ID.scout, agentName: "scout", call: "gh.create_pull_request", plugin: "github",
    heldBy: "policy" as const, summary: "repo: botiverse/antiproton", summaryTruncated: false, summaryWithheld: false, request: "POST /repos/botiverse/antiproton/pulls",
    description: "Approving runs gh.create_pull_request once.", createdAt: "2026-10-29T06:20:00.000Z", expiresAt: "2026-10-30T06:20:00.000Z", decider: "owner" as const,
  };
  const seats = (purpose: SeatsAddAction["purpose"]): SeatsAddAction => ({ type: "seats:add", seats: 2, purpose, reason: "They start Monday.", expiresAt: "2026-11-03T00:00:00.000Z" });
  const seatsCtx = { serverName: "Lumen", requesterUserId: ID.alice, names };

  const formsFor = (action: StoredActionCardAction, ctx: ActionCardSpecBuildContext): Record<string, ActionCardSpecForm> | null => {
    if (action.type === "feedback:submit") return buildFeedbackSubmitForms(action as Extract<ActionCardAction, { type: "feedback:submit" }>);
    if (action.type === "question:ask") return buildQuestionAskForms(action as QuestionAskAction, { ...ctx, requesterAgentId: ID.scout });
    if (action.type === "assistant:owner_action") return buildAssistantOwnerActionForms(action as (typeof ownerViews)[number]);
    if (action.type === "agent:approve_call") return buildAgentApproveCallForms();
    return null;
  };
  const all: { name: string; action: StoredActionCardAction; ctx: ActionCardSpecBuildContext }[] = [
    ...cases,
    ...ownerViews.map((action, i) => ({ name: `assistant:owner_action ${i === 0 ? "old (English only)" : `with view ${i}`}`, action: action as StoredActionCardAction, ctx: {} })),
    { name: "agent:approve_call prepared", action: approveCall as StoredActionCardAction, ctx: {} },
    ...(["invite", "join", "agent:create", "assistant:create"] as const).map((kind) => ({
      name: `seats:add ${kind}`,
      action: seats(kind === "invite" ? { kind, emails: ["grace@lumen.test"] } : kind === "assistant:create" ? { kind } : { kind, name: "scribe" } as SeatsAddAction["purpose"]) as StoredActionCardAction,
      ctx: seatsCtx,
    })),
  ];
  const used = new Set<string>();
  for (const { name, action, ctx } of all) {
    test(name, () => {
      const forms = formsFor(action, ctx);
      const outcome = buildParsedActionCardSpec(action, ctx, forms ? (a, c) => withActionCardForms(buildActionCardSpec(a, c), forms) : buildActionCardSpec);
      assert.ok(outcome.ok, `as built: ${JSON.stringify(outcome.ok ? null : outcome.issues)}`);
      const full = withFullText(outcome.card, used);
      assert.ok(parseActionCardSpec(full, { mode: "emit" }).ok, `with every locale's catalog text: ${JSON.stringify(actionCardSpecIssues(full, { mode: "emit" }))}`);
    });
  }
  test("the cards above reach the catalog's button labels", () => {
    assert.ok(used.has("actionCard.verb.decideOwnerAction") && used.has("actionCard.assistantOwnerAction.form.confirm"), [...used].filter((key) => key.includes("OwnerAction")).join(", "));
  });
});

test("agent:migrate says who asked only when another agent prepared it (\"Requested by\", a reference to that agent)", () => {
  const action: StoredActionCardAction = { type: "agent:migrate", agentId: ID.scout, suggestedComputer: ID.mac };
  const ops = ID.request;
  const other = buildActionCardSpec(action, { names: { ...names, agents: { ...names.agents, [ops]: "IT Ops" } }, requesterAgentId: ops });
  assert.deepEqual(other.spec.elements.requestedBy, {
    type: "Text",
    props: { text: actionCardMsg("actionCard.migrateAgent.requestedBy", { agent: { kind: "agent", id: ops, fallback: "IT Ops" } }), tone: "muted", mono: false },
  });
  assert.equal(parseActionCardSpec(other, { mode: "emit" }).ok, true);
  // Its own move (or no preparer known): no line.
  for (const ctx of [{ names, requesterAgentId: ID.scout }, { names, requesterAgentId: ID.scout.toUpperCase() }, { names }]) {
    assert.equal(buildActionCardSpec(action, ctx).spec.elements.requestedBy, undefined);
  }
});

test("agent:migrate shows its Agent's Current computer before the Suggested one, never with a name the server gave it", () => {
  const source = ID.client;
  const action: StoredActionCardAction = { type: "agent:migrate", agentId: ID.scout, suggestedComputer: ID.mac };
  // The card carries only the id (a viewer who may see it names it).
  const card = buildActionCardSpec(action, { names, currentComputerId: source });
  assert.deepEqual(card.spec.elements.currentComputer, {
    type: "Field",
    props: { label: actionCardMsg("actionCard.field.currentComputer"), value: [{ kind: "computer", id: source, fallback: source.slice(0, 8) }], mono: true },
  });
  const properties = card.spec.elements.properties;
  assert.ok(properties?.type === "Stack");
  assert.deepEqual(properties.children, ["currentComputer", "computer"]);
  assert.equal(parseActionCardSpec(card, { mode: "emit" }).ok, true);
  // Done, it stays; on no computer, no field.
  const result: ActionCardResult = { kind: "agent-migration", agentId: ID.scout, targetMachineId: ID.mac };
  assert.ok(buildActionCardSpec(action, { names, currentComputerId: source, result }).spec.elements.currentComputer);
  for (const currentComputerId of [null, undefined]) {
    assert.equal(buildActionCardSpec(action, { names, currentComputerId }).spec.elements.currentComputer, undefined);
  }
});

test("no card names a computer: every computer reference's fallback is its short id, prepared and done, and a stored name is not carried into a rebuilt card", () => {
  const computerRefs = (card: unknown): ActionCardSpecEntityRef[] => {
    const found: ActionCardSpecEntityRef[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (typeof value !== "object" || value === null) return;
      const ref = value as Partial<ActionCardSpecEntityRef>;
      if (ref.kind === "computer" && typeof ref.id === "string") found.push(ref as ActionCardSpecEntityRef);
      Object.values(value).forEach(walk);
    };
    walk(card);
    return found;
  };
  const cases: Array<{ action: StoredActionCardAction; result: ActionCardResult | null; ctx?: ActionCardSpecBuildContext }> = [
    { action: { type: "agent:create", name: "scribe", suggestedComputer: ID.mac }, result: { kind: "agent", id: ID.created, name: "scribe" } },
    { action: { type: "agent:create", name: "scribe", requiredComputer: ID.mac }, result: null },
    { action: { type: "agent:migrate", agentId: ID.scout, suggestedComputer: ID.mac }, result: { kind: "agent-migration", agentId: ID.scout, targetMachineId: ID.mac }, ctx: { currentComputerId: ID.client } },
  ];
  for (const { action, result, ctx } of cases) {
    for (const built of [buildActionCardSpec(action, { names, ...ctx }), buildActionCardSpec(action, { names, ...ctx, result })]) {
      const refs = computerRefs(built);
      assert.ok(refs.length > 0, action.type);
      for (const ref of refs) assert.equal(ref.fallback, ref.id.slice(0, 8), `${action.type}: ${JSON.stringify(ref)}`);
    }
  }
  // A card stored before this (its computer named): its names give no computer, so a rebuild drops the name.
  const stored = { title: "t", spec: { elements: { computer: { type: "Field", props: { value: [{ kind: "computer", id: ID.mac, fallback: "studio-mac" }] } } } } };
  assert.deepEqual(actionCardSpecNames(stored), {});
});

test("actionCardSpecWithoutComputerNames: a stored card's computer names become short ids wherever they are; nothing else changes, and the input is not changed", () => {
  const action: StoredActionCardAction = { type: "agent:migrate", agentId: ID.scout, suggestedComputer: ID.mac };
  const built = buildActionCardSpec(action, { names, currentComputerId: ID.client, result: { kind: "agent-migration", agentId: ID.scout, targetMachineId: ID.mac } });
  // As a card stored before #14234 holds it: the computers named (in Fields and in a Msg param).
  const legacy = JSON.parse(JSON.stringify(built).replaceAll(`"fallback":"${ID.mac.slice(0, 8)}"`, '"fallback":"studio-mac"')) as typeof built;
  const legacyText = JSON.stringify(legacy);
  assert.ok(legacyText.split("studio-mac").length - 1 >= 2, "the fixture names it in a field and in the result");
  const served = actionCardSpecWithoutComputerNames(legacy);
  assert.deepEqual(served, built);
  assert.equal(JSON.stringify(legacy), legacyText, "the stored card is not changed");
  // Nothing to strip: the same card back.
  assert.equal(actionCardSpecWithoutComputerNames(built), built);
});
