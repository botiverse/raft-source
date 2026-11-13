// GET /api/sync/changes: incremental client sync (contract: packages/shared
// syncChanges.ts; read algorithm: services/syncChanges.ts). Humans only.
//
// Each upsert's row is rebuilt here, now, for this viewer, by the builder of
// its list endpoint, so a synced row is byte-for-byte the list row:
//   channel        GET /api/channels (listHumanChannelItems), then
//                  GET /api/channels/dm (listDMChannels) for DMs;
//   channel_member GET /api/channels/:id/members (buildChannelMembersView);
//   server_member  GET /api/servers/:id/members (listServerMemberDirectory);
//   agent          GET /api/agents (buildAgentListItems);
//   machine        GET /api/servers/:id/machines (buildMachineList), viewMachines only;
//   sidebar_order  GET /api/servers/:id/sidebar-order (loadSidebarOrderResponse);
//   server_order   GET /api/servers/order (getServerSwitcherOrder);
//   message        GET /api/messages/channel/:id's row for one message
//                  (readVisibleMessageRow: that list's access and read).
// Not in the list for this viewer (deleted, archived, no longer visible):
// the change goes out as a delete.
import { Router, type Router as RouterType } from "express";
import { inArray } from "drizzle-orm";
import {
  isSubConversationType,
  SYNC_SNAPSHOT_NAMES,
  type SyncChange,
  type SyncChangesResponse,
  type ServerRole,
  type SyncSnapshotName,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channels } from "../db/schema";
import * as channelService from "../services/channelService";
import * as serverService from "../services/serverService";
import { listHumanChannelItems } from "../services/channelListItems";
import {
  parseSyncChangesCursor,
  readSyncChanges,
  SYNC_CHANGES_DEFAULT_LIMIT,
  SYNC_CHANGES_MAX_LIMIT,
  type PendingRowChange,
  type PendingSyncChange,
  type SyncViewer,
} from "../services/syncChanges";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import { actorRoleHasServerCapability, getActorServerRoleInServer } from "../lib/actorPermissions";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { addTraceEvent, createTraceDbQueryTracer, withTraceChildSpan } from "../tracing/semanticTrace";
import { evaluateFeatureFlag, SYNC_CHANGES_API_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { cachedServerFlagAnswers } from "../services/featureFlagReadCache";
import { sendJsonServerError } from "./errorResponse";
import { refuse } from "../lib/refusal";
import { buildChannelMembersView } from "./channels";
import { buildAgentListItems } from "./agents";
import { buildMachineList, loadSidebarOrderResponse } from "./servers";
import { readVisibleMessageRow } from "./messages";

export const syncRouter: RouterType = Router();

type Viewer = SyncViewer;

const LIMIT_RE = /^[0-9]{1,9}$/;

/** id -> row for the upserts of one entity; an id missing from the map is a delete. */
type RowsById = Map<string, object>;

async function buildChannelRows(viewer: Viewer, ids: string[]): Promise<RowsById> {
  const rows: RowsById = new Map();
  if (ids.length === 0) return rows;
  for (const item of await listHumanChannelItems(viewer.serverId, viewer.userId, { channelIds: ids })) rows.set(item.id, item);
  const notListed = ids.filter((id) => !rows.has(id));
  if (notListed.length === 0) return rows;
  for (const dm of await channelService.listDMChannels(viewer.serverId, viewer.userId, { channelIds: notListed })) rows.set(dm.id, dm);
  return rows;
}

/**
 * Of the channel ids no list carries, the threads and task conversations:
 * neither list ever holds them, so their changes are not channel list
 * changes (their state travels as `conversation`) and are left out.
 */
async function subConversationIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb().select({ id: channels.id, type: channels.type }).from(channels).where(inArray(channels.id, ids));
  return new Set(rows.filter((row) => isSubConversationType(row.type)).map((row) => row.id));
}

/** Channels whose member rows are rebuilt at once (each reads its own roster). */
const MEMBER_CHANNEL_CONCURRENCY = 4;

/**
 * Member rows by change id (`<channelId>:<user|agent>:<id>`) of the channels
 * in `accessible`: one roster read per channel, narrowed to the changed
 * members, a few channels at a time.
 */
