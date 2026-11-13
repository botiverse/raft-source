// `presentation.card` for Raft's first-party action cards, described in the
// `action-card.v1` catalog (actionCardSpec.ts), so the web and the App render
// every type with one renderer. The web runs a card only from it
// (packages/web/src/components/actions/ActionCardSpecCard.tsx; a card without
// one that reads is drawn view only). For a type the web once drew with a card of
// its own (removed, #proj-apps:#40 P9), the spec shows what that card showed:
// its rows and notices, title, button, result line and icon. One pure
// function per type; the copy comes from actionCardMessages.ts.
//
// Only the server builds a card: when it writes a card's metadata, and for a
// card stored before cards carried one, when a human reads it. It stores and
// sends what parseActionCardSpec(card, { mode: "emit" }) returns
// (buildParsedActionCardSpec), never the raw output.
//
// What an agent or an App wrote (draftHint, reason, descriptions, feedback,
// app names, URLs) is plain data: a Text or Field string or a Msg param,
// never a template. No navigate button carries a URL: every URL on these
// cards came from an agent or an App, so they stay Field text. Names the web
// looks up in its store are EntityRefs; their fallback is the name the server
// had when it built the card, else the id's first 8 characters (as the web's
// own card showed an id it could not resolve).

import { isQuestionAskConfirm, plainActionCardText, QUESTION_ASK_LIMITS, QUESTION_CARD_SIZE_THRESHOLD, type QuestionCardQuestionBytes } from "./actionCards";
import type {
  ActionCardAction, ActionCardQuestionAnswer, ActionCardResult, AgentApproveCallAction, AgentMigrateAction, AssistantOwnerActionCardAction, AgentCallApprovalDecidedBy, QuestionAskAction, QuestionAskQuestion,
  SeatsAddAction, SeatsAddPurpose, StoredActionCardAction,
} from "./actionCards";
import {
  actionCardRawText, actionCardSpecIssues, parseActionCardSpec,
  type ActionCardSpecAction, type ActionCardSpecCard, type ActionCardSpecElement,
  type ActionCardFormPlacement, type ActionCardSpecEntityRef, type ActionCardSpecField, type ActionCardSpecForm, type ActionCardSpecFormStep, type ActionCardSpecIcon, type ActionCardSpecIssue,
  type ActionCardSpecMsg, type ActionCardSpecTree,
} from "./actionCardSpec";
import { actionCardMsg, actionCardPluralMsg, type ActionCardMessageKey } from "./actionCardMessages";
import { cardCodePoints } from "./cardElements";
import { searchSnippetCharWidth } from "./searchSnippet";
import { GENERAL_UPGRADE_GATE, type AgentUpgradeCardGate } from "./upgradeGates";
// Read at call time only (as feedbackMachineEvidence does): index re-exports this module.
import {
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES, MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS,
  MAX_JOINT_CHANNEL_FREE_SERVERS, PLAN_CONFIG, PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
} from "./index";

/**
 * Names the server knows for the ids on a card, by entity kind (id -> name).
 * None for computers: a card never carries a computer's name. Computers are
 * listed only to those with viewMachines (not a guest, nor a viewer from
 * another server in a shared channel), so a computer reference's fallback is
 * its short id, and a viewer who may see the computer names it from their own
 * list.
 */
export interface ActionCardSpecNames {
  users?: Record<string, string>;
  agents?: Record<string, string>;
  channels?: Record<string, string>;
  /** The App a connect card is for, for its title: the card's row holds ids only (actionCards.ts). */
  mcpApp?: string;
}

