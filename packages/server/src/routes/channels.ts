import { publishChannelUpdate } from "../services/channelRealtimeEvents.js";
import { serializeErrorForLog } from "../tracing/safeErrorLog.js";
import { revokeSocketAccess } from "../socket/accessRevocation.js";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import { hostname } from "node:os";
import * as channelService from "../services/channelService.js";
import * as channelConversionService from "../services/channelConversionService.js";
import * as agentService from "../services/agentService.js";
import * as serverService from "../services/serverService.js";
import * as messageService from "../services/messageService.js";
import * as userService from "../services/userService.js";
import * as savedService from "../services/savedService.js";
import * as activitySyncService from "../services/activitySyncService.js";
import { CHANNEL_MANAGEMENT_CAPABILITIES, MAX_JOINT_CHANNEL_SERVERS, SERVER_GUEST_FEATURE_FLAG_KEY, THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY, TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, channelTypeSupportsActivityMute, noopTracer, validateName, type ServerCapability, type ServerId, type Tracer } from "@botiverse/raft-shared";
import { getServerPlan, getHistoryCutoff } from "../services/planService.js";
import { evaluateFeatureFlag } from "../services/featureFlagService.js";
import { isReceiverStatePushEnabled } from "../services/receiverStatePushService.js";
import { emitScopeReadUpdated, getPeerReadHydrate } from "../services/readReceiptService.js";
import { emitThreadFollowersUpdated } from "../services/threadFollowerRealtimeService.js";
import {
  actorHasServerCapabilityInServer,
  canHumanOperateAgentReadState,
  getActorServerRoleInServer,
  type ReadStateDelegationBasis,
} from "../lib/actorPermissions.js";
import {
  actorHasChannelCapability,
  channelActorHasCapability,
  resolveChannelActorContext,
  withLockedChannelActorCapability,
  withLockedChannelActorCapabilities,
} from "../lib/channelActorPermissions.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import type { Server as SocketServer } from "socket.io";
import { addTraceEvent, createTraceDbQueryTracer, getCurrentTraceContext, tracePhase } from "../tracing/semanticTrace.js";
import { getThumbnailUrl, normalizeAttachmentFilename, resolveAttachmentMimeType } from "./attachments.js";
import { CHANNEL_NOT_FOUND_BODY, denyChannelAccess } from "./channelAccessDenial.js";
import {
  CompatibilityReadMutationPendingError,
  ReadMutationError,
} from "../services/readMutationSequencer.js";
import {
  DoneFrontierAboveInt4AuthorityError,
  DoneFrontierBeyondLatestError,
  DoneFrontierRequiredError,
} from "../services/inboxSuppressionWriters.js";
import { getInboxRouteBackpressureAdmission } from "../middleware/inboxRouteBackpressure.js";
import { getDb, type DatabaseExecutor } from "../db/index.js";

export const channelRouter: RouterType = Router();

async function attachHumanChannelAuthorization<T extends { id: string }>(
  channel: T,
  serverId: string,
  userId: string,
) {
  const context = await resolveChannelActorContext(serverId, channel.id, "user", userId);
  return {
    ...channel,
    channelRole: context?.channelRole ?? null,
    channelAdminBasis: context?.channelAdminBasis ?? null,
    channelCapabilities: Object.fromEntries(
      CHANNEL_MANAGEMENT_CAPABILITIES.map((capability) => [
        capability,
        context ? channelActorHasCapability(context, capability) : false,
      ]),
    ),
    channelAuthorityRevision: context?.channelAuthorityRevision ?? null,
  };
}

function sendCompatibilityReadPending(
  res: Response,
  error: unknown,
  options: { primaryOutcomeCommitted?: boolean } = {},
): boolean {
  if (!(error instanceof CompatibilityReadMutationPendingError)) return false;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "1");
  res.status(202).json({
    code: error.code,
    status: "admitted",
    outcome: "unknown",
    ...(options.primaryOutcomeCommitted ? { primaryOutcome: "committed" } : {}),
    mutationId: error.mutationId,
    authoritySeq: error.authoritySeq,
    frontierUrl: `/api/read-mutations/frontier?mutationId=${encodeURIComponent(error.mutationId)}`,
  });
  return true;
}

// Resolve "now" from an app-level clock seam (app.set("clock", ...)) so callers
// like the joint-channel billing gate can be pinned to a deterministic instant
// in tests instead of depending on the ambient wall-clock vs TRIAL_END_DATE.
// Defaults to the real clock, so production behavior is unchanged.
function resolveNow(req: { app: { get(key: string): unknown } }): Date {
  const clock = req.app.get("clock") as { now(): Date } | undefined;
  return clock?.now() ?? new Date();
}

const CHANNEL_FILES_DEFAULT_LIMIT = 50;
const CHANNEL_FILES_MAX_LIMIT = 100;
const THREAD_SUMMARY_PARENT_IDS_MAX = 500;
// Compatibility ceiling for old web clients that call
// GET /api/channels/:id/threads without parentMessageIds. New clients should
// pass the thread-parent message ids visible in their current timeline window;
// then the route can compute summaries exactly for that window. Until every
// deployed client does that, we bound the no-param path to the most recent
// thread parents so participant/unread fanout cannot scan every thread in a
// large channel. Cleanup condition: once trace
// parent_message_scope_source=compat_recent disappears across prod clients,
// remove this fallback and require parentMessageIds.
const THREAD_SUMMARY_COMPAT_PARENT_IDS_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UINT64_RE = /^(0|[1-9][0-9]*)$/;
const receiverStatePushWarned = new Set<string>();
const receiverStatePushHost = hostname();

type ReadAllReceiver = { kind: "human" | "agent"; id: string };

function parseReadAllReceiver(body: unknown, callerUserId: string):
  | { ok: true; receiver: ReadAllReceiver; explicit: boolean }
  | { ok: false; status: 400 | 403 } {
  if (!body || typeof body !== "object" || !("receiver" in body)) {
    return { ok: true, receiver: { kind: "human", id: callerUserId }, explicit: false };
  }
  const receiver = (body as { receiver?: unknown }).receiver;
  if (
    !receiver
    || typeof receiver !== "object"
    || Array.isArray(receiver)
    || Object.keys(receiver).some((key) => key !== "kind" && key !== "id")
  ) {
    return { ok: false, status: 400 };
  }
  const { kind, id } = receiver as { kind?: unknown; id?: unknown };
  if ((kind !== "human" && kind !== "agent") || typeof id !== "string" || !UUID_RE.test(id)) {
    return { ok: false, status: 400 };
  }
  if (kind === "human" && id !== callerUserId) {
    return { ok: false, status: 403 };
  }
  return { ok: true, receiver: { kind, id: id.toLowerCase() }, explicit: true };
}

function warnReceiverStatePushOnce(reason: "disabled" | "missing_io", payload: Record<string, unknown>): void {
  const key = `${reason}:${payload.event ?? "unknown"}`;
  if (receiverStatePushWarned.has(key)) return;
  receiverStatePushWarned.add(key);
  console.warn("[ReceiverStatePush] socket_emit_suppressed", { reason, host: receiverStatePushHost, ...payload });
}

function logReadStatePush(
  req: Request,
  state: channelService.ReadStateMutationResult,
  payload: { outcome: "no_change" | "disabled" | "missing_io" | "emitted"; enabled: boolean; io_present: boolean },
): void {
  console.info("[ReceiverStatePush] read_state_emit", {
    event: "read_state:updated",
    host: receiverStatePushHost,
    serverId: req.serverId,
    room: `user:${req.userId}`,
    scopeId: state.channelId,
    maxReadSeq: state.maxReadSeq,
    readStateVersion: state.readStateVersion,
    changed: state.changed,
    ...payload,
  });
}

function emitReadStateUpdated(req: Request, state: channelService.ReadStateMutationResult): void {
  const enabled = isReceiverStatePushEnabled();
  const io = req.app.get("io") as SocketServer | undefined;
  const ioPresent = Boolean(io);
  if (!state.changed) {
    logReadStatePush(req, state, { outcome: "no_change", enabled, io_present: ioPresent });
    return;
  }
  if (!enabled) {
    logReadStatePush(req, state, { outcome: "disabled", enabled, io_present: ioPresent });
    warnReceiverStatePushOnce("disabled", {
      event: "read_state:updated",
      serverId: req.serverId,
      room: `user:${req.userId}`,
      scopeId: state.channelId,
      maxReadSeq: state.maxReadSeq,
      readStateVersion: state.readStateVersion,
      changed: state.changed,
      enabled,
      io_present: ioPresent,
    });
    return;
  }
  if (!io) {
    logReadStatePush(req, state, { outcome: "missing_io", enabled, io_present: ioPresent });
    warnReceiverStatePushOnce("missing_io", {
      event: "read_state:updated",
      serverId: req.serverId,
      room: `user:${req.userId}`,
      scopeId: state.channelId,
      maxReadSeq: state.maxReadSeq,
      readStateVersion: state.readStateVersion,
      changed: state.changed,
      enabled,
      io_present: ioPresent,
    });
    return;
  }
  logReadStatePush(req, state, { outcome: "emitted", enabled, io_present: ioPresent });
  io.to(`user:${req.userId}`).emit("read_state:updated", {
    serverId: req.serverId,
    scopeId: state.channelId,
    maxReadSeq: state.maxReadSeq,
    readStateVersion: state.readStateVersion,
  });
}

function emitReadStateUpdatedBulk(req: Request, scopes: channelService.ReadStateMutationResult[]): void {
  if (scopes.length === 0) return;
  if (!isReceiverStatePushEnabled()) {
    warnReceiverStatePushOnce("disabled", { event: "read_state:updated_bulk", serverId: req.serverId });
    return;
  }
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) {
    warnReceiverStatePushOnce("missing_io", { event: "read_state:updated_bulk", serverId: req.serverId });
    return;
  }
  io.to(`user:${req.userId}`).emit("read_state:updated_bulk", {
    serverId: req.serverId,
    scopes: scopes.map((scope) => ({
      scopeId: scope.channelId,
      maxReadSeq: scope.maxReadSeq,
      readStateVersion: scope.readStateVersion,
    })),
  });
}

function emitNotificationPrefsUpdated(
  req: Request,
  scopeId: string,
  state: channelService.InboxTargetActivityMuteState,
): void {
  if (!state.changed) return;
  if (!isReceiverStatePushEnabled()) {
    warnReceiverStatePushOnce("disabled", { event: "notification_prefs:updated", serverId: req.serverId });
    return;
  }
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) {
    warnReceiverStatePushOnce("missing_io", { event: "notification_prefs:updated", serverId: req.serverId });
    return;
  }
  io.to(`user:${req.userId}`).emit("notification_prefs:updated", {
    serverId: req.serverId,
    scopeId,
    prefs: {
      activityMuted: state.activityMuted,
      muteFromSeq: state.muteFromSeq,
    },
    prefsVersion: state.prefsVersion,
  });
}

function emitMessageDisplayPrefsUpdated(
  req: Request,
  scopeId: string,
  prefs: channelService.UserChannelMessageDisplayPrefs,
): void {
  if (!prefs.changed) return;
  if (!isReceiverStatePushEnabled()) {
    warnReceiverStatePushOnce("disabled", { event: "message_display_prefs:updated", serverId: req.serverId });
    return;
  }
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) {
    warnReceiverStatePushOnce("missing_io", { event: "message_display_prefs:updated", serverId: req.serverId });
    return;
  }
  io.to(`user:${req.userId}`).emit("message_display_prefs:updated", {
    serverId: req.serverId,
    scopeId,
    prefs: {
      collapseLongMessages: prefs.collapseLongMessages,
    },
    prefsVersion: prefs.prefsVersion,
  });
}

function parseChannelFilesLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return CHANNEL_FILES_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return CHANNEL_FILES_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(parsed), CHANNEL_FILES_MAX_LIMIT));
}

function encodeChannelFilesCursor(file: channelService.ChannelFileEntry): string {
  return Buffer.from(JSON.stringify({ createdAt: file.createdAt, id: file.id }), "utf8").toString("base64url");
}

function parseChannelFilesCursor(raw: unknown): channelService.ChannelFilesCursor | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_cursor");
  }
  if (
    typeof decoded !== "object"
    || decoded === null
    || typeof (decoded as { createdAt?: unknown }).createdAt !== "string"
    || typeof (decoded as { id?: unknown }).id !== "string"
  ) {
    throw new Error("invalid_cursor");
  }
  return {
    createdAt: (decoded as { createdAt: string }).createdAt,
    id: (decoded as { id: string }).id,
  };
}

function countJoinedChannels(list: readonly unknown[]): number {
  return list.filter((channel) => (
    typeof channel === "object"
    && channel !== null
    && (channel as { joined?: unknown }).joined === true
  )).length;
}

function countDmPeerType(list: readonly channelService.DMChannel[], peerType: channelService.DMChannel["peerType"]): number {
  return list.filter((channel) => channel.peerType === peerType).length;
}

function parseThreadSummaryParentMessageIds(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined;
  const rawValues = Array.isArray(raw) ? raw : [raw];
  const ids: string[] = [];
  for (const value of rawValues) {
    if (typeof value !== "string") return null;
    ids.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
  }
  if (ids.length > THREAD_SUMMARY_PARENT_IDS_MAX) return null;
  const deduped = [...new Set(ids)];
  if (deduped.some((id) => !UUID_RE.test(id))) return null;
  return deduped;
}

function shouldExposeHumanInHiddenChannelDirectory(human: { id: string; serverSlug?: string | null; role?: string | null }, requesterId: string): boolean {
  return serverService.shouldExposeHumanInHiddenDirectory(human, requesterId);
}

function emitChannelMembersUpdated(
  io: SocketServer | undefined,
  serverId: string,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  addedUserIds?: string | readonly string[],
) {
  const targetedUserIds = typeof addedUserIds === "string" ? [addedUserIds] : addedUserIds ?? [];
  for (const addedUserId of targetedUserIds) {
    io?.to(`user:${addedUserId}`).emit("channel:updated", { channel: { ...channel, joined: true } });
  }
  if (channel.type === "private") {
    io?.to(`channel:${channel.id}`).emit("channel:members-updated", { channelId: channel.id });
    return;
  }
  io?.to(`server:${serverId}`).emit("channel:members-updated", { channelId: channel.id });
}

type ParsedChannelMemberBatch = {
  userIds: string[];
  agentIds: string[];
};

function parseChannelMemberBatch(body: unknown): ParsedChannelMemberBatch | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { userIds = [], agentIds = [] } = body as { userIds?: unknown; agentIds?: unknown };
  if (!Array.isArray(userIds) || !Array.isArray(agentIds)) return null;
  if (
    userIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))
    || agentIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))
  ) {
    return null;
  }
  return {
    userIds: [...new Set(userIds as string[])],
    agentIds: [...new Set(agentIds as string[])],
  };
}

async function shouldFilterChannelHumansForRequester(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  requesterId: string,
) {
  if (!await serverService.shouldHideHumanDirectoryFromRequester(channel.serverId, requesterId)) {
    return false;
  }
  if (channel.type === "channel") {
    return channelService.isAllSystemChannel(channel);
  }
  if (channel.type === "thread") {
    if (!channel.parentMessageId) return false;
    const parentMessage = await channelService.getMessage(channel.parentMessageId);
    if (!parentMessage) return false;
    const parentChannel = await channelService.getChannel(parentMessage.channelId);
    return parentChannel ? channelService.isAllSystemChannel(parentChannel) : false;
  }
  return false;
}

function assertAgentCanBeRemovedFromChannel(channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>) {
  if (channelService.isAllSystemChannel(channel)) {
    throw new Error("Cannot remove members from the #all channel");
  }
}

async function emitJointProjectionUpdates(io: SocketServer | undefined, localChannelId: string) {
  const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(localChannelId);
  const projectionChannels = await channelService.attachJointChannelMetadata(
    projections.map((projection) => ({ ...projection.channel, joined: true })),
  );
  for (const projection of projectionChannels) {
    io?.to(`channel:${projection.id}`).emit("channel:updated", { channel: projection });
  }
  return projectionChannels;
}

