/**
 * What a personal assistant may do AS ITS OWNER, through the owner's own web
 * routes (#proj-assistant:#19). One table: each entry names one route by its
 * exact method and Express-registered full path, and opening something up is
 * one line here, nothing else.
 *
 * The assistant calls that route with its own `sk_agent_*` credential; auth
 * (middleware/assistantAsOwner.ts) answers it AS THE OWNER only for a route in
 * this table: `req.userId` is the owner, `req.sessionScope` is
 * `assistant_as_owner` (never `full`, no session family, so anything that
 * wants a real web session fails closed), and the owner's own handler runs
 * unchanged with the owner's own checks and rate limits. A route outside the
 * table, a body field outside `allowedFields`, or a target outside the
 * assistant's server is refused before the handler runs.
 *
 * Tiers (Tenny's grading, #proj-assistant:#19):
 *   direct   only affects the owner and can be undone: runs, and the response
 *            carries `assistant: { done, undo }` in the owner's terms; every
 *            change is audited (`assistant.owner_action`).
 *   confirm  touches others or is hard to undo: the call runs nothing. Raft
 *            posts an action card in the owner's DM with the assistant,
 *            worded by Raft from the entry's `card` (names, never ids);
 *            Confirm runs the stored route on the owner's own session
 *            (services/assistantOwnerActionCards.ts).
 * Never in the table: sign-in and security, account deletion, billing,
 * deleting a server or channel, SSO, credentials and keys, app installs and
 * grants, OAuth authorize, Computer keys, roles, server invites.
 *
 * Next lines: sidebar / server order, thread follow, single mark-read/done,
 * save, join a public channel, start the owner's agent, `PATCH /api/auth/me`
 * (language and time zone only); `dm:@peer` targets.
 *
 * Each entry also describes its agent-facing tool (Sage, #proj-assistant:#19):
 * a tool name, parameters in the forms the assistant knows (`#design`, enums,
 * booleans) and how they map onto the route. The assistant's context lists
 * them (`assistantOf.ownerActions`); the SDK resolves the refs as the owner
 * and calls the route, and passes Raft's `assistant` block through verbatim.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { asServerId, formatUtcTimestamp, getRuntimeDisplayName, type AgentApiAssistantOwnerAction, type AssistantOwnerActionCardAction, type AssistantOwnerActionResultLine } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, integrationAuditEvents, machines, messages, users } from "../db/schema";
import { getActorServerRoleInServer, userCanActOnAgentResource } from "../lib/actorPermissions";
import * as channelService from "./channelService";
import * as notificationSettings from "./notifications/settings";
import { arrangeConversations, moveConversation, pinConversation } from "./assistantOwnerSidebarActions";
import { ASSISTANT_OWNER_READS } from "./assistantOwnerReads";
import { listOwnerSavedMessages, saveMessage } from "./assistantOwnerSaved";

/**
 * direct: runs right away, affects only the owner, can be undone.
 * confirm: runs only once the owner confirms a card.
 * read: a GET of the owner's own state; changes nothing, answers with Raft's text (assistantOwnerReads.ts).
 */
export type AssistantOwnerActionTier = "direct" | "confirm" | "read";

/** One tool parameter, as the assistant gives it. */
export type AssistantOwnerActionParam =
  | { name: string; kind: "channel"; description: string }
  /** A `#channel` or a `dm:@peer` (the owner's existing DM). */
  | { name: string; kind: "conversation"; description: string }
  | { name: string; kind: "channel_or_server"; description: string }
  | { name: string; kind: "boolean"; description: string }
  | { name: string; kind: "enum"; values: readonly string[]; description: string }
  /** `"top"`, `"bottom"`, or `{ after: "#x" | "dm:@x" }` (a conversation it goes right after). */
  | { name: string; kind: "position"; description: string }
  /** An agent as `@name`, resolved as the owner sees it. */
  | { name: string; kind: "agent"; description: string }
  /** Plain text, sent as is (a computer's name). `optional`: a read's filter may be left out. */
  | { name: string; kind: "text"; description: string; optional?: boolean }
  /** A list of `#channel` / `dm:@peer` refs, in order (#proj-assistant:#28: a whole list's order in one call). */
  | { name: string; kind: "conversation_list"; description: string };