async function buildChannelMemberRows(viewer: Viewer, ids: string[], accessible: ReadonlySet<string>, agentOrchestrator: AgentOrchestrator): Promise<RowsById> {
  const rows: RowsById = new Map();
  const byChannel = new Map<string, { userIds: string[]; agentIds: string[] }>();
  for (const id of ids) {
    const [channelId, kind, memberId] = id.split(":");
    if (!channelId || !memberId || (kind !== "user" && kind !== "agent")) continue;
    const only = byChannel.get(channelId) ?? { userIds: [], agentIds: [] };
    (kind === "user" ? only.userIds : only.agentIds).push(memberId);
    byChannel.set(channelId, only);
  }
  await mapWithConcurrency([...byChannel].filter(([channelId]) => accessible.has(channelId)), MEMBER_CHANNEL_CONCURRENCY, async ([channelId, only]) => {
    const channel = await channelService.getChannel(channelId);
    if (!channel || channel.serverId !== viewer.serverId) return;
    const view = await buildChannelMembersView(channel, viewer, agentOrchestrator, only);
    for (const human of view.humans) rows.set(`${channelId}:user:${human.id}`, human);
    for (const agent of view.agents) rows.set(`${channelId}:agent:${agent.id}`, agent);
  });
  return rows;
}

async function buildServerMemberRows(viewer: Viewer, ids: string[]): Promise<RowsById> {
  const members = await channelService.withVisibleGuestChannels(
    viewer.serverId,
    viewer.userId,
    await serverService.listServerMemberDirectory(viewer.serverId, viewer.userId, { userIds: ids }),
  );
  return new Map(members.map((member) => [member.userId, member]));
}

async function buildAgentRows(viewer: Viewer, ids: string[], agentOrchestrator: AgentOrchestrator): Promise<RowsById> {
  const { agents } = await buildAgentListItems({ ...viewer, agentOrchestrator, agentIds: ids });
  return new Map(agents.map((agent) => [String(agent.id), agent]));
}

async function buildMachineRows(viewer: Viewer, ids: string[], deps: RowDeps): Promise<RowsById> {
  const { body } = await buildMachineList({ ...viewer, ...deps, machineIds: ids });
  return new Map(body.machines.map((machine) => [machine.id, machine]));
}

/** The sidebar_order row (id = this server) and the server_order row (id = the viewer). */
async function buildOrderRows(viewer: Viewer, entity: "sidebar_order" | "server_order", ids: string[]): Promise<RowsById> {
  const rows: RowsById = new Map();
  if (entity === "sidebar_order" && ids.includes(viewer.serverId)) {
    const order = await loadSidebarOrderResponse(viewer.serverId, viewer.userId);
    if (order) rows.set(viewer.serverId, order);
  }
  if (entity === "server_order" && ids.includes(viewer.userId)) {
    rows.set(viewer.userId, await serverService.getServerSwitcherOrder(viewer.userId));
  }
  return rows;
}

/** Messages rebuilt at once (each runs its own access check and read). */
const MESSAGE_ROW_CONCURRENCY = 4;

/**
 * Message rows (RFC 082 §4.4), each the viewer's message list row, through
 * that list's access: one the viewer cannot read (its conversation, the plan's
 * history window) is left out, so its change is dropped.
 */
async function buildMessageRows(viewer: Viewer, ids: string[]): Promise<RowsById> {
  const rows: RowsById = new Map();
  await mapWithConcurrency(ids, MESSAGE_ROW_CONCURRENCY, async (id) => {
    const row = await readVisibleMessageRow(id, viewer.userId, viewer.serverId);
    if (row) rows.set(id, row);
  });
  return rows;
}

type RowDeps = { agentOrchestrator: AgentOrchestrator; app: { get(name: string): unknown } };

/**
 * What this viewer's list endpoints refuse them: those entities' changes are
 * not delivered at all (no upsert, no delete, so no id leaks), and those
 * snapshots leave every snapshot list. Guests have no server member list;
 * machines need `viewMachines`.
 */
type Refusals = { entities: ReadonlySet<PendingRowChange["entity"]>; snapshots: ReadonlySet<SyncSnapshotName> };

function viewerRefusals(role: ServerRole | null): Refusals {
  const entities = new Set<PendingRowChange["entity"]>();
  const snapshots = new Set<SyncSnapshotName>();
  if (role === "guest") { entities.add("server_member"); snapshots.add("server_members"); }
  if (!actorRoleHasServerCapability(role, "viewMachines")) { entities.add("machine"); snapshots.add("machines"); }
  return { entities, snapshots };
}