export interface ActionCardSpecBuildContext {
  /** The card's result once executed: the `result` tree shows it. */
  result?: ActionCardResult | null;
  /** Fallback names for the EntityRefs (absent: the id's first 8 characters). */
  names?: ActionCardSpecNames;
  /** The card's server, for copy that names it (plan:upgrade's limit note, seats:add's notice). */
  serverName?: string;
  /** Who asked for a person's card (`metadata.requesterUserId`), for copy that names them (seats:add's notice). */
  requesterUserId?: string;
  /** The agent that prepared the card, for copy that names it (a question card's form: who sees the answers). */
  requesterAgentId?: string;
  /**
   * An agent:migrate card's Agent's computer when the card was prepared (the
   * server's action_cards record, fromMachineId; none: it was on no
   * computer), for its Current computer field. Not part of the action.
   */
  currentComputerId?: string | null;
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A ScopeList scope or group id (actionCardSpec.ts); one outside it is shown as text instead. */
const SCOPE_ID = /^[a-z][a-z0-9_.:-]{0,127}$/;
/** ScopeList's limits: 1-64 scopes, 1-32 groups (actionCardSpec.ts). */
const SCOPE_LIST_MAX = { scopes: 64, groups: 32 } as const;
type EntityKind = ActionCardSpecEntityRef["kind"];
/** The kinds a card may name (ActionCardSpecNames): every one but a computer. */
type NamedKind = Exclude<EntityKind, "computer">;
const NAME_BUCKETS = { user: "users", agent: "agents", channel: "channels" } as const satisfies Record<NamedKind, keyof ActionCardSpecNames>;

/** At most `max` code points: data longer than its slot is cut, with an ellipsis. */
function clip(text: string, max: number): string {
  if (cardCodePoints(text) <= max) return text;
  return `${Array.from(text).slice(0, max - 1).join("")}…`;
}

const shortId = (id: string) => id.slice(0, 8);

function nameOf(names: ActionCardSpecNames | undefined, kind: EntityKind, id: string): string | undefined {
  if (kind === "computer") return undefined;
  const bucket = names?.[NAME_BUCKETS[kind]];
  const name = bucket && Object.hasOwn(bucket, id) ? bucket[id] : undefined;
  return name && name.trim() ? name : undefined;
}

/** An EntityRef, or null when `id` is not a UUID (then the caller shows text). */
function entityRef(kind: EntityKind, rawId: string, names: ActionCardSpecNames | undefined, known?: string): ActionCardSpecEntityRef | null {
  const id = rawId.toLowerCase();
  if (!LOWER_UUID.test(id)) return null;
  // EntityRef fallbacks are capped well under their 200 so a card with 128 of them stays under 24 KiB.
  // A computer's is always its short id (ActionCardSpecNames).
  if (kind === "computer") return { kind, id, fallback: shortId(id) };
  return { kind, id, fallback: clip(known?.trim() ? known : nameOf(names, kind, id) ?? nameOf(names, kind, rawId) ?? shortId(id), 80) };
}

/** A Msg param naming an entity: a reference when the id is a UUID, else its text. */
function entityParam(kind: EntityKind, id: string, names: ActionCardSpecNames | undefined): ActionCardSpecEntityRef | string {
  return entityRef(kind, id, names) ?? clip(id, 500);
}

// ---------------------------------------------------------------------------
// Tree assembly. A Part is an element with its id; a group is a column Stack.

interface Part { id: string; node: ActionCardSpecElement; children?: Part[] }
type MaybePart = Part | null | undefined | false;

const STACK = { type: "Stack", props: { direction: "column", wrap: false } } as const;

function group(id: string, children: MaybePart[], role?: "reason"): Part | null {
  const kept = children.filter((child): child is Part => !!child);
  return kept.length > 0 ? { id, node: { ...STACK, props: { ...STACK.props, ...(role ? { role } : {}) } }, children: kept } : null;
}

function tree<E extends ActionCardSpecElement = ActionCardSpecElement>(children: MaybePart[]): { root: string; elements: Record<string, E> } {
  const elements: Record<string, ActionCardSpecElement> = {};
  const visit = (part: Part): string => {
    if (Object.hasOwn(elements, part.id)) throw new Error(`Duplicate action-card element id ${part.id}`);
    elements[part.id] = part.node;
    if (part.children) {
      const props = part.node.type === "Stack" ? { ...part.node.props } : { ...STACK.props };
      elements[part.id] = { type: "Stack", props, children: part.children.map(visit) };
    }
    return part.id;
  };
  const root = group("root", children) ?? { id: "root", node: { ...STACK, props: { ...STACK.props } }, children: [] };
  return { root: visit(root), elements: elements as Record<string, E> };
}

const text = (id: string, value: string | ActionCardSpecMsg, tone: "default" | "muted" | "warning" = "default"): Part =>
  ({ id, node: { type: "Text", props: { text: typeof value === "string" ? clip(value, 2000) : value, tone, mono: false } } });

const notice = (id: string, msg: ActionCardSpecMsg, tone: "info" | "warning" = "info"): Part =>
  ({ id, node: { type: "Notice", props: { text: msg, tone } } });

interface FieldOptions { mono?: boolean; muted?: boolean; breakAll?: boolean; clamp?: number }
function field(id: string, label: ActionCardMessageKey, value: string | ActionCardSpecMsg | ActionCardSpecEntityRef[], options: FieldOptions = {}): Part {
  return { id, node: { type: "Field", props: { label: actionCardMsg(label), value: typeof value === "string" ? clip(value, 2000) : value, ...options } } };
}

/**
 * Fields listing entities (the web joins their names with ", "): references,
 * at most 50 to a Field, so a longer list takes a second row with the same
 * label; the names as text if an id is not a UUID. None: no Field.
 */
function entityFields(id: string, label: ActionCardMessageKey, kind: EntityKind, ids: readonly string[] | undefined, names: ActionCardSpecNames | undefined, options: FieldOptions = {}): Part[] {
  if (!ids || ids.length === 0) return [];
  const refs = ids.map((raw) => entityRef(kind, raw, names));
  if (refs.some((ref) => ref === null)) {
    return [field(id, label, ids.map((raw) => nameOf(names, kind, raw) ?? shortId(raw)).join(", "), options)];
  }
  const chunks: ActionCardSpecEntityRef[][] = [];
  for (let i = 0; i < refs.length; i += 50) chunks.push(refs.slice(i, i + 50) as ActionCardSpecEntityRef[]);
  return chunks.map((chunk, index) => field(index === 0 ? id : `${id}${index + 1}`, label, chunk, options));
}

/**
 * The agent's note on why it prepared the card (ActionCard's "Reason" hint): a
 * `reason` column of the muted label over the note, which a client draws as
 * the hint.
 */
function reasonParts(draftHint: string | undefined): MaybePart[] {
  if (!draftHint) return [];
  return [group("reason", [text("reasonLabel", actionCardMsg("actionCard.reason"), "muted"), text("reasonText", draftHint)], "reason")];
}

/** Unique ids a ScopeList can carry as its `scopes` or `groups`. */
function fitsScopeList(ids: readonly string[], kind: keyof typeof SCOPE_LIST_MAX): boolean {
  return ids.length > 0 && ids.length <= SCOPE_LIST_MAX[kind] && ids.every((id) => SCOPE_ID.test(id));
}

/**
 * The permissions a card asks for (ActionCardScopes): the client names each
 * scope and adds the agent-inbound notes for `agentName`. Scopes a ScopeList
 * cannot carry are listed as text, as the web lists scopes it has no copy for.
 */
function scopeParts(scopes: readonly string[] | undefined, agentName?: string): MaybePart[] {
  if (!scopes) return [];
  const shown = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  const label = actionCardMsg("actionCard.permissions", { count: shown.length });
  if (shown.length === 0) return [{ id: "scopes", node: { type: "Field", props: { label, value: "-", mono: true } } }];
  if (fitsScopeList(shown, "scopes")) {
    return [{ id: "scopes", node: { type: "ScopeList", props: { scopes: shown, ...(agentName ? { agentName: clip(agentName, 100) } : {}) } } }];
  }
  return [{ id: "scopes", node: { type: "Field", props: { label, value: clip(shown.join(", "), 2000), mono: true, breakAll: true } } }];
}

/** The card's primary button, in the card's actions row. */
function button(id: string, label: ActionCardMessageKey, action: ActionCardSpecAction, disabledReason?: ActionCardSpecMsg): Part {
  return actions([{ id, node: { type: "Button", props: { label: actionCardMsg(label), emphasis: "primary", action, ...(disabledReason ? { disabledReason } : {}) } } }]);
}

/**
 * The card's actions row (DS MessageActionCardActions: under the body, at the
 * end): an `actions` row Stack of only Buttons, which a client draws as that
 * row. A Button straight in the root column would be drawn as a body element
 * instead.
 */
export const ACTION_CARD_SPEC_ACTIONS_ID = "actions";
function actions(buttons: Part[]): Part {
  return { id: ACTION_CARD_SPEC_ACTIONS_ID, node: { type: "Stack", props: { direction: "row", wrap: true, role: "actions" } }, children: buttons };
}

/** Plain text for a Msg param (at most 500 code points). */
const param = (value: string) => clip(value, 500);

/**
 * An agent the card stored by id and name, for a Msg param: a reference, so a
 * client shows its current name (the stored one goes stale on a rename), with
 * the stored name as the fallback. Not a UUID: the stored name as text.
 */
const storedAgent = (id: string, name: string) => entityRef("agent", id, undefined, name) ?? param(name);

/** The Agent row, naming the agent as the title does: a rename can't leave them disagreeing. */
const agentField = (agent: ActionCardSpecEntityRef | string) =>
  field("agent", "actionCard.field.agent", typeof agent === "string" ? agent : [agent]);

// ---------------------------------------------------------------------------
// One builder per type.

const CONNECT_MCP_TITLE = "actionCard.title.connectMcp";

type Of<T extends ActionCardAction["type"]> = Extract<ActionCardAction, { type: T }>;
interface Built { icon: ActionCardSpecIcon; title: ActionCardSpecMsg; body: MaybePart[] }

function channelCreate(action: Of<"channel:create">, names?: ActionCardSpecNames): Built {
  return {
    icon: "hash",
    // A message per visibility: the adjective is copy, not a value.
    title: actionCardMsg(action.visibility === "private" ? "actionCard.title.createPrivateChannel" : "actionCard.title.createPublicChannel", { name: param(action.name) }),
    body: [
      group("properties", [
        action.description ? field("description", "actionCard.field.description", action.description) : null,
        ...entityFields("humans", "actionCard.field.humans", "user", action.initialHumans, names),
        ...entityFields("agents", "actionCard.field.agents", "agent", action.initialAgents, names),
      ]),
      ...reasonParts(action.draftHint),
      button("createChannel", "actionCard.verb.createChannel", { kind: "open", intent: "create_channel" }),
    ],
  };
}

function agentCreate(action: Of<"agent:create">, names?: ActionCardSpecNames): Built {
  const computer = action.requiredComputer ?? action.suggestedComputer;
  return {
    icon: "bot",
    // The name the agent will go by: it has no record yet, so no reference, and
    // no @, as a card names people and agents (a handle is for mentions).
    title: actionCardMsg("actionCard.title.createAgent", { name: param(action.name.replace(/^@/, "")) }),
    body: [
      group("properties", [
        action.description
          ? field("description", "actionCard.field.description", action.description)
          : field("description", "actionCard.field.description", actionCardMsg("actionCard.noDescription"), { muted: true }),
        ...(computer
          ? entityFields("computer", action.requiredComputer ? "actionCard.field.requiredComputer" : "actionCard.field.suggestedComputer", "computer", [computer], names, { mono: true })
          : []),
        action.hosting === "antiproton"
          ? field("hosting", "actionCard.field.hosting", action.model
            ? actionCardMsg("actionCard.hostedOnModel", { model: param(action.model) })
            : actionCardMsg("actionCard.hosted"))
          : null,
      ]),
      ...reasonParts(action.draftHint),
      button("createAgent", "actionCard.verb.createAgent", { kind: "open", intent: "create_agent" }),
    ],
  };
}

/**
 * An agent is to be moved to another computer: the agent the card names (a
 * reference, so a client shows its current name), the computer it is on
 * (`ctx.currentComputerId`; none, no field) and the one suggested, both as
 * the create-agent card shows its computer. When another agent prepared
 * it (`requesterAgentId`, not the card's Agent), a line under the title says
 * who asked. Its button opens the migration dialog; done, the result says
 * the move started.
 */
function agentMigrate(action: AgentMigrateAction, ctx: ActionCardSpecBuildContext): Built {
  const { names, requesterAgentId } = ctx;
  // Who asked, when it is not the Agent being moved.
  const requestedBy = requesterAgentId && action.agentId && requesterAgentId.toLowerCase() !== action.agentId.toLowerCase() ? requesterAgentId : undefined;
  return {
    icon: "bot",
    // Prepare always stores the Agent; a card without one (built for a test) names none.
    title: actionCardMsg("actionCard.title.migrateAgent", { agent: action.agentId ? entityParam("agent", action.agentId, names) : param("Agent") }),
    body: [
      requestedBy !== undefined && text("requestedBy", actionCardMsg("actionCard.migrateAgent.requestedBy", { agent: entityParam("agent", requestedBy, names) }), "muted"),
      group("properties", [
        // Where it runs now; like every computer on a card, by id only (ActionCardSpecNames).
        ...entityFields("currentComputer", "actionCard.field.currentComputer", "computer", ctx.currentComputerId ? [ctx.currentComputerId] : undefined, names, { mono: true }),
        ...entityFields("computer", "actionCard.field.suggestedComputer", "computer", action.suggestedComputer ? [action.suggestedComputer] : undefined, names, { mono: true }),
      ]),
      ...reasonParts(action.draftHint),
      button("migrateAgent", "actionCard.verb.migrateAgent", { kind: "open", intent: "migrate_agent" }),
    ],
  };
}

/**
 * Done, the card lists who was really added (the result wins): the person may
 * have changed the agent's list in the dialog. The request stays readable in
 * the conversation, and the title keeps it.
 */
function channelAddMember(action: Of<"channel:add_member">, names?: ActionCardSpecNames, result?: ActionCardResult | null): Built {
  const count = (action.humans?.length ?? 0) + (action.agents?.length ?? 0);
  const added = result?.kind === "channel-members" ? result : null;
  return {
    icon: "user_plus",
    title: actionCardPluralMsg("actionCard.title.addMembers", "count", count, { target: entityParam("channel", action.channel, names) }),
    body: [
      group("properties", [
        ...entityFields("channel", "actionCard.field.channel", "channel", [action.channel], names),
        ...entityFields("humans", "actionCard.field.humans", "user", added ? added.addedHumanIds : action.humans, names),
        ...entityFields("agents", "actionCard.field.agents", "agent", added ? added.addedAgentIds : action.agents, names),
      ]),
      ...reasonParts(action.draftHint),
      button("addMembers", "actionCard.verb.addMembers", { kind: "open", intent: "add_members" }),
    ],
  };
}

function approveAgentLogin(action: Of<"integration:approve_agent_login">): Built {
  const agent = storedAgent(action.agentId, action.agentName);
  return {
    icon: "key",
    title: actionCardMsg("actionCard.title.approveLogin", { client: param(action.clientName), agent }),
    body: [
      group("properties", [
        field("service", "actionCard.field.service", action.clientName),
        agentField(agent),
      ]),
      ...reasonParts(action.draftHint),
      ...scopeParts(action.scopes, action.agentName),
      button("approveLogin", "actionCard.verb.approveLogin", { kind: "execute" }),
    ],
  };
}

/** "Setup required" and the App's own setup note, shown once the App has a setup page. */
function setupParts(action: Of<"integration:install_marketplace_app">): MaybePart[] {
  if (!action.setupUrl) return [];
  return [
    notice("setupRequired", actionCardMsg("actionCard.appSetup.requiredAfterInstall")),
    // The App's text: data, so a Text after the notice rather than a Notice (a Notice takes copy only).
    action.setupDescription ? text("setupDescription", action.setupDescription) : null,
  ];
}

/**
 * Installing grants the App's whole permission set on the Server, so the card
 * carries no confirm of its own: a client confirms it in its own install
 * dialog, chosen by the action key, which shows the App (its name, the
 * permissions, the text it adds to agent prompts) as the server has it by the
 * App's id, never from this card's fields (Q1, Tenny 6cad605e; web
 * InstallAppCardDialog). The button is a plain execute for that dialog to run.
 */
function installMarketplaceApp(action: Of<"integration:install_marketplace_app">): Built {
  const agent = storedAgent(action.agentId, action.agentName);
  // Cards prepared before the server bound the App's permission set can't be installed (409).
  const bound = Array.isArray(action.installScopes) && Array.isArray(action.installGroups);
  const unbound = actionCardMsg("actionCard.installDialog.unbound", { agent: param(action.agentName) });
  return {
    icon: "package",
    title: actionCardMsg("actionCard.title.installApp", { client: param(action.clientName), agent }),
    body: [
      notice("ownerOnly", actionCardMsg("actionCard.installMarketplaceOwnerOnly")),
      ...setupParts(action),
      group("properties", [
        field("service", "actionCard.field.service", action.clientName),
        agentField(agent),
      ]),
      ...reasonParts(action.draftHint),
      ...scopeParts(action.scopes, action.agentName),
      button("installApp", "actionCard.verb.installApp", { kind: "execute" }, bound ? undefined : unbound),
    ],
  };
}

/** The App registration fields both register and update cards list. */
function appUrlFields(action: Of<"integration:register_app"> | Of<"integration:update_app_registration">): MaybePart[] {
  return [
    action.homepageUrl ? field("appUrl", "actionCard.field.appUrl", action.homepageUrl, { breakAll: true }) : null,
    action.agentManifestUrl ? field("agentManifest", "actionCard.field.agentManifest", action.agentManifestUrl, { breakAll: true }) : null,
    action.setupUrl ? field("setupUrl", "actionCard.appSetup.urlLabel", action.setupUrl, { breakAll: true }) : null,
    action.setupDescription ? field("setupDescription", "actionCard.appSetup.descriptionLabel", action.setupDescription) : null,
  ];
}

function registerApp(action: Of<"integration:register_app">): Built {
  return {
    icon: "app",
    title: actionCardMsg("actionCard.title.registerApp", { name: param(action.name) }),
    body: [
      notice("ownerNote", actionCardMsg("actionCard.registerOwnerNote")),
      action.unsafeDemoUrlOverride ? notice("unsafeDemoUrl", actionCardMsg("actionCard.unsafeDemoUrlOverride")) : null,
      group("properties", [
        action.clientKey
          ? field("clientKey", "actionCard.field.clientKey", action.clientKey, { mono: true })
          : field("clientKey", "actionCard.field.clientKey", actionCardMsg("actionCard.autoGeneratedOnCommit")),
        field("redirectUrl", "actionCard.field.redirectUrl", action.returnUrl, { breakAll: true }),
        ...appUrlFields(action),
      ]),
      ...reasonParts(action.draftHint),
      ...scopeParts(action.scopes),
      button("registerApp", "actionCard.verb.registerApp", { kind: "execute" }),
    ],
  };
}

function updateAppRegistration(action: Of<"integration:update_app_registration">): Built {
  return {
    icon: "app",
    title: actionCardMsg("actionCard.title.updateApp", { clientKey: param(action.clientKey) }),
    // Prepare and execute both refuse this type now (410): nothing to press.
    body: [
      notice("unavailable", actionCardMsg("actionCard.updateAppUnavailable")),
      action.unsafeDemoUrlOverride ? notice("unsafeDemoUrl", actionCardMsg("actionCard.unsafeDemoUrlOverride")) : null,
      group("properties", [
        field("clientKey", "actionCard.field.clientKey", action.clientKey, { mono: true }),
        action.name ? field("name", "actionCard.field.name", action.name) : null,
        action.returnUrl ? field("redirectUrl", "actionCard.field.redirectUrl", action.returnUrl, { breakAll: true }) : null,
        ...appUrlFields(action),
      ]),
      ...reasonParts(action.draftHint),
      ...scopeParts(action.scopes),
    ],
  };
}

function recoverAppOwner(action: Of<"integration:recover_app_owner">, names?: ActionCardSpecNames): Built {
  return {
    icon: "shield",
    // A reference, as the row below: an agent can name the target by its handle, and a client shows the display name.
    title: actionCardMsg("actionCard.title.recoverOwner", {
      clientKey: param(action.clientKey),
      agent: entityRef("agent", action.targetAgent, names) ?? param(nameOf(names, "agent", action.targetAgent) ?? shortId(action.targetAgent)),
    }),
    body: [
      notice("adminOnly", actionCardMsg("actionCard.adminRecoveryOnly")),
      group("properties", [
        field("clientKey", "actionCard.field.clientKey", action.clientKey, { mono: true }),
        ...entityFields("recoveryOwner", "actionCard.field.recoveryOwner", "agent", [action.targetAgent], names, { mono: true }),
      ]),
      ...reasonParts(action.draftHint),
      button("recoverOwner", "actionCard.verb.recoverOwner", { kind: "execute" }),
    ],
  };
}

function connectMcp(action: Of<"integration:connect_mcp">, names?: ActionCardSpecNames): Built {
  const app = names?.mcpApp?.trim();
  // The client keeps its own connection picker (McpConnectCardBody) below
  // this: who may grant, and which Connections, is projected per viewer. So
  // no notice: what to do here differs by viewer and state, and a card's
  // notice stands for all of them.
  return {
    icon: "plug",
    // A card stored without the App's name keeps the fixed title.
    title: app
      ? actionCardMsg(CONNECT_MCP_TITLE, { app: param(app), agent: entityParam("agent", action.agentId, names) })
      : actionCardMsg("actionCard.verb.connectMcp"),
    body: reasonParts(action.draftHint),
  };
}

function feedbackSubmit(action: Of<"feedback:submit">): Built {
  return {
    icon: "message",
    title: actionCardMsg("actionCard.title.submitFeedback"),
    body: [
      group("properties", [
        field("feedbackType", "actionCard.field.feedbackType",
          actionCardMsg(action.feedbackType === "problem" ? "actionCard.feedbackType.problem" : "actionCard.feedbackType.idea")),
        // Up to 10,000 characters: the card carries the first 2,000 and shows at most 6 lines; the form has it all.
        field("feedback", "actionCard.field.feedback", action.message, { clamp: 6 }),
      ]),
      ...reasonParts(action.draftHint),
      button("submitFeedback", "actionCard.verb.submitFeedback", { kind: "open", intent: "feedback_form" }),
    ],
  };
}

/** The feedback card's one form (form.v1): its id, and the TextArea's limit. */
export const FEEDBACK_SUBMIT_FORM_ID = "feedback";
/**
 * The message's limit in the form, in code points: TextArea's maximum in
 * action-card.v1. The dialog takes 10,000 UTF-16 units
 * (FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH, which the server still applies); a
 * draft longer than this does not fit the form's default, and its card keeps
 * the dialog's button instead (actionCardPresentation.ts).
 */
export const FEEDBACK_SUBMIT_FORM_MESSAGE_MAX_LENGTH = 8000;

/**
 * The feedback card's form: the dialog's fields (FeedbackCardForm.tsx), the
 * Idea / Problem choice and the message, prefilled with the agent's draft as
 * plain strings. Its title and Submit are the dialog's; its description says
 * what is sent with the text. The server makes it the card's form
 * (services/feedbackCardForm.ts) and checks what comes back.
 */
export function buildFeedbackSubmitForms(action: Extract<ActionCardAction, { type: "feedback:submit" }>): Record<string, ActionCardSpecForm> {
  return {
    [FEEDBACK_SUBMIT_FORM_ID]: {
      title: actionCardMsg("actionCard.feedback.dialogTitle"),
      submitLabel: actionCardMsg("actionCard.feedback.submit"),
      description: actionCardMsg("actionCard.feedback.form.description"),
      fields: [
        {
          type: "Select",
          name: "type",
          label: actionCardMsg("actionCard.field.feedbackType"),
          required: true,
          options: [
            { value: "idea", label: actionCardMsg("actionCard.feedbackType.idea") },
            { value: "problem", label: actionCardMsg("actionCard.feedbackType.problem") },
          ],
          default: action.feedbackType,
        },
        {
          type: "TextArea",
          name: "message",
          label: actionCardMsg("actionCard.field.feedback"),
          required: true,
          maxLength: FEEDBACK_SUBMIT_FORM_MESSAGE_MAX_LENGTH,
          rows: 6,
          default: action.message,
        },
      ],
    },
  };
}

type GateHint = ActionCardMessageKey | { plural: "actionCard.upgradeDialog.jointHostLimit.hint"; count: "hosts" };
/** The upgrade dialog's line on Free and Pro for each limit (UpgradeDialog's GATE_COPY hints). */
const GATE_HINTS: Record<Exclude<AgentUpgradeCardGate, typeof GENERAL_UPGRADE_GATE>, GateHint> = {
  history_30d: "actionCard.upgradeDialog.history.hint",
  upload_monthly_quota: "actionCard.upgradeDialog.uploadQuota.hint",
  upload_file_size: "actionCard.upgradeDialog.fileSize.hint",
  joint_channel_free_cap: "actionCard.upgradeDialog.jointFreeCap.hint",
  joint_channel_host_limit: { plural: "actionCard.upgradeDialog.jointHostLimit.hint", count: "hosts" },
  joint_channel_over_limit: "actionCard.upgradeDialog.jointOverLimit.hint",
  joint_channel_read_only: "actionCard.upgradeDialog.jointReadOnly.hint",
  agent_migration: "actionCard.upgradeDialog.migration.hint",
};

function planUpgrade(action: Of<"plan:upgrade">, serverName: string): Built {
  const gate = action.gate ?? GENERAL_UPGRADE_GATE;
  // UpgradeDialog's gateValues, the same numbers the dialog states.
  const mb = (bytes: number) => `${bytes / (1024 * 1024)} MB`;
  const values = {
    server: param(serverName),
    days: PLAN_CONFIG.free.limits.messageHistoryDays,
    monthly: mb(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES),
    single: mb(FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES),
    proSingle: mb(PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES),
    freeServers: MAX_JOINT_CHANNEL_FREE_SERVERS,
  };
  const hint = gate === GENERAL_UPGRADE_GATE ? null : GATE_HINTS[gate];
  const hintMsg = hint === null ? null : typeof hint === "string"
    ? actionCardMsg(hint, values)
    : actionCardPluralMsg(hint.plural, hint.count, MAX_FREE_SERVER_HOSTED_JOINT_CHANNELS, values);
  return {
    icon: "credit_card",
    title: actionCardMsg("actionCard.title.upgradeToPro"),
    body: [
      // The agent's one sentence (a hint, without a label), then Raft's note on the limit it hit (none for `general`).
      group("reason", [text("reasonText", action.reason)], "reason"),
      hintMsg ? notice("gateHint", hintMsg) : null,
      button("upgrade", "actionCard.billing.upgradeToPro", { kind: "open", intent: "upgrade_dialog", gate }),
    ],
  };
}

/** What a seat request is for: the "For" row. */
function seatsPurposeMsg(purpose: SeatsAddPurpose): ActionCardSpecMsg {
  switch (purpose.kind) {
    case "agent:create": return actionCardMsg("actionCard.seats.purpose.agent", { name: param(purpose.name) });
    case "assistant:create": return actionCardMsg("actionCard.seats.purpose.assistant");
    case "invite": return actionCardMsg("actionCard.seats.purpose.invite", { emails: param(purpose.emails.join(", ")) });
    case "member:promote":
      // A message per role: the role is copy, not a value.
      return actionCardMsg(purpose.role === "admin" ? "actionCard.seats.purpose.promoteAdmin" : "actionCard.seats.purpose.promoteMember", { name: param(purpose.name) });
    case "join": return actionCardMsg("actionCard.seats.purpose.join", { name: param(purpose.name) });
  }
}

/**
 * Raft's note on what adding the seats does: the owner finishes invites and a
 * promotion; someone a full link turned away opens it again; anything else is
 * the requester's.
 */
function seatsNotice(purpose: SeatsAddPurpose, ctx: ActionCardSpecBuildContext, names: ActionCardSpecNames | undefined): Part | null {
  const server = param(ctx.serverName ?? "");
  switch (purpose.kind) {
    case "invite": return notice("notice", actionCardMsg("actionCard.seats.notice.invite", { server }));
    case "member:promote":
      return notice("notice", actionCardMsg(purpose.role === "admin" ? "actionCard.seats.notice.promoteAdmin" : "actionCard.seats.notice.promoteMember", { server, name: param(purpose.name) }));
    case "join": return notice("notice", actionCardMsg("actionCard.seats.notice.join", { server, name: param(purpose.name) }));
    case "agent:create":
    case "assistant:create":
      // Names the requester: a card stored without one keeps the rows below and no note.
      return ctx.requesterUserId
        ? notice("notice", actionCardMsg("actionCard.seats.notice.requester", { server, requester: entityParam("user", ctx.requesterUserId, names) }))
        : null;
  }
}

/**
 * A person's seat request (task #10): what it is for and why, while it holds
 * them (an ended request holds neither), and Add Seats, the owner's flow
 * (`add_seats`). Only an owner may run it; the server checks.
 */
function seatsAdd(action: SeatsAddAction, ctx: ActionCardSpecBuildContext): Built {
  const purpose = action.purpose;
  return {
    icon: "credit_card",
    title: actionCardPluralMsg("actionCard.title.addSeats", "count", action.seats),
    body: [
      purpose ? seatsNotice(purpose, ctx, ctx.names) : null,
      purpose ? group("properties", [field("for", "actionCard.field.for", seatsPurposeMsg(purpose))]) : null,
      // The requester's own sentence, shown as an agent's reason is.
      ...reasonParts(action.reason),
      button("addSeats", "actionCard.verb.addSeats", { kind: "open", intent: "add_seats" }),
    ],
  };
}

/** The approval card's one form (form.v1) and its one field. */
export const AGENT_APPROVE_CALL_FORM_ID = "decision";
export const AGENT_APPROVE_CALL_DECISION_FIELD = "decision";

/**
 * A held call (antiproton, docs/contracts/hosted-agent-approvals.md): who holds
 * it and why, what runs (antiproton's summary, verbatim, in monospace), what
 * approving does (its description, verbatim) and when it expires. All of it
 * is antiproton's plain text (and may carry what the agent wrote): Text and
 * Field strings, never a template, a link or markup. Its button opens the
 * decision form (agentApproveCallForm.ts on the server).
 */
function agentApproveCall(action: AgentApproveCallAction): Built {
  const agent = param(action.agentName);
  const summary = action.summaryWithheld || !action.summary
    ? (action.summaryWithheld ? notice("withheld", actionCardMsg("actionCard.approveCall.withheld"), "warning") : null)
    : group("summary", [
      text("summaryLabel", actionCardMsg("actionCard.approveCall.whatRuns"), "muted"),
      { id: "summaryText", node: { type: "Text", props: { text: clip(action.summary, 2000), tone: "default", mono: true } } },
      action.summaryTruncated ? text("summaryTruncated", actionCardMsg("actionCard.approveCall.truncated"), "muted") : null,
    ]);
  return {
    icon: "shield",
    title: actionCardMsg("actionCard.title.approveCall", { agent }),
    body: [
      notice("held", actionCardMsg(action.heldBy === "agent" ? "actionCard.approveCall.heldByAgent" : "actionCard.approveCall.heldByPolicy", { agent })),
      action.decider === "server_admin" ? notice("ownerGone", actionCardMsg("actionCard.approveCall.ownerGone", { agent })) : null,
      group("properties", [
        field("call", "actionCard.approveCall.field.call", action.call, { mono: true, breakAll: true }),
        action.plugin ? field("plugin", "actionCard.approveCall.field.plugin", action.plugin) : null,
        action.request ? field("request", "actionCard.approveCall.field.request", action.request, { mono: true, breakAll: true }) : null,
      ]),
      summary,
      action.description
        ? group("description", [text("descriptionLabel", actionCardMsg("actionCard.approveCall.whatApprovingDoes"), "muted"), text("descriptionText", action.description)])
        : null,
      action.expiresAt ? {
        id: "expiry",
        node: { type: "Stack", props: { direction: "row", wrap: true } },
        children: [text("expiresLabel", actionCardMsg("actionCard.approveCall.expires"), "muted"), { id: "expiresAt", node: { type: "RelativeTime", props: { at: action.expiresAt } } }],
      } : null,
      button("decide", "actionCard.verb.decideCall", { kind: "execute" }),
    ],
  };
}

/**
 * `assistant:owner_action` (#proj-assistant:#19): a personal assistant asks to
 * do something as its owner. Everything on it is Raft's text, built from the
 * owner-action table and the names Raft resolved as the owner; the assistant
 * wrote none of it. Who asked, what happens, when it expires, and the decision
 * form (assistantOwnerActionForm.ts on the server checks it is the owner).
 */
function assistantOwnerAction(action: AssistantOwnerActionCardAction): Built {
  const assistant = param(action.assistantName);
  const { title, whatHappens } = assistantOwnerActionCopy(action, assistant);
  return assistantOwnerActionLanguage(action, {
    icon: "shield",
    title,
    body: [
      group("whatHappens", [
        text("whatHappensLabel", actionCardMsg("actionCard.assistantOwnerAction.whatHappens"), "muted"),
        text("whatHappensText", whatHappens),
      ]),
      notice("askedBy", actionCardMsg("actionCard.assistantOwnerAction.askedBy", { assistant }), "warning"),
      {
        id: "expiry",
        node: { type: "Stack", props: { direction: "row", wrap: true } },
        children: [text("expiresLabel", actionCardMsg("actionCard.approveCall.expires"), "muted"), { id: "expiresAt", node: { type: "RelativeTime", props: { at: action.expiresAt } } }],
      },
      button("decide", "actionCard.verb.decideOwnerAction", { kind: "execute" }),
    ],
  });
}

/**
 * A card without its own copy (`view`; every card posted before views) is all
 * English: its title and description are Raft's English, and a translated frame
 * around them read worse than all-English (Sage). So every Msg on it, the form
 * included, keeps only `text.en`. A card with a `view` is in the viewer's language.
 */
function assistantOwnerActionLanguage<T>(action: Pick<AssistantOwnerActionCardAction, "view">, built: T): T {
  return action.view ? built : englishOnly(built);
}

function englishOnly<T>(value: T): T {
  if (Array.isArray(value)) return value.map(englishOnly) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) out[key] = englishOnly(nested);
  const text = out.text as Record<string, unknown> | undefined;
  if (typeof out.key === "string" && text && typeof text === "object" && typeof text.en === "string") out.text = { en: text.en };
  return out as T;
}