async function broadcastMembershipSystemMessage(
  req: { app: { get(key: string): unknown } },
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  target: { type: "agent" | "human"; id: string; name: string },
  action: "added" | "removed",
  actorUserId: string,
  persistedMessage?: Awaited<ReturnType<typeof messageService.createMessage>>,
) {
  const io = req.app.get("io") as SocketServer | undefined;
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (!io || !agentOrchestrator) {
    return;
  }

  const content = action === "added"
    ? `@${target.name} was added to this channel.`
    : `@${target.name} was removed from this channel.`;

  let targetAgentIds: string[] | undefined;
  if (target.type === "agent" && action === "removed" && channel.type !== "channel") {
    const remainingAgents = await channelService.getChannelAgents(channel.id);
    targetAgentIds = remainingAgents
      .filter((candidate) => candidate.id !== target.id)
      .map((candidate) => candidate.id);
  }

  const broadcast = persistedMessage
    ? messageService.broadcastSystemMessageToLocalSurfaces
    : messageService.broadcastSystemMessage;
  await broadcast(io, agentOrchestrator, channel.id, content, {
    inboxFactPolicy: {
      mode: "record",
      producer: target.type === "agent" ? "channel.agent_membership" : "channel.human_membership",
      reason: `${target.type} membership changes are shared channel activity`,
    },
    // The human who added/removed the member should not see their own action
    // as unread in Activity.
    causalActor: { type: "user", id: actorUserId },
    targetAgentIds,
    persistedMessage,
  });
}

async function broadcastChannelRenameSystemMessage(
  req: { app: { get(key: string): unknown } },
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  actorUserId: string,
  oldName: string,
  newName: string,
) {
  const io = req.app.get("io") as SocketServer | undefined;
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (!io || !agentOrchestrator) {
    return;
  }

  const actor = await userService.getUser(actorUserId);
  const actorName = actor?.name ? `@${actor.name}` : actor?.displayName || "Someone";
  await messageService.broadcastSystemMessage(
    io,
    agentOrchestrator,
    channel.id,
    `${actorName} renamed this channel from #${oldName} to #${newName}.`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "channel.rename",
        reason: "channel rename is shared channel activity",
      },
      // The renamer should not see their own rename as unread.
      causalActor: { type: "user", id: actorUserId },
    },
  );
}

async function canSeeChannel(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  userId: string,
  serverId: ServerId,
): Promise<boolean> {
  return channelService.canUserAccessChannel(channel.id, userId, serverId);
}

function countInboxItemsByKind(list: readonly channelService.InboxItem[], kind: channelService.InboxItem["kind"]): number {
  return list.filter((item) => item.kind === kind).length;
}

function parseChannelVisibility(raw: unknown): "public" | "private" | "joint" | null {
  if (raw === undefined || raw === "public") return "public";
  if (raw === "private" || raw === "joint") return raw;
  return null;
}

function normalizeStringList(raw: unknown, maxItems?: number): string[] {
  if (!Array.isArray(raw)) return [];
  if (maxItems !== undefined && raw.length > maxItems) {
    throw new Error(`A joint channel invite can include a maximum of ${maxItems} invited people per target server`);
  }
  return [...new Set(raw.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function parseJointInviteRequests(raw: {
  targetServerSlug?: unknown;
  invitedPeople?: unknown;
  jointInvites?: unknown;
}): channelService.JointInviteRequest[] {
  const rawRequests = Array.isArray(raw.jointInvites) && raw.jointInvites.length > 0
    ? raw.jointInvites.slice(0, channelService.MAX_JOINT_CHANNEL_INVITE_TARGETS + 1).map((request) => {
        const input = request && typeof request === "object"
          ? request as { targetServerSlug?: unknown; invitedPeople?: unknown }
          : {};
        return {
          targetServerSlug: typeof input.targetServerSlug === "string" ? input.targetServerSlug.trim() : "",
          invitedPeople: normalizeStringList(input.invitedPeople, channelService.MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET),
        };
      })
    : [{
        targetServerSlug: typeof raw.targetServerSlug === "string" ? raw.targetServerSlug.trim() : "",
        invitedPeople: normalizeStringList(raw.invitedPeople, channelService.MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET),
      }];
  if (rawRequests.length > channelService.MAX_JOINT_CHANNEL_INVITE_TARGETS) {
    throw new Error(`Joint channels support a maximum of ${MAX_JOINT_CHANNEL_SERVERS} servers`);
  }

  return rawRequests;
}

// List all channels (excludes DMs), includes `joined` status for the requesting user.
// Supports `?archived=exclude|include|only` (default: exclude).
channelRouter.get("/", async (req, res) => {
  try {
    const raw = typeof req.query.archived === "string" ? req.query.archived : undefined;
    let archived: channelService.ArchivedFilter | undefined;
    if (raw === undefined) archived = undefined;
    else if (raw === "exclude" || raw === "include" || raw === "only") archived = raw;
    else {
      res.status(400).json({ error: "archived must be one of: exclude, include, only" });
      return;
    }
    const archivedFilter = archived ?? "exclude";
    addTraceEvent("channels.list.started", {
      archived_filter: archivedFilter,
    });
    const list = await tracePhase(
      async () => {
        const humanActivityMuteEnabled = await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!);
        const traceQuery = createTraceDbQueryTracer("channels.loaded");
        const channels = await channelService.listChannels(req.serverId!, req.userId!, {
          archived,
          humanActivityMuteEnabled,
          traceQuery,
        });
        return channelService.attachExternalBridgeMetadata(channels, traceQuery);
      },
      (durationMs, result) => ({
        name: "channels.loaded",
        attrs: {
          archived_filter: archivedFilter,
          channels_count: result.length,
          joined_channels_count: countJoinedChannels(result),
          archived_channels_count: result.filter((channel) => channel.archivedAt !== null).length,
        },
      }),
    );
    addTraceEvent("response.ready", {
      archived_filter: archivedFilter,
      channels_count: list.length,
      joined_channels_count: countJoinedChannels(list),
    });
    res.json(await Promise.all(list.map((channel) => attachHumanChannelAuthorization(
      channel,
      req.serverId!,
      req.userId!,
    ))));
  } catch {
    res.status(500).json({ error: "Failed to list channels" });
  }
});

// List DM channels
channelRouter.get("/dm", async (req, res) => {
  try {
    addTraceEvent("dm_channels.list.started");
    const list = await tracePhase(
      async () => {
        const humanActivityMuteEnabled = await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!);
        return channelService.listDMChannels(req.serverId!, req.userId!, {
          humanActivityMuteEnabled,
          traceQuery: createTraceDbQueryTracer("dm_channels.loaded"),
        });
      },
      (durationMs, result) => ({
        name: "dm_channels.loaded",
        attrs: {
          dm_channels_count: result.length,
          agent_dm_channels_count: countDmPeerType(result, "agent"),
          user_dm_channels_count: countDmPeerType(result, "user"),
        },
      }),
    );
    addTraceEvent("response.ready", {
      dm_channels_count: list.length,
      agent_dm_channels_count: countDmPeerType(list, "agent"),
      user_dm_channels_count: countDmPeerType(list, "user"),
    });
    res.json(list);
  } catch {
    res.status(500).json({ error: "Failed to list DM channels" });
  }
});

// Find or create DM — accepts { agentId } for agent-DM or { userId } for user-DM
channelRouter.post("/dm", async (req, res) => {
  try {
    const { agentId, userId } = req.body;
    if (!agentId && !userId) {
      res.status(400).json({ error: "Either agentId or userId is required" });
      return;
    }
    if (agentId && userId) {
      res.status(400).json({ error: "Cannot provide both agentId and userId" });
      return;
    }

    const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (requesterRole === "guest") {
      const guestGate = await evaluateFeatureFlag({
        key: SERVER_GUEST_FEATURE_FLAG_KEY,
        serverId: req.serverId!,
        userId: req.userId!,
      });
      const existingDm = guestGate.enabled
        ? (await channelService.listDMChannels(req.serverId!, req.userId!)).some((dm) =>
            agentId
              ? dm.peerType === "agent" && dm.peerId === agentId
              : dm.peerType === "user" && dm.peerId === userId)
        : false;
      if (!existingDm) {
        res.status(403).json({ error: "Guests cannot create direct messages" });
        return;
      }
    }

    let channel;
    if (agentId) {
      channel = await channelService.findOrCreateDM(req.serverId!, req.userId!, agentId);
      if (!channel) {
        res.status(404).json({ error: "Agent not found in this server" });
        return;
      }
    } else {
      if (
        userId !== req.userId
        && await serverService.shouldHideHumanDirectoryFromRequester(req.serverId!, req.userId!)
      ) {
        const existingDm = (await channelService.listDMChannels(req.serverId!, req.userId!))
          .some((dm) => dm.peerType === "user" && dm.peerId === userId);
        if (!existingDm) {
          res.status(404).json({ error: "DM target not found" });
          return;
        }
      }
      // Verify target user is a member of this server (self-DM always OK)
      const targetRole = await getActorServerRoleInServer(req.serverId!, "user", userId);
      if (!targetRole) {
        res.status(400).json({ error: "User is not a member of this server" });
        return;
      }
      if (targetRole === "guest") {
        const existingDm = (await channelService.listDMChannels(req.serverId!, req.userId!))
          .some((dm) => dm.peerType === "user" && dm.peerId === userId);
        if (!existingDm) {
          res.status(403).json({ error: "Guests cannot be added to new direct messages" });
          return;
        }
      }
      channel = await channelService.findOrCreateUserDM(req.serverId!, req.userId!, userId, {
        hidePassivePeerOnCreate: true,
      });
    }
    res.json(channel);
  } catch (err: any) {
    console.error("Failed to create DM:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to create DM" });
  }
});

// Create channel
channelRouter.post("/", async (req, res) => {
  try {
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "createChannels"))) {
      res.status(403).json({ error: "You do not have permission to create channels" });
      return;
    }
    const { name, description, visibility, agentIds, userIds, targetServerSlug, invitedPeople, jointInvites } = req.body;
    const parsedVisibility = parseChannelVisibility(visibility);
    if (parsedVisibility === null) {
      res.status(400).json({ error: "visibility must be one of: public, private, joint" });
      return;
    }
    const channelType: channelService.RegularChannelType = parsedVisibility === "private" ? "private" : "channel";
    const selectedJointInviteRequests = parseJointInviteRequests({ targetServerSlug, invitedPeople, jointInvites });
    const nameError = validateName(name, "Channel name");
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }
    if (typeof name === "string" && name.trim() === "all") {
      res.status(400).json({ error: 'Channel name "all" is reserved' });
      return;
    }
    if (parsedVisibility === "joint" && selectedJointInviteRequests.some((request) => !request.targetServerSlug)) {
      res.status(400).json({ error: "Invite server slug is required" });
      return;
    }
    if (parsedVisibility === "joint" && (
      selectedJointInviteRequests.length === 0
      || selectedJointInviteRequests.some((request) => request.invitedPeople.length === 0)
    )) {
      res.status(400).json({ error: "At least one invited person is required" });
      return;
    }
    if (description && (typeof description !== "string" || description.length > 500)) {
      res.status(400).json({ error: "Description must be a string of at most 500 characters" });
      return;
    }
    const selectedAgentIds = Array.isArray(agentIds) ? [...new Set(agentIds.filter((id): id is string => typeof id === "string"))] : [];
    const selectedUserIds = Array.isArray(userIds) ? [...new Set(userIds.filter((id): id is string => typeof id === "string"))] : [];
    if (
      parsedVisibility === "joint"
      && !(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))
    ) {
      res.status(403).json({ error: "You do not have permission to federate channels" });
      return;
    }
    // Creation is the one add-member bootstrap: the creator and all selected
    // initial members are committed together after target validation below.
    // Do not apply the existing-channel add policy before the creator's local
    // admin membership exists.
    for (const agentId of selectedAgentIds) {
      const agent = await agentService.getAgent(agentId);
      if (!agent || agent.serverId !== req.serverId) {
        res.status(400).json({ error: "Agent not found in this server" });
        return;
      }
    }
    for (const userId of selectedUserIds) {
      const role = await getActorServerRoleInServer(req.serverId!, "user", userId);
      if (!role) {
        res.status(400).json({ error: "User is not a member of this server" });
        return;
      }
    }
    let channel: Awaited<ReturnType<typeof channelService.createChannel>>;
    let createdJointInvites: unknown[] = [];
    if (parsedVisibility === "joint") {
      const result = await channelService.createJointChannel({
        hostServerId: req.serverId!,
        createdByUserId: req.userId!,
        name: name.trim(),
        description,
        userIds: selectedUserIds,
        agentIds: selectedAgentIds,
        jointInvites: selectedJointInviteRequests,
        now: resolveNow(req),
      });
      channel = result.channel;
      createdJointInvites = result.invites;
    } else {
      channel = await channelService.createChannel(
        req.serverId!,
        name.trim(),
        description,
        channelType,
        {
          type: "user",
          id: req.userId!,
          initialUserIds: selectedUserIds,
          initialAgentIds: selectedAgentIds,
        },
      );
    }
    const [channelWithMetadata] = await channelService.attachJointChannelMetadata([{ ...channel, joined: true }]);
    const io = req.app.get("io") as SocketServer | undefined;
    await publishChannelUpdate(io, channelWithMetadata);
    const humanActivityMuteEnabled = await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!);
    const activityMuteSupported = humanActivityMuteEnabled && channelTypeSupportsActivityMute(channel.type);
    const rawActivityMuteState = activityMuteSupported
      ? await channelService.getInboxTargetActivityMuteState("user", req.userId!, channel.id)
      : null;
    const activityMuteState = rawActivityMuteState
      ? {
          activityMuted: rawActivityMuteState.activityMuted,
          muteFromSeq: rawActivityMuteState.muteFromSeq,
          prefsVersion: rawActivityMuteState.prefsVersion,
        }
      : {};
    const readState = await channelService.getReadStateSnapshot(req.userId!, channel.id);
    const peerReadHydrate = channel.type === "channel" || channel.type === "private" || channel.type === "dm"
      ? await getPeerReadHydrate({
          serverId: req.serverId!,
          channelId: channel.id,
          viewerKind: "human",
          viewerId: req.userId!,
        })
      : null;
    res.json({
      ...await attachHumanChannelAuthorization(channelWithMetadata, req.serverId!, req.userId!),
      ...activityMuteState,
      ...readState,
      ...(peerReadHydrate ?? {}),
      ...(humanActivityMuteEnabled ? { activityMuteSupported } : {}),
      jointInvites: createdJointInvites,
      jointInvite: createdJointInvites[0] ?? null,
    });
  } catch (err: any) {
    if (err instanceof channelService.ArchivedNameCollisionError) {
      const canUnarchiveArchivedChannel = err.archivedChannelType === "channel" || err.archivedChannelType === "private"
        ? await actorHasChannelCapability(
            req.serverId!,
            err.archivedChannelId,
            "user",
            req.userId!,
            "archiveChannels",
          )
        : err.archivedChannelType === "joint"
          && await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "archiveChannels");
      res.status(409).json({
        error: `Channel name "${err.channelName}" is held by an archived channel`,
        code: "archived_name_collision",
        archivedChannelId: err.archivedChannelId,
        archivedChannelName: err.channelName,
        archivedChannelType: err.archivedChannelType,
        canUnarchiveArchivedChannel,
      });
      return;
    }
    const msg = err?.message || "";
    if (msg.includes("already taken")) {
      res.status(409).json({ error: msg });
    } else if (msg.includes("Channel limit reached")) {
      res.status(403).json({ error: msg });
    } else if (msg === "Creating a second Joint Channel requires the Pro plan.") {
      res.status(403).json({ error: msg, code: "joint_channel_free_limit_reached" });
    } else if (msg.includes("requires the Pro plan")) {
      res.status(403).json({ error: msg });
    } else if (msg.includes("Target server") || msg.includes("Cannot invite") || msg.includes("already in this joint channel") || msg.includes("invited person") || msg.includes("maximum of")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to create channel" });
    }
  }
});

channelRouter.get("/joint-invites", async (req, res) => {
  try {
    const invites = await channelService.listPendingJointChannelInvites(req.serverId!, req.userId!);
    res.json({ invites });
  } catch {
    res.status(500).json({ error: "Failed to list joint channel invites" });
  }
});

channelRouter.post("/joint-invites/:inviteId/accept", async (req, res) => {
  try {
    if (!channelService.isJointChannelInviteId(req.params.inviteId)) {
      res.status(404).json({ error: "Joint channel invite not found" });
      return;
    }
    const channel = await channelService.acceptJointChannelInvite({
      inviteId: req.params.inviteId,
      targetServerId: req.serverId!,
      acceptedByUserId: req.userId!,
    });
    const [channelWithMetadata] = await channelService.attachJointChannelMetadata([{ ...channel, joined: true }]);
    const io = req.app.get("io") as SocketServer | undefined;
    await emitJointProjectionUpdates(io, channel.id);
    io?.to(`user:${req.userId}`).emit("channel:updated", { channel: channelWithMetadata });
    res.json(channelWithMetadata);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
    } else if (msg.includes("Only target server admins")) {
      res.status(403).json({ error: msg });
    } else if (msg.includes("expired") || msg.includes("already taken") || msg.includes("already in this joint channel")) {
      res.status(409).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to accept joint channel invite" });
    }
  }
});