/**
 * Where a parameter goes in the route request:
 *   path   `:field` in the path; a `channel` / `conversation` ref resolved to its id
 *   body   `field` in the JSON body, as given
 *   level_scope  a `channel_or_server` ref: body `scope` ("server" | "channel") and `id`
 */
export type AssistantOwnerActionMapping =
  | { param: string; into: "path"; field: string }
  | { param: string; into: "body"; field: string }
  | { param: string; into: "level_scope" }
  /** A `conversation` ref resolved to its id, as body `field` (a `transform` entry's tool body). */
  | { param: string; into: "body_ref"; field: string }
  /** A `position`: `"top"` / `"bottom"` as is, `{ after: ref }` with the ref resolved to `{ after: id }`, as body `field`. */
  | { param: string; into: "body_position"; field: string }
  /** A read's own option, as query `field` (Raft reads it itself; the route never sees it). */
  | { param: string; into: "query"; field: string }
  /** A `conversation_list`, each ref resolved to its id, in order, as body `field`. */
  | { param: string; into: "body_ref_list"; field: string };

/** An undo argument: a value as the assistant gives it (a `position` may be `{ after: "#x" }`). */
export type AssistantOwnerActionArg = string | boolean | { after: string } | string[];

/** The undo: a call of a tool, with its arguments filled in. */
export type AssistantOwnerActionUndo = { tool: string; args: Record<string, AssistantOwnerActionArg> };

/** A refusal written by Raft before the handler runs (status, code and the assistant's text). */
export interface AssistantOwnerActionRefusal {
  status: number;
  code: string;
  error: string;
}

/** What `admit` decides: refuse (the default target-not-found text, or the entry's own), or run. */
export type AssistantOwnerActionAdmission<Before> =
  | {
    ok: true;
    before: Before;
    /**
     * A `transform` entry's route body: the tool's arguments arrive as the
     * request body, and Raft computes the route's own body from the owner's
     * current state in this same read; the owner's handler then runs on it.
     */
    routeBody?: Record<string, unknown>;
  }
  | { ok: false; refusal?: AssistantOwnerActionRefusal };