/**
 * The title and "what happens" in the viewer's language when the entry has its
 * own copy (`view`); otherwise Raft's English phrase and description as stored.
 */
function assistantOwnerActionCopy(action: AssistantOwnerActionCardAction, assistant: string): { title: ActionCardSpecMsg; whatHappens: ActionCardSpecMsg | string } {
  const view = action.view;
  if (view?.kind === "moveAgent") {
    const names = { agent: param(view.agent), to: param(view.to) };
    return {
      title: actionCardMsg("actionCard.title.assistantOwnerAction.moveAgent", { assistant, ...names }),
      whatHappens: view.from
        ? actionCardMsg("actionCard.assistantOwnerAction.moveAgent.description", { ...names, from: param(view.from) })
        : actionCardMsg("actionCard.assistantOwnerAction.moveAgent.descriptionNoSource", names),
    };
  }
  return {
    title: actionCardMsg("actionCard.title.assistantOwnerAction", { assistant, phrase: param(action.phrase) }),
    whatHappens: clip(action.description, 1000),
  };
}

/**
 * How an owner-action card ended. A card with its own copy (`view`) and a
 * result with its `line` shows it in the viewer's language; otherwise Raft's
 * English line as stored (an old card stays English throughout).
 */
function assistantOwnerActionResult(action: StoredActionCardAction, result: Extract<ActionCardResult, { kind: "assistant-owner-action" }>): MaybePart[] {
  const tone = result.ok || result.decision === "declined" ? "default" : "warning";
  const line = result.line;
  if (action.type !== "assistant:owner_action" || !action.view || !line) return [text("summary", clip(result.summary, 1000), tone)];
  switch (line.kind) {
    case "declined":
      return [text("summary", actionCardMsg("actionCard.result.assistantOwnerAction.declined"), tone)];
    case "unknown":
      return [text("summary", actionCardMsg("actionCard.result.assistantOwnerAction.unknown"), tone)];
    case "failed":
      return [text("summary", actionCardMsg("actionCard.result.assistantOwnerAction.failed", { error: param(clip(line.error, 900)) }), tone)];
    case "moveStarted":
      return [
        text("summary", actionCardMsg("actionCard.result.assistantOwnerAction.moveStarted", { agent: param(line.agent), to: param(line.to) }), tone),
        line.arrivalAt ? {
          id: "arrival",
          node: { type: "Stack", props: { direction: "row", wrap: true } },
          children: [text("arrivalLabel", actionCardMsg("actionCard.result.assistantOwnerAction.arrivesBy"), "muted"), { id: "arrivalAt", node: { type: "RelativeTime", props: { at: line.arrivalAt } } }],
        } : null,
      ];
  }
}

