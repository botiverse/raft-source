/**
 * RFC 074 §2 personal assistant (v0): an agent whose
 * `agents.assistant_owner_user_id` names a person may read what that person
 * can see (DMs too unless the owner turned that off, RFC 077) through the
 * assistant-only Agent API reads. The
 * assistant always calls with its own credential; the owner's identity is
 * applied here, on the server, and nowhere else.
 *
 * Every read re-checks the whole chain (`resolveAssistantOwner`): the flag is
 * on for the server, the agent is live and still this person's assistant, and
 * the person is still a member of the server. Nothing is cached, so clearing
 * the link, removing the owner, or turning the flag off takes effect on the
 * next request.
 */
import { describeAssistantOwnerActions, type AssistantOwnerActionDescriptor } from "./assistantOwnerActions";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { afterAmbientTransaction } from "../db/ambientTransaction";
import { agents, assistantOwnerNotes, assistantCheckState, assistantChecks, assistantDoorbells, assistantDoorbellSources, channelAgents, channelHumans, channels, inboxTargetMuteStates, jointChannelServers, messageReactions, messages, taskEvents, tasks, thirdPartyAgentEvents, users } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { SYSTEM_ASSISTANT_APP } from "./agentAppEventsService";
import type { InboxNotificationFactInput } from "./inboxNotificationService";
import { createSystemAppAgentEvent, deliverSystemAppAgentEvent, type SystemAppAgentEvent } from "./systemAppAgentEvents";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { getHistoryCutoff, getServerPlan } from "./planService";
import { assistantRaftCheckEnabled, planCheck, recordCheck, type CheckPlan } from "./assistantCheckService";
import { contactContext } from "./assistantContactRulesService";
import { BRIEF_HOUR, BRIEF_LATEST_HOUR, localDay, localHour, nextBriefAt } from "./assistantBriefSchedule";
import type { NeedsOwnerCounts } from "./assistantCheckFilter";
import * as channelService from "./channelService";
import * as serverService from "./serverService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { evaluateFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "./featureFlagService";
import { ASSISTANT_OWNER_NOTES_MAX_LENGTH } from "./assistantInstructions";
import { asServerId, EXTERNAL_AGENT_RUNTIME_ID, EXTERNAL_AGENT_RUNTIME_MODEL, formatDmPeerRef, NAME_MAX_LENGTH, type Tracer } from "@botiverse/raft-shared";
import { createAgent } from "./agentService";
import { AssistantCannotUseComputerError } from "./computerAgents";
import { getAgentRuntimeProviderAvailability } from "./agentRuntimeProviderFeature";
import { kickAgentRuntimeProvisionWorker, recordAgentProvisioning } from "./agentRuntimeProvisionService";
import { hostedModelForCreate } from "./hostedAgentModelService";
import { isPrincipalHandleConflictError } from "./principalHandleService";

export const ASSISTANT_NOT_ENABLED_CODE = "assistant_not_enabled";

export async function isPersonalAssistantEnabled(serverId: string): Promise<boolean> {
  try {
    const evaluation = await evaluateFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, serverId });
    return evaluation.enabled;
  } catch {
    // Fail closed: an evaluation failure must never open a borrowed read.
    return false;
  }
}