export interface AssistantOwnerActionRequestScope {
  agentId: string;
  serverId: string;
  ownerUserId: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

export interface AssistantOwnerAction<Before = unknown> {
  key: string;
  tool: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The exact Express-registered full path (assistantOwnerActions.routes.test.ts). */
  path: string;
  tier: AssistantOwnerActionTier;
  /** What it does, lower case, without "for {owner}" (Sage's {phrase}). */
  phrase: string;
  params: readonly AssistantOwnerActionParam[];
  mapping: readonly AssistantOwnerActionMapping[];
  /**
   * The JSON body keys the route may receive from an assistant; any other is
   * refused. For an entry whose `admit` returns a `routeBody`, these are the
   * tool's own fields (the route body is Raft's).
   */
  allowedFields: readonly string[];
  /** A read's query fields (its options, e.g. `filter`); any other query is refused, and every other tier takes none. */
  queryFields?: readonly string[];
  /** The tool's description, where the entry writes its own (reads); otherwise generated from `phrase` and `tier`. */
  description?: (owner: string) => string;
  /**
   * Body keys this entry needs. Two entries may share one route (both sidebar
   * tools are PATCH /api/servers/:id/sidebar-order): the request's body keys
   * pick the one whose `requiredFields` are all there and `allowedFields` cover them.
   */
  requiredFields?: readonly string[];
  /**
   * Before the handler: the target must be in the assistant's server; returns
   * what undo needs (the value before), or null to refuse.
   */
  admit(scope: AssistantOwnerActionRequestScope, owner: string): Promise<AssistantOwnerActionAdmission<Before>>;
  /**
   * The handler's own refusals, rewritten for the assistant: by the handler's
   * `code`, Raft's text (the code is kept). Applied to non-2xx answers.
   */
  errorText?: Readonly<Record<string, (owner: string) => string>>;
  /**
   * A confirm entry's card, Raft's text from what `admit` read (names, never
   * ids): the phrase ("move Sage to build-box-1"), its past form for the
   * confirmed event, what confirming does, and the tool's arguments as the
   * assistant names things.
   */
  card?(scope: AssistantOwnerActionRequestScope, before: Before, owner: string): Promise<AssistantOwnerActionCardText>;
  /**
   * A confirm entry's line for the assistant once the confirmed route answered
   * 2xx, from the route's own JSON (what it started, by when), and the card's
   * result line. Without it: "{owner} confirmed, and it's done: {done}."
   */
  confirmedText?(card: Pick<AssistantOwnerActionCardAction, "args" | "view">, owner: string, result: Record<string, unknown>): { event: string; summary: string; line?: AssistantOwnerActionResultLine };
  /**
   * After a 2xx: what changed, in the owner's terms, and how to undo it. The
   * "after" value comes from the handler's own JSON (`result`), so a concurrent
   * change cannot slip into this request's audit row; re-read only when absent.
   */
  describe?(scope: AssistantOwnerActionRequestScope, before: Before, owner: string, result: Record<string, unknown>): Promise<AssistantOwnerActionResult>;
  /**
   * A read's answer: Raft's text from the route's 2xx JSON (`result`, any JSON
   * value) and the read's query options. Replaces the route's JSON, which never
   * reaches the assistant (assistantOwnerReads.ts).
   */
  render?(scope: AssistantOwnerActionRequestScope, result: unknown, query: Record<string, string>): Promise<string>;
}

export interface AssistantOwnerActionCardText {
  phrase: string;
  done: string;
  description: string;
  args: Record<string, string>;
  /** The card's own copy in the viewer's language (actionCardMessages), with the names that fill it. */
  view?: AssistantOwnerActionCardAction["view"];
}

export interface AssistantOwnerActionResult {
  /** Sage's done line: "{Done} for {owner}." */
  done: string;
  /** Sage's undo line, or null when there is nothing to undo (nothing changed). */
  undo: (AssistantOwnerActionUndo & { text: string }) | null;
  /** For the audit row. */
  audit: { targetId: string | null; previousValue: string | boolean | null; nextValue: string | boolean | null };
}

/** `#name` for a channel, `dm:@peer` for a DM from the owner's side; null when neither. */
export async function ownerFacingConversationRef(serverId: string, ownerUserId: string, channelId: string): Promise<string | null> {
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId) return null;
  if (channel.type === "dm") {
    const peer = await channelService.resolveUserFacingDmPeerRef(serverId, ownerUserId, channelId);
    return peer ? `dm:@${peer}` : null;
  }
  return channel.name ? `#${channel.name}` : null;
}

/** A channel of this server the owner can see; null otherwise (the same refusal either way). */
async function ownerChannelInServer(scope: AssistantOwnerActionRequestScope, channelId: unknown) {
  if (typeof channelId !== "string" || !channelId) return null;
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== scope.serverId) return null;
  // A DM only when it is the owner's own (the handler checks channels the same way).
  if (channel.type === "dm" && !await channelService.canUserAccessChannel(channel.id, scope.ownerUserId, asServerId(scope.serverId))) return null;
  return channel;
}