export const ASSISTANT_OWNER_ACTION_FORM_ID = "decision";
export const ASSISTANT_OWNER_ACTION_DECISION_FIELD = "decision";

/** Confirm or Decline with no default; the submit button says which (submitLabels). All English on a card without a `view`. */
export function buildAssistantOwnerActionForms(action: AssistantOwnerActionCardAction): Record<string, ActionCardSpecForm> {
  return assistantOwnerActionLanguage(action, {
    [ASSISTANT_OWNER_ACTION_FORM_ID]: {
      title: actionCardMsg("actionCard.assistantOwnerAction.form.title"),
      submitLabel: actionCardMsg("actionCard.assistantOwnerAction.form.submit"),
      submitLabels: {
        field: ASSISTANT_OWNER_ACTION_DECISION_FIELD,
        labels: {
          confirm: actionCardMsg("actionCard.assistantOwnerAction.form.confirm"),
          decline: actionCardMsg("actionCard.assistantOwnerAction.form.decline"),
        },
      },
      description: actionCardMsg("actionCard.assistantOwnerAction.form.description"),
      fields: [{
        type: "Select",
        name: ASSISTANT_OWNER_ACTION_DECISION_FIELD,
        label: actionCardMsg("actionCard.assistantOwnerAction.form.decision"),
        required: true,
        options: [
          { value: "confirm", label: actionCardMsg("actionCard.assistantOwnerAction.form.confirm") },
          { value: "decline", label: actionCardMsg("actionCard.assistantOwnerAction.form.decline") },
        ],
      }],
    },
  });
}