/** The configured owner, or null. Says nothing about whether reads are allowed. */
export async function getAssistantOwnerUserId(
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const [row] = await executor
    .select({ ownerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  return row?.ownerUserId ?? null;
}

/** A server owner/admin paused this assistant: nothing wakes it until its owner starts it again. */
export async function isAssistantPaused(agentId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [row] = await executor.select({ pausedAt: agents.assistantPausedAt }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return Boolean(row?.pausedAt);
}

/**
 * The person this agent may currently read as, or null when any link of the
 * chain is missing. Callers answer every null the same way
 * (`403 assistant_not_enabled`) so the reason is not observable.
 */
export async function resolveAssistantOwner(agentId: string, serverId: string): Promise<string | null> {
  if (!await isPersonalAssistantEnabled(serverId)) return null;
  const [row] = await getDb()
    .select({ ownerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
    .limit(1);
  const ownerUserId = row?.ownerUserId ?? null;
  if (!ownerUserId) return null;
  const ownerRole = await getActorServerRoleInServer(serverId, "user", ownerUserId);
  // A Guest has no assistant (myAssistantRouter); one left from before its
  // owner became a Guest reads and acts for no one.
  return ownerRole && ownerRole !== "guest" ? ownerUserId : null;
}

export {
  assistantReadsOwnerDms,
  dmScopeOf,
  isDmScopedChannel,
  mayAssistantReadOwnerConversation,
  readableOwnerDmPolicy,
  setAssistantReadsDms,
} from "./assistantDmScope";
import { assistantReadsOwnerDms, dmScopeOf, isDmScopedChannel, mayAssistantReadOwnerConversation, readableOwnerDmPolicy } from "./assistantDmScope";

// ---------------------------------------------------------------------------
// "My assistant" (RFC 075 v4): each person may create one cloud assistant per
// server. It is an ordinary hosted agent with `assistant_owner_user_id` = that
// person, created in no channel (the 074 guard keeps it in its DM with the
// owner), plus that DM. Its @handle is derived from the owner's. Every
// assistant is named Ottie with the otter avatar (product decision): nobody
// renames it or changes its avatar, the owner, an admin or the assistant.
// ---------------------------------------------------------------------------

export const ASSISTANT_PROVIDER = "antiproton" as const;
/** Every personal assistant's display name; fixed. */
export const ASSISTANT_DISPLAY_NAME = "Ottie";
/**
 * Every personal assistant's avatar; fixed, and reserved: only the server sets
 * it, and only on an assistant (the web draws the otter art for it; the
 * `ottie` sprite in pixelAvatars.json is the fallback elsewhere).
 */
export const ASSISTANT_AVATAR_URL = "pixel:ottie";
export const ASSISTANT_PROFILE_FIXED_CODE = "assistant_profile_fixed";
export const ASSISTANT_PROFILE_FIXED_ERROR = "An assistant's name and avatar are always Ottie's, so there is nothing to change: leave them out.";
export const AVATAR_RESERVED_CODE = "avatar_reserved";
export const AVATAR_RESERVED_ERROR = "This avatar is reserved for personal assistants: choose another one.";

/** True for the assistant-only avatar, which no client may set. */
export function isReservedAssistantAvatarUrl(avatarUrl: unknown): boolean {
  return typeof avatarUrl === "string" && avatarUrl.trim() === ASSISTANT_AVATAR_URL;
}

/**
 * Why a profile write to this agent is refused, or null. An assistant's name
 * and avatar stay Ottie: any other value is refused (resending the fixed one is
 * a no-op and passes, so a form that echoes the current profile still saves).
 * On any other agent the assistant avatar is reserved.
 */
export function agentProfileWriteRefusal(
  agent: { assistantOwnerUserId: string | null },
  fields: { displayName?: unknown; avatarUrl?: unknown },
): { status: 400 | 403; code: string; error: string } | null {
  if (agent.assistantOwnerUserId) {
    const renames = fields.displayName !== undefined
      && (typeof fields.displayName !== "string" || fields.displayName.trim() !== ASSISTANT_DISPLAY_NAME);
    const changesAvatar = fields.avatarUrl !== undefined && !isReservedAssistantAvatarUrl(fields.avatarUrl);
    return renames || changesAvatar ? { status: 403, code: ASSISTANT_PROFILE_FIXED_CODE, error: ASSISTANT_PROFILE_FIXED_ERROR } : null;
  }
  return isReservedAssistantAvatarUrl(fields.avatarUrl) ? { status: 400, code: AVATAR_RESERVED_CODE, error: AVATAR_RESERVED_ERROR } : null;
}

export interface MyAssistant {
  /** The assistant's id: in v4 the assistant is its agent, so this equals `agentId`. */
  id: string;
  name: string;
  agentId: string;
  dmChannelId: string | null;
  /** RFC 077: the owner lets this assistant read their DMs (default on). */
  readsDms: boolean;
  /** RFC 077: the owner lets this assistant send messages as them (on for a new assistant, v3.2). */
  sendAsOwner: boolean;
  /** RFC 077: the owner's notes, sent after Raft's fixed instructions; only the owner sees them. */
  ownerNotes: string | null;
}

/** "My assistant" is offered here: the flag is on and the cloud runtime can provision. */
export async function isMyAssistantAvailable(serverId: string): Promise<boolean> {
  if (!await isPersonalAssistantEnabled(serverId)) return false;
  if (assistantWithoutRuntimeForPreview()) return true;
  try {
    return (await getAgentRuntimeProviderAvailability(serverId, ASSISTANT_PROVIDER)).available;
  } catch {
    return false;
  }
}

/**
 * A raftdev preview shows a seeded assistant (its otter, its DM) with no
 * hosted runtime behind it (#proj-assistant:#24): `RAFTDEV_ASSISTANT_WITHOUT_RUNTIME=1`,
 * which raftdev passes to the server it starts. Only there: the server
 * raftdev starts runs with `DEPLOYMENT_ENV=slockdev`, and any other
 * `DEPLOYMENT_ENV` (staging, production) turns it off, so a deployment always
 * needs the provider.
 */
export function assistantWithoutRuntimeForPreview(env: NodeJS.ProcessEnv = process.env): boolean {
  const deploymentEnv = env.DEPLOYMENT_ENV?.trim() ?? "";
  return env.RAFTDEV_ASSISTANT_WITHOUT_RUNTIME === "1" && (deploymentEnv === "" || deploymentEnv === "slockdev");
}

/** The caller's live assistant in this server, or null. */
export type AssistantOf = {
  userId: string;
  /** The owner's handle (`@name`, without the `@`); null if the user row is gone. */
  name: string | null;
  /** The owner's display name; null when they never set one. */
  displayName: string | null;
  /**
   * RFC 077 step 2: Raft runs this assistant's checks and brief (`check` on its
   * wakes); the runtime then turns off its own brief timer, prefilter and local
   * notify. The runtime's only switch; false rolls back to today's behaviour.
   */
  raftCheck: boolean;
  /** The owner's preferred zone, else the last observed browser zone; null when neither is known. */
  timezone: string | null;
  /**
   * The language to talk to the owner in: the owner's translation target,
   * else their UI language; null when neither is set. A BCP 47-ish tag as
   * stored (`zh-CN`, `en`, `zh-cn`).
   */
  language: string | null;
  /** `dm:@owner~human`, the assistant's DM with its owner; null until that DM exists. */
  dmTarget: string | null;
  /** What it may do as its owner on the owner's own routes (assistantOwnerActions.ts), with how to call each. */
  ownerActions: AssistantOwnerActionDescriptor[];
};

/**
 * The `assistantOf` block of an assistant's agent context (RFC 075 v4). The DM
 * target carries `~human` so it stays unambiguous when an agent shares the
 * owner's name.
 */
export async function describeAssistantOf(agent: { id: string; serverId: string; assistantOwnerUserId: string | null }): Promise<AssistantOf | null> {
  const ownerUserId = agent.assistantOwnerUserId;
  if (!ownerUserId) return null;
  const [owner] = await getDb()
    .select({ name: users.name, displayName: users.displayName, preferredTimezone: users.preferredTimezone, lastObservedTimezone: users.lastObservedTimezone, preferredLanguage: users.preferredLanguage, displayLanguage: users.displayLanguage })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1);
  const dmChannelId = owner ? await channelService.findHumanAgentDmChannelId(agent.serverId, ownerUserId, agent.id) : null;
  return {
    userId: ownerUserId,
    name: owner?.name ?? null,
    displayName: owner?.displayName || null,
    raftCheck: assistantRaftCheckEnabled(),
    timezone: owner?.preferredTimezone || owner?.lastObservedTimezone || null,
    language: owner?.preferredLanguage || owner?.displayLanguage || null,
    dmTarget: owner && dmChannelId ? `dm:@${formatDmPeerRef(owner.name, "human")}` : null,
    ownerActions: describeAssistantOwnerActions(owner?.displayName || owner?.name || "your owner"),
  };
}

export async function getMyAssistant(serverId: string, userId: string): Promise<MyAssistant | null> {
  const [agent] = await getDb()
    .select({ id: agents.id, name: agents.name, displayName: agents.displayName, readsDms: agents.assistantReadsDms, sendAsOwner: agents.assistantSendAsOwner, ownerNotes: assistantOwnerNotes.notes })
    .from(agents)
    .leftJoin(assistantOwnerNotes, eq(assistantOwnerNotes.agentId, agents.id))
    .where(and(eq(agents.serverId, serverId), eq(agents.assistantOwnerUserId, userId), isNull(agents.deletedAt)))
    .limit(1);
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.displayName ?? agent.name,
    agentId: agent.id,
    dmChannelId: await channelService.findHumanAgentDmChannelId(serverId, userId, agent.id),
    readsDms: agent.readsDms,
    sendAsOwner: agent.sendAsOwner,
    ownerNotes: agent.ownerNotes ?? null,
  };
}

/** The owner's notes as stored: trimmed, empty means none; refused past the limit. */
export function normalizeAssistantOwnerNotes(raw: unknown): { ok: true; notes: string | null } | { ok: false; reason: string } {
  if (raw === null) return { ok: true, notes: null };
  if (typeof raw !== "string") return { ok: false, reason: "ownerNotes must be text or null." };
  const notes = raw.trim();
  if (notes.length > ASSISTANT_OWNER_NOTES_MAX_LENGTH) return { ok: false, reason: `Keep your notes to ${ASSISTANT_OWNER_NOTES_MAX_LENGTH} characters or fewer.` };
  return { ok: true, notes: notes || null };
}

export async function setAssistantOwnerNotes(agentId: string, notes: string | null, executor: DatabaseExecutor = getDb()): Promise<void> {
  if (notes === null) {
    await executor.delete(assistantOwnerNotes).where(eq(assistantOwnerNotes.agentId, agentId));
    return;
  }
  await executor.insert(assistantOwnerNotes).values({ agentId, notes })
    .onConflictDoUpdate({ target: assistantOwnerNotes.agentId, set: { notes, updatedAt: new Date() } });
}

export class AssistantExistsError extends Error {
  constructor() {
    super("You already have an assistant in this server.");
    this.name = "AssistantExistsError";
  }
}

/** `<owner handle>-assistant`, cut to the handle length limit, with `-2`, `-3`… on a collision. */
export function assistantHandleCandidates(ownerHandle: string): string[] {
  const base = /^[\p{L}]/u.test(ownerHandle) ? ownerHandle : `u${ownerHandle}`;
  const make = (suffix: string) => `${base.slice(0, NAME_MAX_LENGTH - "-assistant".length - suffix.length)}-assistant${suffix}`;
  return [make(""), ...Array.from({ length: 8 }, (_, i) => make(`-${i + 2}`))];
}

/**
 * Create the caller's assistant: a hosted agent provisioned on the cloud
 * runtime, linked to the caller in the same transaction (a second one for the
 * same person and server fails on the partial unique index), in no channel;
 * then its DM with the caller. Throws AssistantExistsError when one exists.
 */
export async function createMyAssistant(input: {
  serverId: string;
  userId: string;
  ownerHandle: string;
}): Promise<{ agentId: string }> {
  if (await getMyAssistant(input.serverId, input.userId)) throw new AssistantExistsError();
  const model = await hostedModelForCreate(input.serverId, null);
  for (const handle of assistantHandleCandidates(input.ownerHandle)) {
    try {
      const agent = await createAgent(input.serverId, handle, {
        runtime: EXTERNAL_AGENT_RUNTIME_ID,
        model: EXTERNAL_AGENT_RUNTIME_MODEL,
        displayName: ASSISTANT_DISPLAY_NAME,
        avatarUrl: ASSISTANT_AVATAR_URL,
        description: `Personal assistant of @${input.ownerHandle}.`,
        creatorType: "user",
        creatorId: input.userId,
        kind: "personal_assistant",
        configChangeSource: "assistant_create",
        afterInsert: async (tx, created) => {
          // Only an agent with no machine becomes an assistant (agents_assistant_not_on_machine).
          if (created.machineId) throw new AssistantCannotUseComputerError();
          try {
            // "Send messages as me" starts on for a new assistant (tygg, task #8);
            // the owner turns it off in its permissions. Existing ones keep theirs.
            await tx.update(agents)
              .set({ assistantOwnerUserId: input.userId, assistantSendAsOwner: true })
              .where(eq(agents.id, created.id));
          } catch (err) {
            if (isUniqueViolation(err, "idx_agents_server_assistant_owner")) throw new AssistantExistsError();
            throw err;
          }
          await recordAgentProvisioning(tx, {
            agent: created,
            provider: ASSISTANT_PROVIDER,
            createdByUserId: input.userId,
            model,
            assistant: true,
          });
          // RFC 077 step 2: Raft briefs an assistant made while it runs the
          // checks from day one. Its schedule row is due now, so the first
          // brief pass does not hold today (that hold only waits for the
          // `check-state/import` of an assistant the runtime briefed before).
          if (assistantRaftCheckEnabled()) {
            await tx.insert(assistantCheckState).values({ agentId: created.id, nextBriefAt: new Date() }).onConflictDoNothing();
          }
        },
      });
      kickAgentRuntimeProvisionWorker();
      const dm = await channelService.findOrCreateDM(input.serverId, input.userId, agent.id);
      if (dm) await keepAssistantDmOutOfActivity({ serverId: input.serverId, ownerUserId: input.userId, dmChannelId: dm.id });
      return { agentId: agent.id };
    } catch (err) {
      if (err instanceof AssistantExistsError) throw err;
      if (isPrincipalHandleConflictError(err) || (err instanceof Error && err.message.includes("already taken"))) continue;
      throw err;
    }
  }
  throw new Error("No free handle for the assistant");
}

/**
 * The owner's DM with their assistant stays out of their Activity (tygg,
 * #proj-assistant a859e8fd): an activity mute from its first message, which
 * Activity and its badge already leave out while the DM's own unread count
 * stays (the composer's otter reads it). Unlike a person's mute it keeps push
 * (`push_muted` false). Leaves alone a row the owner wrote (their own mute).
 */
export async function keepAssistantDmOutOfActivity(
  input: { serverId: string; ownerUserId: string; dmChannelId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  const now = new Date();
  await executor.insert(inboxTargetMuteStates).values({
    receiverType: "user",
    receiverId: input.ownerUserId,
    serverId: input.serverId,
    sourceChannelId: input.dmChannelId,
    activityMuted: true,
    muteFromSeq: 0,
    pushMuted: false,
    prefsVersion: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === "23505" && (candidate.constraint === constraint || candidate.constraint_name === constraint)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Doorbell (RFC 074 §2 item 3): "your owner's inbox has new activity".
//
// Producer: recordInboxNotificationFacts calls recordAssistantDoorbells inside
// the transaction that writes the owner's facts. It only INSERTs ... ON
// CONFLICT DO NOTHING into assistant_doorbells (one pending row per assistant;
// no lock on an existing row, so concurrent messages to the same owner do not
// queue behind each other), and upserts each ringing conversation's highest
// seq into assistant_doorbell_sources (a row lock per conversation only). DMs
// and threads under DMs ring only when the owner lets the assistant read DMs
// (RFC 077), and never the assistant's own DM with the owner; facts that are
// not unread for the owner (their own sends) never ring.
//
// Worker: the first change after a quiet period goes out at once; changes
// within the coalesce window (assistantDoorbellCoalesceMs) of the last doorbell go out together
// when that window closes. A send deletes the pending row (and its sources,
// which go out as payload `sources`) and inserts a
// `system.assistant` event into third_party_agent_events in ONE transaction,
// then delivers it like an app event (inbox row + push). If that delivery
// fails, the row is still queued: the next /events pull rebuilds it and the
// push sweep announces it.
// ---------------------------------------------------------------------------

/** RFC 075 v4: 5 minutes, so a busy morning wakes the assistant a few times an hour, not every 30 s. */
export const ASSISTANT_DOORBELL_COALESCE_MS = 5 * 60_000;

/** `ASSISTANT_DOORBELL_COALESCE_MS` env override (ms, 1 s to 1 h); the default otherwise. */
export function assistantDoorbellCoalesceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ASSISTANT_DOORBELL_COALESCE_MS);
  return Number.isInteger(raw) && raw >= 1_000 && raw <= 60 * 60_000 ? raw : ASSISTANT_DOORBELL_COALESCE_MS;
}
export const ASSISTANT_DOORBELL_TTL_MS = 60 * 60 * 1000;
/**
 * RFC 077 step 2: at most one DM from doorbells in this window. What rings
 * meanwhile waits on the doorbell and goes out together in the next one.
 */
export const ASSISTANT_NOTIFY_SPACING_MS = 30 * 60_000;
const ASSISTANT_DOORBELL_POLL_MS = 5_000;
const ASSISTANT_DOORBELL_KICK_DELAY_MS = 250;
const ASSISTANT_DOORBELL_BATCH = 100;

export async function recordAssistantDoorbells(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor,
): Promise<number> {
  return ringAssistantDoorbells(facts
    .filter((fact) => fact.receiverType === "user")
    .map((fact) => fact.unreadEligible === false
      // Not unread for the owner: their own send (RFC 077 owner action), if the
      // message really is theirs and not one their assistant sent for them.
      ? { receiverId: fact.receiverId, serverId: fact.serverId, channelId: fact.sourceChannelId, seq: fact.messageSeq, messageId: fact.messageId, ownerAction: true, requireOwnerSender: true }
      : { receiverId: fact.receiverId, serverId: fact.serverId, channelId: fact.sourceChannelId, seq: fact.messageSeq, messageId: fact.messageId, ownerAction: false, requireOwnerSender: false }), executor);
}

/**
 * RFC 077: the owner's own actions outside a message send also ring their
 * assistant, in the same 5-minute window: a reaction, a task status change.
 * `seq` is the related message's seq (never ahead of the conversation).
 */
export async function recordAssistantOwnerAction(
  input: { ownerUserId: string; serverId: string; channelId: string; seq: number; messageId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<number> {
  return ringAssistantDoorbells([{
    receiverId: input.ownerUserId, serverId: input.serverId, channelId: input.channelId, seq: input.seq,
    messageId: input.messageId, ownerAction: true, requireOwnerSender: false,
  }], executor);
}

/**
 * A task change made by a person rings their assistant (RFC 077 owner
 * actions): status changes, reopen, close and reassignment. Cheap when the
 * person has no assistant (one indexed probe).
 */
export async function recordAssistantOwnerTaskAction(
  input: { actorUserId: string; taskRowId: string },
  executor: DatabaseExecutor,
): Promise<void> {
  const result = await executor.execute(sql`
    SELECT t.channel_id, c.server_id, t.message_id, m.seq::text AS seq
    FROM ${tasks} t
    JOIN ${channels} c ON c.id = t.channel_id
    LEFT JOIN ${messages} m ON m.id = t.message_id
    WHERE t.id = ${input.taskRowId}
      AND EXISTS (SELECT 1 FROM ${agents} a WHERE a.assistant_owner_user_id = ${input.actorUserId} AND a.server_id = c.server_id AND a.deleted_at IS NULL)
    LIMIT 1`);
  const [row] = result.rows as Array<{ channel_id: string; server_id: string; message_id: string | null; seq: string | null }>;
  if (!row?.message_id || row.seq == null) return;
  await recordAssistantOwnerAction({ ownerUserId: input.actorUserId, serverId: row.server_id, channelId: row.channel_id, seq: Number(row.seq), messageId: row.message_id }, executor);
}

type DoorbellRing = {
  receiverId: string;
  serverId: string;
  channelId: string;
  seq: number;
  messageId: string;
  /** Caused by the owner themself (RFC 077 owner actions). */
  ownerAction: boolean;
  /** Only when the message's sender is the owner (and not delegated). */
  requireOwnerSender: boolean;
};

async function ringAssistantDoorbells(rings: readonly DoorbellRing[], executor: DatabaseExecutor): Promise<number> {
  const keyed = new Map<string, DoorbellRing>();
  for (const ring of rings) {
    const key = `${ring.receiverId}:${ring.serverId}:${ring.channelId}:${ring.ownerAction}`;
    const seen = keyed.get(key);
    if (!seen || ring.seq > seen.seq) keyed.set(key, ring);
  }
  if (keyed.size === 0) return 0;
  const rows = [...keyed.values()];
  // One probe whatever the fan-out (array parameters). The join on agents uses
  // the partial unique (server_id, assistant_owner_user_id) index, so a batch
  // with no assistant owner costs one index probe per receiver and writes
  // nothing; the message join is by primary key and only matters for owner sends.
  const probe = await executor.execute(sql`
    SELECT a.id AS agent_id, a.server_id, a.assistant_owner_user_id AS owner_user_id, f.channel_id,
      max(f.seq)::text AS max_seq, bool_or(f.owner_action) AS owner_action
    FROM unnest(
      ${sql.param(rows.map((row) => row.receiverId))}::uuid[],
      ${sql.param(rows.map((row) => row.serverId))}::uuid[],
      ${sql.param(rows.map((row) => row.channelId))}::uuid[],
      ${sql.param(rows.map((row) => row.seq))}::bigint[],
      ${sql.param(rows.map((row) => row.messageId))}::uuid[],
      ${sql.param(rows.map((row) => row.ownerAction))}::boolean[],
      ${sql.param(rows.map((row) => row.requireOwnerSender))}::boolean[]
    ) AS f(receiver_id, server_id, channel_id, seq, message_id, owner_action, require_owner_sender)
    JOIN ${agents} a
      ON a.server_id = f.server_id
     AND a.assistant_owner_user_id = f.receiver_id
     AND a.deleted_at IS NULL
    JOIN ${channels} c ON c.id = f.channel_id
    LEFT JOIN ${channels} p ON p.id = c.parent_channel_id
    LEFT JOIN ${messages} m ON f.require_owner_sender AND m.id = f.message_id
    WHERE (
        NOT f.require_owner_sender
        OR (m.sender_type = 'user' AND m.sender_id = f.receiver_id::text AND m.message_type = 'chat' AND m.delegated_by_agent_id IS NULL)
      )
      AND (
        -- Threads and task v2 conversations ring only when their parent
        -- channel is not a DM (a task conversation names it on the row).
        c.type NOT IN ('dm', 'thread', 'task')
        OR (c.type IN ('thread', 'task') AND p.id IS NOT NULL AND p.type <> 'dm')
        -- A joint thread's local projection has no parent fields; its parent
        -- is a joint channel, never a DM.
        OR (c.type = 'thread' AND c.parent_channel_id IS NULL AND EXISTS (
          SELECT 1 FROM ${jointChannelServers} jcs
          WHERE jcs.local_channel_id = c.id AND jcs.server_id = f.server_id AND jcs.status = 'active'
        ))
        -- RFC 077: the owner's DMs (and threads / task conversations under
        -- them) ring when the owner lets the assistant read DMs, except its own
        -- DM with the owner.
        OR (a.assistant_reads_dms AND c.type = 'dm' AND NOT EXISTS (
          SELECT 1 FROM ${channelAgents} ca WHERE ca.channel_id = c.id AND ca.agent_id = a.id
        ))
        OR (a.assistant_reads_dms AND c.type IN ('thread', 'task') AND p.type = 'dm' AND NOT EXISTS (
          SELECT 1 FROM ${channelAgents} ca WHERE ca.channel_id = p.id AND ca.agent_id = a.id
        ))
      )
    GROUP BY a.id, a.server_id, a.assistant_owner_user_id, f.channel_id
    ORDER BY a.id, f.channel_id`);
  const matched = probe.rows as Array<{ agent_id: string; server_id: string; owner_user_id: string; channel_id: string; max_seq: string; owner_action: boolean }>;
  if (matched.length === 0) return 0;
  // Lock order, here and in the drain: the doorbell row, then its sources, each
  // in id order. ON CONFLICT DO NOTHING takes no lock on a pending doorbell, so
  // concurrent messages to one owner do not queue behind each other; the
  // source upsert locks one conversation's row only.
  const agentsToRing = [...new Map(matched.map((row) => [row.agent_id, row])).values()];
  const result = await executor.execute(sql`
    INSERT INTO ${assistantDoorbells} (agent_id, server_id, owner_user_id)
    SELECT * FROM unnest(${sql.param(agentsToRing.map((row) => row.agent_id))}::uuid[], ${sql.param(agentsToRing.map((row) => row.server_id))}::uuid[], ${sql.param(agentsToRing.map((row) => row.owner_user_id))}::uuid[])
    ON CONFLICT (agent_id) DO NOTHING
    RETURNING agent_id`);
  await executor.execute(sql`
    INSERT INTO ${assistantDoorbellSources} (agent_id, source_channel_id, max_seq, owner_action)
    SELECT * FROM unnest(
      ${sql.param(matched.map((row) => row.agent_id))}::uuid[],
      ${sql.param(matched.map((row) => row.channel_id))}::uuid[],
      ${sql.param(matched.map((row) => row.max_seq))}::bigint[],
      ${sql.param(matched.map((row) => row.owner_action))}::boolean[]
    )
    ON CONFLICT (agent_id, source_channel_id)
      DO UPDATE SET max_seq = GREATEST(${assistantDoorbellSources}.max_seq, EXCLUDED.max_seq),
        owner_action = ${assistantDoorbellSources}.owner_action OR EXCLUDED.owner_action`);
  const inserted = result.rows.length;
  // After commit, so the drain never runs inside (and savepoints onto) the producing transaction.
  if (inserted > 0) afterAmbientTransaction(kickAssistantDoorbellDrain);
  return inserted;
}

type DoorbellDeliverer = Pick<AgentOrchestrator, "deliverMessage">;

let doorbellDeliverer: DoorbellDeliverer | null = null;
// The poll and the post-commit kick run outside any request context, where
// recordTraceEvent would fall back to the noop tracer and drop the send events.
let doorbellTracer: Tracer | undefined;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let draining: Promise<number> | null = null;

/** Schedule a drain shortly after the producing transaction has likely committed. The poll is the floor. */
export function kickAssistantDoorbellDrain(): void {
  if (!doorbellDeliverer || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void runAssistantDoorbellDrain();
  }, ASSISTANT_DOORBELL_KICK_DELAY_MS);
  kickTimer.unref?.();
}

function runAssistantDoorbellDrain(): Promise<number> {
  if (!doorbellDeliverer) return Promise.resolve(0);
  if (draining) return draining;
  const deliverer = doorbellDeliverer;
  draining = drainAssistantDoorbells({ deliverer, tracer: doorbellTracer })
    .catch((err) => {
      console.error("[AssistantDoorbell] drain failed", err);
      return 0;
    })
    .finally(() => { draining = null; });
  return draining;
}

/**
 * Pushes one of the assistant's own system.assistant events (an owner-action
 * card's outcome, assistantOwnerActionCards.ts) now. Without a deliverer on
 * this instance, or when the push fails, it stays queued: the assistant reads
 * it from /events, and the redelivery sweeps pick it up.
 */
export async function deliverAssistantSystemEvent(event: SystemAppAgentEvent): Promise<boolean> {
  if (!doorbellDeliverer) return false;
  return deliverSystemAppAgentEvent({
    event,
    deliverer: doorbellDeliverer,
    onDeliveryError: (err) => console.warn("[assistant] owner-action event push failed:", err instanceof Error ? err.message : err),
  });
}

/** Owner-action cards expire after 24 hours; checked this often. */
const ASSISTANT_OWNER_ACTION_CARD_SWEEP_MS = 5 * 60 * 1000;

const ASSISTANT_TOLD_SWEEP_MS = 60 * 60 * 1000;
const ASSISTANT_BRIEF_SWEEP_MS = 60 * 1000;

export function startAssistantDoorbellWorker(input: { agentOrchestrator: DoorbellDeliverer; tracer?: Tracer }): { stop(): void } {
  doorbellDeliverer = input.agentOrchestrator;
  doorbellTracer = input.tracer;
  const interval = setInterval(() => { void runAssistantDoorbellDrain(); }, ASSISTANT_DOORBELL_POLL_MS);
  interval.unref?.();
  // RFC 077: "already told" facts past their 30 days, hourly (imported lazily: that module imports this one).
  // Also once at start, so deploys more often than hourly still sweep.
  const sweepTold = () => {
    void import("./assistantContactRulesService")
      .then(({ sweepAssistantTold }) => sweepAssistantTold())
      .catch((err) => console.error("[assistant] told sweep failed:", err instanceof Error ? err.message : err));
  };
  const toldSweepStart = setTimeout(sweepTold, 30_000);
  toldSweepStart.unref?.();
  const toldSweep = setInterval(sweepTold, ASSISTANT_TOLD_SWEEP_MS);
  toldSweep.unref?.();
  // RFC 077 step 2c: the morning brief, once a minute (a no-op unless ASSISTANT_RAFT_CHECK=on).
  const briefs = setInterval(() => {
    if (!doorbellDeliverer) return;
    void runAssistantBriefs({ deliverer: doorbellDeliverer, tracer: doorbellTracer })
      .catch((err) => console.error("[assistant] brief sweep failed:", err instanceof Error ? err.message : err));
  }, ASSISTANT_BRIEF_SWEEP_MS);
  briefs.unref?.();
  // #proj-assistant:#19: owner-action cards nobody answered in 24 hours end expired (each assistant told).
  // No socket server here: the card's new state reaches clients on their next read of the DM.
  const ownerActionCards = setInterval(() => {
    void import("./assistantOwnerActionCards")
      .then(({ sweepExpiredAssistantOwnerActionCards }) => sweepExpiredAssistantOwnerActionCards(null))
      .catch((err) => console.error("[assistant] owner-action card sweep failed:", err instanceof Error ? err.message : err));
  }, ASSISTANT_OWNER_ACTION_CARD_SWEEP_MS);
  ownerActionCards.unref?.();
  return {
    stop() {
      clearInterval(interval);
      clearInterval(toldSweep);
      clearInterval(briefs);
      clearInterval(ownerActionCards);
      clearTimeout(toldSweepStart);
      if (kickTimer) clearTimeout(kickTimer);
      kickTimer = null;
      doorbellDeliverer = null;
      doorbellTracer = undefined;
    },
  };
}

/** The ids among `channelIds` that are a DM or a thread (or task v2 conversation) under a DM. */
async function dmScopedChannelIds(channelIds: readonly string[], executor: DatabaseExecutor): Promise<Set<string>> {
  if (channelIds.length === 0) return new Set();
  const result = await executor.execute(sql`
    SELECT c.id
    FROM ${channels} c
    LEFT JOIN ${channels} p ON p.id = c.parent_channel_id
    WHERE c.id = ANY(${sql.param([...channelIds])}::uuid[])
      AND (c.type = 'dm' OR (c.type IN ('thread', 'task') AND p.type = 'dm'))`);
  return new Set((result.rows as Array<{ id: string }>).map((row) => row.id));
}

/**
 * A message whose doorbell insert found one pending (DO NOTHING) can write its
 * source just after that doorbell was claimed: the source then has no doorbell.
 * Give it one, so it rings in the next window instead of waiting for more
 * activity; drop sources whose agent is no longer an assistant.
 */
async function ringOrphanedDoorbellSources(tracer?: Tracer): Promise<void> {
  // Same bounded lock wait as the drop and claim: its doorbell INSERT can meet
  // a producer's uncommitted doorbell while that producer waits on this one.
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${ASSISTANT_DOORBELL_DRAIN_LOCK_TIMEOUT}'`));
      await sweepOrphanedDoorbellSources(tx);
    });
  } catch (err) {
    if (!isLockNotAvailable(err)) throw err;
    recordDoorbellLockTimeout(null, "orphan_sweep", tracer);
  }
}

async function sweepOrphanedDoorbellSources(db: DatabaseExecutor): Promise<void> {
  await db.execute(sql`
    DELETE FROM ${assistantDoorbellSources} s
    USING ${agents} a
    WHERE a.id = s.agent_id AND (a.assistant_owner_user_id IS NULL OR a.deleted_at IS NOT NULL)`);
  await db.execute(sql`
    INSERT INTO ${assistantDoorbells} (agent_id, server_id, owner_user_id)
    SELECT DISTINCT a.id, a.server_id, a.assistant_owner_user_id
    FROM ${assistantDoorbellSources} s
    JOIN ${agents} a ON a.id = s.agent_id AND a.assistant_owner_user_id IS NOT NULL AND a.deleted_at IS NULL
    WHERE NOT EXISTS (SELECT 1 FROM ${assistantDoorbells} d WHERE d.agent_id = s.agent_id)
    ORDER BY a.id
    ON CONFLICT (agent_id) DO NOTHING`);
}

/**
 * Send every pending doorbell whose window is open. Returns how many were
 * sent. Pending rows of an assistant that is no longer effective (flag off,
 * link cleared, owner gone) are dropped without a send.
 */
/** One check, woken or not (AndyLok): ids, enums and counts only. */
function recordAssistantCheckTrace(input: {
  agentId: string;
  trigger: "doorbell" | "brief";
  woke: boolean;
  reason: "invoked" | "no_items" | "night_held" | "read_behind";
  counts: NeedsOwnerCounts;
  checkId?: string;
  /** Doorbell checks: how long this doorbell had waited on a trailing read (0 if it never trailed). Trace only. */
  behindWaitedMs?: number;
}, tracer?: Tracer): void {
  recordTraceEvent("server.assistant.check", {
    agent_id: input.agentId,
    trigger: input.trigger,
    woke: input.woke,
    reason: input.reason,
    ...(input.checkId ? { check_id: input.checkId } : {}),
    ...(input.behindWaitedMs !== undefined ? { behind_waited_ms: input.behindWaitedMs } : {}),
    ...input.counts,
  }, tracer);
}

/** How long a doorbell waits for an inbox read that trails it before deciding on what was read. */
export const ASSISTANT_CHECK_LAG_WAIT_MS = 60_000;
/** A new message restarts that wait, but a doorbell never waits longer than this in all (a read that stays behind). */
export const ASSISTANT_CHECK_LAG_MAX_WAIT_MS = 3 * 60_000;

/** A ring landed between a doorbell's plan and its claim: give the claim up; the next poll plans again. */
class DoorbellMovedError extends Error {}

/**
 * The drain's own transactions (drop and claim) wait at most this long for a
 * row lock, then give the doorbell up for the next poll. A producer transaction
 * (a message or task write) can ring twice: it upserts a source, then inserts a
 * doorbell row the drain is deleting, while the drain waits for that source;
 * PostgreSQL then kills one side after deadlock_timeout (1 s), sometimes the
 * user's request (10-26 02:35Z, #proj-o11y:058cb07b). Timing out first keeps
 * the user-facing side alive; the doorbell stays queued.
 */
export const ASSISTANT_DOORBELL_DRAIN_LOCK_TIMEOUT = "200ms";

function isLockNotAvailable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The pending doorbell first rung at `firstChangeAt` (as read back into a JS
 * Date). The column keeps microseconds (`now()`), a Date only milliseconds, so
 * a plain equality never matches a row the producer inserted.
 */
function sameDoorbell(firstChangeAt: Date) {
  return sql`date_trunc('milliseconds', ${assistantDoorbells.firstChangeAt}) = ${firstChangeAt.toISOString()}::timestamptz`;
}

/**
 * A doorbell whose assistant sent its owner a doorbell DM within `windowMs`
 * before `now`: it waits, and is left out of the batch so it never holds a
 * place a doorbell that may go out needs (Tenny, #11713 review). The stored
 * notify is assistantNotifyService's StoredNotify: `{ result: { outcome }, content }`.
 */
function notifiedWithin(now: Date, windowMs: number) {
  return sql`EXISTS (
    SELECT 1 FROM ${assistantChecks}
    WHERE ${assistantChecks.agentId} = ${assistantDoorbells.agentId}
      AND ${assistantChecks.trigger} = 'doorbell'
      AND ${assistantChecks.createdAt} > ${new Date(now.getTime() - windowMs).toISOString()}::timestamptz
      AND ${assistantChecks.notifyResult}->'result'->>'outcome' = 'sent'
  )`;
}

function recordDoorbellLockTimeout(agentId: string | null, step: "drop" | "claim" | "orphan_sweep", tracer?: Tracer): void {
  recordTraceEvent("server.assistant.doorbell.lock_timeout", { ...(agentId ? { agent_id: agentId } : {}), step }, tracer);
}

/**
 * RFC 081 inbox items (`object.ref`) of the assistant's own events, beside
 * the owner-action cards' (`card/<card message id>`,
 * assistantOwnerActionCards.ts): the doorbell's is the owner's inbox, the
 * morning brief's its owner-local day.
 */
export function assistantOwnerInboxObjectRef(ownerUserId: string): string {
  return `owner-inbox/${ownerUserId}`;
}

export function assistantBriefObjectRef(day: string): string {
  return `brief/${day}`;
}

export async function drainAssistantDoorbells(input: { deliverer: DoorbellDeliverer; now?: Date; tracer?: Tracer; /** Tests only. */ batch?: number }): Promise<number> {
  const db = getDb();
  const now = input.now ?? new Date();
  const coalesceMs = assistantDoorbellCoalesceMs();
  await ringOrphanedDoorbellSources(input.tracer);
  const raftCheck = assistantRaftCheckEnabled();
  const pending = await db
    .select()
    .from(assistantDoorbells)
    .where(raftCheck ? sql`NOT ${notifiedWithin(now, ASSISTANT_NOTIFY_SPACING_MS)}` : undefined)
    .orderBy(asc(assistantDoorbells.firstChangeAt))
    .limit(input.batch ?? ASSISTANT_DOORBELL_BATCH);
  let sent = 0;
  for (const row of pending) {
    // Not this owner's effective assistant, or paused by an admin: nothing to ring.
    if (await resolveAssistantOwner(row.agentId, row.serverId) !== row.ownerUserId || await isAssistantPaused(row.agentId)) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${ASSISTANT_DOORBELL_DRAIN_LOCK_TIMEOUT}'`));
          const dropped = await tx.delete(assistantDoorbells).where(and(
            eq(assistantDoorbells.agentId, row.agentId),
            sameDoorbell(row.firstChangeAt),
          )).returning({ agentId: assistantDoorbells.agentId });
          if (dropped.length > 0) await tx.delete(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, row.agentId));
        });
      } catch (err) {
        if (!isLockNotAvailable(err)) throw err;
        recordDoorbellLockTimeout(row.agentId, "drop", input.tracer);
      }
      continue;
    }
    const [last] = await db
      .select({ createdAt: thirdPartyAgentEvents.createdAt })
      .from(thirdPartyAgentEvents)
      .where(and(
        eq(thirdPartyAgentEvents.agentId, row.agentId),
        eq(thirdPartyAgentEvents.systemApp, SYSTEM_ASSISTANT_APP),
      ))
      .orderBy(desc(thirdPartyAgentEvents.createdAt))
      .limit(1);
    if (last && now.getTime() - last.createdAt.getTime() < coalesceMs) continue;

    // RFC 077 step 2: Raft decides what needs the owner (planned before the
    // claim, reads only); the claimer records the check with the wake.
    // The sources as planned: a ring between the plan and the claim (it bumps
    // or adds a source) means the plan may have missed it, so the claim is
    // given up and the next poll plans again (Tenny, #10610 review).
    const sourceRows = raftCheck
      ? await db.select().from(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, row.agentId))
      : [];
    const plannedSources = raftCheck ? new Map(sourceRows.map((source) => [source.sourceChannelId, source.maxSeq])) : null;
    // Lag is judged only on what others posted: the owner's own actions are not unread for them.
    const awaitedSources = new Map(sourceRows.filter((source) => !source.ownerAction).map((source) => [source.sourceChannelId, source.maxSeq]));
    const plan: CheckPlan | null = raftCheck
      ? await planCheck({ agentId: row.agentId, serverId: row.serverId, ownerUserId: row.ownerUserId, trigger: "doorbell", now, sourceSeqs: awaitedSources })
      : null;
    // The inbox read trailed the doorbell (a conversation rang at a seq the read does not show):
    // leave the doorbell for the next poll to plan again, for up to ASSISTANT_CHECK_LAG_WAIT_MS,
    // then go ahead on what was read (InNOut, 2026-10-21: a told recorded below the new message).
    // The wait is timed on the doorbell row (first poll that found it behind), so
    // every replica times the same wait and a consumed doorbell takes it along.
    let behindWaitedMs = 0;
    if (plan?.readBehind) {
      // A source rang again (its seq grew): the new message gets its own full wait.
      const awaitedKey = [...awaitedSources].map(([channelId, seq]) => `${channelId}:${seq}`).sort().join(",");
      const [marked] = await db.update(assistantDoorbells)
        .set({
          behindSince: sql`CASE WHEN ${assistantDoorbells.behindSince} IS NULL OR ${assistantDoorbells.behindSources} IS DISTINCT FROM ${awaitedKey}
            THEN ${now.toISOString()}::timestamptz ELSE ${assistantDoorbells.behindSince} END`,
          behindSources: awaitedKey,
          behindFirstSince: sql`COALESCE(${assistantDoorbells.behindFirstSince}, ${now.toISOString()}::timestamptz)`,
        })
        .where(and(eq(assistantDoorbells.agentId, row.agentId), sameDoorbell(row.firstChangeAt)))
        .returning({ behindSince: assistantDoorbells.behindSince, behindFirstSince: assistantDoorbells.behindFirstSince });
      // Claimed or re-rung meanwhile: the next poll plans again.
      if (!marked?.behindSince || !marked.behindFirstSince) continue;
      const sinceLatest = Math.max(0, now.getTime() - marked.behindSince.getTime());
      // Reported as the whole wait, restarts included.
      behindWaitedMs = Math.max(0, now.getTime() - marked.behindFirstSince.getTime());
      if (sinceLatest < ASSISTANT_CHECK_LAG_WAIT_MS && behindWaitedMs < ASSISTANT_CHECK_LAG_MAX_WAIT_MS) {
        if (sinceLatest === 0) {
          recordAssistantCheckTrace({ agentId: row.agentId, trigger: "doorbell", woke: false, reason: "read_behind", counts: plan.kind === "wake" ? plan.check.counts : plan.counts, behindWaitedMs }, input.tracer);
        }
        continue;
      }
    }

    let won = false;
    let event: Awaited<ReturnType<typeof claimDoorbell>> = null;
    const claimDoorbell = () => db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${ASSISTANT_DOORBELL_DRAIN_LOCK_TIMEOUT}'`));
      const [claimed] = await tx
        .delete(assistantDoorbells)
        .where(eq(assistantDoorbells.agentId, row.agentId))
        .returning();
      // Another replica sent it first.
      if (!claimed) return null;
      won = true;
      const claimedSources = await tx
        .delete(assistantDoorbellSources)
        .where(eq(assistantDoorbellSources.agentId, claimed.agentId))
        .returning();
      if (plannedSources && claimedSources.some((source) => (plannedSources.get(source.sourceChannelId) ?? -1) < source.maxSeq)) {
        throw new DoorbellMovedError();
      }
      // Only conversations the owner can still see (owner-inbox's own check), so
      // a listed source that is missing from the inbox means "not caught up yet".
      const visible = await channelService.filterUserAccessibleChannelIds(
        claimedSources.map((source) => source.sourceChannelId),
        claimed.ownerUserId,
        asServerId(claimed.serverId),
      );
      // RFC 077: DM sources only while the owner still lets the assistant read DMs
      // (the switch may have been turned off after they rang).
      const dmSourceIds = claimedSources.length > 0 && !await assistantReadsOwnerDms(claimed.agentId)
        ? await dmScopedChannelIds(claimedSources.map((source) => source.sourceChannelId), tx)
        : new Set<string>();
      const sources = claimedSources.filter((source) => visible.has(source.sourceChannelId) && !dmSourceIds.has(source.sourceChannelId));
      // Everything that rang it was a DM the owner has since closed to the assistant: nothing to say.
      if (claimedSources.length > 0 && dmSourceIds.size === claimedSources.length) return null;
      // Nothing needs the owner: no wake (the saving step 2 is for).
      if (plan?.kind === "skip") return null;
      if (plan?.kind === "wake") await recordCheck(tx, { agentId: claimed.agentId, check: plan.check, items: plan.items, briefDay: null, now });
      const payload = {
        type: "owner_inbox_updated",
        owner_user_id: claimed.ownerUserId,
        first_change_at: claimed.firstChangeAt.toISOString(),
        last_change_at: now.toISOString(),
        // The inbox has caught up with this doorbell once every listed conversation
        // is in it with its latest seq at max_seq or above (`channel_id` as in the
        // owner inbox; only conversations the owner can see now). Additive: empty on
        // a doorbell recorded before the sources existed.
        sources: sources
          .sort((a, b) => a.sourceChannelId.localeCompare(b.sourceChannelId))
          .map((source) => ({ channel_id: source.sourceChannelId, max_seq: source.maxSeq, owner_action: source.ownerAction })),
        // RFC 077: something in this window was the owner's own doing (read it with owner-activity).
        includes_owner_actions: sources.some((source) => source.ownerAction),
        // RFC 077 step 2: what Raft's check decided the assistant should look at.
        ...(plan?.kind === "wake" ? { check: plan.check } : {}),
      };
      return createSystemAppAgentEvent({
        serverId: claimed.serverId,
        agentId: claimed.agentId,
        systemApp: SYSTEM_ASSISTANT_APP,
        kind: "event",
        // No "(DMs not included)": DMs are in it whenever the owner lets the assistant read them (InNOut, #proj-assistant:#3).
        summary: "Your owner's inbox has new activity. List it with the assistant owner inbox.",
        payload,
        ttlMs: ASSISTANT_DOORBELL_TTL_MS,
        now,
        executor: tx,
        // RFC 081: every doorbell is about the one owner inbox, so they share its row; a ring while it is unread joins it.
        objectRef: assistantOwnerInboxObjectRef(claimed.ownerUserId),
      });
    });
    try {
      event = await claimDoorbell();
    } catch (err) {
      if (err instanceof DoorbellMovedError) continue;
      // A producer holds a source or the doorbell row: leave it queued for the next poll.
      if (isLockNotAvailable(err)) {
        recordDoorbellLockTimeout(row.agentId, "claim", input.tracer);
        continue;
      }
      throw err;
    }
    // Only the instance that claimed it reports the check (a lost race is not a check).
    if (plan && won) {
      recordAssistantCheckTrace({
        agentId: row.agentId,
        trigger: "doorbell",
        woke: plan.kind === "wake" && !!event,
        reason: plan.kind === "wake" ? "invoked" : plan.reason,
        counts: plan.kind === "wake" ? plan.check.counts : plan.counts,
        behindWaitedMs,
        ...(plan.kind === "wake" && event ? { checkId: plan.check.id } : {}),
      }, input.tracer);
    }
    if (!event) continue;
    sent += 1;
    recordTraceEvent("server.assistant.doorbell.sent", {
      agent_id: event.agentId,
      subject_user_id: row.ownerUserId,
      event_id: event.id,
      pending_ms: now.getTime() - row.firstChangeAt.getTime(),
      source_count: ((event.payload as { sources?: unknown[] }).sources ?? []).length,
    }, input.tracer);
    // A failed push leaves it queued in the table: the next /events pull
    // rebuilds it and the push sweep announces it.
    await deliverSystemAppAgentEvent({
      event,
      deliverer: input.deliverer,
      onDeliveryError: (err) => console.error("[AssistantDoorbell] delivery failed; left queued", err),
    });
  }
  return sent;
}