// Get unread counts for all channels in this server (must be before /:id)
channelRouter.get("/unread", async (req, res) => {
  try {
    addTraceEvent("unread_counts.load.started");
    const plan = await tracePhase(
      () => getServerPlan(req.serverId!),
      (durationMs, result) => ({
        name: "history.policy.checked",
        attrs: {
          plan: result,
        },
      }),
    );
    const historyCutoff = getHistoryCutoff(plan);
    const wantsSummary = req.query.summary === "1";
    const loaded = wantsSummary
      ? await tracePhase(
        () => channelService.getUnreadSummary(req.serverId!, req.userId!, historyCutoff, {
          traceQuery: createTraceDbQueryTracer("unread_counts.loaded"),
        }),
        (durationMs, result) => ({
          name: "unread_counts.loaded",
          attrs: {
            unread_channels_count: Object.keys(result).length,
            response_summary: wantsSummary,
            history_cutoff_present: Boolean(historyCutoff),
          },
        }),
      )
      : await tracePhase(
        () => channelService.getUnreadCounts(req.serverId!, req.userId!, historyCutoff, {
          traceQuery: createTraceDbQueryTracer("unread_counts.loaded"),
        }),
        (durationMs, result) => ({
          name: "unread_counts.loaded",
          attrs: {
            unread_channels_count: Object.keys(result).length,
            response_summary: wantsSummary,
            history_cutoff_present: Boolean(historyCutoff),
          },
        }),
      );
    addTraceEvent("response.ready", {
      unread_channels_count: Object.keys(loaded).length,
      response_summary: wantsSummary,
    });
    res.json(wantsSummary ? { channels: loaded } : loaded);
  } catch {
    res.status(500).json({ error: "Failed to get unread counts" });
  }
});

// Server-authoritative Activity v1 successor. Existing socket events remain
// wake signals; clients hydrate/repair through these exact snapshot/difference
// reads rather than treating socket payloads as a second source of truth.
channelRouter.get("/activity/snapshot", async (req, res) => {
  const requestId = typeof req.query.requestId === "string" ? req.query.requestId.trim() : "";
  const windowId = req.query.windowId;
  if (!requestId || (windowId !== undefined && windowId !== "main")) {
    res.status(400).json({ error: "requestId is required and windowId must be main" });
    return;
  }
  const filter = req.query.filter === "unread" || req.query.filter === "mentions"
    ? req.query.filter
    : req.query.filter === undefined || req.query.filter === "all"
      ? "all"
      : null;
  if (!filter) {
    res.status(400).json({ error: "filter must be all, unread, or mentions" });
    return;
  }
  try {
    const plan = await getServerPlan(req.serverId!);
    const body = await activitySyncService.getActivitySnapshot({
      serverId: req.serverId!,
      principalId: req.userId!,
      requestId,
      filter,
      historyCutoff: getHistoryCutoff(plan),
      humanActivityMuteEnabled: await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!),
    }, { now: () => resolveNow(req) });
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  } catch (error) {
    console.error("[ActivitySync] snapshot failed", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to get Activity snapshot" });
  }
});

channelRouter.get("/activity/difference", async (req, res) => {
  const requestId = typeof req.query.requestId === "string" ? req.query.requestId.trim() : "";
  const epoch = typeof req.query.epoch === "string" ? req.query.epoch : "";
  const afterWatermark = typeof req.query.afterWatermark === "string"
    ? req.query.afterWatermark
    : "";
  const windowId = req.query.windowId;
  if (
    !requestId
    || !UINT64_RE.test(epoch)
    || !UINT64_RE.test(afterWatermark)
    || (windowId !== undefined && windowId !== "main")
  ) {
    res.status(400).json({
      error: "requestId, canonical uint64 epoch/afterWatermark, and windowId=main are required",
    });
    return;
  }
  const filter = req.query.filter === "unread" || req.query.filter === "mentions"
    ? req.query.filter
    : req.query.filter === undefined || req.query.filter === "all"
      ? "all"
      : null;
  if (!filter) {
    res.status(400).json({ error: "filter must be all, unread, or mentions" });
    return;
  }
  try {
    const plan = await getServerPlan(req.serverId!);
    const result = await activitySyncService.getActivityDifference({
      serverId: req.serverId!,
      principalId: req.userId!,
      requestId,
      filter,
      epoch,
      afterWatermark,
      historyCutoff: getHistoryCutoff(plan),
      humanActivityMuteEnabled: await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!),
    }, { now: () => resolveNow(req) });
    res.setHeader("Cache-Control", "no-store");
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error("[ActivitySync] difference failed", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to get Activity difference" });
  }
});

// Unified Inbox: regular channels, DMs, and followed threads that are not done.
channelRouter.get("/inbox", async (req, res) => {
  const admission = getInboxRouteBackpressureAdmission(res);
  if (!admission) {
    throw new Error("Inbox route backpressure admission is missing");
  }
  try {
    const filterParam = req.query.filter;
    const filter: "all" | "unread" | "mentions" | "unread_mentions" =
      filterParam === "unread" || filterParam === "mentions" || filterParam === "unread_mentions"
        ? filterParam
        : "all";
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const channelIdParam = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const channelId = channelIdParam && UUID_RE.test(channelIdParam) ? channelIdParam : undefined;
    const qParam = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const q = qParam || undefined;
    const sort = req.query.sort === "asc" ? "asc" as const : "desc" as const;
    addTraceEvent("inbox.load.started", {
      filter,
      limit,
      offset,
      channel_id_present: Boolean(channelId),
      query_present: Boolean(q),
    });
    const plan = await tracePhase(
      () => getServerPlan(req.serverId!),
      (durationMs, result) => ({
        name: "history.policy.checked",
        attrs: {
          plan: result,
        },
      }),
    );
    const historyCutoff = getHistoryCutoff(plan);
    const humanActivityMuteEnabled = await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!);
    const result = await tracePhase(
      () => channelService.getInboxItems(req.serverId!, req.userId!, {
        filter,
        limit,
        offset,
        channelId,
        q,
        sort,
        historyCutoff,
        humanActivityMuteEnabled,
        includeUnfollowedThreads: filter === "all",
        traceQuery: createTraceDbQueryTracer("inbox.loaded"),
      }),
      (durationMs, loaded) => ({
        name: "inbox.loaded",
        attrs: {
          filter,
          limit,
          offset,
          channel_id_present: Boolean(channelId),
          query_present: Boolean(q),
          history_cutoff_present: Boolean(historyCutoff),
          inbox_items_count: loaded.items.length,
          total_count: loaded.totalCount,
          total_unread_count: loaded.totalUnreadCount,
          active_unread_count: loaded.activeUnreadCount,
          channel_items_count: countInboxItemsByKind(loaded.items, "channel"),
          dm_items_count: countInboxItemsByKind(loaded.items, "dm"),
          thread_items_count: countInboxItemsByKind(loaded.items, "thread"),
          has_more: loaded.hasMore,
        },
      }),
    );
    addTraceEvent("response.ready", {
      filter,
      channel_id_present: Boolean(channelId),
      query_present: Boolean(q),
      inbox_items_count: result.items.length,
      total_count: result.totalCount,
      total_unread_count: result.totalUnreadCount,
      active_unread_count: result.activeUnreadCount,
      has_more: result.hasMore,
    });
    res.json(result);
  } catch (err) {
    console.error("Failed to get inbox:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get inbox" });
  } finally {
    admission.release();
  }
});

// Durable Done history for Activity v2. Kept out of the active Inbox serving
// contract so rollout can be feature-gated without changing legacy clients.
channelRouter.get("/inbox/done", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const channelIdParam = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const channelId = channelIdParam && UUID_RE.test(channelIdParam) ? channelIdParam : undefined;
    const qParam = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const q = qParam || undefined;
    const sort = req.query.sort === "asc" ? "asc" as const : "desc" as const;
    const plan = await getServerPlan(req.serverId!);
    const result = await channelService.getDoneInboxItems(req.serverId!, req.userId!, {
      limit,
      offset,
      channelId,
      q,
      sort,
      historyCutoff: getHistoryCutoff(plan),
      traceQuery: createTraceDbQueryTracer("done_inbox.loaded"),
    });
    res.json(result);
  } catch (err) {
    console.error("Failed to get Done history:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get Done history" });
  }
});

// Compatibility history for clients that still request explicit unfollows.
// Activity All now includes not-Done unfollowed rows directly, while this
// endpoint retains the frozen history projection across completion states.
channelRouter.get("/inbox/unfollowed", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const channelIdParam = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const channelId = channelIdParam && UUID_RE.test(channelIdParam) ? channelIdParam : undefined;
    const qParam = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const q = qParam || undefined;
    const sort = req.query.sort === "asc" ? "asc" as const : "desc" as const;
    const plan = await getServerPlan(req.serverId!);
    const result = await channelService.getUnfollowedInboxItems(req.serverId!, req.userId!, {
      limit,
      offset,
      channelId,
      q,
      sort,
      historyCutoff: getHistoryCutoff(plan),
      traceQuery: createTraceDbQueryTracer("unfollowed_inbox.loaded"),
    });
    res.json(result);
  } catch (err) {
    console.error("Failed to get unfollowed Activity history:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to get unfollowed Activity history" });
  }
});

channelRouter.post("/inbox/done", async (req, res) => {
  try {
    const { channelId, throughActivitySeq, frontierSpace: requestedFrontierSpace } = req.body;
    if (!channelId) {
      res.status(400).json({ error: "channelId is required" });
      return;
    }
    // Adjudicated compatibility matrix (keep this explicit rather than hiding
    // it behind a display-to-storage mapper): omitted value => the existing
    // canonical snapshot, with or without an explicit storage identity;
    // value without identity => refresh-required 412; unsupported identity =>
    // 400; storage value => the unchanged strict guard below.
    if (requestedFrontierSpace === undefined && throughActivitySeq !== undefined) {
      res.status(412).json({
        error: "frontierSpace is required; refresh and retry",
        code: "DONE_FRONTIER_SPACE_REQUIRED",
      });
      return;
    }
    if (requestedFrontierSpace !== undefined && requestedFrontierSpace !== "storage") {
      res.status(400).json({
        error: "frontierSpace must be storage",
        code: "DONE_FRONTIER_UNMAPPABLE",
      });
      return;
    }
    const channel = await channelService.getChannel(channelId);
    if (!channel || channel.type === "thread") {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const canonicalServerId = channel.serverId as ServerId;
    // canUserAccessChannel assumes its serverId is already an authenticated
    // user scope. Here the item may belong to a server other than the active
    // request server, so re-establish canonical membership before using it.
    const isCanonicalServerMember = await serverService.isMember(canonicalServerId, req.userId!);
    if (!isCanonicalServerMember) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, canonicalServerId);
    if (!canAccess) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    await channelService.markChannelInboxDone(req.userId!, channelId, throughActivitySeq);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DoneFrontierRequiredError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof DoneFrontierBeyondLatestError || err instanceof DoneFrontierAboveInt4AuthorityError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (sendCompatibilityReadPending(res, err)) return;
    res.status(500).json({ error: "Failed to mark chat as done" });
  }
});

channelRouter.post("/inbox/undone", async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) {
      res.status(400).json({ error: "channelId is required" });
      return;
    }
    const channel = await channelService.getChannel(channelId);
    if (!channel || channel.type === "thread") {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const canonicalServerId = channel.serverId as ServerId;
    const isCanonicalServerMember = await serverService.isMember(canonicalServerId, req.userId!);
    if (!isCanonicalServerMember) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, canonicalServerId);
    if (!canAccess) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    await channelService.markChannelInboxActive(req.userId!, channelId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to restore chat from Done:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to restore chat from Done" });
  }
});

channelRouter.post("/inbox/read-all", async (req, res) => {
  try {
    const result = await channelService.markInboxReadLatest(req.serverId!, req.userId!);
    emitReadStateUpdatedBulk(req, result.scopes);
    await Promise.all(result.scopes.map((scope) => emitScopeReadUpdated({
      io: req.app.get("io") as SocketServer | undefined,
      serverId: req.serverId!,
      scopeId: scope.channelId,
      peerKind: "human",
      peerId: req.userId!,
      maxReadSeq: scope.maxReadSeq,
      changed: scope.changed,
    })));
    res.json({ ok: true, markedCount: result.markedCount, scopes: result.scopes.map((scope) => ({
      scopeId: scope.channelId,
      maxReadSeq: scope.maxReadSeq,
      readStateVersion: scope.readStateVersion,
    })) });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    console.error("Failed to mark inbox as read:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to mark inbox as read" });
  }
});

// List threads the user participates in, with unread counts
channelRouter.get("/threads/followed", async (req, res) => {
  try {
    addTraceEvent("followed_threads.load.started");
    const plan = await tracePhase(
      () => getServerPlan(req.serverId!),
      (durationMs, result) => ({
        name: "history.policy.checked",
        attrs: {
          plan: result,
        },
      }),
    );
    const historyCutoff = getHistoryCutoff(plan);
    const threads = await tracePhase(
      () => channelService.getFollowedThreads(req.serverId!, req.userId!, historyCutoff, {
        traceQuery: createTraceDbQueryTracer("followed_threads.loaded"),
      }),
      (durationMs, result) => ({
        name: "followed_threads.loaded",
        attrs: {
          followed_threads_count: result.length,
          unread_threads_count: result.filter((thread) => thread.unreadCount > 0).length,
          history_cutoff_present: Boolean(historyCutoff),
        },
      }),
    );
    addTraceEvent("response.ready", {
      followed_threads_count: threads.length,
      unread_threads_count: threads.filter((thread) => thread.unreadCount > 0).length,
    });
    res.json({ threads });
  } catch {
    res.status(500).json({ error: "Failed to get followed threads" });
  }
});

async function resolveThreadFollowerManagementGate(req: Request, res: Response): Promise<boolean> {
  const gate = await evaluateFeatureFlag({
    key: THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY,
    serverId: req.serverId!,
    userId: req.userId!,
    platform: "web",
  });
  if (gate.enabled) return true;
  res.status(404).json({
    error: "Thread follower management is not enabled",
    code: "thread_follower_management_disabled",
  });
  return false;
}

async function resolveManagedThread(req: Request, res: Response, threadChannelId: string) {
  const channel = await channelService.getChannel(threadChannelId);
  if (!channel || channel.type !== "thread" || channel.serverId !== req.serverId) {
    res.status(404).json({ error: "Thread not found" });
    return null;
  }
  if (!await channelService.canUserAccessChannel(threadChannelId, req.userId!, req.serverId!)) {
    res.status(404).json({ error: "Thread not found" });
    return null;
  }
  return channel;
}

async function canManageThreadFollowers(
  req: Request,
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
): Promise<boolean> {
  if (await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "removeChannelMembers")) {
    return true;
  }
  if (!channel.parentMessageId) return false;
  const parent = await channelService.getMessage(channel.parentMessageId);
  return parent?.senderType === "user" && parent.senderId === req.userId;
}

const THREAD_FOLLOWER_ROSTER_MAX = 100;

async function resolveManagedFollowerActivity(
  orchestrator: AgentOrchestrator | undefined,
  agentId: string,
) {
  if (!orchestrator) return { activity: "online" as const, activityDetail: "" };
  try {
    return await orchestrator.getActivity(agentId);
  } catch (error) {
    console.warn("Failed to resolve Agent activity for follower management:", serializeErrorForLog(error));
    return { activity: "online" as const, activityDetail: "" };
  }
}

async function emitManagedFollowerActivity(
  orchestrator: AgentOrchestrator | undefined,
  agentId: string,
  activityEvent: NonNullable<channelService.ManagedAgentThreadFollowerMutation["activityEvent"]>,
): Promise<void> {
  if (!orchestrator) return;
  try {
    await orchestrator.recordAgentRaftAction(agentId, {
      title: activityEvent.title,
      text: activityEvent.text,
      producerFactId: activityEvent.id,
      dedupeKey: activityEvent.dedupeKey,
    });
  } catch (error) {
    // The canonical Activity row committed with the follower mutation. A live
    // socket projection failure must not turn a completed state change into an
    // HTTP error or cause a retry to create a second user-visible action.
    console.warn("Failed to emit managed follower Activity event:", serializeErrorForLog(error));
  }
}