/**
 * The decision form: Approve or Deny with no default, so nothing is decided
 * until the person picks one; the submit button says what pressing does
 * (submitLabels). The server checks the decider again when it arrives.
 */
export function buildAgentApproveCallForms(): Record<string, ActionCardSpecForm> {
  return {
    [AGENT_APPROVE_CALL_FORM_ID]: {
      title: actionCardMsg("actionCard.approveCall.form.title"),
      submitLabel: actionCardMsg("actionCard.approveCall.form.submit"),
      submitLabels: {
        field: AGENT_APPROVE_CALL_DECISION_FIELD,
        labels: {
          approve: actionCardMsg("actionCard.approveCall.form.submitApprove"),
          deny: actionCardMsg("actionCard.approveCall.form.submitDeny"),
        },
      },
      description: actionCardMsg("actionCard.approveCall.form.description"),
      fields: [{
        type: "Select",
        name: AGENT_APPROVE_CALL_DECISION_FIELD,
        label: actionCardMsg("actionCard.approveCall.form.decision"),
        required: true,
        options: [
          { value: "approve", label: actionCardMsg("actionCard.approveCall.form.approve") },
          { value: "deny", label: actionCardMsg("actionCard.approveCall.form.deny") },
        ],
      }],
    },
  };
}

/** Who ended a hold, by role (none for an expiry: the status says it). */
function decidedByMsg(decidedBy: AgentCallApprovalDecidedBy): ActionCardSpecMsg | null {
  if (decidedBy.via === "console") return actionCardMsg("actionCard.approveCall.decidedBy.console");
  if (decidedBy.via === "expiry") return null;
  switch (decidedBy.role) {
    case "agent_owner": return actionCardMsg("actionCard.approveCall.decidedBy.agentOwner");
    case "server_owner": return actionCardMsg("actionCard.approveCall.decidedBy.serverOwner");
    case "server_admin": return actionCardMsg("actionCard.approveCall.decidedBy.serverAdmin");
  }
}

const APPROVE_CALL_RESULT_MESSAGES = {
  approved: "actionCard.result.approveCall.approved",
  executed: "actionCard.result.approveCall.executed",
  failed: "actionCard.result.approveCall.failed",
  denied: "actionCard.result.approveCall.denied",
  expired: "actionCard.result.approveCall.expired",
  unavailable: "actionCard.result.approveCall.unavailable",
} as const satisfies Record<Extract<ActionCardResult, { kind: "agent-call-approval" }>["status"], ActionCardMessageKey>;

function agentCallApprovalResult(result: Extract<ActionCardResult, { kind: "agent-call-approval" }>): MaybePart[] {
  const by = result.decidedBy ? decidedByMsg(result.decidedBy) : null;
  const outcome = result.outcome;
  return [
    text("summary", actionCardMsg(APPROVE_CALL_RESULT_MESSAGES[result.status])),
    group("decision", [
      by ? field("decidedBy", "actionCard.approveCall.field.decidedBy", by) : null,
    ]),
    result.decidedAt && by ? {
      id: "decidedAtRow",
      node: { type: "Stack", props: { direction: "row", wrap: true } },
      children: [text("decidedAtLabel", actionCardMsg("actionCard.approveCall.field.decidedAt"), "muted"), { id: "decidedAt", node: { type: "RelativeTime", props: { at: result.decidedAt } } }],
    } : null,
    outcome && (outcome.withheld || outcome.summary) ? group("outcome", [
      text("outcomeLabel", actionCardMsg("actionCard.approveCall.field.result"), "muted"),
      outcome.withheld
        ? text("outcomeWithheld", actionCardMsg("actionCard.approveCall.outcomeWithheld"), "muted")
        : { id: "outcomeText", node: { type: "Text", props: { text: clip(outcome.summary, 2000), tone: "default", mono: true, clamp: 6 } } },
      outcome.truncated && !outcome.withheld ? text("outcomeTruncated", actionCardMsg("actionCard.approveCall.outcomeTruncated"), "muted") : null,
    ]) : null,
  ];
}

// ---------------------------------------------------------------------------
// Question cards (`question:ask`, question-card spec §2.4, §5). Raft's copy
// around the agent's plain text: a Field or Text string where the slot takes
// one, the raw Msg (actionCardRawText) where it takes only a Msg (form
// labels, descriptions, placeholders, options). The body's button executes;
// withActionCardForms turns it into `open_form` with the form below. An
// answered card has neither: the person can no longer open the form, so it
// carries none (the answers are in its result), and a withdrawn or expired
// card is never rebuilt (the server changes only its state). Element counts:
// at most 12 in the body (root, the properties column with For and 4
// questions, the reason column and the actions row), 9 in the result (root, a
// question and an answer row per question). The size bounds are
// QUESTION_ASK_LIMITS'.

/** Unpaired surrogates, which JSON writes as 6-byte escapes: dropped from the answers a card shows. */
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The question card's one form, `answers`. */
export const QUESTION_ASK_FORM_ID = "answers";
/** The rows of a text question's text area. */
const QUESTION_ASK_TEXT_AREA_ROWS = 4;

/** "For": the person asked (a reference), or anyone in the channel. None before the server resolved `to`. */
function questionForField(action: QuestionAskAction, names: ActionCardSpecNames | undefined): Part[] {
  const addressee = action.addressee;
  if (!addressee) return [];
  if (addressee.kind === "anyone") return [field("for", "actionCard.question.for", actionCardMsg("actionCard.question.anyone"))];
  const named = nameOf(names, "user", addressee.userId.toLowerCase()) ? names : mergeActionCardSpecNames(names, { users: { [addressee.userId.toLowerCase()]: addressee.handle } });
  return entityFields("for", "actionCard.question.for", "user", [addressee.userId], named);
}

/** A question's label: "Question" alone on a one-question card, else "Question {n}". */
const questionLabel = (count: number, index: number): ActionCardSpecMsg =>
  count === 1 ? actionCardMsg("actionCard.question.question") : actionCardMsg("actionCard.question.questionN", { n: index + 1 });

/**
 * A question's element id on the card: `q` its row in the body (the web drops
 * it when it asks the question inline, QuestionInlineForm), `a` its answer in
 * the result.
 */
export const questionElementId = (prefix: "q" | "a", id: string) => `${prefix}_${id}`;

function questionAsk(action: QuestionAskAction, ctx: ActionCardSpecBuildContext): Built {
  const count = action.questions.length;
  // Answered: the result pairs each question with its answer (spec §2.4), so the body no longer lists them.
  const answered = ctx.result?.kind === "question-answers";
  return {
    icon: "message",
    title: actionCardPluralMsg("actionCard.question.title", "count", count),
    body: [
      group("properties", [
        ...questionForField(action, ctx.names),
        ...(answered ? [] : action.questions.map((question, index): Part => ({
          id: questionElementId("q", question.id),
          node: { type: "Field", props: { label: questionLabel(count, index), value: clip(question.text, 2000) } },
        }))),
      ]),
      ...reasonParts(action.reason),
      // Answered: nothing left to press, and no form for a button to open (buildQuestionAskForms).
      answered ? null : actions([{ id: "answer", node: { type: "Button", props: {
        label: actionCardPluralMsg("actionCard.question.answer", "count", count),
        emphasis: "primary",
        action: { kind: "execute" },
      } } }]),
    ],
  };
}

/** The raw Msg for an agent's text, when it has any. */
const raw = (text: string | undefined) => (text && text.trim() ? actionCardRawText(text) : undefined);