/**
 * RFC 077 step 2c: the morning brief, scheduled by Raft (`ASSISTANT_RAFT_CHECK=on`).
 * Every live assistant has an `assistant_check_state` row whose `next_brief_at`
 * is the next 08:00 owner-local; the minute sweep claims due rows by moving
 * that time forward (an instance that loses the race skips), and runs the same
 * query as a doorbell in brief mode. Nothing needs the owner: no wake.
 */
const ASSISTANT_BRIEF_ROWS_SYNC_MS = 10 * 60_000;
let lastBriefRowsSync = 0;
/** Test seam: the next sweep also creates schedule rows. */
export function __resetAssistantBriefRowsSyncForTests(): void {
  lastBriefRowsSync = 0;
}

export async function runAssistantBriefs(input: { deliverer: DoorbellDeliverer; now?: Date; tracer?: Tracer }): Promise<number> {
  if (!assistantRaftCheckEnabled()) return 0;
  const db = getDb();
  const now = input.now ?? new Date();
  // New assistants get a schedule row: at most every 10 minutes, and only for
  // those without one (the claim below reads by the next_brief_at index).
  if (now.getTime() - lastBriefRowsSync >= ASSISTANT_BRIEF_ROWS_SYNC_MS) {
    lastBriefRowsSync = now.getTime();
    await db.execute(sql`
      INSERT INTO ${assistantCheckState} (agent_id)
      SELECT a.id FROM ${agents} a
      WHERE a.assistant_owner_user_id IS NOT NULL AND a.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ${assistantCheckState} s WHERE s.agent_id = a.id)
      ON CONFLICT (agent_id) DO NOTHING`);
  }
  const due = await db.select().from(assistantCheckState)
    .where(or(isNull(assistantCheckState.nextBriefAt), lte(assistantCheckState.nextBriefAt, now)))
    .limit(ASSISTANT_DOORBELL_BATCH);
  let woke = 0;
  for (const row of due) {
    const [agent] = await db.select({ id: agents.id, serverId: agents.serverId, ownerUserId: agents.assistantOwnerUserId, pausedAt: agents.assistantPausedAt })
      .from(agents).where(and(eq(agents.id, row.agentId), isNull(agents.deletedAt))).limit(1);
    // Paused by an admin: no brief (it is not effective until its owner starts it again).
    const ownerUserId = agent?.ownerUserId && !agent.pausedAt && await resolveAssistantOwner(agent.id, agent.serverId) === agent.ownerUserId ? agent.ownerUserId : null;
    const o = agent && ownerUserId ? { agentId: agent.id, serverId: agent.serverId, ownerUserId } : null;
    const zone = o ? (await contactContext(o)).zone : "UTC";
    const next = o ? nextBriefAt(now.getTime(), zone) : new Date(now.getTime() + 60 * 60 * 1000);
    // The first pass only schedules: it also holds today's brief (Tenny, #raft-antiproton:84bedc06),
    // so a runtime switching over that already briefed today does not brief twice. Its
    // `check-state/import` releases today's brief if it did not (`importAssistantCheckState`).
    const firstPass = row.nextBriefAt === null && o;
    const claimed = await db.update(assistantCheckState).set({
      nextBriefAt: next,
      ...(firstPass ? { briefSentDay: localDay(now.getTime(), zone) } : {}),
      updatedAt: now,
    }).where(and(
      eq(assistantCheckState.agentId, row.agentId),
      // Millisecond-truncated: a value written by SQL (now(), microseconds) is still claimable.
      row.nextBriefAt === null
        ? isNull(assistantCheckState.nextBriefAt)
        : sql`date_trunc('milliseconds', ${assistantCheckState.nextBriefAt}) = ${row.nextBriefAt.toISOString()}::timestamptz`,
    )).returning({ agentId: assistantCheckState.agentId });
    // Another instance took it, the row was only being scheduled, or the assistant is not effective.
    if (claimed.length === 0 || row.nextBriefAt === null || !o) continue;
    const day = localDay(now.getTime(), zone);
    const hour = localHour(now.getTime(), zone);
    // Claimed outside 08:00-11:59 owner-local (a zone change, or a sweep that ran late): no brief that day.
    if (hour < BRIEF_HOUR || hour >= BRIEF_LATEST_HOUR || row.briefSentDay === day) continue;
    let plan: CheckPlan;
    try {
      plan = await planCheck({ ...o, trigger: "brief", now });
    } catch (err) {
      // A failed plan does not lose the day: try again in 5 minutes while still inside the window.
      console.error("[AssistantBrief] plan failed; retrying", err instanceof Error ? err.message : err);
      await db.update(assistantCheckState).set({ nextBriefAt: new Date(now.getTime() + 5 * 60_000), updatedAt: now })
        .where(eq(assistantCheckState.agentId, o.agentId));
      continue;
    }
    if (plan.kind === "skip") {
      await db.update(assistantCheckState).set({ briefSentDay: day, updatedAt: now }).where(eq(assistantCheckState.agentId, o.agentId));
      recordAssistantCheckTrace({ agentId: o.agentId, trigger: "brief", woke: false, reason: plan.reason, counts: plan.counts }, input.tracer);
      continue;
    }
    const event = await db.transaction(async (tx) => {
      await recordCheck(tx, { agentId: o.agentId, check: plan.check, items: plan.items, briefDay: day, now });
      await tx.update(assistantCheckState).set({ briefSentDay: day, updatedAt: now }).where(eq(assistantCheckState.agentId, o.agentId));
      const payload = { type: "owner_brief", owner_user_id: o.ownerUserId, brief_day: day, check: plan.check };
      return createSystemAppAgentEvent({
        serverId: o.serverId,
        agentId: o.agentId,
        systemApp: SYSTEM_ASSISTANT_APP,
        kind: "event",
        summary: "Morning brief: what is waiting on your owner.",
        payload,
        ttlMs: ASSISTANT_DOORBELL_TTL_MS,
        now,
        executor: tx,
        // RFC 081: each day's brief is its own row, apart from the doorbell's.
        objectRef: assistantBriefObjectRef(day),
      });
    });
    recordAssistantCheckTrace({ agentId: o.agentId, trigger: "brief", woke: !!event, reason: "invoked", counts: plan.check.counts, ...(event ? { checkId: plan.check.id } : {}) }, input.tracer);
    if (!event) continue;
    woke += 1;
    await deliverSystemAppAgentEvent({
      event,
      deliverer: input.deliverer,
      onDeliveryError: (err) => console.error("[AssistantBrief] delivery failed; left queued", err),
    });
  }
  return woke;
}