// Current Agent followers for thread cards/detail headers. Historical followers
// are deliberately excluded by channelService.getThreadFollowers().
channelRouter.get("/threads/followers", async (req, res) => {
  try {
    if (!await resolveThreadFollowerManagementGate(req, res)) return;
    const raw = typeof req.query.threadChannelIds === "string" ? req.query.threadChannelIds : "";
    const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > THREAD_FOLLOWER_ROSTER_MAX || ids.some((id) => !UUID_RE.test(id))) {
      res.status(400).json({ error: "threadChannelIds must contain 1-100 thread UUIDs" });
      return;
    }
    const threads = [];
    for (const threadChannelId of ids) {
      const channel = await resolveManagedThread(req, res, threadChannelId);
      if (!channel) return;
      const [followers, canManage] = await Promise.all([
        channelService.getManagedThreadAgentFollowers(threadChannelId),
        canManageThreadFollowers(req, channel),
      ]);
      threads.push({
        threadChannelId,
        agents: followers.map((agent) => ({
          ...agent,
          isCurrentServer: agent.serverId === req.serverId,
          canRemove: canManage && agent.serverId === req.serverId,
        })),
        canManage,
      });
    }
    res.json({ threads });
  } catch (error) {
    console.error("Failed to get thread Agent followers:", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to get thread Agent followers" });
  }
});

channelRouter.delete("/threads/:threadChannelId/followers/agents/:agentId", async (req, res) => {
  try {
    if (!await resolveThreadFollowerManagementGate(req, res)) return;
    const threadChannelId = String(req.params.threadChannelId);
    const agentId = String(req.params.agentId);
    if (!UUID_RE.test(threadChannelId) || !UUID_RE.test(agentId)) {
      res.status(400).json({ error: "Invalid thread or Agent id" });
      return;
    }
    const channel = await resolveManagedThread(req, res, threadChannelId);
    if (!channel) return;
    if (!await canManageThreadFollowers(req, channel)) {
      res.status(403).json({ error: "Only the thread author or a channel manager can remove followers" });
      return;
    }
    const agent = await agentService.getAgent(agentId);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent follower not found" });
      return;
    }
    const actor = await userService.getUser(req.userId!);
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const currentActivity = await resolveManagedFollowerActivity(orchestrator, agentId);
    const result = await channelService.removeManagedAgentThreadFollower({
      threadChannelId,
      agentId,
      actorLabel: actor?.name ? `@${actor.name}` : actor?.displayName || "A channel manager",
      threadLabel: channel.name || "thread",
      ...currentActivity,
    });
    if (result.changed && result.activityEvent) {
      await emitManagedFollowerActivity(orchestrator, agentId, result.activityEvent);
    }
    if (result.changed) {
      await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, threadChannelId);
    }
    res.json({
      ok: true,
      removed: Boolean(result.removalToken),
      undoToken: result.removalToken,
    });
  } catch (error) {
    console.error("Failed to remove Agent thread follower:", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to remove Agent thread follower" });
  }
});

channelRouter.post("/threads/:threadChannelId/followers/agents/:agentId/restore", async (req, res) => {
  try {
    if (!await resolveThreadFollowerManagementGate(req, res)) return;
    const threadChannelId = String(req.params.threadChannelId);
    const agentId = String(req.params.agentId);
    const removalToken = typeof req.body?.undoToken === "string" ? req.body.undoToken : "";
    if (!UUID_RE.test(threadChannelId) || !UUID_RE.test(agentId) || !removalToken) {
      res.status(400).json({ error: "Valid thread, Agent, and undo token are required" });
      return;
    }
    const channel = await resolveManagedThread(req, res, threadChannelId);
    if (!channel) return;
    if (!await canManageThreadFollowers(req, channel)) {
      res.status(403).json({ error: "Only the thread author or a channel manager can restore followers" });
      return;
    }
    const agent = await agentService.getAgent(agentId);
    if (!agent || agent.serverId !== req.serverId) {
      res.status(404).json({ error: "Agent follower not found" });
      return;
    }
    const actor = await userService.getUser(req.userId!);
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const currentActivity = await resolveManagedFollowerActivity(orchestrator, agentId);
    const result = await channelService.restoreManagedAgentThreadFollower({
      threadChannelId,
      agentId,
      actorLabel: actor?.name ? `@${actor.name}` : actor?.displayName || "A channel manager",
      threadLabel: channel.name || "thread",
      removalToken,
      ...currentActivity,
    });
    if (result.changed && result.activityEvent) {
      await emitManagedFollowerActivity(orchestrator, agentId, result.activityEvent);
    }
    if (result.changed) {
      await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, threadChannelId);
    }
    res.json({ ok: true, restored: result.changed });
  } catch (error) {
    console.error("Failed to restore Agent thread follower:", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to restore Agent thread follower" });
  }
});

// Follow a thread (manual follow)
channelRouter.post("/threads/follow", async (req, res) => {
  try {
    const { parentMessageId } = req.body;
    if (!parentMessageId) {
      res.status(400).json({ error: "parentMessageId is required" });
      return;
    }

    // Verify the parent message exists and belongs to a channel in this server
    const parentMsg = await channelService.getMessage(parentMessageId);
    if (!parentMsg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const parentChannel = await channelService.getChannel(parentMsg.channelId);
    if (!parentChannel) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    let localParentChannelId = parentMsg.channelId;
    if (parentChannel.serverId !== req.serverId || parentChannel.type === "joint") {
      const localProjection = (await channelService.getActiveJointChannelProjectionsByLocalChannel(parentMsg.channelId))
        .find((projection) => projection.serverId === req.serverId);
      if (!localProjection) {
        res.status(404).json({ error: "Message not found" });
        return;
      }
      localParentChannelId = localProjection.localChannelId;
    }
    const canAccessParent = await channelService.canUserAccessChannel(localParentChannelId, req.userId!, req.serverId!);
    if (!canAccessParent) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    // Find thread channel for this message
    const thread = await channelService.getOrCreateThreadForChannel(localParentChannelId, parentMessageId, req.userId!, "user");
    await channelService.followThread(req.userId!, thread.id, parentMessageId);
    await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, thread.id);
    res.json({ ok: true, threadChannelId: thread.id });
  } catch (err: any) {
    if (sendCompatibilityReadPending(res, err, { primaryOutcomeCommitted: true })) return;
    console.error("Failed to follow thread:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to follow thread" });
  }
});

// Unfollow a thread
channelRouter.post("/threads/unfollow", async (req, res) => {
  try {
    const { threadChannelId } = req.body;
    if (!threadChannelId) {
      res.status(400).json({ error: "threadChannelId is required" });
      return;
    }
    // Verify the thread channel belongs to this server
    const channel = await channelService.getChannel(threadChannelId);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(threadChannelId, req.userId!, req.serverId!);
    if (!canAccess) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    await channelService.unfollowThread(req.userId!, threadChannelId);
    await emitThreadFollowersUpdated(req.app.get("io") as SocketServer | undefined, threadChannelId);
    res.json({ ok: true });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err, { primaryOutcomeCommitted: true })) return;
    res.status(500).json({ error: "Failed to unfollow thread" });
  }
});

// Mark a thread as done (hide from active list, auto-restores on new messages)
channelRouter.post("/threads/done", async (req, res) => {
  try {
    const { threadChannelId, throughActivitySeq, frontierSpace } = req.body;
    if (!threadChannelId) {
      res.status(400).json({ error: "threadChannelId is required" });
      return;
    }
    // Same adjudicated four-way matrix as /inbox/done: omitted value uses the
    // existing canonical snapshot (whether storage is explicit or omitted), a
    // value without identity is refresh-required, an unsupported identity is
    // invalid, and only an explicit storage value enters the strict guard.
    if (frontierSpace === undefined && throughActivitySeq !== undefined) {
      res.status(412).json({
        error: "frontierSpace is required; refresh and retry",
        code: "DONE_FRONTIER_SPACE_REQUIRED",
      });
      return;
    }
    if (frontierSpace !== undefined && frontierSpace !== "storage") {
      res.status(400).json({
        error: "frontierSpace must be storage",
        code: "DONE_FRONTIER_UNMAPPABLE",
      });
      return;
    }
    // Resolution is fail-closed: any throw before the caller's standing is
    // established collapses to the same 404 rather than a 500. A 500 is
    // distinguishable from a 404, so a future throw in any helper would reopen
    // the existence oracle through a different exit.
    let activeChannel: Awaited<ReturnType<typeof channelService.getChannel>> | null = null;
    let channel: Awaited<ReturnType<typeof channelService.getChannel>> | null = null;
    try {
      activeChannel = await channelService.getChannel(threadChannelId);
      channel = activeChannel
        ?? await channelService.getChannel(threadChannelId, { includeDeleted: true });
    } catch (resolveErr) {
      console.error("[threads/done] resolve failed:", resolveErr);
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    // Never-existed and lives-in-another-server are merged deliberately: telling
    // them apart makes this endpoint an existence oracle over thread ids.
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    const authorize = async () => {
      try {
        return await channelService.canUserAccessChannel(
          threadChannelId,
          req.userId!,
          req.serverId!,
          { includeDeleted: true },
        );
      } catch (authErr) {
        console.error("[threads/done] authorize failed:", authErr);
        return false;
      }
    };

    // A non-thread scope is a caller bug worth naming -- but only to someone who
    // can already see the channel. To anyone else it stays in the merged 404,
    // because "wrong type" still reveals that the id is real.
    if (channel.type !== "thread") {
      if (await authorize()) {
        res.status(400).json({ error: "Not a thread", code: "NOT_A_THREAD" });
      } else {
        res.status(404).json({ error: "Thread not found" });
      }
      return;
    }
    // Deleted threads are adjudicated by the caller's OWN residue, not by parent
    // access, so this precedes the access gate exactly as in #6052. Callers with
    // no receiver-owned evidence get SCOPE_NOT_FOUND -> the same merged 404.
    if (!activeChannel && channel.deletedAt) {
      const receipt = await channelService.retireDeletedThreadDoneResidue(
        req.userId!,
        threadChannelId,
        throughActivitySeq,
      );
      res.json({ ok: true, ...receipt });
      return;
    }
    // A live thread below a deleted DM parent is no longer a content-access
    // target, but the receiver may still own stale Activity residue. Keep this
    // narrower than the ordinary authorization path: live private/hidden
    // parents still pass through authorize() and remain merged into 404.
    if (activeChannel && await channelService.hasDeletedDmThreadParent(threadChannelId, req.serverId!)) {
      if (!await channelService.hasUserThreadResidue(req.userId!, req.serverId!, threadChannelId)) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
      const receipt = await channelService.retireDeletedThreadDoneResidue(
        req.userId!,
        threadChannelId,
        throughActivitySeq,
      );
      res.json({ ok: true, ...receipt });
      return;
    }
    if (!await authorize()) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    await channelService.markThreadDone(req.userId!, threadChannelId, throughActivitySeq);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DoneFrontierRequiredError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof DoneFrontierBeyondLatestError || err instanceof DoneFrontierAboveInt4AuthorityError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ReadMutationError && err.code === "SCOPE_NOT_FOUND") {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    if (sendCompatibilityReadPending(res, err)) return;
    res.status(500).json({ error: "Failed to mark thread as done" });
  }
});

// Un-done a thread (restore to active list)
channelRouter.post("/threads/undone", async (req, res) => {
  try {
    const { threadChannelId } = req.body;
    if (!threadChannelId) {
      res.status(400).json({ error: "threadChannelId is required" });
      return;
    }
    const channel = await channelService.getChannel(threadChannelId);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(threadChannelId, req.userId!, req.serverId!);
    if (!canAccess) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    await channelService.undoneThread(req.userId!, threadChannelId);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to undone thread" });
  }
});

// ── Saved Messages ──

// List all saved messages
channelRouter.get("/saved", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const channelIdParam = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const channelId = channelIdParam && UUID_RE.test(channelIdParam) ? channelIdParam : undefined;
    const qParam = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const q = qParam || undefined;
    const sort = req.query.sort === "asc" ? "asc" as const : "desc" as const;
    const filteredTotalPromise = savedService.countSaved(req.userId!, req.serverId!, { channelId, q });
    const globalTotalPromise = channelId || q
      ? savedService.countSaved(req.userId!, req.serverId!)
      : filteredTotalPromise;
    const [saved, total, globalTotal] = await Promise.all([
      savedService.listSaved(req.userId!, req.serverId!, { limit, offset, channelId, q, sort }),
      filteredTotalPromise,
      globalTotalPromise,
    ]);
    // `total` = true saved count (drives the sidebar/panel badge, which used to
    // be capped at the loaded page size); `saved` is one page. Derive hasMore
    // from the true total — `saved.length >= limit` over-reports when the count
    // is an exact multiple of limit (a full last page wrongly looks like there's
    // more), so a `total`-exact check is both correct and simpler.
    res.json({ saved, hasMore: offset + saved.length < total, total, globalTotal });
  } catch {
    res.status(500).json({ error: "Failed to list saved messages" });
  }
});

// Save a message
channelRouter.post("/saved", async (req, res) => {
  try {
    const { messageId } = req.body;
    if (!messageId || typeof messageId !== "string") {
      res.status(400).json({ error: "messageId is required" });
      return;
    }
    // Verify the message is visible in this server. Joint messages live under
    // canonical storage, so raw message.channelId/serverId is not enough.
    const canAccess = await savedService.canSaveMessage(req.userId!, req.serverId!, messageId);
    if (!canAccess) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    await savedService.saveMessage(req.userId!, messageId, req.serverId!);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to save message" });
  }
});

// Unsave a message
channelRouter.delete("/saved/:messageId", async (req, res) => {
  try {
    await savedService.unsaveMessage(req.userId!, req.params.messageId);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to unsave message" });
  }
});

// Check saved status for a batch of message IDs
channelRouter.post("/saved/check", async (req, res) => {
  try {
    const { messageIds } = req.body;
    if (!Array.isArray(messageIds)) {
      res.status(400).json({ error: "messageIds array is required" });
      return;
    }
    if (messageIds.length > 200) {
      res.status(400).json({ error: "Maximum 200 messageIds per request" });
      return;
    }
    if (!messageIds.every((id: unknown) => typeof id === "string")) {
      res.status(400).json({ error: "messageIds must be strings" });
      return;
    }
    const saved = await savedService.getSavedMessageIds(req.userId!, req.serverId!, messageIds);
    res.json({ savedIds: [...saved] });
  } catch {
    res.status(500).json({ error: "Failed to check saved messages" });
  }
});

function parseRegularChannelVisibility(raw: unknown): channelService.RegularChannelType | undefined {
  if (raw === undefined) return undefined;
  if (raw === "public") return "channel";
  if (raw === "private") return "private";
  throw new Error("invalid_visibility");
}

// Hide the built-in #all channel. The mirror of /system/all/restore, and the
// only way in: the generic visibility field refuses #all outright.
//
// This endpoint exists because hiding #all is not an instance of "make a channel
// private". #all carries no membership rows -- its audience is derived from
// server membership -- so the transition drops everyone at once, including the
// actor, and an agent that reached #all through that derived audience can never
// reach it again. Keeping both directions on dedicated, human-only, id-free
// endpoints makes the door two-way by construction.
channelRouter.post("/system/all/hide", async (req, res) => {
  try {
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "changeChannelVisibility"))) {
      res.status(403).json({ error: "Only admins can hide #all" });
      return;
    }

    const channel = await channelService.getSystemAllChannel(req.serverId!);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const alreadyHidden = !channelService.isEnabledAllChannel(channel);
    const updated = alreadyHidden
      ? channel
      : await channelService.updateChannel(channel.id, { type: "private" });

    // Moved here from the generic PATCH handler along with the hide path itself.
    // Claiming the unlock instruction is what stops the onboarding team-growth
    // unlock from re-revealing an #all that an admin hid on purpose
    // (agentService reads `allChannelUnlockInstructionSentAt` before unlocking).
    // Leaving it behind in PATCH would have resurrected that bug silently: the
    // regression test covering it drives the PATCH route, so it would have kept
    // passing against a path nothing uses any more.
    // Unconditional on purpose. Guarding this with `!alreadyHidden` meant an #all
    // that was ALREADY hidden never got the claim -- and under onboarding_opener_v2
    // that is the birth state of every new server, instruction unclaimed. The owner
    // who hides an already-hidden #all expresses the same intent as one who hides a
    // visible one, and used to get a different durable outcome: team growth
    // re-revealed it. The claim is idempotent (it writes only when the column is
    // null), so calling it always costs nothing and removes the divergence.
    // Found in independent review of this PR.
    const server = await serverService.getServer(req.serverId!);
    if (server) {
      await serverService.tryClaimAllChannelUnlockInstruction(req.serverId!, server.ownerId, resolveNow(req));
    }

    const io = req.app.get("io") as SocketServer | undefined;
    io?.in(`server:${req.serverId}`).socketsLeave(`channel:${channel.id}`);
    await publishChannelUpdate(io, updated);
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to hide #all" });
  }
});