function questionField(question: QuestionAskQuestion): ActionCardSpecField {
  const common = {
    name: question.id,
    label: actionCardRawText(question.text),
    ...(question.description ? { description: actionCardRawText(question.description) } : {}),
    required: question.required,
  };
  if (question.kind === "text") {
    const maxLength = question.maxLength ?? 1000;
    return question.multiline === false
      ? { type: "TextInput", ...common, maxLength }
      : { type: "TextArea", ...common, maxLength, rows: QUESTION_ASK_TEXT_AREA_ROWS };
  }
  const options = (question.options ?? []).map((option) => ({ value: option.value, label: actionCardRawText(option.label) }));
  // A confirm (one option, single or multiple): a single Choice of that option and no Other…, so
  // a tap on it answers and a client may draw it as one button. Its answer is the option, as any choice's.
  if (isQuestionAskConfirm(question)) return { type: "Choice", ...common, multiple: false, options };
  const other: { placeholder?: string; maxLength?: number } = question.other ?? {};
  const placeholder = raw(other.placeholder);
  return {
    type: "Choice",
    ...common,
    multiple: question.kind === "multiple",
    ...(question.kind === "multiple" && question.minItems !== undefined ? { minItems: question.minItems } : {}),
    ...(question.kind === "multiple" && question.maxItems !== undefined ? { maxItems: question.maxItems } : {}),
    options,
    // Every choice question of two or more options ends in Other… (spec §5.10): Raft's short label only (no description, and
    // no placeholder of Raft's: the client shows its own), plus the agent's placeholder if it gave one.
    // Raft copy repeated on every question costs 24 KiB budget (QUESTION_ASK_LIMITS).
    other: {
      label: actionCardMsg("actionCard.question.other"),
      ...(placeholder ? { placeholder } : {}),
      maxLength: other.maxLength ?? QUESTION_ASK_LIMITS.otherMaxLength,
    },
  };
}

/** The sheet's pages: the agent's `pages`, else a question a page; none for one page. */
function questionSteps(action: QuestionAskAction): ActionCardSpecFormStep[] | null {
  const pages = action.pages ?? action.questions.map((question) => [question.id]);
  return pages.length >= 2 ? pages.map((fields) => ({ fields: [...fields] })) : null;
}

/**
 * When a question card is answered on the card itself (question-card spec
 * §5.9): at most 3 questions, every one a choice (single or multiple; Other…
 * is the card's own row and its input shows only once chosen), each option's
 * label at most 32 columns wide (a CJK or fullwidth character takes two), so
 * on a 390-wide phone an option is one line, and no `pages` (an agent that
 * pages its questions gets the sheet it asked for). The spec's other two
 * conditions, at most 5 options and none with a description, hold for every
 * question card (QUESTION_ASK_LIMITS: 4 options; options take no description).
 */
export const QUESTION_ASK_INLINE_LIMITS = { questions: 3, optionLabelColumns: 32 } as const;

/** Where a question card's form is filled in: `inline` on the card (QUESTION_ASK_INLINE_LIMITS), else the sheet. */
export function questionAskPlacement(action: Pick<QuestionAskAction, "questions" | "pages">): ActionCardFormPlacement {
  const columns = (text: string) => Array.from(text).reduce((sum, char) => sum + searchSnippetCharWidth(char.codePointAt(0)!), 0);
  const inline = action.pages === undefined
    && action.questions.length <= QUESTION_ASK_INLINE_LIMITS.questions
    && action.questions.every((question) => question.kind !== "text"
      && (question.options ?? []).every((option) => columns(option.label) <= QUESTION_ASK_INLINE_LIMITS.optionLabelColumns));
  return inline ? "inline" : "sheet";
}

/**
 * The question card's form (form.v1): a Choice per choice question (with
 * Other…; a confirm, one option, without), a TextArea (or one-line TextInput) per text question, every field
 * listed in `fields` and paged by `steps`, placed on the card when it is
 * short (questionAskPlacement). Its description says who will see the answers. Needs `ctx.requesterAgentId` (the agent it names); the
 * server's form handler serves it (questionAskForm.ts).
 */
export function buildQuestionAskForms(action: QuestionAskAction, ctx: ActionCardSpecBuildContext): Record<string, ActionCardSpecForm> {
  // Answered: nobody opens the form again; the card keeps none (and no button for one).
  if (ctx.result?.kind === "question-answers") return {};
  if (!ctx.requesterAgentId) throw new Error("A question card's form names the agent that asked: requesterAgentId is required");
  const count = action.questions.length;
  const steps = questionSteps(action);
  return {
    [QUESTION_ASK_FORM_ID]: {
      title: actionCardPluralMsg("actionCard.question.form.title", "count", count),
      submitLabel: actionCardMsg("actionCard.question.form.submit"),
      description: actionCardMsg("actionCard.question.form.visibility", { agent: entityParam("agent", ctx.requesterAgentId, ctx.names) }),
      ...(steps ? { steps } : {}),
      // The sheet is the default: only `inline` is written (spec §5.9).
      ...(questionAskPlacement(action) === "inline" ? { placement: "inline" as const } : {}),
      fields: action.questions.map(questionField),
    },
  };
}

/** One answer as the card shows it: option labels, the person's own text marked as theirs, the text, or No answer. */
function questionAnswerValue(question: QuestionAskQuestion | undefined, answer: ActionCardQuestionAnswer | undefined): { value: string | ActionCardSpecMsg; muted?: boolean } {
  if (!answer || answer.kind === "skipped") return { value: actionCardMsg("actionCard.question.skipped"), muted: true };
  // The card shows each answer cut to QUESTION_ASK_LIMITS.shownAnswer, as plain one-line text (no control
  // character, which JSON would escape to 6 bytes), so it fits 24 KiB once answered whatever was answered;
  // the whole answer is in metadata.result and the reply to the agent. Options and Other share the length.
  const shown = (text: string, max: number = QUESTION_ASK_LIMITS.shownAnswer) => plainActionCardText(text.replace(LONE_SURROGATES, ""), max) || "…";
  if (answer.kind === "text") return answer.text.trim() ? { value: shown(answer.text) } : { value: actionCardMsg("actionCard.question.skipped"), muted: true };
  const labelOf = (value: string) => question?.options?.find((option) => option.value === value)?.label ?? value;
  const choices = answer.selected.map(labelOf).join(", ");
  const own = answer.other?.trim() ? answer.other : undefined;
  if (own === undefined) return choices ? { value: shown(choices) } : { value: actionCardMsg("actionCard.question.skipped"), muted: true };
  const half = Math.floor(QUESTION_ASK_LIMITS.shownAnswer / 2);
  return choices
    ? { value: actionCardMsg("actionCard.question.choicesAndOwnAnswer", { choices: shown(choices, half), text: shown(own, half) }) }
    : { value: actionCardMsg("actionCard.question.ownAnswer", { text: shown(own) }) };
}

/**
 * Each question, then its answer (spec §2.4: in pairs; a client folds all but
 * the first three). At most 4 questions: 8 rows, within a Stack's 12.
 */
function questionAnswersResult(action: StoredActionCardAction, result: Extract<ActionCardResult, { kind: "question-answers" }>): MaybePart[] {
  if (action.type !== "question:ask") return [];
  const count = action.questions.length;
  return action.questions.flatMap((question, index): Part[] => {
    const shown = questionAnswerValue(question, Object.hasOwn(result.answers, question.id) ? result.answers[question.id] : undefined);
    return [
      { id: questionElementId("q", question.id), node: { type: "Field", props: { label: questionLabel(count, index), value: clip(question.text, 2000) } } },
      { id: questionElementId("a", question.id), node: { type: "Field", props: { label: actionCardMsg("actionCard.question.answerLabel"), value: shown.value, ...(shown.muted ? { muted: true } : {}) } } },
    ];
  });
}

// ---------------------------------------------------------------------------
// The question card's size gate (prepare refuses a card over
// QUESTION_CARD_SIZE_THRESHOLD with 400 CARD_TOO_LARGE).

/**
 * A form card (a type with a server form handler) as the server sends it:
 * `card` with `forms`, every button that would act (execute, open a native
 * dialog) opening the first form instead, and a card with no such button
 * given one, labelled with the form's submit label. Navigate buttons stay.
 * No forms: the card as built, which must then have no button that acts (it
 * would end in FORM_REQUIRED); an answered question card is one. The one
 * implementation: the server's actionCardSpecFor and measureQuestionCard
 * (through buildQuestionAskCard) both assemble with it.
 */
export function withActionCardForms(card: ActionCardSpecCard, forms: Record<string, ActionCardSpecForm>): ActionCardSpecCard {
  const acts = (node: ActionCardSpecElement) => node.type === "Button" && (node.props.action.kind === "execute" || node.props.action.kind === "open");
  const [first] = Object.keys(forms);
  if (first === undefined) {
    if (Object.values(card.spec.elements).some(acts)) throw new Error("A form handler built no forms for a card with a button");
    const { forms: _forms, confirms: _confirms, ...rest } = card;
    return rest;
  }
  const action = { kind: "open_form", form: first } as const;
  let opened = false;
  const elements: Record<string, ActionCardSpecElement> = {};
  for (const [id, node] of Object.entries(card.spec.elements)) {
    if (node.type === "Button" && acts(node)) {
      opened = true;
      // Only an execute with a confirm may be destructive.
      elements[id] = { ...node, props: { ...node.props, action, emphasis: node.props.emphasis === "destructive" ? "primary" : node.props.emphasis } };
    } else {
      elements[id] = node;
    }
  }
  if (!opened) {
    const root = elements[card.spec.root];
    // In the card's actions row, as every card's button: the root's `actions`
    // Stack (`actions` above), else one named so by id.
    const rowId = (root?.type === "Stack" ? root.children ?? [] : []).find((id) => {
      const node = elements[id];
      return node?.type === "Stack" && node.props.role === "actions";
    }) ?? (Object.hasOwn(elements, ACTION_CARD_SPEC_ACTIONS_ID) ? ACTION_CARD_SPEC_ACTIONS_ID : undefined);
    const row = rowId === undefined ? undefined : elements[rowId];
    if (!root || root.type !== "Stack" || Object.hasOwn(elements, "openForm") || (row && (row.type !== "Stack" || row.props.direction !== "row"))) {
      throw new Error("No place for the form button");
    }
    if (rowId !== undefined && row?.type === "Stack") {
      elements[rowId] = { ...row, children: [...(row.children ?? []), "openForm"] };
    } else {
      elements[card.spec.root] = { ...root, children: [...(root.children ?? []), ACTION_CARD_SPEC_ACTIONS_ID] };
      elements[ACTION_CARD_SPEC_ACTIONS_ID] = { type: "Stack", props: { direction: "row", wrap: true, role: "actions" }, children: ["openForm"] };
    }
    elements.openForm = { type: "Button", props: { label: forms[first]!.submitLabel, emphasis: "primary", action } };
  }
  // The confirms belonged to the execute buttons replaced above.
  const { confirms: _confirms, ...rest } = card;
  return { ...rest, spec: { root: card.spec.root, elements }, forms };
}