/**
 * The runtime's one-time push when it sees `raftCheck` turn on: whether it
 * already briefed the owner today (owner-local `YYYY-MM-DD`). A brief Raft
 * held on its first pass is released when the runtime did not brief today:
 * due now inside the brief window, else at the next 08:00 as scheduled.
 * Idempotent; never undoes a brief Raft itself sent.
 */
export async function importAssistantCheckState(
  o: { agentId: string; serverId: string; ownerUserId: string },
  input: { briefSent?: string | null },
  now = new Date(),
): Promise<{ briefToday: "sent" | "due" | "scheduled" }> {
  const db = getDb();
  const zone = (await contactContext(o)).zone;
  const day = localDay(now.getTime(), zone);
  await db.insert(assistantCheckState).values({ agentId: o.agentId, nextBriefAt: nextBriefAt(now.getTime(), zone), briefSentDay: day, updatedAt: now })
    .onConflictDoNothing();
  if (input.briefSent === day) {
    await db.update(assistantCheckState).set({ briefSentDay: day, updatedAt: now }).where(eq(assistantCheckState.agentId, o.agentId));
    return { briefToday: "sent" };
  }
  const [raftBrief] = await db.select({ id: assistantChecks.id }).from(assistantChecks).where(and(
    eq(assistantChecks.agentId, o.agentId), eq(assistantChecks.trigger, "brief"), eq(assistantChecks.briefDay, day),
  )).limit(1);
  if (raftBrief) return { briefToday: "sent" };
  const hour = localHour(now.getTime(), zone);
  const inWindow = hour >= BRIEF_HOUR && hour < BRIEF_LATEST_HOUR;
  await db.update(assistantCheckState).set({
    briefSentDay: null,
    ...(inWindow ? { nextBriefAt: now } : {}),
    updatedAt: now,
  }).where(and(eq(assistantCheckState.agentId, o.agentId), eq(assistantCheckState.briefSentDay, day)));
  return { briefToday: inWindow ? "due" : "scheduled" };
}