// Restore the built-in #all channel when it is hidden. Hidden #all is
// deliberately omitted from ordinary channel lists, so the admin UI cannot
// rely on already knowing the channel id.
channelRouter.post("/system/all/restore", async (req, res) => {
  try {
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "changeChannelVisibility"))) {
      res.status(403).json({ error: "Only admins can restore #all" });
      return;
    }

    const channel = await channelService.getSystemAllChannel(req.serverId!);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    const updated = channelService.isEnabledAllChannel(channel)
      ? channel
      : await channelService.updateChannel(channel.id, { type: "channel" });

    await publishChannelUpdate(req.app.get("io"), updated);
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to restore #all" });
  }
});

// Update channel (name / description / visibility)
channelRouter.patch("/:id", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const [canEditChannelMetadata, canChangeChannelVisibility, canManageGuestAccess] = await Promise.all([
      actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "editChannelMetadata"),
      actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "changeChannelVisibility"),
      actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "manageGuestAccess"),
    ]);
    const canManageRequestedChange = canEditChannelMetadata || canChangeChannelVisibility || canManageGuestAccess;
    const isHiddenAllChannel = channelService.isAllSystemChannel(channel)
      && !channelService.isEnabledAllChannel(channel);
    if (isHiddenAllChannel && !canManageRequestedChange) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!isHiddenAllChannel && !await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // DMs cannot be renamed/updated
    if (channel.type === "dm") {
      res.status(403).json({ error: "Cannot edit DM channels" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    const { name, description, visibility, guestVisible, guestJoinable } = req.body;
    const guestPolicyRequested = guestVisible !== undefined || guestJoinable !== undefined;
    if ((name !== undefined || description !== undefined) && !canEditChannelMetadata) {
      res.status(403).json({ error: "You do not have permission to edit channel metadata" });
      return;
    }
    if (visibility !== undefined && !canChangeChannelVisibility) {
      res.status(403).json({ error: "You do not have permission to change channel visibility" });
      return;
    }
    if (guestPolicyRequested && !canManageGuestAccess) {
      res.status(403).json({ error: "You do not have permission to manage guest access" });
      return;
    }
    if (guestPolicyRequested) {
      const guestGate = await evaluateFeatureFlag({
        key: SERVER_GUEST_FEATURE_FLAG_KEY,
        serverId: req.serverId!,
        userId: req.userId!,
      });
      if (!guestGate.enabled) {
        res.status(404).json({ error: "Guest access is not enabled" });
        return;
      }
      if ((guestVisible !== undefined && typeof guestVisible !== "boolean")
        || (guestJoinable !== undefined && typeof guestJoinable !== "boolean")) {
        res.status(400).json({ error: "guestVisible and guestJoinable must be booleans" });
        return;
      }
      if (channelService.isAllSystemChannel(channel) && guestJoinable !== undefined) {
        res.status(400).json({ error: "The #all channel does not support Guest joining" });
        return;
      }
    }
    if (name === undefined && description === undefined && visibility === undefined && !guestPolicyRequested && !canEditChannelMetadata) {
      res.status(403).json({ error: "You do not have permission to update channels" });
      return;
    }
    if (name !== undefined) {
      const nameError = validateName(name, "Channel name");
      if (nameError) {
        res.status(400).json({ error: nameError });
        return;
      }
    }
    if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
      res.status(400).json({ error: "Description must be a string of at most 500 characters" });
      return;
    }
    let type: channelService.RegularChannelType | undefined;
    try {
      type = parseRegularChannelVisibility(visibility);
    } catch {
      res.status(400).json({ error: "visibility must be one of: public, private" });
      return;
    }
    // #all is never reachable through the generic visibility field (@cindyz,
    // 2026-09-07, #wg-rbac msg=c1a72093). Hiding it is not "making a channel
    // private": #all has no membership rows at all, so the transition drops the
    // entire derived audience at once and takes the actor down with it. It is
    // managed only through the dedicated human surfaces below.
    //
    // Written as an explicit refusal rather than leaning on the membership check
    // that follows. #all happens to carry zero rows today, so the membership rule
    // would exclude it as a side effect -- but a side effect is not a contract:
    // the day anything writes an explicit #all row the gate would reopen silently
    // and no test would go red.
    if (visibility !== undefined && channelService.isAllSystemChannel(channel)) {
      res.status(403).json({
        error: channelService.ALL_CHANNEL_VISIBILITY_REFUSAL,
        code: "all_channel_visibility_managed_separately",
      });
      return;
    }
    // Both humans and agents must be members of the channel whose visibility they
    // change (@cindyz, 2026-09-07). This is what makes the door two-way: a public
    // channel is readable without a membership row, so an admin who was never a
    // member could turn it private and then be refused by the very rule they had
    // just created. Requiring membership up front means the actor holds a row,
    // and ordinary channels preserve rows across the transition.
    if (visibility !== undefined && !await channelService.isChannelHuman(channel.id, req.userId!)) {
      res.status(403).json({
        error: "You must be a member of this channel to change its visibility",
        code: "channel_membership_required",
      });
      return;
    }
    if (guestPolicyRequested) {
      if (channel.type !== "channel" && channel.type !== "private") {
        res.status(400).json({ error: "Guest access is supported only for ordinary channels" });
        return;
      }
      const nextType = type ?? channel.type;
      const privateGuestPolicyDisabled = nextType === "private" && !channelService.isAllSystemChannel(channel);
      const nextGuestVisible = privateGuestPolicyDisabled ? false : guestVisible ?? channel.guestVisible;
      const nextGuestJoinable = channelService.isAllSystemChannel(channel)
        ? false
        : privateGuestPolicyDisabled ? false : guestJoinable ?? channel.guestJoinable;
      if (nextGuestJoinable && !nextGuestVisible) {
        res.status(400).json({ error: "Guest-joinable channels must also be guest-visible" });
        return;
      }
    }
    const requiredCapabilities: ServerCapability[] = [];
    if (name !== undefined || description !== undefined) requiredCapabilities.push("editChannelMetadata");
    if (visibility !== undefined) requiredCapabilities.push("changeChannelVisibility");
    if (guestPolicyRequested) requiredCapabilities.push("manageGuestAccess");
    const updated = await withLockedChannelActorCapabilities({
      serverId: req.serverId!,
      channelId: channel.id,
      actorType: "user",
      actorId: req.userId!,
      capabilities: requiredCapabilities,
    }, (tx) => channelService.updateChannel(req.params.id, {
      name: name?.trim(),
      description,
      type,
      guestVisible,
      guestJoinable: channelService.isAllSystemChannel(channel) && guestPolicyRequested ? false : guestJoinable,
    }, tx));
    await channelService.revokeChannelAccessAfterUpdate({ type, guestVisible }, updated);
    const renamed = updated.name !== channel.name;

    // Notify clients about channel update
    const io = req.app.get("io");
    // The #all unlock-instruction claim used to live here. It moved to
    // POST /system/all/hide together with the only path that can now hide #all;
    // this route refuses #all visibility outright, so a claim here would be dead
    // code that hides the move.
    if (updated.type === "joint") {
      const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(updated.id);
      const projectionChannels = await channelService.attachJointChannelMetadata(
        projections.map((projection) => ({ ...projection.channel, joined: true })),
      );
      for (const projection of projectionChannels) {
        io?.to(`channel:${projection.id}`).emit("channel:updated", { channel: projection });
      }
    } else {
      await publishChannelUpdate(io, updated);
    }

    if (renamed) {
      await broadcastChannelRenameSystemMessage(req, updated, req.userId!, channel.name, updated.name).catch(() => {});
    }

    res.json(updated);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === "Channel capability required") {
      res.status(403).json({ error: "You do not have permission to update channels" });
    } else if (msg.includes("already taken")) {
      res.status(409).json({ error: msg });
    } else if (msg.includes("Cannot rename") || msg.includes("Cannot edit") || msg.includes("Cannot change visibility") || msg.includes("reserved")) {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to update channel" });
    }
  }
});

// List message attachments visible from a channel-level Files tab.
// Thread attachments are included under their parent channel and carry enough
// source metadata for the client to jump back to the original thread surface.
channelRouter.get("/:id/files", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!);
    if (!canAccess) {
      await denyChannelAccess(res, req.userId!, channel.id, "You do not have access to this channel");
      return;
    }

    const plan = await getServerPlan(req.serverId!);
    const historyCutoff = getHistoryCutoff(plan);
    const limit = parseChannelFilesLimit(req.query.limit);
    let cursor: channelService.ChannelFilesCursor | null;
    try {
      cursor = parseChannelFilesCursor(req.query.cursor);
    } catch {
      res.status(400).json({ error: "Invalid cursor" });
      return;
    }
    const files = await channelService.listChannelFiles(channel.id, { historyCutoff, limit: limit + 1, cursor });
    const pageFiles = files.slice(0, limit);
    const nextCursor = files.length > limit && pageFiles.length > 0
      ? encodeChannelFilesCursor(pageFiles[pageFiles.length - 1])
      : null;
    res.json({
      files: pageFiles.map((file) => {
        const filename = normalizeAttachmentFilename(file.filename);
        return {
          id: file.id,
          messageId: file.messageId,
          channelId: file.channelId,
          filename,
          mimeType: resolveAttachmentMimeType(filename, file.mimeType),
          sizeBytes: file.sizeBytes,
          width: file.width,
          height: file.height,
          thumbnailUrl: getThumbnailUrl(file.thumbnailKey),
          createdAt: file.createdAt,
          uploader: {
            type: file.uploaderType,
            id: file.uploaderId,
            name: file.uploaderName,
            displayName: file.uploaderDisplayName || file.uploaderName,
          },
          source: file.source,
        };
      }),
      nextCursor,
    });
  } catch (err) {
    console.error("Failed to list channel files:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list channel files" });
  }
});

async function resolveActivityMuteTarget(req: Request, res: Response) {
  const channelId = typeof req.params.id === "string" ? req.params.id : req.params.id[0];
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== req.serverId) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  if (channel.type === "thread") {
    res.status(400).json({ error: "Thread notification settings are managed via follow/unfollow" });
    return null;
  }
  const canAccess = await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!);
  if (!canAccess) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  return channel;
}

async function resolveMessageDisplayPrefsTarget(req: Request, res: Response) {
  const gate = await evaluateFeatureFlag({
    key: TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
    serverId: req.serverId!,
    userId: req.userId!,
    platform: "web",
  });
  if (!gate.enabled) {
    res.status(404).json({
      error: "Channel message display settings are not enabled",
      code: "message_display_settings_disabled",
    });
    return null;
  }

  const channelId = typeof req.params.id === "string" ? req.params.id : req.params.id[0];
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== req.serverId) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  if (channel.type === "thread") {
    res.status(400).json({ error: "Thread message display settings are managed by the parent channel" });
    return null;
  }
  // Display prefs are a per-user "my channel" setting, so the gate is channel
  // membership — not canUserAccessChannel, which lets any server member read a
  // public channel without joining it. The #all system channel has implicit
  // membership for every server human (addHuman is a no-op there).
  const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
  const isPrefsMember = channelService.isAllSystemChannel(channel)
    ? requesterRole !== "guest" && channelService.isEnabledAllChannel(channel)
    : channel.type === "channel"
      ? await channelService.isChannelHuman(channel.id, req.userId!)
      : await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!);
  if (!isPrefsMember) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  return channel;
}

channelRouter.get("/:id/notification-settings", async (req, res) => {
  try {
    const channel = await resolveActivityMuteTarget(req, res);
    if (!channel) return;
    const humanActivityMuteEnabled = await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!);
    if (!humanActivityMuteEnabled) {
      res.json({ activityMuted: false, muteFromSeq: null, prefsVersion: 0, activityMuteSupported: false });
      return;
    }
    const state = await channelService.getInboxTargetActivityMuteState("user", req.userId!, channel.id);
    addTraceEvent("activity_mute.setting.loaded", {
      server_id: req.serverId,
      source_channel_id: channel.id,
      receiver_type: "user",
      activity_mute_state: state.activityMuted ? "muted" : "unmuted",
      activity_muted: state.activityMuted,
      mute_from_seq: state.muteFromSeq,
      negative_evidence_bucket: "does_not_prove_future_message_suppression",
    });
    res.json({
      activityMuted: state.activityMuted,
      muteFromSeq: state.muteFromSeq,
      prefsVersion: state.prefsVersion,
      activityMuteSupported: channelTypeSupportsActivityMute(channel.type),
    });
  } catch {
    res.status(500).json({ error: "Failed to get channel notification settings" });
  }
});

channelRouter.patch("/:id/notification-settings", async (req, res) => {
  try {
    const channel = await resolveActivityMuteTarget(req, res);
    if (!channel) return;
    const humanActivityMuteEnabled = await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!);
    if (!humanActivityMuteEnabled) {
      res.status(404).json({ error: "Human Activity mute is not enabled", code: "human_activity_mute_disabled" });
      return;
    }
    if (typeof req.body?.activityMuted !== "boolean") {
      res.status(400).json({ error: "activityMuted must be a boolean" });
      return;
    }
    const state = await channelService.setInboxTargetActivityMuteState({
      receiverType: "user",
      receiverId: req.userId!,
      serverId: req.serverId!,
      sourceChannelId: channel.id,
      activityMuted: req.body.activityMuted,
    });
    addTraceEvent("activity_mute.api.updated", {
      server_id: req.serverId,
      source_channel_id: channel.id,
      receiver_type: "user",
      activity_mute_state: state.activityMuted ? "muted" : "unmuted",
      activity_muted: state.activityMuted,
      mute_from_seq: state.muteFromSeq,
      negative_evidence_bucket: "does_not_prove_future_message_suppression",
    });
    emitNotificationPrefsUpdated(req, channel.id, state);
    res.json({
      activityMuted: state.activityMuted,
      muteFromSeq: state.muteFromSeq,
      prefsVersion: state.prefsVersion,
      activityMuteSupported: channelTypeSupportsActivityMute(channel.type),
    });
  } catch {
    res.status(500).json({ error: "Failed to update channel notification settings" });
  }
});

channelRouter.get("/:id/message-display-settings", async (req, res) => {
  try {
    const channel = await resolveMessageDisplayPrefsTarget(req, res);
    if (!channel) return;
    const prefs = await channelService.getUserChannelMessageDisplayPrefs(req.userId!, channel.id);
    res.json({
      collapseLongMessages: prefs.collapseLongMessages,
      prefsVersion: prefs.prefsVersion,
    });
  } catch {
    res.status(500).json({ error: "Failed to get channel message display settings" });
  }
});

channelRouter.patch("/:id/message-display-settings", async (req, res) => {
  try {
    const channel = await resolveMessageDisplayPrefsTarget(req, res);
    if (!channel) return;
    if (typeof req.body?.collapseLongMessages !== "boolean") {
      res.status(400).json({ error: "collapseLongMessages must be a boolean" });
      return;
    }
    const prefs = await channelService.setUserChannelMessageDisplayPrefs({
      userId: req.userId!,
      serverId: req.serverId!,
      channelId: channel.id,
      collapseLongMessages: req.body.collapseLongMessages,
    });
    emitMessageDisplayPrefsUpdated(req, channel.id, prefs);
    res.json({
      collapseLongMessages: prefs.collapseLongMessages,
      prefsVersion: prefs.prefsVersion,
    });
  } catch {
    res.status(500).json({ error: "Failed to update channel message display settings" });
  }
});