/**
 * Whether a hard delete (change_log op delete) of a server-wide entity may go
 * to this viewer: never one they could not have been shown. A guest sees only
 * the agents of their channels, so no agent deletes; in a server hiding its
 * human directory from them, only their own member row.
 */
function deliversServerWideDelete(change: PendingRowChange, viewer: Viewer, hideHumanDirectory: boolean): boolean {
  if (change.entity === "agent") return !viewer.isGuest;
  if (change.entity === "server_member") return !hideHumanDirectory || change.id === viewer.userId;
  return true;
}

function allowedSnapshots(names: readonly SyncSnapshotName[], refusals: Refusals): SyncSnapshotName[] {
  return names.filter((name) => !refusals.snapshots.has(name));
}

const NO_ROWS: RowsById = new Map();

async function buildChanges(viewer: Viewer, pending: readonly PendingSyncChange[], deps: RowDeps, refusals: Refusals): Promise<SyncChange[]> {
  const refused = refusals.entities;
  const upserts = (entity: PendingRowChange["entity"]) => refused.has(entity) ? [] : pending
    .filter((change): change is PendingRowChange => change.entity === entity && change.op === "upsert")
    .map((change) => change.id);
  const build = (ids: string[], work: (ids: string[]) => Promise<RowsById>) => ids.length > 0 ? work(ids) : Promise.resolve(NO_ROWS);
  const channelIds = upserts("channel");
  // Member changes of a channel the viewer cannot access are dropped (one
  // batched check for every channel they name).
  const memberChannelIds = [...new Set(pending.filter((change) => change.entity === "channel_member").map((change) => change.id.split(":")[0]!))];
  const accessibleMemberChannels = memberChannelIds.length > 0
    ? await channelService.filterUserAccessibleChannelIds(memberChannelIds, viewer.userId, viewer.serverId)
    : new Set<string>();
  const [channel, channelMember, serverMember, agent, machine, sidebarOrder, serverOrder, message] = await Promise.all([
    build(channelIds, (ids) => buildChannelRows(viewer, ids)),
    build(upserts("channel_member"), (ids) => buildChannelMemberRows(viewer, ids, accessibleMemberChannels, deps.agentOrchestrator)),
    build(upserts("server_member"), (ids) => buildServerMemberRows(viewer, ids)),
    build(upserts("agent"), (ids) => buildAgentRows(viewer, ids, deps.agentOrchestrator)),
    build(upserts("machine"), (ids) => buildMachineRows(viewer, ids, deps)),
    build(upserts("sidebar_order"), (ids) => buildOrderRows(viewer, "sidebar_order", ids)),
    build(upserts("server_order"), (ids) => buildOrderRows(viewer, "server_order", ids)),
    build(upserts("message"), (ids) => buildMessageRows(viewer, ids)),
  ]);
  const channelDeleteIds = pending
    .filter((change) => change.entity === "channel" && change.op === "delete")
    .map((change) => change.id);
  const [skippedChannels, hideHumanDirectory] = await Promise.all([
    subConversationIds([...channelIds.filter((id) => !channel.has(id)), ...channelDeleteIds]),
    pending.some((change) => change.entity === "server_member" && change.op === "delete")
      ? serverService.shouldHideHumanDirectoryFromRequester(viewer.serverId, viewer.userId)
      : Promise.resolve(false),
  ]);

  const rowsFor: Record<PendingRowChange["entity"], RowsById> = {
    channel,
    channel_member: channelMember,
    server_member: serverMember,
    agent,
    machine,
    sidebar_order: sidebarOrder,
    server_order: serverOrder,
    message,
  };

  const changes: SyncChange[] = [];
  for (const change of pending) {
    if (change.entity === "conversation") {
      changes.push(change);
      continue;
    }
    if (change.entity === "scope") {
      changes.push({ ...change, snapshots: allowedSnapshots(change.snapshots, refusals) });
      continue;
    }
    if (refused.has(change.entity)) continue;
    if (change.entity === "channel" && skippedChannels.has(change.id)) continue;
    if (change.entity === "channel_member" && !accessibleMemberChannels.has(change.id.split(":")[0]!)) continue;
    if (change.op === "delete") {
      if (change.ifMissing === "drop" && !deliversServerWideDelete(change, viewer, hideHumanDirectory)) continue;
      changes.push({ seq: change.seq, entity: change.entity, id: change.id, op: "delete" });
      continue;
    }
    const row = rowsFor[change.entity].get(change.id);
    if (row) changes.push({ seq: change.seq, entity: change.entity, id: change.id, op: "upsert", row });
    else if (change.ifMissing === "delete") changes.push({ seq: change.seq, entity: change.entity, id: change.id, op: "delete" });
  }
  return changes;
}