/** Test seam: run one drain with the given deliverer, as the worker would. */
export function __setAssistantDoorbellDelivererForTests(deliverer: DoorbellDeliverer | null): void {
  doorbellDeliverer = deliverer;
}

// ---------------------------------------------------------------------------
// RFC 077 owner actions: what the owner did themself since a cursor, as
// references only (no text), so the assistant stops reminding them of things
// they already handled. Same reach as the other owner reads: conversations the
// owner can see right now; DMs only while the owner lets the assistant read
// them; never the assistant's own DM with the owner; never a message the
// assistant sent for them.
// ---------------------------------------------------------------------------

export const ASSISTANT_OWNER_ACTIVITY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ASSISTANT_OWNER_ACTIVITY_MAX_LIMIT = 100;

export type OwnerActivityItem =
  | { kind: "message"; channelId: string; messageId: string; seq: number; at: string }
  | { kind: "reaction"; channelId: string; messageId: string; emoji: string; at: string }
  | { kind: "task"; channelId: string; messageId: string; taskNumber: number; event: string; status: string | null; at: string };

export async function listOwnerActivity(input: {
  agentId: string;
  serverId: string;
  ownerUserId: string;
  since: Date;
  limit: number;
}): Promise<{ items: OwnerActivityItem[]; hasMore: boolean }> {
  const db = getDb();
  const limit = Math.min(Math.max(input.limit, 1), ASSISTANT_OWNER_ACTIVITY_MAX_LIMIT);
  const sentRows = await db.execute(sql`
    SELECT m.id, m.channel_id, m.seq::text AS seq, m.created_at
    FROM ${messages} m
    WHERE m.sender_type = 'user' AND m.sender_id = ${input.ownerUserId}
      AND m.created_at > ${input.since}
      AND m.message_type = 'chat' AND m.delegated_by_agent_id IS NULL AND m.server_id = ${input.serverId}
    ORDER BY m.created_at ASC
    LIMIT ${limit + 1}`);
  const reactionRows = await db.execute(sql`
    SELECT r.message_id, m.channel_id, r.emoji, r.created_at
    FROM ${messageReactions} r
    JOIN ${messages} m ON m.id = r.message_id
    WHERE r.reactor_type = 'user' AND r.reactor_id = ${input.ownerUserId}
      AND r.created_at > ${input.since} AND m.server_id = ${input.serverId}
    ORDER BY r.created_at ASC
    LIMIT ${limit + 1}`);
  const taskRows = await db.execute(sql`
    SELECT t.channel_id, t.message_id, t.task_number, e.event_type, e.payload->>'status' AS status, e.created_at
    FROM ${taskEvents} e
    JOIN ${tasks} t ON t.id = e.task_id
    JOIN ${channels} c ON c.id = t.channel_id
    WHERE e.actor_type = 'user' AND e.actor_id = ${input.ownerUserId}
      AND e.created_at > ${input.since} AND c.server_id = ${input.serverId}
      AND e.event_type IN ('status_changed', 'reopened', 'closed', 'assignee_changed')
      AND t.message_id IS NOT NULL
    ORDER BY e.created_at ASC
    LIMIT ${limit + 1}`);
  const iso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
  const all: OwnerActivityItem[] = [
    ...(sentRows.rows as Array<{ id: string; channel_id: string; seq: string; created_at: unknown }>)
      .map((row) => ({ kind: "message" as const, channelId: row.channel_id, messageId: row.id, seq: Number(row.seq), at: iso(row.created_at) })),
    ...(reactionRows.rows as Array<{ message_id: string; channel_id: string; emoji: string; created_at: unknown }>)
      .map((row) => ({ kind: "reaction" as const, channelId: row.channel_id, messageId: row.message_id, emoji: row.emoji, at: iso(row.created_at) })),
    ...(taskRows.rows as Array<{ channel_id: string; message_id: string; task_number: number; event_type: string; status: string | null; created_at: unknown }>)
      .map((row) => ({ kind: "task" as const, channelId: row.channel_id, messageId: row.message_id, taskNumber: Number(row.task_number), event: row.event_type, status: row.status, at: iso(row.created_at) })),
  ];

  // Reach: what the owner can see now; DMs per the owner's switch; never the assistant's own DM.
  const channelIds = [...new Set(all.map((item) => item.channelId))];
  const visible = await channelService.filterUserAccessibleChannelIds(channelIds, input.ownerUserId, asServerId(input.serverId));
  const dmIds = await dmScopedChannelIds(channelIds, db);
  const policy = await readableOwnerDmPolicy({ agentId: input.agentId, serverId: input.serverId, ownerUserId: input.ownerUserId });
  const readableDm = new Map<string, boolean>();
  for (const id of dmIds) {
    const channel = await channelService.getChannel(id);
    readableDm.set(id, channel ? await mayAssistantReadOwnerConversation(policy, channel) : false);
  }
  const reachable = all
    .filter((item) => visible.has(item.channelId) && (!dmIds.has(item.channelId) || readableDm.get(item.channelId) === true))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { items: reachable.slice(0, limit), hasMore: reachable.length > limit || all.length > limit * 3 };
}