// Get channel details
channelRouter.get("/:id", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // Include `joined` to align response shape with `/channels` list. Without
    // this, first-paint hydration via `ensureChannel()` (added in PR #1549)
    // treats `joined === undefined` as not-joined and flashes a "Join channel"
    // CTA for users who are already members. DMs are always joined for the
    // recipient by definition; for regular/private channels we check the
    // human membership table. (#engineering:e4f52605 / staging-only regression
    // observed by @xxchan; root-cause + patch reviewed by @哭哭 + @Leiysky.)
    // #all uses implicit membership (no channelHumans row — addHuman is a no-op
    // for the system #all channel), so isChannelHuman is false for members. Mirror
    // the listChannels contract and treat an enabled #all as joined; otherwise a
    // direct GET /channels/:id (ensureChannel navigation) flashes a "Join #all" CTA
    // for someone already in it, until a full /channels refresh corrects it.
    const readableDm = channel.type === "dm"
      ? await channelService.getReadableDMChannelForUser(channel.id, req.userId!)
      : null;
    const channelForResponse = readableDm
      ? { ...channel, ...readableDm, serverId: channel.serverId }
      : channel;
    const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const joined = channel.type === "dm"
      ? true
      : requesterRole !== "guest" && channelService.isEnabledAllChannel(channel)
        ? true
        : channelService.isAllSystemChannel(channel) && requesterRole === "guest"
          ? false
          : await channelService.isChannelHuman(channel.id, req.userId!);
    const humanActivityMuteEnabled = await channelService.isHumanActivityMuteEnabled(req.serverId!, req.userId!);
    const activityMuteSupported = humanActivityMuteEnabled && channelTypeSupportsActivityMute(channel.type);
    const activityMuteState = activityMuteSupported
      ? await channelService.getInboxTargetActivityMuteState("user", req.userId!, channel.id)
      : {};
    const messageDisplayPrefs = channel.type !== "thread"
      ? await channelService.getUserChannelMessageDisplayPrefs(req.userId!, channel.id)
      : { collapseLongMessages: true, prefsVersion: 0 };
    const readState = await channelService.getReadStateSnapshot(req.userId!, channel.id);
    const peerReadHydrate = channel.type === "channel" || channel.type === "private" || channel.type === "dm"
      ? await getPeerReadHydrate({
          serverId: req.serverId!,
          channelId: channel.id,
          viewerKind: "human",
          viewerId: req.userId!,
        })
      : null;
    const [channelWithJointMetadata] = await channelService.attachJointChannelMetadata([{
      ...channelForResponse,
      joined,
      ...activityMuteState,
      collapseLongMessages: messageDisplayPrefs.collapseLongMessages,
      displayPrefsVersion: messageDisplayPrefs.prefsVersion,
      ...readState,
      ...(peerReadHydrate ?? {}),
      ...(humanActivityMuteEnabled ? { activityMuteSupported } : {}),
    }]);
    const [channelWithMetadata] = await channelService.attachExternalBridgeMetadata([channelWithJointMetadata]);
    res.json(await attachHumanChannelAuthorization(channelWithMetadata, req.serverId!, req.userId!));
  } catch {
    res.status(500).json({ error: "Failed to get channel" });
  }
});

// Archive channel (freezes writes, preserves name)
channelRouter.post("/:id/archive", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!["channel", "private", "joint"].includes(channel.type)) {
      res.status(400).json({ error: "Only regular channels can be archived" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canArchive = channel.type === "channel" || channel.type === "private"
      ? await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "archiveChannels")
      : await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "archiveChannels");
    if (!canArchive) {
      res.status(403).json({ error: "Only admins can archive channels" });
      return;
    }

    const wasArchived = !!channel.archivedAt;
    const updated = channel.type === "joint"
      ? await channelService.archiveChannel(req.params.id, req.userId!)
      : await withLockedChannelActorCapability({
          serverId: req.serverId!,
          channelId: channel.id,
          actorType: "user",
          actorId: req.userId!,
          capability: "archiveChannels",
        }, (tx) => channelService.archiveChannel(req.params.id, req.userId!, tx));

    const io = req.app.get("io");
    if (updated.type === "joint") {
      const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(updated.id);
      const projectionChannels = await channelService.attachJointChannelMetadata(
        projections.map((projection) => ({ ...projection.channel, joined: true })),
      );
      for (const projection of projectionChannels) {
        io?.to(`channel:${projection.id}`).emit("channel:updated", { channel: projection });
      }
    } else {
      await publishChannelUpdate(io, updated);
    }

    if (!wasArchived) {
      const user = await userService.getUser(req.userId!);
      const userName = user?.displayName || user?.name || "Someone";
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      messageService.broadcastSystemMessage(io, agentOrchestrator, req.params.id,
        `📦 ${userName} archived this channel`, {
          inboxFactPolicy: {
            mode: "record",
            producer: "channel.archive",
            reason: "channel archive is shared channel activity",
          },
          causalActor: { type: "user", id: req.userId! },
        }).catch(() => {});
    }

    res.json(updated);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === "Channel capability required") {
      res.status(403).json({ error: "Only admins can archive channels" });
    } else if (msg.includes("#all") || msg.includes("Only regular")) {
      res.status(400).json({ error: msg });
    } else if (msg === "Channel not found") {
      res.status(404).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to archive channel" });
    }
  }
});

// Unarchive channel
channelRouter.post("/:id/unarchive", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!["channel", "private", "joint"].includes(channel.type)) {
      res.status(400).json({ error: "Only regular channels can be unarchived" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canUnarchive = channel.type === "channel" || channel.type === "private"
      ? await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "archiveChannels")
      : await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "archiveChannels");
    if (!canUnarchive) {
      res.status(403).json({ error: "Only admins can unarchive channels" });
      return;
    }

    const wasArchived = !!channel.archivedAt;
    const updated = channel.type === "joint"
      ? await channelService.unarchiveChannel(req.params.id)
      : await withLockedChannelActorCapability({
          serverId: req.serverId!,
          channelId: channel.id,
          actorType: "user",
          actorId: req.userId!,
          capability: "archiveChannels",
        }, (tx) => channelService.unarchiveChannel(req.params.id, tx));

    const io = req.app.get("io");
    if (updated.type === "joint") {
      const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(updated.id);
      const projectionChannels = await channelService.attachJointChannelMetadata(
        projections.map((projection) => ({ ...projection.channel, joined: true })),
      );
      for (const projection of projectionChannels) {
        io?.to(`channel:${projection.id}`).emit("channel:updated", { channel: projection });
      }
    } else {
      await publishChannelUpdate(io, updated);
    }

    if (wasArchived) {
      const user = await userService.getUser(req.userId!);
      const userName = user?.displayName || user?.name || "Someone";
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      messageService.broadcastSystemMessage(io, agentOrchestrator, req.params.id,
        `📤 ${userName} unarchived this channel`, {
          inboxFactPolicy: {
            mode: "record",
            producer: "channel.unarchive",
            reason: "channel unarchive is shared channel activity",
          },
          causalActor: { type: "user", id: req.userId! },
        }).catch(() => {});
    }

    res.json(updated);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === "Channel capability required") {
      res.status(403).json({ error: "Only admins can unarchive channels" });
    } else if (msg.includes("Only regular")) {
      res.status(400).json({ error: msg });
    } else if (msg === "Channel not found") {
      res.status(404).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to unarchive channel" });
    }
  }
});

// Delete channel
channelRouter.delete("/:id", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "joint") {
      res.status(400).json({ error: "Joint channels cannot be deleted; disconnect this server instead" });
      return;
    }
    // DMs: only participants can delete; regular/private channels: admin/owner only
    if (channel.type !== "dm") {
      if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "deleteChannels"))) {
        res.status(403).json({ error: "Only admins can delete channels" });
        return;
      }
    }
    await channelService.deleteChannel(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("cannot be deleted")) {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to delete channel" });
    }
  }
});

channelRouter.post("/:id/disconnect", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type !== "joint") {
      res.status(400).json({ error: "Only joint channels can be disconnected" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can disconnect joint channels" });
      return;
    }

    await channelService.disconnectJointChannel(req.params.id, req.userId!);
    const io = req.app.get("io");
    io?.to(`server:${req.serverId}`).emit("channel:updated", { channelId: req.params.id });
    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === "Joint channel not found" || msg === "Channel not found") {
      res.status(404).json({ error: "Channel not found" });
    } else if (msg.includes("Only joint")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to disconnect joint channel" });
    }
  }
});

channelRouter.post("/:id/joint-invite/resend", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type !== "joint") {
      res.status(400).json({ error: "Only joint channels can resend joint invites" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can resend joint channel invites" });
      return;
    }

    const result = await channelService.resendPendingJointChannelInvites({
      localChannelId: req.params.id,
      fromServerId: req.serverId!,
      requestedByUserId: req.userId!,
    });
    res.json(result);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === "Joint channel not found" || msg === "Channel not found") {
      res.status(404).json({ error: "Channel not found" });
    } else if (msg.includes("No pending")) {
      res.status(409).json({ error: msg });
    } else if (msg.includes("Only joint")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to resend joint channel invite" });
    }
  }
});

channelRouter.post("/:id/convert-to-joint", async (req, res) => {
  let failedPreJobPhase: channelConversionService.ChannelConversionPreJobPhase | null = null;
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can convert channels to joint channels" });
      return;
    }

    let job = await channelConversionService.startChannelToJointConversion({
      serverId: req.serverId!,
      sourceChannelId: req.params.id,
      createdByUserId: req.userId!,
      confirmTaskIdentityDrop: req.body?.confirmTaskIdentityDrop === true,
      tracePreJobPhase: ({ phase, outcome, errorClass, eligibilitySubcheck }) => {
        if (outcome === "failed") failedPreJobPhase = phase;
        addTraceEvent("server.channel_conversion.pre_job", {
          event_kind: "channel_conversion",
          channel_id: req.params.id,
          phase,
          outcome,
          ...(eligibilitySubcheck ? { eligibility_subcheck: eligibilitySubcheck } : {}),
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      },
    });
    if (job.status === "failed") {
      job = await channelConversionService.retryChannelConversionJob(job.id);
    }
    const tracer = (req.app.get("serverTracer") as Tracer | undefined) ?? noopTracer;
    const rootAttrs = {
      event_kind: "channel_conversion",
      job_id: job.id,
      channel_id: job.sourceChannelId,
      phase: job.phase,
      outcome: "ok",
    };
    addTraceEvent("server.channel_conversion.job.started", rootAttrs);
    const jobSpan = tracer.startSpan("server.channel_conversion.job", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: rootAttrs,
    });
    let completedJob;
    try {
      completedJob = await channelConversionService.runChannelConversionJob(job.id, {
        tracer,
        traceParent: jobSpan.context,
      });
    } finally {
      const currentJob = await channelConversionService.getChannelConversionJob(job.id);
      jobSpan.end(currentJob?.status === "failed" ? "error" : "ok", {
        attrs: {
          event_kind: "channel_conversion",
          job_id: currentJob?.id ?? job.id,
          channel_id: currentJob?.sourceChannelId ?? job.sourceChannelId,
          phase: currentJob?.phase ?? job.phase,
          outcome: currentJob?.status === "failed" ? "failed" : "ok",
        },
      });
    }
    const converted = await channelService.getChannel(req.params.id);
    const [channelWithMetadata] = converted
      ? await channelService.attachJointChannelMetadata([{ ...converted, joined: true }])
      : [];
    if (converted && channelWithMetadata) {
      const io = req.app.get("io") as SocketServer | undefined;
      await emitJointProjectionUpdates(io, converted.id);
      io?.to(`channel:${converted.id}`).emit("channel:updated", { channel: channelWithMetadata });
    }

    if (completedJob.status === "failed") {
      const progress = completedJob.progress && typeof completedJob.progress === "object" && !Array.isArray(completedJob.progress)
        ? completedJob.progress as Record<string, unknown>
        : {};
      const awaitingRetry = progress.retryState === "awaiting_retry";
      res.status(409).json({
        error: awaitingRetry
          ? "Channel conversion interrupted after history was partially migrated. The source channel is locked until retry completes."
          : completedJob.error ?? "Channel conversion failed",
        code: awaitingRetry ? "channel_conversion_awaiting_retry" : "channel_conversion_failed",
        conversionJob: completedJob,
      });
      return;
    }
    res.json({ channel: channelWithMetadata ?? converted, conversionJob: completedJob });
  } catch (err: unknown) {
    if (err instanceof channelConversionService.ChannelConversionTaskIdentityDropRequiredError) {
      res.status(409).json({
        error: err.message,
        code: err.code,
        requiresConfirmation: true,
        taskIdentityDrop: {
          policy: "drop_task_identity",
          acknowledged: false,
          consequence: channelConversionService.CHANNEL_CONVERSION_TASK_IDENTITY_DROP_COPY,
          inventory: err.taskInventory,
        },
      });
      return;
    }
    if (err instanceof channelConversionService.ChannelConversionError) {
      if (err.code === "channel_not_found") {
        res.status(404).json({ error: err.message, code: err.code });
      } else if (err.code === "reserved_channel" || err.code === "unsupported_channel_type") {
        res.status(400).json({ error: err.message, code: err.code });
      } else if (err.code === "job_not_found") {
        res.status(404).json({ error: err.message, code: err.code });
      } else {
        res.status(409).json({ error: err.message, code: err.code });
      }
      return;
    }
    if (failedPreJobPhase) {
      const failure = channelConversionService.describeChannelConversionPreJobFailure(failedPreJobPhase, err);
      res.status(failure.status).json(failure);
      return;
    }
    res.status(500).json({ error: "Failed to convert channel to joint channel" });
  }
});

channelRouter.post("/:id/joint-invites", async (req, res) => {
  try {
    const { targetServerSlug, invitedPeople } = req.body || {};
    if (typeof targetServerSlug !== "string" || !targetServerSlug.trim()) {
      res.status(400).json({ error: "Invite server slug is required" });
      return;
    }
    const selectedInvitedPeople = normalizeStringList(invitedPeople, channelService.MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET);
    if (selectedInvitedPeople.length === 0) {
      res.status(400).json({ error: "At least one invited person is required" });
      return;
    }

    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type !== "joint") {
      res.status(400).json({ error: "Only joint channels can invite servers" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "federateChannels"))) {
      res.status(403).json({ error: "Only admins can invite servers to joint channels" });
      return;
    }

    const result = await channelService.inviteServerToJointChannel({
      localChannelId: req.params.id,
      fromServerId: req.serverId!,
      invitedByUserId: req.userId!,
      targetServerSlug,
      invitedPeople: selectedInvitedPeople,
    });
    const [channelWithMetadata] = await channelService.attachJointChannelMetadata([{ ...channel, joined: true }]);
    const io = req.app.get("io") as SocketServer | undefined;
    await emitJointProjectionUpdates(io, channel.id);
    res.json({ ...channelWithMetadata, jointInvites: result.invites, jointInvite: result.invites[0] ?? null });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === "Joint channel not found" || msg === "Channel not found") {
      res.status(404).json({ error: msg === "Joint channel not found" ? "Channel not found" : msg });
    } else if (msg.includes("Cannot invite") || msg.includes("Target server") || msg.includes("not found") || msg.includes("At least one") || msg.includes("Invite server slug") || msg.includes("maximum of")) {
      res.status(400).json({ error: msg });
    } else if (msg.includes("must be a target server admin")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to invite server to joint channel" });
    }
  }
});

// Get agents in channel
channelRouter.get("/:id/agents", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const agentList = await channelService.getChannelAgents(req.params.id);
    res.json(agentList);
  } catch {
    res.status(500).json({ error: "Failed to get agents" });
  }
});

// Stop all agents in channel (emergency stop)
channelRouter.post("/:id/stop-all-agents", async (req, res) => {
  try {
    if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "controlAgentRuntime")) {
      res.status(403).json({ error: "The `controlAgentRuntime` capability is required to stop all agents in a channel" });
      return;
    }
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const agents = await channelService.getChannelAgents(req.params.id);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const results: { agentId: string; ok: boolean; error?: string }[] = [];
    await Promise.allSettled(
      agents.map(async (agent) => {
        try {
          await agentOrchestrator.stopAgent(agent.id);
          results.push({ agentId: agent.id, ok: true });
        } catch (err: unknown) {
          results.push({ agentId: agent.id, ok: false, error: (err as Error).message });
        }
      })
    );
    res.json({ ok: true, stopped: results.filter((r) => r.ok).length, total: agents.length, results });
  } catch {
    res.status(500).json({ error: "Failed to stop agents" });
  }
});

// Resume all agents in channel (SOS recovery)
channelRouter.post("/:id/resume-all-agents", async (req, res) => {
  try {
    if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "controlAgentRuntime")) {
      res.status(403).json({ error: "The `controlAgentRuntime` capability is required to resume all agents in a channel" });
      return;
    }
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const { prompt } = req.body as { prompt?: string };
    if (prompt && (typeof prompt !== "string" || prompt.length > 10000)) {
      res.status(400).json({ error: "Prompt must be a string under 10000 characters" });
      return;
    }
    const agents = await channelService.getChannelAgents(req.params.id);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const results: { agentId: string; ok: boolean; error?: string }[] = [];
    await Promise.allSettled(
      agents.map(async (agent) => {
        try {
          await agentOrchestrator.startAgent(agent.id, { resumePrompt: prompt });
          results.push({ agentId: agent.id, ok: true });
        } catch (err: unknown) {
          results.push({ agentId: agent.id, ok: false, error: (err as Error).message });
        }
      })
    );
    res.json({ ok: true, started: results.filter((r) => r.ok).length, total: agents.length, results });
  } catch {
    res.status(500).json({ error: "Failed to resume agents" });
  }
});