/**
 * A question card as the server sends it (actionCardPresentation's
 * actionCardSpecFor with questionAskFormHandler, whose buildForm is
 * buildQuestionAskForms): the body with its form, by withActionCardForms.
 */
export function buildQuestionAskCard(action: QuestionAskAction, ctx: ActionCardSpecBuildContext): ActionCardSpecCard {
  return withActionCardForms(buildActionCardSpec(action, ctx), buildQuestionAskForms(action, ctx));
}

/** The states a question card can end in; the frame paints the state, so withdrawn and expired are the unanswered card. */
export type QuestionCardState = "unanswered" | "answered" | "withdrawn" | "expired";

export interface QuestionCardMeasure {
  /** UTF-8 bytes of the card's JSON in its largest state, measured as the 24 KiB check measures (the emit-parsed card). */
  bytes: number;
  /** QUESTION_CARD_SIZE_THRESHOLD. */
  threshold: number;
  /** Within the threshold, and every state builds (an emit-valid card but for its size). */
  ok: boolean;
  /** Each state's bytes. */
  states: Record<QuestionCardState, number>;
  /**
   * Each question's own bytes, in the state where they are most: its body
   * row, its form field and page, and once answered its question and answer
   * rows. The rest (title, For, reason, the form's header) is the card's.
   */
  perQuestion: QuestionCardQuestionBytes[];
}

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** A 4-byte character: the most a code point of displayed text takes in UTF-8 JSON (answers are cleaned of what JSON escapes). */
const WORST_CHAR = "\u{1F600}";
const WORST_ID = "00000000-0000-4000-8000-000000000000";

/** Every ordering of `size` of `items` (at most 5! of 5). */
function orderings<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, i) => orderings([...items.slice(0, i), ...items.slice(i + 1)], size - 1).map((rest) => [item, ...rest]));
}

/**
 * The answer to `question` that shows the most bytes on the card, of every
 * answer it may get: no answer (when optional), a text, Other alone, and
 * every choice of options in every order, alone and with Other, up to what
 * it takes. The person's own text is QUESTION_ASK_LIMITS.shownAnswer 4-byte
 * characters (the card shows no more; it cleans what JSON would escape), and
 * the options shown are cut as the card cuts them, so comparing what
 * questionAnswerValue shows is exact.
 */
function worstAnswer(question: QuestionAskQuestion): ActionCardQuestionAnswer {
  const own = WORST_CHAR.repeat(QUESTION_ASK_LIMITS.shownAnswer);
  const candidates: ActionCardQuestionAnswer[] = question.required ? [] : [{ kind: "skipped" }];
  if (question.kind === "text") {
    candidates.push({ kind: "text", text: own });
  } else {
    const values = (question.options ?? []).map((option) => option.value);
    // A confirm offers no Other…: its one option is all it can be answered with.
    const withOther = !isQuestionAskConfirm(question);
    const items = values.length + (withOther ? 1 : 0);
    const max = question.kind === "single" ? 1 : Math.min(question.maxItems ?? items, items);
    if (withOther) candidates.push({ kind: "choice", selected: [], other: own });
    for (let size = 1; size <= Math.min(max, values.length); size++) {
      for (const selected of orderings(values, size)) {
        candidates.push({ kind: "choice", selected });
        if (withOther && size + 1 <= max) candidates.push({ kind: "choice", selected, other: own });
      }
    }
  }
  let worst = candidates[0]!;
  let most = -1;
  for (const candidate of candidates) {
    const bytes = utf8Bytes(questionAnswerValue(question, candidate));
    if (bytes > most) { most = bytes; worst = candidate; }
  }
  return worst;
}

/**
 * The size gate for a question card (question-card spec §2.3): builds it
 * with the real builders in every state it can reach (unanswered, which is
 * also withdrawn and expired; answered, with each question's answer the one
 * it may get that shows the most, the person's own text in 4-byte
 * characters) and the names it shows at their longest (80 four-byte characters), and
 * measures each as the 24 KiB check does. `ok` when the largest is at most
 * `threshold` (QUESTION_CARD_SIZE_THRESHOLD; another only in a test). Pure;
 * never throws (a card that does not build is not ok).
 */
export function measureQuestionCard(action: QuestionAskAction, ctx: ActionCardSpecBuildContext = {}, threshold: number = QUESTION_CARD_SIZE_THRESHOLD): QuestionCardMeasure {
  const agentId = ctx.requesterAgentId ?? WORST_ID;
  const longName = WORST_CHAR.repeat(80);
  const worstNames: ActionCardSpecNames = { agents: { [agentId.toLowerCase()]: longName } };
  if (action.addressee?.kind === "user") worstNames.users = { [action.addressee.userId.toLowerCase()]: longName };
  const base: ActionCardSpecBuildContext = { ...ctx, requesterAgentId: agentId, names: worstNames, result: null };
  let valid = true;
  const measure = (result: ActionCardResult | null): { bytes: number; card: ActionCardSpecCard | null } => {
    let raw: ActionCardSpecCard;
    try {
      raw = buildQuestionAskCard(action, { ...base, result });
    } catch {
      valid = false;
      return { bytes: Number.POSITIVE_INFINITY, card: null };
    }
    const parsed = parseActionCardSpec(raw, { mode: "emit" });
    if (parsed.ok) return { bytes: utf8Bytes(parsed.card), card: parsed.card };
    // Refused: for its size only, or (not ok) for anything else.
    if (actionCardSpecIssues(raw, { mode: "emit" }).some((issue) => !/^The card is \d+ bytes, over \d+$/.test(issue.message))) valid = false;
    return { bytes: utf8Bytes(raw), card: raw };
  };
  const answeredWith = (answers: Record<string, ActionCardQuestionAnswer>): ActionCardResult => ({
    kind: "question-answers", ref: null, answeredBy: { userId: WORST_ID, handle: "h" }, answeredAt: "2026-01-01T00:00:00.000Z", answers,
  });
  // Each question's answer shows in its own row only, so the largest per question makes the largest card.
  const unanswered = measure(null);
  const answered = measure(answeredWith(Object.fromEntries(action.questions.map((question) => [question.id, worstAnswer(question)]))));
  const states: Record<QuestionCardState, number> = { unanswered: unanswered.bytes, answered: answered.bytes, withdrawn: unanswered.bytes, expired: unanswered.bytes };
  const bytes = Math.max(...Object.values(states));
  const own = (card: ActionCardSpecCard | null, id: string) => {
    if (!card) return 0;
    const form = card.forms?.[QUESTION_ASK_FORM_ID];
    const parts = [
      card.spec.elements[questionElementId("q", id)],
      card.result?.elements[questionElementId("q", id)],
      card.result?.elements[questionElementId("a", id)],
      form?.fields.find((field) => field.name === id),
      form?.steps?.find((step) => step.fields.includes(id)),
    ];
    return parts.reduce((sum: number, part) => sum + (part === undefined ? 0 : utf8Bytes(part)), 0);
  };
  return {
    bytes,
    threshold,
    ok: valid && bytes <= threshold,
    states,
    perQuestion: action.questions.map((question) => ({ id: question.id, bytes: Math.max(own(unanswered.card, question.id), own(answered.card, question.id)) })),
  };
}

function buildBody(action: StoredActionCardAction, ctx: ActionCardSpecBuildContext): Built {
  switch (action.type) {
    case "channel:create": return channelCreate(action, ctx.names);
    case "agent:create": return agentCreate(action, ctx.names);
    case "agent:migrate": return agentMigrate(action, ctx);
    case "channel:add_member": return channelAddMember(action, ctx.names, ctx.result);
    case "integration:approve_agent_login": return approveAgentLogin(action);
    case "integration:install_marketplace_app": return installMarketplaceApp(action);
    case "integration:register_app": return registerApp(action);
    case "integration:update_app_registration": return updateAppRegistration(action);
    case "integration:recover_app_owner": return recoverAppOwner(action, ctx.names);
    case "integration:connect_mcp": return connectMcp(action, ctx.names);
    case "feedback:submit": return feedbackSubmit(action);
    case "plan:upgrade": return planUpgrade(action, ctx.serverName ?? "");
    case "seats:add": return seatsAdd(action, ctx);
    case "agent:approve_call": return agentApproveCall(action);
    case "assistant:owner_action": return assistantOwnerAction(action);
    case "question:ask": return questionAsk(action, ctx);
    default: {
      const unknown: never = action;
      throw new Error(`No action-card.v1 builder for ${(unknown as { type?: unknown }).type}`);
    }
  }
}

/** Whether `added` names anyone `asked` doesn't (ids without case). */
const addsUnasked = (asked: readonly string[] | undefined, added: readonly string[]) => {
  const known = new Set((asked ?? []).map((id) => id.toLowerCase()));
  return added.some((id) => !known.has(id.toLowerCase()));
};

/**
 * Whether the person changed the agent's list before adding. The server
 * records it (`changed`): someone asked for who was a member already is
 * missing from what was added without it being a change. A card executed
 * before that has no record, so only a sure sign counts: someone added who
 * wasn't asked for. Someone asked for and missing may have been a member.
 */
const membersListChanged = (action: StoredActionCardAction, result: Extract<ActionCardResult, { kind: "channel-members" }>) => {
  if (typeof result.changed === "boolean") return result.changed;
  return action.type === "channel:add_member"
    && (addsUnasked(action.humans, result.addedHumanIds) || addsUnasked(action.agents, result.addedAgentIds));
};

/**
 * What came of an executed card (ActionCard's result line), which the frame
 * shows under "Committed by". Its buttons navigate, to an entity, or open the
 * feedback ticket (a result intent).
 */