/** An owner-inbox row as the assistant reads it (`assistantOwnerInbox`) and as Raft's own check reads it. */
export type OwnerInboxRow = {
  kind: "channel" | "thread";
  channelId: string;
  channelName: string;
  channelType: string;
  parentChannelId: string | null;
  parentMessageId: string | null;
  unread: number;
  hasMention: boolean;
  latestAt: string | null;
  latestSenderName: string | null;
  latestSenderId: string | null;
  latestSenderType: "human" | "agent" | "third_party_app" | "system" | null;
  latestPreview: string | null;
  latestSeq: number | null;
  firstUnreadMessageId: string | null;
  ownerParticipated?: boolean;
  peer: { id: string; type: string } | null;
  /** Task v2: the row is a task conversation (kind stays "thread"); its task. */
  conversationKind?: "task";
  taskId?: string | null;
  taskNumber?: number | null;
  taskTitle?: string | null;
};

/**
 * An inbox row's sender type in agent-facing words; null when the row has
 * none. A system message is stored with sender type `user` and sender id
 * `system`: it reads as `system`, never `human`.
 */
export function ownerInboxSenderType(value: string | null | undefined, senderId?: string | null): OwnerInboxRow["latestSenderType"] {
  if (!value) return null;
  if (value === "system" || senderId === "system") return "system";
  return value === "external_projection" ? "third_party_app" : value === "user" ? "human" : "agent";
}