// Get all members (agents + humans) of a channel
channelRouter.get("/:id/members", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const [members, externalMembers] = await Promise.all([
      channelService.getChannelMembers(req.params.id),
      channelService.getChannelExternalMembers(req.params.id),
    ]);
    const viewerContext = await resolveChannelActorContext(
      req.serverId!,
      channel.id,
      "user",
      req.userId!,
    );
    const viewerCanChangeRoles = viewerContext
      ? channelActorHasCapability(viewerContext, "changeChannelMemberRoles")
      : false;
    const projectMemberRole = <T extends { id: string; serverRole?: string | null; role?: string | null; channelRole?: string | null }>(member: T) => {
      // Human roster rows historically expose the server role as `role`,
      // while Agent rows use `serverRole`. Normalize before projecting the
      // effective channel role; otherwise every human in #all appears to be a
      // plain Member even when they inherit Owner/Admin authority.
      const serverRole = member.serverRole ?? member.role ?? "member";
      return {
        ...member,
        serverRole,
        effectiveChannelRole: serverRole === "owner"
          ? "owner"
          : serverRole === "admin" || member.channelRole === "admin"
            ? "admin"
            : serverRole === "guest" ? "guest" : "member",
        channelAdminBasis: serverRole === "owner" || serverRole === "admin"
          ? member.channelRole === "admin" ? "both" : "server_role"
          : member.channelRole === "admin" ? "channel_role" : null,
        canChangeChannelRole: viewerCanChangeRoles
          && member.id !== req.userId
          && serverRole !== "owner"
          && serverRole !== "admin"
          && serverRole !== "guest",
      };
    };
    if (viewerContext?.serverRole === "guest") {
      res.json({
        agents: members.agents.map((agent) => ({
          id: agent.id,
          serverId: req.serverId,
          name: agent.name,
          displayName: agent.displayName,
          avatarUrl: agent.avatarUrl,
          status: agent.status,
          profileProjection: "channel_summary",
          effectiveChannelRole: "member",
          canChangeChannelRole: false,
        })),
        humans: members.humans.map((human) => ({
          id: human.id,
          name: human.name,
          displayName: human.displayName,
          avatarUrl: human.avatarUrl,
          gravatarHash: human.gravatarHash,
          effectiveChannelRole: human.role === "guest" ? "guest" : "member",
          canChangeChannelRole: false,
        })),
      });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const agents = await Promise.all(members.agents.map(async (agent) => {
      try {
        const { activity, activityDetail } = await agentOrchestrator.getActivity(agent.id);
        return projectMemberRole({ ...agent, activity, activityDetail });
      } catch {
        return projectMemberRole(agent);
      }
    }));
    const humans = members.humans.map(projectMemberRole);
    if (await shouldFilterChannelHumansForRequester(channel, req.userId!)) {
      res.json({
        ...members,
        agents,
        humans: humans.filter((human) => shouldExposeHumanInHiddenChannelDirectory(human, req.userId!)),
        externalMembers,
      });
      return;
    }
    res.json({ ...members, agents, humans, externalMembers });
  } catch {
    res.status(500).json({ error: "Failed to get members" });
  }
});

// Add a mixed batch of agents and humans to a channel. The whole target set is
// validated before the transaction, then membership rows and their durable
// system notices commit under one channel capability lock. Existing members
// are idempotent successes and are reported separately.
channelRouter.post("/:id/members/batch", async (req, res) => {
  try {
    const batch = parseChannelMemberBatch(req.body);
    if (!batch) {
      res.status(400).json({
        error: "userIds and agentIds must be arrays of UUIDs",
        code: "invalid_member_batch",
      });
      return;
    }
    if (batch.userIds.length === 0 && batch.agentIds.length === 0) {
      res.status(400).json({
        error: "At least one userId or agentId is required",
        code: "empty_member_batch",
      });
      return;
    }

    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canSee = await canSeeChannel(channel, req.userId!, req.serverId!);
    const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const canManageUnjoined = (channel.type === "channel" || channel.type === "private")
      && (requesterRole === "owner" || requesterRole === "admin");
    if (!canSee && !canManageUnjoined) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "thread") {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    if (channel.type === "dm") {
      if (!await channelService.isChannelHuman(channel.id, req.userId!)) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
    } else if (!(await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "addChannelMembers"))) {
      res.status(403).json({ error: "You do not have permission to add channel members" });
      return;
    }

    const [targetAgents, targetUsers] = await Promise.all([
      Promise.all(batch.agentIds.map((agentId) => agentService.getAgent(agentId))),
      Promise.all(batch.userIds.map(async (userId) => {
        const [role, user] = await Promise.all([
          getActorServerRoleInServer(req.serverId!, "user", userId),
          userService.getUser(userId),
        ]);
        return role && user ? user : null;
      })),
    ]);
    const invalidAgentIds = batch.agentIds.filter((_, index) => targetAgents[index]?.serverId !== req.serverId);
    if (invalidAgentIds.length > 0) {
      res.status(400).json({
        error: "One or more agents are not members of this server",
        code: "agents_not_in_server",
        invalidAgentIds,
      });
      return;
    }
    const invalidUserIds = batch.userIds.filter((_, index) => !targetUsers[index]);
    if (invalidUserIds.length > 0) {
      res.status(400).json({
        error: "One or more users are not members of this server",
        code: "users_not_in_server",
        invalidUserIds,
      });
      return;
    }

    const applyBatch = async (tx: DatabaseExecutor) => {
      const addedUserIds: string[] = [];
      const addedAgentIds: string[] = [];
      const userMessages = new Map<string, Awaited<ReturnType<typeof messageService.createMessage>>>();
      const agentMessages = new Map<string, Awaited<ReturnType<typeof messageService.createMessage>>>();

      for (let index = 0; index < batch.userIds.length; index += 1) {
        const userId = batch.userIds[index];
        const user = targetUsers[index];
        if (!userId || !user) throw new Error("User is not a member of this server");
        const result = await messageService.addHumanWithMembershipSystemMessage({
          channel,
          userId,
          userName: user.name,
          causalActor: { type: "user", id: req.userId! },
          executor: tx,
        });
        if (result.added) {
          addedUserIds.push(userId);
          if (result.message) userMessages.set(userId, result.message);
        }
      }
      for (let index = 0; index < batch.agentIds.length; index += 1) {
        const agentId = batch.agentIds[index];
        const agent = targetAgents[index];
        if (!agentId || !agent) throw new Error("Agent is not a member of this server");
        const result = await messageService.addAgentWithMembershipSystemMessage({
          channel,
          agentId,
          agentName: agent.name,
          causalActor: { type: "user", id: req.userId! },
          executor: tx,
        });
        if (result.added) {
          addedAgentIds.push(agentId);
          if (result.message) agentMessages.set(agentId, result.message);
        }
      }
      return { addedUserIds, addedAgentIds, userMessages, agentMessages };
    };

    const result = channel.type === "dm"
      ? await getDb().transaction(applyBatch)
      : await withLockedChannelActorCapability({
          serverId: req.serverId!,
          channelId: channel.id,
          actorType: "user",
          actorId: req.userId!,
          capability: "addChannelMembers",
        }, applyBatch);

    for (const userId of result.addedUserIds) {
      const user = targetUsers[batch.userIds.indexOf(userId)]!;
      await broadcastMembershipSystemMessage(
        req,
        channel,
        { type: "human", id: userId, name: user.name },
        "added",
        req.userId!,
        result.userMessages.get(userId),
      );
    }
    for (const agentId of result.addedAgentIds) {
      const agent = targetAgents[batch.agentIds.indexOf(agentId)]!;
      await broadcastMembershipSystemMessage(
        req,
        channel,
        { type: "agent", id: agentId, name: agent.name },
        "added",
        req.userId!,
        result.agentMessages.get(agentId),
      );
    }

    const io = req.app.get("io") as SocketServer | undefined;
    emitChannelMembersUpdated(io, req.serverId!, channel, result.addedUserIds);
    const addedUserIds = new Set(result.addedUserIds);
    const addedAgentIds = new Set(result.addedAgentIds);
    res.json({
      ok: true,
      added: {
        userIds: result.addedUserIds,
        agentIds: result.addedAgentIds,
      },
      alreadyMembers: {
        userIds: batch.userIds.filter((id) => !addedUserIds.has(id)),
        agentIds: batch.agentIds.filter((id) => !addedAgentIds.has(id)),
      },
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "Guest cannot be added to the #all channel") {
      res.status(403).json({ error: err.message });
    } else if (err instanceof Error && err.message === "Channel capability required") {
      res.status(403).json({ error: "You do not have permission to add channel members" });
    } else if (err instanceof Error && err.message === "Human is not a member of this channel's server") {
      res.status(400).json({ error: "One or more users are not members of this server", code: "users_not_in_server" });
    } else if (err instanceof Error && err.message === "Agent is not a member of this channel's server") {
      res.status(400).json({ error: "One or more agents are not members of this server", code: "agents_not_in_server" });
    } else {
      res.status(500).json({ error: "Failed to add channel members" });
    }
  }
});

// Add a member (agent or human) to a channel. Retained for older clients and
// single-row actions; multi-select clients should use /members/batch.
channelRouter.post("/:id/members", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canSee = await canSeeChannel(channel, req.userId!, req.serverId!);
    const requesterRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const canManageUnjoined = (channel.type === "channel" || channel.type === "private")
      && (requesterRole === "owner" || requesterRole === "admin");
    if (!canSee && !canManageUnjoined) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "thread") {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    // DMs retain participant semantics. Ordinary public/private channels use
    // the object-aware add policy; server owner/admin may therefore manage a
    // private channel without first joining it.
    if (channel.type === "dm") {
      const isParticipant = await channelService.isChannelHuman(channel.id, req.userId!);
      if (!isParticipant) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
    } else if (!(await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "addChannelMembers"))) {
      res.status(403).json({ error: "You do not have permission to add channel members" });
      return;
    }
    const { agentId, userId } = req.body;
    if (!agentId && !userId) {
      res.status(400).json({ error: "Either agentId or userId is required" });
      return;
    }
    if (agentId) {
      // Validate agent belongs to this server
      const agent = await agentService.getAgent(agentId);
      if (!agent || agent.serverId !== req.serverId) {
        res.status(400).json({ error: "Agent not found in this server" });
        return;
      }
      const wasAgentMember = await channelService.isChannelAgent(req.params.id, agentId);
      if (channel.type === "dm") {
        await channelService.addAgent(req.params.id, agentId);
      } else {
        await withLockedChannelActorCapability({
          serverId: req.serverId!,
          channelId: channel.id,
          actorType: "user",
          actorId: req.userId!,
          capability: "addChannelMembers",
        }, (tx) => channelService.addAgent(req.params.id, agentId, { executor: tx }));
      }
      if (!wasAgentMember) {
        await broadcastMembershipSystemMessage(req, channel, { type: "agent", ...agent }, "added", req.userId!);
      }
    } else {
      // Verify target user is a member of this server
      const targetRole = await getActorServerRoleInServer(req.serverId!, "user", userId);
      if (!targetRole) {
        res.status(400).json({ error: "User is not a member of this server" });
        return;
      }
      const targetUser = await userService.getUser(userId);
      if (!targetUser) {
        res.status(400).json({ error: "User is not a member of this server" });
        return;
      }
      const addHumanWithNotice = (executor?: Parameters<typeof messageService.addHumanWithMembershipSystemMessage>[0]["executor"]) =>
        messageService.addHumanWithMembershipSystemMessage({
          channel,
          userId,
          userName: targetUser.name,
          causalActor: { type: "user", id: req.userId! },
          executor,
        });
      const persisted = channel.type === "dm"
        ? await addHumanWithNotice()
        : await withLockedChannelActorCapability({
          serverId: req.serverId!,
          channelId: channel.id,
          actorType: "user",
          actorId: req.userId!,
          capability: "addChannelMembers",
        }, (tx) => addHumanWithNotice(tx));
      if (persisted.added) {
        await broadcastMembershipSystemMessage(
          req,
          channel,
          { type: "human", id: targetUser.id, name: targetUser.name },
          "added",
          req.userId!,
          persisted.message,
        );
      }
    }

    // Notify clients about membership change
    const io = req.app.get("io") as SocketServer | undefined;
    emitChannelMembersUpdated(io, req.serverId!, channel, userId);

    res.json({ ok: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "Guest cannot be added to the #all channel") {
      res.status(403).json({ error: err.message });
    } else if (err instanceof Error && err.message === "Channel capability required") {
      res.status(403).json({ error: "You do not have permission to add channel members" });
    } else {
      res.status(500).json({ error: "Failed to add member" });
    }
  }
});

// Human-only v1 surface for channel-local member/admin transitions. Agents can
// hold the role but intentionally have no Agent API/CLI/action-card entry.
channelRouter.patch("/:id/members/:targetType/:memberId/role", async (req, res) => {
  const targetType = req.params.targetType === "user" || req.params.targetType === "agent"
    ? req.params.targetType
    : null;
  const nextRole = req.body?.role === "member" || req.body?.role === "admin"
    ? req.body.role
    : null;
  if (!targetType || !nextRole) {
    res.status(400).json({ error: "targetType and role must be user|agent and member|admin" });
    return;
  }

  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const result = await channelService.changeChannelMembershipRole({
      serverId: req.serverId!,
      channelId: channel.id,
      requesterUserId: req.userId!,
      targetType,
      targetId: req.params.memberId,
      nextRole,
    });
    if (result.changed) {
      const io = req.app.get("io") as SocketServer | undefined;
      emitChannelMembersUpdated(io, req.serverId!, channel, targetType === "user" ? result.targetId : undefined);
      io?.to(targetType === "user" ? `user:${result.targetId}` : `agent:${result.targetId}`).emit(
        "channel:authority-updated",
        {
          channelId: channel.id,
          channelRole: result.channelRole,
          authorityRevision: result.authorityRevision,
        },
      );
      if (result.eventId) {
        try {
          await channelService.markChannelMembershipRoleEventDelivered(result.eventId);
        } catch (deliveryError) {
          // The role mutation and durable outbox row are already committed.
          // Leave the event pending for retry rather than turning a successful
          // authority change into an ambiguous HTTP 500.
          console.error("Failed to mark channel role event delivered:", deliveryError);
        }
      }
    }
    res.json(result);
  } catch (err) {
    if (err instanceof channelService.ChannelMembershipRoleMutationError) {
      if (err.code === "channel_not_found") {
        res.status(404).json({ error: err.message, code: err.code });
      } else if (err.code === "channel_capability_required" || err.code === "protected_server_role") {
        res.status(403).json({ error: err.message, code: err.code });
      } else if (err.code === "unsupported_channel_shape") {
        res.status(400).json({ error: err.message, code: err.code });
      } else {
        res.status(409).json({ error: err.message, code: err.code });
      }
      return;
    }
    console.error("Failed to change channel member role:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to change channel member role" });
  }
});

// Remove an agent member from a channel
channelRouter.delete("/:id/members/agent/:memberId", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "thread") {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.type === "dm") {
      const isParticipant = await channelService.isChannelHuman(channel.id, req.userId!);
      if (!isParticipant) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
    } else if (!(await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "removeChannelMembers"))) {
      res.status(403).json({ error: "Only admins can remove channel agents" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    assertAgentCanBeRemovedFromChannel(channel);
    const agent = await agentService.getAgent(req.params.memberId);
    const wasAgentMember = await channelService.isChannelAgent(req.params.id, req.params.memberId);
    if (wasAgentMember && agent && agent.serverId === req.serverId) {
      // Preserve the established audience ordering: the removed Agent must
      // receive the durable notice while its membership is still active.
      await broadcastMembershipSystemMessage(req, channel, { type: "agent", ...agent }, "removed", req.userId!);
    }
    if (channel.type === "dm") {
      await channelService.removeAgent(req.params.id, req.params.memberId);
    } else {
      await withLockedChannelActorCapability({
        serverId: req.serverId!,
        channelId: channel.id,
        actorType: "user",
        actorId: req.userId!,
        capability: "removeChannelMembers",
      }, (tx) => channelService.removeAgent(req.params.id, req.params.memberId, tx));
    }
    if (wasAgentMember && agent && agent.serverId === req.serverId && channel.type !== "channel") {
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      await agentOrchestrator.purgeAgentInboxForChannelTree(
        req.params.memberId,
        channel.id,
        "channel_membership_removed",
      );
    }

    // Notify clients about membership change
    const io = req.app.get("io") as SocketServer | undefined;
    emitChannelMembersUpdated(io, req.serverId!, channel);

    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("Cannot remove") || msg === "Channel capability required") {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to remove member" });
    }
  }
});