function resultParts(action: StoredActionCardAction, result: ActionCardResult, names: ActionCardSpecNames | undefined): MaybePart[] | null {
  switch (result.kind) {
    case "channel": {
      const channel = entityRef("channel", result.id, names, result.name);
      return channel
        ? [field("channel", "actionCard.field.channel", [channel]), actions([{
          id: "openChannel",
          node: { type: "Button", props: { label: actionCardMsg("actionCard.channel.edit.returnToChannel"), emphasis: "secondary", action: { kind: "navigate", target: { kind: "channel", id: channel.id } } } },
        }])]
        : [field("channel", "actionCard.field.channel", `#${result.name}`)];
    }
    case "agent": {
      const agent = entityRef("agent", result.id, names, result.name);
      return agent
        ? [field("agent", "actionCard.field.agent", [agent]), actions([{
          id: "openAgent",
          node: { type: "Button", props: { label: actionCardMsg("actionCard.result.openAgent"), emphasis: "secondary", action: { kind: "navigate", target: { kind: "agent", id: agent.id } } } },
        }])]
        : [field("agent", "actionCard.field.agent", result.name)];
    }
    case "agent-migration":
      // Done when the move started: where to, and that its progress is on the
      // Agent's page (the Agent's reference is the link there).
      return [text("summary", actionCardMsg("actionCard.result.migrationStarted", {
        agent: entityParam("agent", result.agentId, names),
        to: entityParam("computer", result.targetMachineId, names),
      }))];
    case "channel-members": {
      // The body lists who was added (channelAddMember), so no list or count
      // here (the title and the list say both). Only, when the person changed
      // the agent's list in the dialog, that they did: the request itself is
      // in the conversation.
      return membersListChanged(action, result) ? [text("changed", actionCardMsg("actionCard.result.changedBeforeAdding"), "muted")] : null;
    }
    case "mcp-connection":
      // Whom access was granted to. The result holds the App's and the Agent's
      // ids only, never the Connection or its name: the card is read by the
      // whole channel and the Connection is withheld from some of them
      // (actionCards.ts, ActionCardResult). So the line names the Agent.
      return [text("summary", actionCardMsg("actionCard.result.mcpConnectionGranted", { agent: entityParam("agent", result.agentId, names) }))];
    case "agent-integration-login":
      return [text("summary", actionCardMsg("actionCard.result.integrationLogin", { client: param(result.clientName), agent: storedAgent(result.agentId, result.agentName) }))];
    case "marketplace-app-installation":
      return [
        text("summary", actionCardMsg("actionCard.result.marketplaceInstalled", { client: param(result.clientName) })),
        // The web links it ("Continue Setup"); a card never carries an App's URL as a link.
        result.setupUrl ? field("setupUrl", "actionCard.appSetup.urlLabel", result.setupUrl, { breakAll: true }) : null,
      ];
    case "integration-app-registration":
      return [text("summary", actionCardMsg(result.mode === "register" ? "actionCard.result.appRegistered" : "actionCard.result.appUpdated", {
        client: param(result.clientName),
        clientKey: param(result.clientKey),
      }))];
    case "integration-app-owner-recovery":
      return [text("summary", actionCardMsg("actionCard.result.ownerRecovered", { client: param(result.clientName), owner: param(result.ownerAgentName) }))];
    case "agent-call-approval":
      return agentCallApprovalResult(result);
    case "question-answers":
      return questionAnswersResult(action, result);
    case "assistant-owner-action":
      return assistantOwnerActionResult(action, result);
    case "product-feedback":
      // Where it went, for every viewer, and the sender's way to follow it:
      // an `open` of the result intent feedback_ticket. The card carries no
      // ticket id; a client reads metadata.result (ticketId, source) and
      // shows the button only to executedByUserId, and only when it can open
      // a ticket of that `source`: its own Hands app, and on the web any app
      // (the link carries `?platform=<source>`).
      return [
        text("summary", actionCardMsg("actionCard.result.feedbackSentToRaft")),
        actions([{
          id: "openTicket",
          node: { type: "Button", props: { label: actionCardMsg("actionCard.result.feedbackSubmitted"), emphasis: "secondary", action: { kind: "open", intent: "feedback_ticket" } } },
        }]),
      ];
    default: {
      const unknown: never = result;
      throw new Error(`No action-card.v1 result for ${(unknown as { kind?: unknown }).kind}`);
    }
  }
}

/** The names a result carries, so the card's other references show them too. */
function resultNames(result: ActionCardResult | null | undefined): ActionCardSpecNames {
  if (!result) return {};
  switch (result.kind) {
    case "channel": return { channels: { [result.id.toLowerCase()]: result.name } };
    case "agent": return { agents: { [result.id.toLowerCase()]: result.name } };
    case "channel-members": return { channels: { [result.channelId.toLowerCase()]: result.channelName } };
    case "agent-integration-login":
    case "marketplace-app-installation": return { agents: { [result.agentId.toLowerCase()]: result.agentName } };
    case "integration-app-owner-recovery": return { agents: { [result.ownerAgentId.toLowerCase()]: result.ownerAgentName } };
    default: return {};
  }
}

/** `base` with `extra` filled in where `base` has no name. */
export function mergeActionCardSpecNames(base: ActionCardSpecNames | undefined, extra: ActionCardSpecNames | undefined): ActionCardSpecNames {
  const mcpApp = base?.mcpApp ?? extra?.mcpApp;
  const merged: ActionCardSpecNames = mcpApp ? { mcpApp } : {};
  for (const bucket of Object.values(NAME_BUCKETS)) {
    const names = { ...extra?.[bucket], ...base?.[bucket] };
    if (Object.keys(names).length > 0) merged[bucket] = names;
  }
  return merged;
}

/**
 * `presentation.card` for `action` as built, before the emit parse. Throws
 * only for a type it has no builder for; prefer buildParsedActionCardSpec.
 */
export function buildActionCardSpec(action: StoredActionCardAction, ctx: ActionCardSpecBuildContext = {}): ActionCardSpecCard {
  const names = mergeActionCardSpecNames(ctx.names, resultNames(ctx.result));
  const built = buildBody(action, { ...ctx, names });
  const result = ctx.result ? resultParts(action, ctx.result, names) : null;
  return {
    catalog: "action-card.v1",
    icon: built.icon,
    title: built.title,
    spec: tree(built.body),
    ...(result ? { result: tree(result) } : {}),
  };
}

export type ActionCardSpecBuildOutcome =
  | { ok: true; card: ActionCardSpecCard }
  | { ok: false; error: unknown; issues: ActionCardSpecIssue[] };

/**
 * The card to store and send: buildActionCardSpec's output as the emit parse
 * returns it (defaults filled in, the size measured on it). Never throws: a
 * builder that throws or a card the parse refuses is `{ ok: false }` with the
 * reason, and the caller sends the legacy presentation alone. A card the
 * parse refuses with names is built once more without them: long names on a
 * long member list can pass 24 KiB, and a client names what it can see
 * itself (fallbacks are for what it cannot).
 */
export function buildParsedActionCardSpec(
  action: StoredActionCardAction,
  ctx: ActionCardSpecBuildContext = {},
  build: (action: StoredActionCardAction, ctx: ActionCardSpecBuildContext) => ActionCardSpecCard = buildActionCardSpec,
): ActionCardSpecBuildOutcome {
  const attempt = (attemptCtx: ActionCardSpecBuildContext): ActionCardSpecBuildOutcome => {
    let raw: ActionCardSpecCard;
    try {
      raw = build(action, attemptCtx);
    } catch (error) {
      return { ok: false, error, issues: [] };
    }
    const parsed = parseActionCardSpec(raw, { mode: "emit" });
    if (parsed.ok) return { ok: true, card: parsed.card };
    return { ok: false, error: null, issues: actionCardSpecIssues(raw, { mode: "emit" }) };
  };
  const first = attempt(ctx);
  if (first.ok || first.error !== null || !ctx.names) return first;
  const unnamed = attempt({ ...ctx, names: undefined });
  return unnamed.ok ? unnamed : first;
}

/** The App a stored connect card's title names: nothing else on the card keeps it. */
function storedMcpApp(card: unknown): string | undefined {
  const title = typeof card === "object" && card !== null ? (card as { title?: Partial<ActionCardSpecMsg> }).title : undefined;
  const app = title?.key === CONNECT_MCP_TITLE ? title.params?.app : undefined;
  return typeof app === "string" ? app : undefined;
}

/**
 * A stored card (`presentation.card`) as it may be served: every computer
 * reference's fallback its short id, as cards are built now
 * (ActionCardSpecNames). Cards stored before that carry the computer's name
 * there; serving them through this keeps it from a viewer who may not list
 * computers. The input is never changed; with nothing to change, it is
 * returned as is.
 */
export function actionCardSpecWithoutComputerNames<T>(card: T): T {
  const strip = (value: unknown, depth: number): unknown => {
    if (depth > 24 || typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const items = value.map((item) => {
        const next = strip(item, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? items : value;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "computer" && typeof record.id === "string" && typeof record.fallback === "string") {
      const fallback = shortId(record.id.toLowerCase());
      return record.fallback === fallback ? value : { ...record, fallback };
    }
    let next: Record<string, unknown> | null = null;
    for (const [key, child] of Object.entries(record)) {
      const stripped = strip(child, depth + 1);
      if (stripped !== child) (next ??= { ...record })[key] = stripped;
    }
    return next ?? value;
  };
  return strip(card, 0) as T;
}

/**
 * The names a stored card already shows (EntityRef fallbacks that are names,
 * not short ids; a connect card's App), so a rebuilt card (after execute)
 * keeps them.
 */
export function actionCardSpecNames(card: unknown): ActionCardSpecNames {
  const mcpApp = storedMcpApp(card);
  const names: ActionCardSpecNames = mcpApp ? { mcpApp } : {};
  const add = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const ref = value as Partial<ActionCardSpecEntityRef>;
    if (typeof ref.kind !== "string" || !Object.hasOwn(NAME_BUCKETS, ref.kind) || typeof ref.id !== "string" || typeof ref.fallback !== "string") return;
    if (ref.fallback === shortId(ref.id)) return;
    const bucket = NAME_BUCKETS[ref.kind as NamedKind];
    (names[bucket] ??= {})[ref.id] = ref.fallback;
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) { value.forEach((item) => walk(item, depth + 1)); return; }
    add(value);
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(card, 0);
  return names;
}