/**
 * The owner's inbox as their assistant may read it: what they would see in
 * Activity, DMs unless they turned that off (RFC 077), never the assistant's
 * own DM with them, every row re-checked against the owner's access now, a DM
 * named from the owner's side. Reads nothing as read for anyone.
 */
export async function listOwnerInboxRows(input: {
  agentId: string;
  serverId: string;
  ownerUserId: string;
  filter: "all" | "unread" | "mentions" | "unread_mentions";
  limit: number;
  offset: number;
}): Promise<{ items: OwnerInboxRow[]; loadedCount: number; hasMore: boolean }> {
  const { ownerUserId, filter, limit, offset } = input;
  const serverId = asServerId(input.serverId);
  const historyCutoff = getHistoryCutoff(await getServerPlan(serverId));
  // RFC 077: DMs too, unless the owner turned that off; never the
  // assistant's own DM with its owner (or threads under it).
  const dmPolicy = await readableOwnerDmPolicy({ agentId: input.agentId, serverId, ownerUserId });
  const loaded = await channelService.getInboxItems(serverId, ownerUserId, {
    filter,
    limit,
    offset,
    ...(dmPolicy ? {} : { scope: "no_dms" as const }),
    historyCutoff,
  });
  // Re-check every row against the owner's access right now. The inbox
  // projection can trail a membership change; a borrowed read must not.
  const accessChannelIds = loaded.items.map(channelService.inboxItemScopeChannelId);
  const visible = await channelService.filterUserAccessibleChannelIds(accessChannelIds, ownerUserId, serverId);
  // A thread's or task conversation's DM is its parent channel.
  const dmRootOf = (item: typeof loaded.items[number]) => channelService.isSubConversationInboxItem(item) ? item.parentChannelId : item.channelId;
  const readable = loaded.items
    .filter((item) => !channelService.isDmScopedInboxItem(item)
      || (dmPolicy !== null && dmRootOf(item) !== dmPolicy.excludedRootChannelId))
    .filter((item) => visible.has(channelService.inboxItemScopeChannelId(item)));
  // A DM is named from the owner's side (`dm:@<peer>`), not by its storage name.
  const dmPeers = new Map<string, Awaited<ReturnType<typeof channelService.resolveUserFacingDmPeer>>>();
  for (const item of readable) {
    if (!channelService.isDmScopedInboxItem(item)) continue;
    const rootId = dmRootOf(item);
    if (!dmPeers.has(rootId)) dmPeers.set(rootId, await channelService.resolveUserFacingDmPeer(serverId, ownerUserId, rootId));
  }
  const peerOf = (item: typeof loaded.items[number]) => {
    const peer = channelService.isDmScopedInboxItem(item) ? dmPeers.get(dmRootOf(item)) : null;
    return peer ? { id: peer.id, type: peer.type } : null;
  };
  const nameOf = (item: typeof loaded.items[number], storageName: string) =>
    channelService.isDmScopedInboxItem(item) ? dmPeers.get(dmRootOf(item))?.ref ?? storageName : storageName;
  const participated = await ownerParticipatedThreadIds(
    ownerUserId,
    readable.flatMap((item) => channelService.isSubConversationInboxItem(item) ? [item] : []),
  );
  const items: OwnerInboxRow[] = readable
    .map((item) => item.kind === "thread" || item.kind === "task"
      ? {
          // A task conversation (task v2) reads like a thread here (the
          // contract's kinds are channel | thread); conversationKind and the
          // task fields say which.
          kind: "thread" as const,
          ...(item.kind === "task"
            ? { conversationKind: "task" as const, taskId: item.taskId, taskNumber: item.taskNumber, taskTitle: item.taskTitle }
            : {}),
          channelId: item.threadChannelId,
          channelName: nameOf(item, item.parentChannelName),
          channelType: item.parentChannelType,
          parentChannelId: item.parentChannelId,
          parentMessageId: item.parentMessageId,
          unread: item.unreadCount,
          hasMention: item.hasMention,
          latestAt: item.lastActivityAt ?? null,
          latestSenderName: item.latestActivitySenderName ?? null,
          latestSenderId: item.latestActivitySenderId || null,
          latestSenderType: ownerInboxSenderType(item.latestActivitySenderType, item.latestActivitySenderId),
          latestPreview: item.latestActivityPreview ?? null,
          latestSeq: item.latestActivitySeq == null ? null : Number(item.latestActivitySeq),
          firstUnreadMessageId: item.firstUnreadMessageId ?? null,
          ownerParticipated: participated.has(item.threadChannelId),
          peer: peerOf(item),
        }
      : {
          kind: "channel" as const,
          channelId: item.channelId,
          channelName: nameOf(item, item.channelName),
          channelType: item.channelType,
          parentChannelId: null,
          parentMessageId: null,
          unread: item.unreadCount,
          hasMention: item.hasMention,
          latestAt: item.lastMessageAt ?? null,
          latestSenderName: item.lastMessageSenderName ?? null,
          latestSenderId: item.lastMessageSenderId || null,
          latestSenderType: ownerInboxSenderType(item.lastMessageSenderType, item.lastMessageSenderId),
          latestPreview: item.lastMessagePreview ?? null,
          latestSeq: item.latestActivitySeq == null ? null : Number(item.latestActivitySeq),
          firstUnreadMessageId: item.firstUnreadMessageId ?? null,
          peer: peerOf(item),
        });
  return { items, loadedCount: loaded.items.length, hasMore: loaded.hasMore };
}