/**
 * SYNC_CHANGES_API_FEATURE_FLAG_KEY: false only when the flag is killed or
 * turned off for this server. Absent, any other answer, or a failed read: served.
 */
async function syncChangesServed(serverId: string): Promise<boolean> {
  try {
    // The cache only asks for what it was given: this one server.
    const [served] = await cachedServerFlagAnswers([serverId], SYNC_CHANGES_API_FEATURE_FLAG_KEY, async () => {
      const evaluation = await evaluateFeatureFlag({ key: SYNC_CHANGES_API_FEATURE_FLAG_KEY, serverId });
      return [evaluation.reason !== "kill_switch" && evaluation.reason !== "flag_disabled"];
    });
    return served !== false;
  } catch {
    return true;
  }
}

// GET /api/sync/changes?since=<cursor>&limit=<n>
// No `since`: the current cursor and no changes (snapshot, then pull from it).
syncRouter.get("/changes", async (req, res) => {
  try {
    if (!await syncChangesServed(req.serverId!)) {
      addTraceEvent("sync.changes.rejected", { reason: "switched_off" });
      refuse(res, 404, { code: "sync_changes_off", error: "Incremental sync is off on this server; reload the lists instead." });
      return;
    }
    const rawSince = req.query.since;
    const since = rawSince === undefined ? null : parseSyncChangesCursor(rawSince);
    if (rawSince !== undefined && !since) {
      addTraceEvent("sync.changes.rejected", { reason: "invalid_cursor" });
      res.status(400).json({ error: "since must be a cursor this endpoint returned", code: "invalid_cursor" });
      return;
    }
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && (typeof rawLimit !== "string" || !LIMIT_RE.test(rawLimit))) {
      res.status(400).json({ error: "limit must be a positive integer", code: "invalid_limit" });
      return;
    }
    const limit = rawLimit === undefined
      ? SYNC_CHANGES_DEFAULT_LIMIT
      : Math.min(Math.max(Number(rawLimit), 1), SYNC_CHANGES_MAX_LIMIT);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const body = await withTraceChildSpan(
      "server.sync.changes.read",
      { surface: "server", kind: "internal", attrs: { since_present: Boolean(since), limit } },
      async (): Promise<SyncChangesResponse & { stats: Awaited<ReturnType<typeof readSyncChanges>>["stats"] }> => {
        // Inside the span: its time and failures are the read's.
        const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
        const viewer: Viewer = { userId: req.userId!, serverId: req.serverId!, isGuest: role === "guest" };
        const refusals = viewerRefusals(role);
        const read = await readSyncChanges({ viewer, since, limit, traceQuery: createTraceDbQueryTracer("sync.changes.read") });
        return {
          cursor: read.cursor,
          hasMore: read.hasMore,
          changes: read.changes.length > 0 ? await buildChanges(viewer, read.changes, { agentOrchestrator, app: req.app }, refusals) : [],
          reset: read.reset ? { reason: read.reset, snapshots: allowedSnapshots(SYNC_SNAPSHOT_NAMES, refusals) } : null,
          stats: read.stats,
        };
      },
      {
        onSuccess: (result) => ({
          rows_scanned: result.stats.rowsScanned,
          late_rows: result.stats.lateRows,
          skipped_rows: result.stats.skippedRows,
          changes_count: result.changes.length,
          has_more: result.hasMore,
          ...(result.reset ? { reset_reason: result.reset.reason } : {}),
          ...(result.stats.horizonLag === null ? {} : { horizon_lag: result.stats.horizonLag }),
        }),
      },
    );
    const { stats: _stats, ...response } = body;
    res.json(response satisfies SyncChangesResponse);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read sync changes",
      logPrefix: "Failed to read sync changes:",
      err,
    });
  }
});