function formatArg(value: AssistantOwnerActionArg): string {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (typeof value === "object") return `{ after: ${JSON.stringify(value.after)} }`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Sage's undo line: `To undo: tool(name: value, ...).` with an optional note. */
export function undoLine(undo: AssistantOwnerActionUndo, note?: string): string {
  const args = Object.entries(undo.args).map(([name, value]) => `${name}: ${formatArg(value)}`).join(", ");
  return `To undo: ${undo.tool}(${args})${note ? `, ${note}` : ""}.`;
}

const muteConversation: AssistantOwnerAction<{ channelId: string; muted: boolean }> = {
  key: "conversationMute",
  tool: "mute_conversation",
  method: "PATCH",
  path: "/api/channels/:id/notification-settings",
  tier: "direct",
  phrase: "mute or unmute a conversation",
  params: [
    { name: "target", kind: "conversation", description: "A channel (#design), or a DM with an app bot (dm:@bot); a DM with a person can't be muted." },
    { name: "muted", kind: "boolean", description: "true to mute, false to unmute." },
  ],
  mapping: [
    { param: "target", into: "path", field: "id" },
    { param: "muted", into: "body", field: "activityMuted" },
  ],
  allowedFields: ["activityMuted"],
  errorText: {
    ACTIVITY_MUTE_NOT_SUPPORTED: (owner) => `Raft can't mute a DM with a person, only channels and DMs with app bots. Tell ${owner}.`,
  },
  async admit(scope) {
    const channel = await ownerChannelInServer(scope, scope.params.id);
    if (!channel) return { ok: false };
    const state = await channelService.getInboxTargetActivityMuteState("user", scope.ownerUserId, channel.id);
    return { ok: true, before: { channelId: channel.id, muted: state.activityMuted } };
  },
  async describe(scope, before, owner, result) {
    const after = typeof result.activityMuted === "boolean"
      ? { activityMuted: result.activityMuted }
      : await channelService.getInboxTargetActivityMuteState("user", scope.ownerUserId, before.channelId);
    const ref = await ownerFacingConversationRef(scope.serverId, scope.ownerUserId, before.channelId) ?? "the conversation";
    const done = after.activityMuted
      ? (before.muted ? `Nothing changed: ${ref} was already muted for ${owner}.` : `Muted ${ref} for ${owner}.`)
      : (before.muted ? `Unmuted ${ref} for ${owner}.` : `Nothing changed: ${ref} was already unmuted for ${owner}.`);
    const changed = before.muted !== after.activityMuted;
    const undo = changed ? { tool: "mute_conversation", args: { target: ref, muted: before.muted } } : null;
    return {
      done,
      undo: undo ? { ...undo, text: undoLine(undo) } : null,
      audit: { targetId: before.channelId, previousValue: before.muted, nextValue: after.activityMuted },
    };
  },
};

type LevelBefore = { scope: "server" | "channel"; id: string; level: string };

async function currentLevel(ownerUserId: string, serverId: string, scope: "server" | "channel", id: string): Promise<string | null> {
  const snapshot = await notificationSettings.getServerLevels(ownerUserId, serverId);
  if (!snapshot) return null;
  if (scope === "server") return snapshot.server;
  return snapshot.channels.find((row) => row.id === id)?.level ?? "default";
}

const setNotificationLevel: AssistantOwnerAction<LevelBefore> = {
  key: "notificationLevelSet",
  tool: "set_notification_level",
  method: "PUT",
  path: "/api/notification-levels",
  tier: "direct",
  phrase: "set a notification level",
  params: [
    { name: "target", kind: "channel_or_server", description: "A channel (#design), or \"server\" for this whole server." },
    { name: "level", kind: "enum", values: ["default", "all", "mentions", "none"], description: "all = All new messages, mentions = Only what involves me, none = Nothing (the whole server only); default (channels only) follows the server's level." },
  ],
  mapping: [
    { param: "target", into: "level_scope" },
    { param: "level", into: "body", field: "level" },
  ],
  allowedFields: ["scope", "id", "level"],
  async admit(scope) {
    const { scope: levelScope, id } = scope.body;
    if (typeof id !== "string") return { ok: false };
    if (levelScope === "server") {
      if (id.toLowerCase() !== scope.serverId.toLowerCase()) return { ok: false };
    } else if (levelScope === "channel") {
      if (!await ownerChannelInServer(scope, id)) return { ok: false };
      // Silencing one channel is a mute (Sage): `none` is for the whole server.
      if (scope.body.level === "none") return { ok: false, refusal: { status: 400, code: "assistant_owner_action_use_mute", error: "To silence a channel, use mute_conversation; none is for the whole server." } };
    } else {
      return { ok: false };
    }
    const level = await currentLevel(scope.ownerUserId, scope.serverId, levelScope, id.toLowerCase());
    if (level === null) return { ok: false };
    return { ok: true, before: { scope: levelScope, id: id.toLowerCase(), level } };
  },
  async describe(scope, before, owner, result) {
    const after = typeof result.level === "string"
      ? result.level
      : await currentLevel(scope.ownerUserId, scope.serverId, before.scope, before.id) ?? before.level;
    const ref = before.scope === "server"
      ? "server"
      : await ownerFacingConversationRef(scope.serverId, scope.ownerUserId, before.id) ?? "the channel";
    const what = before.scope === "server" ? "this server" : ref;
    const done = after === before.level
      ? `Nothing changed: ${what} was already set to ${levelText(after)} for ${owner}.`
      : `Set ${what} to ${levelText(after)} for ${owner}.`;
    const undo = after !== before.level ? { tool: "set_notification_level", args: { target: ref, level: before.level } } : null;
    return {
      done,
      undo: undo ? { ...undo, text: undoLine(undo, "the level before this change") } : null,
      audit: { targetId: before.id, previousValue: before.level, nextValue: after },
    };
  },
};

/** A computer is online when its heartbeat is this fresh (routes/agents.ts MIGRATION_MACHINE_ONLINE_MAX_AGE_MS). */
const TARGET_ONLINE_MAX_AGE_MS = 2 * 60 * 1000;

interface MoveAgentBefore {
  agentId: string;
  /** Its display name: the card's copy, which names agents without an @. */
  agentName: string;
  /** `@handle`, as the assistant names it: its events, the legacy fields. */
  agentRef: string;
  fromName: string | null;
  toName: string;
}

/**
 * Moves one of the owner's agents to another computer of this server
 * (POST /api/agents/:id/migrate). Confirm tier: it stops the agent's turn and
 * moves its workspace. Admission only names things; the route's own checks
 * (the flag, the plan, the target online, its runtimes, a migration already
 * running) run when the owner confirms, and their refusal reaches the
 * assistant in the confirmed event.
 */
const moveAgent: AssistantOwnerAction<MoveAgentBefore> = {
  key: "agentMigrate",
  tool: "move_agent",
  method: "POST",
  path: "/api/agents/:id/migrate",
  tier: "confirm",
  phrase: "move an agent to another computer",
  params: [
    { name: "agent", kind: "agent", description: "The agent to move, as @name: one your owner may move." },
    { name: "computer", kind: "text", description: "The computer to move it to, by its name in this server." },
  ],
  mapping: [
    { param: "agent", into: "path", field: "id" },
    { param: "computer", into: "body", field: "targetComputer" },
  ],
  allowedFields: ["targetComputer"],
  requiredFields: ["targetComputer"],
  async admit(scope, owner) {
    const agentId = scope.params.id;
    const computer = typeof scope.body.targetComputer === "string" ? scope.body.targetComputer.trim() : "";
    if (!agentId || !computer) return { ok: false };
    const [agent] = await getDb()
      .select({ id: agents.id, name: agents.name, displayName: agents.displayName, machineId: agents.machineId, runtime: agents.runtime, creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId, deletedAt: agents.deletedAt, serverId: agents.serverId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    const role = agent && agent.serverId === scope.serverId && !agent.deletedAt
      ? await getActorServerRoleInServer(scope.serverId, "user", scope.ownerUserId)
      : null;
    // The route's own rule (migrateAgents, or the agent's creator); the same answer for "no such agent".
    if (!agent || !role || !userCanActOnAgentResource(role, scope.ownerUserId, agent, "migrateAgents")) {
      return { ok: false, refusal: { status: 404, code: "assistant_owner_action_target_not_found", error: `No agent with that name that ${owner} can move.` } };
    }
    if (agent.id === scope.agentId) {
      return { ok: false, refusal: { status: 409, code: "assistant_owner_action_not_self", error: `You can't move yourself; ${owner} can move you in Raft.` } };
    }
    const computers = await getDb().select({ id: machines.id, name: machines.name, lastHeartbeat: machines.lastHeartbeat, runtimes: machines.runtimes })
      .from(machines).where(eq(machines.serverId, scope.serverId)).orderBy(asc(machines.name));
    const target = computers.find((machine) => machine.name === computer);
    if (!target) {
      const here = computers.map((machine) => machine.name).join(", ");
      return { ok: false, refusal: { status: 404, code: "assistant_owner_action_target_not_found", error: `No computer named "${computer}" in this server.${here ? ` Computers here: ${here}.` : " There are no computers here."}` } };
    }
    const [source] = agent.machineId
      ? await getDb().select({ name: machines.name }).from(machines).where(eq(machines.id, agent.machineId)).limit(1)
      : [];
    const agentName = agent.displayName || agent.name;
    if (agent.machineId === target.id) {
      return { ok: false, refusal: { status: 409, code: "assistant_owner_action_already_there", error: `Nothing to do: @${agent.name} is already on ${target.name}.` } };
    }
    // The cheap checks of migrate's own preflight, so the owner is never asked to confirm a move bound to
    // fail: the target online (its heartbeat, as MIGRATION_MACHINE_ONLINE_MAX_AGE_MS in routes/agents.ts) and
    // the agent's runtime on it (machineSupportsRuntime there). The rest runs at Confirm.
    if (!target.lastHeartbeat || Date.now() - target.lastHeartbeat.getTime() > TARGET_ONLINE_MAX_AGE_MS) {
      const seen = target.lastHeartbeat ? ` (last seen ${formatUtcTimestamp(target.lastHeartbeat)})` : "";
      return { ok: false, refusal: { status: 409, code: "assistant_owner_action_target_offline", error: `${target.name} is offline${seen}, so moving @${agent.name} there would fail. ${owner} can try again once it's back.` } };
    }
    if (Array.isArray(target.runtimes) && !target.runtimes.includes(agent.runtime)) {
      return { ok: false, refusal: { status: 409, code: "assistant_owner_action_runtime_missing", error: `${target.name} doesn't have ${getRuntimeDisplayName(agent.runtime)}, which @${agent.name} runs on, so it can't move there.` } };
    }
    return { ok: true, before: { agentId: agent.id, agentName, agentRef: `@${agent.name}`, fromName: source?.name ?? null, toName: target.name } };
  },
  async card(_scope, before) {
    const name = before.agentRef;
    return {
      phrase: `move ${name} to ${before.toName}`,
      done: `Moved ${name} to ${before.toName}`,
      description: before.fromName
        ? `Moves ${name} from ${before.fromName} to ${before.toName}. ${name} stops its current turn, its workspace folder moves to ${before.toName}, and it starts again there. It takes a few minutes, longer for a large workspace. Files outside its workspace folder stay on ${before.fromName}.`
        : `Moves ${name} to ${before.toName}. ${name} stops its current turn, its workspace folder moves to ${before.toName}, and it starts again there. It takes a few minutes, longer for a large workspace.`,
      args: { agent: name, computer: before.toName },
      view: { kind: "moveAgent", agent: before.agentName, from: before.fromName, to: before.toName },
    };
  },
  // Migrate only starts when it answers: say so, and by when it should arrive (the route's arrivalDeadlineAt).
  confirmedText(card, owner, result) {
    const arrival = typeof result.arrivalDeadlineAt === "string" ? ` it should arrive by ${formatUtcTimestamp(result.arrivalDeadlineAt)}, and` : "";
    const agent = card.args.agent ?? "the agent";
    const started = `Started moving ${agent} to ${card.args.computer ?? "the other computer"};${arrival} ${agent} starts again there.`;
    // The card's line as names (shown in the owner's language); the event stays English.
    const line = card.args.agent && card.args.computer
      ? { kind: "moveStarted" as const, agent: card.view?.agent ?? card.args.agent, to: card.args.computer, arrivalAt: typeof result.arrivalDeadlineAt === "string" && !Number.isNaN(Date.parse(result.arrivalDeadlineAt)) ? result.arrivalDeadlineAt : null }
      : undefined;
    return { event: `${owner} confirmed. ${started}`, summary: started, ...(line ? { line } : {}) };
  },
  async describe(_scope, before) {
    return {
      done: `Moved ${before.agentRef} to ${before.toName}.`,
      undo: null,
      audit: { targetId: before.agentId, previousValue: before.fromName, nextValue: before.toName },
    };
  },
};

export const ASSISTANT_OWNER_ACTIONS: readonly AssistantOwnerAction<unknown>[] = [
  muteConversation,
  setNotificationLevel,
  moveConversation,
  pinConversation,
  arrangeConversations,
  moveAgent,
  saveMessage,
  ...ASSISTANT_OWNER_READS,
  listOwnerSavedMessages,
];

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * The entry for this method, path (no query) and body, matched segment by
 * segment; with the path's `:params`. Where entries share a route, the body's
 * keys pick one (`requiredFields` all present, every key in `allowedFields`);
 * with no body given, the first entry of the route.
 */
export function matchAssistantOwnerAction(method: string, path: string, body?: Record<string, unknown>): { action: AssistantOwnerAction<unknown>; params: Record<string, string> } | null {
  const candidates = matchAssistantOwnerActionRoute(method, path);
  if (candidates.length === 0) return null;
  if (!body) return candidates[0]!;
  const keys = Object.keys(body);
  return candidates.find(({ action }) => (
    (action.requiredFields ?? []).every((field) => keys.includes(field))
    && keys.every((key) => action.allowedFields.includes(key))
  )) ?? (candidates.length === 1 ? candidates[0]! : null);
}

/** Every entry on this method and path, in table order. */
export function matchAssistantOwnerActionRoute(method: string, path: string): Array<{ action: AssistantOwnerAction<unknown>; params: Record<string, string> }> {
  const reqSegs = segments(path);
  const upper = method.toUpperCase();
  const matches: Array<{ action: AssistantOwnerAction<unknown>; params: Record<string, string> }> = [];
  for (const action of ASSISTANT_OWNER_ACTIONS) {
    if (action.method !== upper) continue;
    const patSegs = segments(action.path);
    if (patSegs.length !== reqSegs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < patSegs.length; i++) {
      const pat = patSegs[i]!;
      const seg = reqSegs[i]!;
      if (pat.startsWith(":")) {
        let decoded: string;
        try { decoded = decodeURIComponent(seg); } catch { ok = false; break; }
        params[pat.slice(1)] = decoded;
      } else if (pat !== seg) { ok = false; break; }
    }
    if (ok) matches.push({ action, params });
  }
  return matches;
}

/** The owner as the strings name them: display name, else handle. */
export async function ownerLabel(ownerUserId: string): Promise<string> {
  const [row] = await getDb().select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, ownerUserId)).limit(1);
  return row?.displayName || row?.name || "your owner";
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** Sage's generated tool description. */
export function ownerActionDescription(action: AssistantOwnerAction<unknown>, owner: string): string {
  if (action.description) return action.description(owner);
  return action.tier === "direct"
    ? `${capitalize(action.phrase)} as ${owner}. Runs right away and affects only ${owner}; it can be undone. ${owner} sees each change in their settings, under "Changed by your assistant".`
    : `${capitalize(action.phrase)} as ${owner}. Doesn't run until ${owner} confirms it on a card Raft posts in your DM.`;
}

/** What `assistantOf.ownerActions` lists: every tool the assistant may call, with how to call it. */
export type AssistantOwnerActionDescriptor = AgentApiAssistantOwnerAction;

export function describeAssistantOwnerActions(owner: string): AssistantOwnerActionDescriptor[] {
  return ASSISTANT_OWNER_ACTIONS.map((action) => ({
    tool: action.tool,
    tier: action.tier,
    description: ownerActionDescription(action, owner),
    method: action.method,
    path: action.path,
    params: action.params.map((param) => ({
      name: param.name,
      kind: param.kind,
      description: param.description,
      ...(param.kind === "enum" ? { values: [...param.values] } : {}),
      ...(param.kind === "text" && param.optional ? { optional: true } : {}),
    })),
    mapping: action.mapping.map((map) => ({ ...map })),
    ...(action.requiredFields ? { requiredFields: [...action.requiredFields] } : {}),
  }));
}

/** The web's own labels for the levels (notifications.level.*), quoted as the owner reads them. */
const LEVEL_LABEL: Record<string, string> = {
  all: "All new messages",
  mentions: "Only what involves me",
  none: "Nothing",
};

/** A level as the owner reads it: the web's label in quotes; `default` says what it follows. */
function levelText(level: string): string {
  if (level === "default") return "default (follows this server's level)";
  return LEVEL_LABEL[level] ? `"${LEVEL_LABEL[level]}"` : level;
}

/** The audit event of a change an assistant made as its owner (middleware/assistantAsOwner.ts). */
export const ASSISTANT_OWNER_ACTION_EVENT = "assistant.owner_action" as const;

export const OWNER_ACTION_CHANGES_LIMIT = 10;

/** What the owner's settings page calls each action ("Changed by your assistant"). */
const OWNER_ACTION_CHANGE_KIND: Record<string, OwnerActionChangeKind> = {
  conversationMute: "conversationMute",
  notificationLevelSet: "notificationLevel",
  sidebarMove: "sidebarMove",
  sidebarPin: "sidebarPin",
  sidebarArrange: "sidebarArrange",
  agentMigrate: "agentMove",
  messageSave: "messageSave",
};
export type OwnerActionChangeKind = "conversationMute" | "notificationLevel" | "sidebarMove" | "sidebarPin" | "sidebarArrange" | "agentMove" | "messageSave";

export interface OwnerActionChange {
  id: string;
  agentId: string | null;
  assistantName: string | null;
  /** Shares `setting` with the owner-setting changes (one list on the web); the web shows these under Notifications. */
  setting: OwnerActionChangeKind;
  serverId: string;
  /**
   * The conversation as the owner names it now (`#design`, `dm:@peer`), `"server"` for this server,
   * or the agent (`@sage`) a confirmed move names; null once it is gone.
   */
  targetRef: string | null;
  /** The owner confirmed it on a card (a confirm-tier action); otherwise the assistant did it directly. */
  confirmed: boolean;
  previousValue: string | boolean | null;
  nextValue: string | boolean | null;
  createdAt: string;
}

function auditValue(value: unknown): string | boolean | null {
  return typeof value === "string" || typeof value === "boolean" ? value : null;
}

/**
 * What an assistant did as this person in this server, newest first (the
 * `assistant.owner_action` rows whose subject is them), each target named as
 * they see it now.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `@name` of a live agent of this server; null once it is gone. */
async function agentRefInServer(serverId: string, agentId: string): Promise<string | null> {
  if (!UUID_PATTERN.test(agentId)) return null;
  const [agent] = await getDb().select({ name: agents.name }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt))).limit(1);
  return agent ? `@${agent.name}` : null;
}