// Remove a human member from a channel
channelRouter.delete("/:id/members/user/:memberId", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "thread") {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.type === "dm") {
      // DMs: only participants can interact, and only remove self
      const isParticipant = await channelService.isChannelHuman(channel.id, req.userId!);
      if (!isParticipant) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      if (req.params.memberId !== req.userId) {
        res.status(403).json({ error: "Cannot remove other participants from a DM" });
        return;
      }
    } else if (!(await actorHasChannelCapability(req.serverId!, channel.id, "user", req.userId!, "removeChannelMembers"))) {
      res.status(403).json({ error: "Only admins can remove channel members" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    if (channel.type === "dm") {
      await channelService.removeHuman(req.params.id, req.params.memberId);
    } else {
      await withLockedChannelActorCapability({
        serverId: req.serverId!,
        channelId: channel.id,
        actorType: "user",
        actorId: req.userId!,
        capability: "removeChannelMembers",
      }, (tx) => channelService.removeHuman(req.params.id, req.params.memberId, tx));
      await revokeSocketAccess({ userId: req.params.memberId });
    }

    // Notify clients about membership change
    const io = req.app.get("io") as SocketServer | undefined;
    emitChannelMembersUpdated(io, req.serverId!, channel);

    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("Cannot remove") || msg === "Channel capability required") {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to remove member" });
    }
  }
});

// Join a channel (self)
channelRouter.post("/:id/join", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "thread") {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.type === "dm") {
      res.status(403).json({ error: "Cannot join DM channels" });
      return;
    }
    if (channel.type === "private") {
      res.status(403).json({ error: "Private channels require an invitation" });
      return;
    }
    if (channel.type === "joint") {
      res.status(403).json({ error: "Joint channels require an admin invitation" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    const actorRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const isGuest = actorRole === "guest";
    const alreadyMember = (!isGuest && channelService.isEnabledAllChannel(channel))
      || await channelService.isChannelHuman(channel.id, req.userId!);
    if (alreadyMember) {
      res.json({ ok: true });
      return;
    }
    if (isGuest) {
      const guestJoin = await channelService.addGuestHumanIfAllowed(channel.id, req.userId!);
      if (guestJoin === "forbidden") {
        res.status(403).json({ error: "Guest policy does not allow joining this channel" });
        return;
      }
      if (guestJoin === "joined") {
        const io = req.app.get("io");
        io?.to(`server:${req.serverId}`).emit("channel:members-updated", { channelId: req.params.id });
      }
      res.json({ ok: true });
      return;
    }
    if (!(await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "joinPublicChannels"))) {
      res.status(403).json({ error: "Server role cannot join public channels" });
      return;
    }
    await channelService.addHuman(req.params.id, req.userId!);

    const io = req.app.get("io");
    io?.to(`server:${req.serverId}`).emit("channel:members-updated", { channelId: req.params.id });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to join channel" });
  }
});

// Leave a channel (self)
channelRouter.post("/:id/leave", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!await canSeeChannel(channel, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "thread") {
      res.status(400).json({ error: "Thread membership is managed via follow/unfollow" });
      return;
    }
    if (channel.type === "dm") {
      res.status(403).json({ error: "Cannot leave DM channels" });
      return;
    }
    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    await channelService.removeHuman(req.params.id, req.userId!);

    const io = req.app.get("io");
    io?.to(`server:${req.serverId}`).emit("channel:members-updated", { channelId: req.params.id });

    res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("Cannot remove")) {
      res.status(403).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to leave channel" });
    }
  }
});

// Mark a channel as read
channelRouter.post("/:id/read", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "private" || channel.type === "joint" || channel.type === "dm") {
      const canAccess = await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!);
      if (!canAccess) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
    }
    const seq = Number(req.body.seq);
    if (!seq) {
      res.status(400).json({ error: "seq is required" });
      return;
    }
    const state = await channelService.markRead(req.userId!, channel.id, seq);
    emitReadStateUpdated(req, state);
    await emitScopeReadUpdated({
      io: req.app.get("io") as SocketServer | undefined,
      serverId: req.serverId!,
      scopeId: channel.id,
      peerKind: "human",
      peerId: req.userId!,
      maxReadSeq: state.maxReadSeq,
      changed: state.changed,
    });
    res.json({ ok: true, maxReadSeq: state.maxReadSeq, readStateVersion: state.readStateVersion });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    res.status(500).json({ error: "Failed to mark as read" });
  }
});

// Mark a channel as fully read
channelRouter.post("/:id/read-all", async (req, res) => {
  let receiver: ReadAllReceiver = { kind: "human", id: req.userId! };
  let delegationBasis: ReadStateDelegationBasis | null = null;
  try {
    const parsedReceiver = parseReadAllReceiver(req.body, req.userId!);
    if (!parsedReceiver.ok) {
      res.status(parsedReceiver.status).json({
        error: parsedReceiver.status === 403 ? "Read receiver is not authorized" : "Invalid read receiver",
      });
      return;
    }
    receiver = parsedReceiver.receiver;

    const channel = await channelService.getChannel(req.params.id)
      ?? await channelService.getChannel(req.params.id, { includeDeleted: true });
    const deletedInboxResidueRead = Boolean(channel?.deletedAt && channel.type !== "dm");
    if (
      !channel
      || channel.serverId !== req.serverId
      || (deletedInboxResidueRead && receiver.kind !== "human")
    ) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // Set when the caller cannot access the channel but the server's own records
    // show they once did. They are allowed to retire THEIR OWN residue -- that is
    // the usability half of task #48 -- but they must learn nothing about the
    // channel's present state, so this branch answers from receiver-owned values
    // only. See the receipt below.
    let residueOnlyRetire = false;
    if (
      receiver.kind === "human"
      && !deletedInboxResidueRead
      && (channel.type === "private" || channel.type === "joint" || channel.type === "dm")
    ) {
      const canAccess = await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!, { includeDeleted: true });
      if (!canAccess) {
        if (await channelService.hasPriorChannelRelationship(req.userId!, channel.id)) {
          residueOnlyRetire = true;
        } else {
          // Unchanged: a caller the server has no record of gets the same 404 a
          // missing id gets. This is what stops the usability fix from reopening
          // the existence oracle the privacy half closed.
          res.status(404).json({ error: "Channel not found" });
          return;
        }
      }
    }

    if (receiver.kind === "agent") {
      const agent = await agentService.getAgent(receiver.id);
      if (!agent || agent.serverId !== req.serverId) {
        res.status(404).json({ error: "Read receiver not found" });
        return;
      }
      const decision = await canHumanOperateAgentReadState(req.serverId!, req.userId!, agent);
      if (!decision.allowed) {
        addTraceEvent("channel_read_all.receiver.denied", {
          caller_kind: "human",
          caller_id: req.userId!,
          receiver_kind: receiver.kind,
          receiver_id: receiver.id,
          delegation_basis: null,
          scope_id: channel.id,
        });
        res.status(403).json({ error: "Read receiver is not authorized" });
        return;
      }
      delegationBasis = decision.basis;
    }

    addTraceEvent("channel_read_all.receiver.resolved", {
      caller_kind: "human",
      caller_id: req.userId!,
      receiver_kind: receiver.kind,
      receiver_id: receiver.id,
      delegation_basis: delegationBasis,
      scope_id: channel.id,
    });
    const state = await channelService.markReadLatest(receiver, channel.id);
    if (residueOnlyRetire) {
      // Return BEFORE the emits, and structurally rather than by remembering to
      // strip a field. `emitReadStateUpdated` pushes `maxReadSeq` straight to
      // room `user:<id>`, so restricting only the HTTP body would have been
      // cosmetic -- the caller would receive the channel's live frontier through
      // the socket instead. `emitScopeReadUpdated` is skipped for the same
      // reason and because a former member's read position is not something the
      // channel's remaining members' read-receipt UI should be told about.
      res.json(channelService.buildResidueOnlyReadAllReceipt(state));
      return;
    }
    if (receiver.kind === "human") emitReadStateUpdated(req, state);
    await emitScopeReadUpdated({
      io: req.app.get("io") as SocketServer | undefined,
      serverId: req.serverId!,
      scopeId: channel.id,
      peerKind: receiver.kind,
      peerId: receiver.id,
      maxReadSeq: state.maxReadSeq,
      changed: state.changed,
    });
    res.json({ ok: true, seq: state.maxReadSeq, readStateVersion: state.readStateVersion });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    if (err instanceof ReadMutationError && err.code === "SCOPE_NOT_FOUND") {
      addTraceEvent("channel_read_all.receiver.scope_rejected", {
        caller_kind: "human",
        caller_id: req.userId!,
        receiver_kind: receiver.kind,
        receiver_id: receiver.id,
        delegation_basis: delegationBasis,
        scope_id: req.params.id,
      });
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    res.status(500).json({ error: "Failed to mark as read" });
  }
});

// Mark a channel as unread
channelRouter.post("/:id/unread", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id)
      ?? await channelService.getChannel(req.params.id, { includeDeleted: true });
    if (!channel || channel.serverId !== req.serverId || (channel.deletedAt && channel.type !== "dm")) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (channel.type === "private" || channel.type === "joint" || channel.type === "dm" || channel.type === "thread") {
      const canAccess = await channelService.canUserAccessChannel(channel.id, req.userId!, req.serverId!, { includeDeleted: true });
      if (!canAccess) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
    }
    const state = await channelService.markUnread(req.userId!, channel.id);
    emitReadStateUpdated(req, state);
    res.json({ ok: true, unreadCount: state.unreadCount, maxReadSeq: state.maxReadSeq, readStateVersion: state.readStateVersion });
  } catch (err) {
    if (sendCompatibilityReadPending(res, err)) return;
    console.error("Failed to mark as unread:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to mark as unread" });
  }
});

// ── Thread routes ────────────────────────────────────────

// Create or get thread for a message, optionally post first reply
channelRouter.post("/:id/threads", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object"
      ? req.body as { parentMessageId?: unknown; content?: unknown }
      : {};
    const { parentMessageId, content } = body;
    if (typeof parentMessageId !== "string" || parentMessageId.trim() === "") {
      res.status(400).json({ error: "parentMessageId is required" });
      return;
    }

    // Verify the parent message belongs to this channel
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }

    // Access is established BEFORE the shape of the id is described. The nested-
    // thread 400 below used to run first, so a stranger probing an id learned
    // "this exists and is a thread" -- the same existence oracle the 403 was, just
    // through a different exit. Closing only the 403 would have left this door
    // open. Same ordering as the merged /threads/done split (`9566e1327`).
    const canAccess = await channelService.canUserAccessChannel(req.params.id, req.userId!, req.serverId!);
    if (!canAccess) {
      await denyChannelAccess(res, req.userId!, req.params.id, "Access denied");
      return;
    }

    // Prevent nested threads: cannot create a thread inside a thread channel.
    // Only reported to a caller who can already see the channel.
    if (channel.type === "thread") {
      res.status(400).json({ error: "Cannot create a thread inside a thread" });
      return;
    }

    if (channel.archivedAt) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }

    // Create or get thread. Joint parents return a server-local thread
    // projection while storing replies in the canonical thread channel.
    const thread = await channelService.getOrCreateThreadForChannel(req.params.id, parentMessageId, req.userId!, "user");

    // If content provided, post first reply
    if (content && typeof content === "string" && content.trim().length > 0) {
      const user = await userService.getUser(req.userId!);
      const senderName = user?.displayName || user?.name || "User";

      const io = req.app.get("io");
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      // slack-bridge-ordinary-message-producer: channels.first_thread_reply
      await messageService.broadcastAndDeliver(io, agentOrchestrator, {
        channelId: thread.id,
        senderType: "user",
        senderId: req.userId!,
        senderName,
        content,
      });
    }

    // Return thread info
    const info = await channelService.getThreadInfoForChannel(req.params.id, parentMessageId);
    res.json({ threadChannelId: thread.id, ...info });
  } catch (err: any) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    const msg = err?.message || "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
    } else {
      console.error("Failed to create thread:", serializeErrorForLog(err));
      res.status(500).json({ error: "Failed to create thread" });
    }
  }
});

// Get thread summaries for channel thread-parent messages.
//
// Preferred/current client behavior:
//   The web timeline sends parentMessageIds for the thread parents currently
//   loaded on screen. That keeps the participant/unread phases scoped to the
//   same window the user can inspect.
//
// Legacy/no-param compatibility behavior:
//   Older deployed clients call this route with no parentMessageIds and used
//   to trigger a full-channel thread summary fanout. For those clients only,
//   fall back to a bounded recent-parent window and tag traces as
//   parent_message_scope_source=compat_recent. This is deliberately a
//   compatibility escape hatch, not the long-term contract. Future cleanup:
//   when compat_recent disappears from production traces, make the parameter
//   required or remove the fallback.
channelRouter.get("/:id/threads", async (req, res) => {
  try {
    addTraceEvent("channel_threads.load.started");
    const channel = await tracePhase(
      () => channelService.getChannel(req.params.id),
      (durationMs, result) => ({
        name: "channel.loaded",
        attrs: {
          channel_found: Boolean(result),
          channel_type: result?.type ?? "missing",
          server_match: result?.serverId === req.serverId,
        },
      }),
    );
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }
    const canAccess = await tracePhase(
      () => channelService.canUserAccessChannel(req.params.id, req.userId!, req.serverId!),
      (durationMs, result) => ({
        name: "channel.access.checked",
        attrs: {
          allowed: result,
          channel_type: channel.type,
        },
      }),
    );
    if (!canAccess) {
      await denyChannelAccess(res, req.userId!, req.params.id, "Access denied");
      return;
    }

    const requestedParentMessageIds = parseThreadSummaryParentMessageIds(req.query.parentMessageIds);
    if (requestedParentMessageIds === null) {
      res.status(400).json({ error: "Invalid parentMessageIds" });
      return;
    }
    const parentMessageIds = requestedParentMessageIds ?? await channelService.listRecentThreadParentMessageIdsForChannelView(
      req.params.id,
      THREAD_SUMMARY_COMPAT_PARENT_IDS_LIMIT,
    );
    const parentMessageScopeSource = requestedParentMessageIds === undefined ? "compat_recent" : "client";

    const summaries = await tracePhase(
      () => channelService.getThreadSummaries(req.params.id, {
        userId: req.userId!,
        parentMessageIds,
        parentMessageScopeSource,
        traceQuery: createTraceDbQueryTracer("channel_threads.loaded"),
      }),
      (durationMs, result) => {
        const summaries = Object.values(result);
        return {
          name: "channel_threads.loaded",
          attrs: {
            thread_summaries_count: summaries.length,
            total_replies_count: summaries.reduce((sum, summary) => sum + summary.replyCount, 0),
            total_unread_replies_count: summaries.reduce((sum, summary) => sum + summary.unreadCount, 0),
            participant_links_count: summaries.reduce((sum, summary) => sum + summary.participantIds.length, 0),
            parent_message_scope_count: parentMessageIds.length,
            parent_message_scope_source: parentMessageScopeSource,
          },
        };
      },
    );
    addTraceEvent("response.ready", {
      thread_summaries_count: Object.keys(summaries).length,
      parent_message_scope_count: parentMessageIds.length,
      parent_message_scope_source: parentMessageScopeSource,
    });
    res.json(summaries);
  } catch {
    res.status(500).json({ error: "Failed to get thread summaries" });
  }
});

// Get thread info for a specific parent message
channelRouter.get("/:id/threads/:messageId", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.id);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(req.params.id, req.userId!, req.serverId!);
    if (!canAccess) {
      await denyChannelAccess(res, req.userId!, req.params.id, "Access denied");
      return;
    }

    const info = await channelService.getThreadInfoForChannel(req.params.id, req.params.messageId);
    if (!info) {
      res.status(404).json({ error: "No thread found for this message" });
      return;
    }
    res.json(info);
  } catch {
    res.status(500).json({ error: "Failed to get thread info" });
  }
});