// ---------------------------------------------------------------------------
// Owner fields for the assistant's reads (RFC 077 follow-up).
// ---------------------------------------------------------------------------

/**
 * The threads (by their own channel id) the owner has written in: a reply, or
 * the message the thread hangs off. Messages the assistant sent for the owner
 * count too, since everyone else sees them as the owner's.
 */
export async function ownerParticipatedThreadIds(
  ownerUserId: string,
  threads: { threadChannelId: string; parentMessageSenderType: string; parentMessageSenderId: string }[],
): Promise<Set<string>> {
  const participated = new Set(threads
    .filter((thread) => thread.parentMessageSenderType === "user" && thread.parentMessageSenderId === ownerUserId)
    .map((thread) => thread.threadChannelId));
  const rest = threads.map((thread) => thread.threadChannelId).filter((id) => !participated.has(id));
  if (rest.length === 0) return participated;
  const rows = await getDb()
    .selectDistinct({ channelId: messages.channelId })
    .from(messages)
    .where(and(
      inArray(messages.channelId, rest),
      eq(messages.senderType, "user"),
      eq(messages.senderId, ownerUserId),
    ));
  for (const row of rows) participated.add(row.channelId);
  return participated;
}

export const OWNER_RESOLVE_NOT_FOUND_CODE = "owner_resolve_not_found";
export const OWNER_RESOLVE_AMBIGUOUS_CODE = "owner_resolve_ambiguous";

export type OwnerResolveResult =
  | { ok: true; id: string; type: "human" | "agent" | "channel" | "dm"; name: string }
  | { ok: false; code: typeof OWNER_RESOLVE_NOT_FOUND_CODE | typeof OWNER_RESOLVE_AMBIGUOUS_CODE };

/**
 * Who `@name` is, as the owner would find them in this server: a member they
 * can see in the directory, or an agent they can see. Someone the owner cannot
 * see is answered exactly like someone who does not exist. `~human` / `~agent`
 * picks one side when a human and an agent share the name. `#name` is a
 * channel the owner can see here (task #proj-assistant:#10: the runtime's own
 * lookup paged the owner's inbox and missed channels past its cap).
 */
export async function resolveNameForOwner(serverId: string, ownerUserId: string, rawName: string): Promise<OwnerResolveResult> {
  const notFound = { ok: false, code: OWNER_RESOLVE_NOT_FOUND_CODE } as const;
  // `dm:@name`: the owner's existing DM with them (never a new one), when the owner can read it.
  if (rawName.trim().startsWith("dm:")) {
    const peerRef = rawName.trim().slice(3);
    if (!peerRef.startsWith("@") || peerRef.includes(":")) return notFound;
    const peer = await resolveNameForOwner(serverId, ownerUserId, peerRef);
    if (!peer.ok) return peer;
    if (peer.type !== "human" && peer.type !== "agent") return notFound;
    const dmChannelId = peer.type === "human"
      ? await channelService.findHumanHumanDmChannelId(serverId, ownerUserId, peer.id)
      : await channelService.findHumanAgentDmChannelId(serverId, ownerUserId, peer.id);
    if (!dmChannelId || !await channelService.canUserAccessChannel(dmChannelId, ownerUserId, asServerId(serverId))) return notFound;
    return { ok: true, id: dmChannelId, type: "dm", name: peer.name };
  }
  if (rawName.trim().startsWith("#")) {
    const channelName = rawName.trim().slice(1);
    const channelId = channelName ? await visibleChannelByName(serverId, ownerUserId, channelName) : null;
    return channelId ? { ok: true, id: channelId, type: "channel", name: channelName } : notFound;
  }
  const trimmed = rawName.trim().replace(/^@/, "");
  const suffix = /~(human|agent)$/.exec(trimmed)?.[1] as "human" | "agent" | undefined;
  const name = suffix ? trimmed.slice(0, -suffix.length - 1) : trimmed;
  if (!name) return notFound;
  const role = await getActorServerRoleInServer(serverId, "user", ownerUserId);
  const human = suffix === "agent" ? null : await visibleHumanByName(serverId, ownerUserId, role, name);
  const agent = suffix === "human" ? null : await visibleAgentByName(serverId, ownerUserId, role, name);
  if (human && agent) return { ok: false, code: OWNER_RESOLVE_AMBIGUOUS_CODE };
  if (human) return { ok: true, id: human, type: "human", name };
  if (agent) return { ok: true, id: agent, type: "agent", name };
  return notFound;
}

/** A channel (public, private or joint; never a DM) by its name, when the owner can see it. */
async function visibleChannelByName(serverId: string, ownerUserId: string, name: string): Promise<string | null> {
  const [channel] = await getDb().select({ id: channels.id }).from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, channelService.LISTABLE_CHANNEL_TYPES),
      eq(channels.name, name),
      isNull(channels.deletedAt),
    ))
    .limit(1);
  if (!channel) return null;
  return await channelService.canUserAccessChannel(channel.id, ownerUserId, asServerId(serverId)) ? channel.id : null;
}

async function visibleHumanByName(serverId: string, ownerUserId: string, role: string | null, name: string): Promise<string | null> {
  const userId = await channelService.resolveUserByName(serverId, name);
  if (!userId) return null;
  if (userId === ownerUserId) return userId;
  // The same checks as the human profile route (GET /servers/:id/members/:memberId/profile).
  if (role === "guest") return await channelService.canUserSeeHumanThroughLocalChannel(serverId, ownerUserId, userId) ? userId : null;
  const profile = await serverService.getServerMemberProfile(serverId, userId, ownerUserId);
  if (!profile || profile.membershipStatus !== "active") return null;
  if (
    await serverService.shouldHideHumanDirectoryFromRequester(serverId, ownerUserId)
    && !serverService.shouldExposeHumanInHiddenDirectory(profile, ownerUserId)
    && !await channelService.canUserSeeHumanThroughLocalChannel(serverId, ownerUserId, userId)
  ) return null;
  return userId;
}

async function visibleAgentByName(serverId: string, ownerUserId: string, role: string | null, name: string): Promise<string | null> {
  const agentId = await channelService.resolveAgentByName(serverId, name, { userId: ownerUserId });
  if (!agentId) return null;
  // The same check as the agent profile route (GET /agents/:id).
  if (role === "guest" && !await channelService.canUserSeeAgentThroughLocalChannel(serverId, ownerUserId, agentId)) return null;
  return agentId;
}