/** A saved message as the owner names its conversation now: `#design msg=1a2b3c4d`; null once it is gone. */
async function savedMessageRef(serverId: string, ownerUserId: string, messageId: string): Promise<string | null> {
  if (!UUID_PATTERN.test(messageId)) return null;
  const [row] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!row) return null;
  const ref = await ownerFacingConversationRef(serverId, ownerUserId, row.channelId);
  return ref ? `${ref} msg=${messageId.slice(0, 8)}` : null;
}

async function agentDisplayName(agentId: string): Promise<string | null> {
  if (!UUID_PATTERN.test(agentId)) return null;
  const [agent] = await getDb().select({ name: agents.name, displayName: agents.displayName }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return agent ? agent.displayName || agent.name : null;
}

export async function listOwnerActionChanges(serverId: string, ownerUserId: string, limit = OWNER_ACTION_CHANGES_LIMIT): Promise<OwnerActionChange[]> {
  const rows = await getDb()
    .select({
      id: integrationAuditEvents.id,
      agentId: integrationAuditEvents.actorId,
      assistantName: agents.displayName,
      metadata: integrationAuditEvents.metadata,
      createdAt: integrationAuditEvents.createdAt,
    })
    .from(integrationAuditEvents)
    .leftJoin(agents, eq(agents.id, integrationAuditEvents.actorId))
    .where(and(
      eq(integrationAuditEvents.serverId, serverId),
      eq(integrationAuditEvents.eventType, ASSISTANT_OWNER_ACTION_EVENT),
      eq(integrationAuditEvents.subjectType, "human"),
      eq(integrationAuditEvents.subjectId, ownerUserId),
    ))
    .orderBy(desc(integrationAuditEvents.createdAt), desc(integrationAuditEvents.id))
    .limit(limit);
  const changes: OwnerActionChange[] = [];
  for (const row of rows) {
    const action = typeof row.metadata?.action === "string" ? row.metadata.action : "";
    const kind = OWNER_ACTION_CHANGE_KIND[action];
    if (!kind) continue;
    const targetId = typeof row.metadata?.targetId === "string" ? row.metadata.targetId : null;
    const confirmed = row.metadata?.confirmed === true;
    // A confirmed action's actor is the owner (they pressed Confirm); the assistant that asked is `via`.
    const via = confirmed && typeof row.metadata?.via === "string" ? row.metadata.via : null;
    const targetRef = !targetId
      ? null
      : kind === "agentMove"
        ? await agentRefInServer(serverId, targetId)
        : kind === "messageSave"
          ? await savedMessageRef(serverId, ownerUserId, targetId)
        : targetId.toLowerCase() === serverId.toLowerCase()
          ? "server"
          : await ownerFacingConversationRef(serverId, ownerUserId, targetId);
    changes.push({
      id: row.id,
      agentId: via ?? row.agentId,
      assistantName: via ? await agentDisplayName(via) : row.assistantName ?? null,
      confirmed,
      setting: kind,
      serverId,
      targetRef,
      previousValue: auditValue(row.metadata?.previousValue),
      nextValue: auditValue(row.metadata?.nextValue),
      createdAt: row.createdAt.toISOString(),
    });
  }
  return changes;
}
