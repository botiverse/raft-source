import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import type {
  ActivityFilter,
  ActivityRowTombstone,
  ActivityScope,
  ActivityWindow,
  ChannelActivityRow,
  DifferenceIngress,
  DmActivityRow,
  NotModifiedIngress,
  SnapshotIngress,
  SnapshotRequiredBody,
  ThreadActivityRow,
  TombstoneReason,
} from "@botiverse/raft-sync-core";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  activitySyncChanges,
  activitySyncPrincipalAuthorities,
  activitySyncRowAuthorities,
  activitySyncRows,
  activitySyncScopes,
  channels,
  threadFollows,
  userChannelInboxStates,
  userChannelReadCursors,
} from "../db/schema.js";
import {
  getInboxItems,
  type InboxFilter,
  type InboxItem,
} from "./channelService.js";

const WINDOW_ID = "main";
const MAIN_WINDOW_SIZE = 100;
const CHANGE_RETENTION = 2048;
const SERIALIZATION_ATTEMPTS = 3;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

export type ActivityExactMutationForTest =
  | "principalRowVersion"
  | "rowAuthorityVersion"
  | "scopeEpoch"
  | "scopeWatermark"
  | "scopeRowVersion"
  | "changeSeq"
  | "changeRowVersion"
  | "maxReadSeq"
  | "readStateVersion"
  | "wireNumber";

let exactMutationForTest: ActivityExactMutationForTest | null = null;

export type ActivitySyncRuntime = {
  now(): Date;
  createId(): string;
};

type ActivitySyncTestHooks = {
  beforePrincipalAuthorityInsert?(executor: DatabaseExecutor): Promise<void>;
  beforePrincipalAuthorityLock?(executor: DatabaseExecutor): Promise<void>;
  onTransactionAttemptStart?(attempt: number): void;
  onSerializationFailure?(sqlState: string | null, attempt: number): void;
  onSerializationRetry?(attempt: number): void;
  disableSerializationRetry?: boolean;
};

let activitySyncTestHooks: ActivitySyncTestHooks | null = null;

export function setActivitySyncTestHooksForTest(hooks: ActivitySyncTestHooks | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Activity sync hooks are test-only");
  }
  activitySyncTestHooks = hooks;
}

export function setActivityExactMutationForTest(
  mutation: ActivityExactMutationForTest | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Activity exactness mutation hook is test-only");
  }
  exactMutationForTest = mutation;
}

type ActivityRow = ChannelActivityRow | DmActivityRow | ThreadActivityRow;
type WithoutRowVersion<T> = T extends { rowVersion: string } ? Omit<T, "rowVersion"> : never;
type ActivityRowPayload = WithoutRowVersion<ActivityRow>;
type ScopeMetadata = Pick<
  ActivityWindow,
  "nextCursor" | "hasMore" | "complete" | "totalCount" | "totalUnreadCount"
>;

type ScopeKey = {
  serverId: string;
  principalId: string;
  filter: ActivityFilter;
};

type ReconcileOptions = ScopeKey & {
  historyCutoff?: Date;
  humanActivityMuteEnabled?: boolean;
  /** Test-only rollback tooth; routes never pass this. */
  failAfterReconcileForTest?: boolean;
};

type ReconciledScope = {
  scope: ActivityScope;
  epoch: bigint;
  watermark: bigint;
  window: ActivityWindow;
};

export type ActivityDifferenceResult =
  | { status: 200; body: DifferenceIngress | NotModifiedIngress }
  | { status: 409; body: SnapshotRequiredBody };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const fields = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${fields.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Exact DB acquisition boundary. Every authority int8 is selected as
 * PostgreSQL text before it reaches JavaScript; accepting a number here would
 * re-open the node-postgres/PGlite driver mismatch above 2^53.
 */
export function exactDatabaseInt8(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value)) {
    throw new Error(`${field} must arrive from PostgreSQL as canonical decimal text`);
  }
  return BigInt(value);
}

function exactText(column: SQLWrapper, field: ActivityExactMutationForTest) {
  return exactMutationForTest === field
    ? sql<unknown>`${column}`
    : sql<string>`${column}::text`;
}

function decimalText(value: bigint): string {
  return value.toString(10);
}

function exactWire(value: bigint): string {
  if (exactMutationForTest === "wireNumber") {
    return Number(value) as unknown as string;
  }
  return decimalText(value);
}

function sqlState(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function actorKind(value: string): "user" | "agent" | "system" | "external_projection" {
  if (value === "user" || value === "agent" || value === "system" || value === "external_projection") return value;
  throw new Error(`Unsupported Activity actor kind: ${value}`);
}

function parentActorKind(value: string): "user" | "agent" | "external_projection" {
  if (value === "user" || value === "agent" || value === "external_projection") return value;
  throw new Error(`Unsupported Activity thread parent actor kind: ${value}`);
}

function channelKind(value: string): "channel" | "private" | "joint" | "dm" {
  if (value === "channel" || value === "private" || value === "joint" || value === "dm") {
    return value;
  }
  throw new Error(`Unsupported Activity channel kind: ${value}`);
}

function scopeIdOf(item: InboxItem): string {
  return item.kind === "thread" ? item.threadChannelId : item.channelId;
}

async function exactReadStateByScope(
  executor: DatabaseExecutor,
  principalId: string,
  items: readonly InboxItem[],
): Promise<Map<string, { maxReadSeq: string; readStateVersion: string }>> {
  const scopeIds = [...new Set(items.map(scopeIdOf))];
  if (scopeIds.length === 0) return new Map();
  const rows = await executor
    .select({
      channelId: userChannelReadCursors.channelId,
      maxReadSeq: exactText(userChannelReadCursors.lastReadSeq, "maxReadSeq"),
      readStateVersion: exactText(userChannelReadCursors.readStateVersion, "readStateVersion"),
    })
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, principalId),
      inArray(userChannelReadCursors.channelId, scopeIds),
    ));
  return new Map(rows.map((row) => [
    row.channelId,
    {
      maxReadSeq: decimalText(exactDatabaseInt8(
        row.maxReadSeq,
        "user_channel_read_cursors.last_read_seq",
      )),
      readStateVersion: decimalText(exactDatabaseInt8(
        row.readStateVersion,
        "user_channel_read_cursors.read_state_version",
      )),
    },
  ]));
}

function requireLatestActivitySeq(item: InboxItem, rowId: string): string {
  const seq = item.latestActivitySeq;
  // RW join-miss without a provable canonical-PG fallback yields null/empty; a
  // fabricated "0" or a non-canonical decimal is equally invalid (message seqs
  // are positive canonical decimals). Fail closed with a hard reject BEFORE
  // ActivityRowPayload serialization — never fabricate "0" and never silently
  // drop the row (赵梓淇 freeze condition). The canonical-PG fallback supplies a
  // real seq when the RW serving join misses; reaching here means neither path
  // proved a frontier.
  if (
    seq == null
    || typeof seq !== "string"
    || seq === ""
    || seq === "0"
    || !/^[1-9][0-9]*$/.test(seq)
  ) {
    throw new Error(
      `Activity row ${rowId} has no provable latestActivitySeq (join-miss without canonical fallback)`,
    );
  }
  return seq;
}

function normalizeRow(
  item: InboxItem,
  readStates: ReadonlyMap<string, { maxReadSeq: string; readStateVersion: string }>,
): ActivityRowPayload {
  const rowId = scopeIdOf(item);
  const readState = readStates.get(rowId) ?? { maxReadSeq: "0", readStateVersion: "0" };
  if (item.kind === "thread") {
    return {
      type: "thread",
      rowId,
      threadChannelId: item.threadChannelId,
      parentMessageId: item.parentMessageId,
      parentChannelId: item.parentChannelId,
      parentChannelName: item.parentChannelName,
      parentChannelKind: channelKind(item.parentChannelType),
      parentMessagePreview: item.parentMessagePreview,
      parentMessageSenderKind: parentActorKind(item.parentMessageSenderType),
      parentMessageSenderId: item.parentMessageSenderId,
      latestActivityPreview: item.latestActivityPreview,
      latestActivitySenderKind: actorKind(item.latestActivitySenderType),
      latestActivitySenderId: item.latestActivitySenderId,
      latestActivitySenderName: item.latestActivitySenderName,
      latestActivityMessageId: item.latestActivityMessageId,
      isFollowing: item.isFollowing !== false,
      latestActivitySeq: requireLatestActivitySeq(item, rowId),
      firstUnreadMessageId: item.firstUnreadMessageId,
      firstMentionMessageId: item.firstMentionMessageId,
      lastActivityAt: item.lastActivityAt,
      lastReplyAt: item.lastReplyAt,
      replyCount: item.replyCount,
      unreadCount: item.unreadCount,
      hasMention: item.hasMention,
      taskNumber: item.taskNumber,
      taskStatus: item.taskStatus,
      taskClaimedByName: item.taskClaimedByName,
      maxReadSeq: readState.maxReadSeq,
      readStateVersion: readState.readStateVersion,
    };
  }
  const common = {
    rowId,
    channelId: item.channelId,
    channelName: item.channelName,
    lastMessageId: item.lastMessageId,
    latestActivitySeq: requireLatestActivitySeq(item, rowId),
    firstUnreadMessageId: item.firstUnreadMessageId,
    firstMentionMessageId: item.firstMentionMessageId,
    lastActivityAt: item.lastMessageAt,
    lastMessagePreview: item.lastMessagePreview,
    lastMessageSenderKind: actorKind(item.lastMessageSenderType),
    lastMessageSenderId: item.lastMessageSenderId,
    lastMessageSenderName: item.lastMessageSenderName,
    unreadCount: item.unreadCount,
    hasMention: item.hasMention,
    maxReadSeq: readState.maxReadSeq,
    readStateVersion: readState.readStateVersion,
  };
  if (item.kind === "dm") {
    if (item.channelType !== "dm") throw new Error("DM Activity row must have channelType=dm");
    return { ...common, type: "dm", channelKind: "dm" };
  }
  const kind = channelKind(item.channelType);
  if (kind === "dm") throw new Error("Channel Activity row cannot have channelType=dm");
  return { ...common, type: "channel", channelKind: kind };
}

async function readCanonicalWindow(
  executor: DatabaseExecutor,
  input: ReconcileOptions,
): Promise<{ rows: ActivityRowPayload[]; metadata: ScopeMetadata }> {
  const page = await getInboxItems(input.serverId, input.principalId, {
    filter: input.filter as InboxFilter,
    limit: MAIN_WINDOW_SIZE,
    offset: 0,
    sort: "desc",
    historyCutoff: input.historyCutoff,
    humanActivityMuteEnabled: input.humanActivityMuteEnabled,
    executor,
    forcePostgres: true,
    forceCanonicalPostgres: true,
    includeUnfollowedThreads: input.filter === "all",
  });
  const readStates = await exactReadStateByScope(executor, input.principalId, page.items);
  return {
    rows: page.items.map((item) => normalizeRow(item, readStates)),
    metadata: {
      nextCursor: page.hasMore ? String(MAIN_WINDOW_SIZE) : null,
      hasMore: page.hasMore,
      complete: !page.hasMore,
      totalCount: page.totalCount,
      totalUnreadCount: page.totalUnreadCount,
    },
  };
}

async function tombstoneReasons(
  executor: DatabaseExecutor,
  principalId: string,
  rows: readonly { rowId: string }[],
): Promise<Map<string, TombstoneReason>> {
  const rowIds = rows.map((row) => row.rowId);
  if (rowIds.length === 0) return new Map();
  const [doneChannels, doneThreads, channelRows] = await Promise.all([
    executor
      .select({ rowId: userChannelInboxStates.channelId })
      .from(userChannelInboxStates)
      .where(and(
        eq(userChannelInboxStates.userId, principalId),
        inArray(userChannelInboxStates.channelId, rowIds),
        sql`${userChannelInboxStates.doneAt} IS NOT NULL`,
      )),
    executor
      .select({ rowId: threadFollows.threadChannelId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, principalId),
        inArray(threadFollows.threadChannelId, rowIds),
        sql`${threadFollows.doneAt} IS NOT NULL`,
      )),
    executor
      .select({ rowId: channels.id, deletedAt: channels.deletedAt })
      .from(channels)
      .where(inArray(channels.id, rowIds)),
  ]);
  const done = new Set([...doneChannels, ...doneThreads].map((row) => row.rowId));
  const channelsById = new Map(channelRows.map((row) => [row.rowId, row]));
  return new Map(rowIds.map((rowId) => {
    if (done.has(rowId)) return [rowId, "done" as const];
    const channel = channelsById.get(rowId);
    if (!channel || channel.deletedAt) return [rowId, "deleted" as const];
    return [rowId, "outOfWindow" as const];
  }));
}

function scopeWhere(input: ScopeKey) {
  return and(
    eq(activitySyncScopes.serverId, input.serverId),
    eq(activitySyncScopes.principalId, input.principalId),
    eq(activitySyncScopes.filter, input.filter),
    eq(activitySyncScopes.windowId, WINDOW_ID),
  );
}

function rowScopeWhere(input: ScopeKey) {
  return and(
    eq(activitySyncRows.serverId, input.serverId),
    eq(activitySyncRows.principalId, input.principalId),
    eq(activitySyncRows.filter, input.filter),
    eq(activitySyncRows.windowId, WINDOW_ID),
  );
}

function changeScopeWhere(input: ScopeKey) {
  return and(
    eq(activitySyncChanges.serverId, input.serverId),
    eq(activitySyncChanges.principalId, input.principalId),
    eq(activitySyncChanges.filter, input.filter),
    eq(activitySyncChanges.windowId, WINDOW_ID),
  );
}

async function nextRowVersion(
  executor: DatabaseExecutor,
  input: ScopeKey,
  current: bigint,
  now: Date,
): Promise<bigint> {
  const next = current + 1n;
  await executor
    .update(activitySyncPrincipalAuthorities)
    .set({ rowVersion: next, updatedAt: now })
    .where(and(
      eq(activitySyncPrincipalAuthorities.serverId, input.serverId),
      eq(activitySyncPrincipalAuthorities.principalId, input.principalId),
    ));
  return next;
}

async function materializeWindow(
  executor: DatabaseExecutor,
  input: ScopeKey,
  epoch: bigint,
  watermark: bigint,
): Promise<ActivityWindow> {
  const rawRows = await executor
    .select({
      rowId: activitySyncRows.rowId,
      rowVersionText: exactText(activitySyncRows.rowVersion, "scopeRowVersion"),
      active: activitySyncRows.active,
      payload: activitySyncRows.payload,
      tombstoneReason: activitySyncRows.tombstoneReason,
    })
    .from(activitySyncRows)
    .where(rowScopeWhere(input))
    .orderBy(asc(activitySyncRows.rowId));
  const rows = rawRows.map((row) => ({
    ...row,
    rowVersion: exactDatabaseInt8(row.rowVersionText, "activity_sync_rows.row_version"),
  }));
  const rawScope = (await executor
    .select({
      epochText: exactText(activitySyncScopes.epoch, "scopeEpoch"),
      watermarkText: exactText(activitySyncScopes.watermark, "scopeWatermark"),
      metadata: activitySyncScopes.metadata,
    })
    .from(activitySyncScopes)
    .where(scopeWhere(input))
    .limit(1))[0];
  const scope = rawScope && {
    epoch: exactDatabaseInt8(rawScope.epochText, "activity_sync_scopes.epoch"),
    watermark: exactDatabaseInt8(rawScope.watermarkText, "activity_sync_scopes.watermark"),
    metadata: rawScope.metadata,
  };
  if (!scope || scope.epoch !== epoch || scope.watermark !== watermark) {
    throw new Error("Activity scope changed inside its authority transaction");
  }
  const metadata = scope.metadata ?? {
    nextCursor: null,
    hasMore: false,
    complete: true,
    totalCount: 0,
    totalUnreadCount: 0,
  };
  return {
    rows: rows
      .filter((row) => row.active && row.payload)
      .map((row) => ({ ...row.payload!, rowVersion: exactWire(row.rowVersion) } as ActivityRow))
      .sort((left, right) => {
        if (left.lastActivityAt !== right.lastActivityAt) {
          return left.lastActivityAt < right.lastActivityAt ? 1 : -1;
        }
        return left.rowId.localeCompare(right.rowId);
      }),
    tombstones: rows
      .filter((row) => !row.active && row.tombstoneReason)
      .map((row) => ({
        rowId: row.rowId,
        rowVersion: exactWire(row.rowVersion),
        reason: row.tombstoneReason!,
      })),
    ...metadata,
  };
}

async function reconcileInTransaction(
  executor: DatabaseExecutor,
  input: ReconcileOptions,
  now: Date,
  attempt: number,
): Promise<ReconciledScope> {
  activitySyncTestHooks?.onTransactionAttemptStart?.(attempt);
  await activitySyncTestHooks?.beforePrincipalAuthorityInsert?.(executor);
  await executor.insert(activitySyncPrincipalAuthorities)
    .values({ serverId: input.serverId, principalId: input.principalId })
    .onConflictDoNothing();
  await activitySyncTestHooks?.beforePrincipalAuthorityLock?.(executor);
  const rawPrincipal = (await executor
    .select({
      rowVersionText: exactText(
        activitySyncPrincipalAuthorities.rowVersion,
        "principalRowVersion",
      ),
    })
    .from(activitySyncPrincipalAuthorities)
    .where(and(
      eq(activitySyncPrincipalAuthorities.serverId, input.serverId),
      eq(activitySyncPrincipalAuthorities.principalId, input.principalId),
    ))
    .for("update")
    .limit(1))[0];
  if (!rawPrincipal) throw new Error("Failed to establish Activity principal authority");
  const principalVersionAtLock = exactDatabaseInt8(
    rawPrincipal.rowVersionText,
    "activity_sync_principal_authorities.row_version",
  );

  await executor.insert(activitySyncScopes)
    .values({
      serverId: input.serverId,
      principalId: input.principalId,
      filter: input.filter,
      windowId: WINDOW_ID,
      windowSize: MAIN_WINDOW_SIZE,
    })
    .onConflictDoNothing();
  const rawScope = (await executor
    .select({
      epochText: exactText(activitySyncScopes.epoch, "scopeEpoch"),
      watermarkText: exactText(activitySyncScopes.watermark, "scopeWatermark"),
      scopeDigest: activitySyncScopes.scopeDigest,
      metadata: activitySyncScopes.metadata,
    })
    .from(activitySyncScopes)
    .where(scopeWhere(input))
    .for("update")
    .limit(1))[0];
  if (!rawScope) throw new Error("Failed to establish Activity scope authority");
  let scope = {
    epoch: exactDatabaseInt8(rawScope.epochText, "activity_sync_scopes.epoch"),
    watermark: exactDatabaseInt8(rawScope.watermarkText, "activity_sync_scopes.watermark"),
    scopeDigest: rawScope.scopeDigest,
    metadata: rawScope.metadata,
  };

  const canonical = await readCanonicalWindow(executor, input);
  const rawCurrentRows = await executor
    .select({
      rowId: activitySyncRows.rowId,
      rowVersionText: exactText(activitySyncRows.rowVersion, "scopeRowVersion"),
      active: activitySyncRows.active,
      payload: activitySyncRows.payload,
      payloadDigest: activitySyncRows.payloadDigest,
      tombstoneReason: activitySyncRows.tombstoneReason,
    })
    .from(activitySyncRows)
    .where(rowScopeWhere(input));
  const currentRows = rawCurrentRows.map((row) => ({
    ...row,
    rowVersion: exactDatabaseInt8(row.rowVersionText, "activity_sync_rows.row_version"),
  }));
  const currentById = new Map(currentRows.map((row) => [row.rowId, row]));
  const canonicalById = new Map(canonical.rows.map((row) => [row.rowId, row]));
  const rawAuthorityRows = await executor
    .select({
      rowId: activitySyncRowAuthorities.rowId,
      lastVersionText: exactText(
        activitySyncRowAuthorities.lastVersion,
        "rowAuthorityVersion",
      ),
      active: activitySyncRowAuthorities.active,
      payloadDigest: activitySyncRowAuthorities.payloadDigest,
    })
    .from(activitySyncRowAuthorities)
    .where(and(
      eq(activitySyncRowAuthorities.serverId, input.serverId),
      eq(activitySyncRowAuthorities.principalId, input.principalId),
      canonical.rows.length > 0
        ? inArray(activitySyncRowAuthorities.rowId, canonical.rows.map((row) => row.rowId))
        : sql`false`,
    ));
  const authorityRows = rawAuthorityRows.map((row) => ({
    ...row,
    lastVersion: exactDatabaseInt8(
      row.lastVersionText,
      "activity_sync_row_authorities.last_version",
    ),
  }));
  const authorityById = new Map(authorityRows.map((row) => [row.rowId, row]));
  let principalVersion = principalVersionAtLock;
  const pending: Array<{
    rowId: string | null;
    rowVersion: bigint | null;
    kind: "upsert" | "tombstone" | "scope";
    payload: Record<string, unknown> | null;
    tombstoneReason: TombstoneReason | null;
  }> = [];

  for (const payload of canonical.rows) {
    const payloadDigest = digest(payload);
    const current = currentById.get(payload.rowId);
    if (current?.active && current.payloadDigest === payloadDigest) continue;
    const authority = authorityById.get(payload.rowId);
    let rowVersion: bigint;
    if (
      authority?.active
      && authority.payloadDigest === payloadDigest
      && (!current || authority.lastVersion > current.rowVersion)
    ) {
      rowVersion = authority.lastVersion;
    } else {
      principalVersion = await nextRowVersion(executor, input, principalVersion, now);
      rowVersion = principalVersion;
      await executor.insert(activitySyncRowAuthorities)
        .values({
          serverId: input.serverId,
          principalId: input.principalId,
          rowId: payload.rowId,
          lastVersion: rowVersion,
          active: true,
          payloadDigest,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            activitySyncRowAuthorities.serverId,
            activitySyncRowAuthorities.principalId,
            activitySyncRowAuthorities.rowId,
          ],
          set: { lastVersion: rowVersion, active: true, payloadDigest, updatedAt: now },
        });
    }
    await executor.insert(activitySyncRows)
      .values({
        serverId: input.serverId,
        principalId: input.principalId,
        filter: input.filter,
        windowId: WINDOW_ID,
        rowId: payload.rowId,
        rowVersion,
        active: true,
        payload,
        payloadDigest,
        tombstoneReason: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          activitySyncRows.serverId,
          activitySyncRows.principalId,
          activitySyncRows.filter,
          activitySyncRows.windowId,
          activitySyncRows.rowId,
        ],
        set: {
          rowVersion,
          active: true,
          payload,
          payloadDigest,
          tombstoneReason: null,
          updatedAt: now,
        },
      });
    pending.push({
      rowId: payload.rowId,
      rowVersion,
      kind: "upsert",
      payload,
      tombstoneReason: null,
    });
  }

  const missingActive = currentRows.filter((row) => row.active && !canonicalById.has(row.rowId));
  const reasons = await tombstoneReasons(executor, input.principalId, missingActive);
  for (const current of missingActive) {
    const reason = reasons.get(current.rowId) ?? "outOfWindow";
    principalVersion = await nextRowVersion(executor, input, principalVersion, now);
    const rowVersion = principalVersion;
    await executor.insert(activitySyncRowAuthorities)
      .values({
        serverId: input.serverId,
        principalId: input.principalId,
        rowId: current.rowId,
        lastVersion: rowVersion,
        active: false,
        payloadDigest: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          activitySyncRowAuthorities.serverId,
          activitySyncRowAuthorities.principalId,
          activitySyncRowAuthorities.rowId,
        ],
        set: { lastVersion: rowVersion, active: false, payloadDigest: null, updatedAt: now },
      });
    await executor.update(activitySyncRows)
      .set({
        rowVersion,
        active: false,
        payload: null,
        payloadDigest: null,
        tombstoneReason: reason,
        updatedAt: now,
      })
      .where(and(rowScopeWhere(input), eq(activitySyncRows.rowId, current.rowId)));
    pending.push({
      rowId: current.rowId,
      rowVersion,
      kind: "tombstone",
      payload: null,
      tombstoneReason: reason,
    });
  }

  const rawProjectedRows = await executor
    .select({
      rowId: activitySyncRows.rowId,
      rowVersionText: exactText(activitySyncRows.rowVersion, "scopeRowVersion"),
      active: activitySyncRows.active,
      tombstoneReason: activitySyncRows.tombstoneReason,
    })
    .from(activitySyncRows)
    .where(rowScopeWhere(input))
    .orderBy(asc(activitySyncRows.rowId));
  const projectedRows = rawProjectedRows.map((row) => ({
    ...row,
    rowVersion: exactDatabaseInt8(row.rowVersionText, "activity_sync_rows.row_version"),
  }));
  let scopeFact = {
    rows: canonical.rows.map((row) => ({ rowId: row.rowId, payloadDigest: digest(row) })),
    tombstones: projectedRows
      .filter((row) => !row.active)
      .map((row) => ({
        rowId: row.rowId,
        rowVersion: decimalText(row.rowVersion),
        reason: row.tombstoneReason,
      })),
    metadata: canonical.metadata,
  };
  let scopeDigest = digest(scopeFact);
  if (scope.scopeDigest !== scopeDigest) {
    pending.push({
      rowId: null,
      rowVersion: null,
      kind: "scope",
      payload: canonical.metadata,
      tombstoneReason: null,
    });
  }

  const retained = (await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(activitySyncChanges)
    .where(changeScopeWhere(input)))[0]?.count ?? 0;
  if (pending.length > 0 && retained + pending.length > CHANGE_RETENTION) {
    const epoch = scope.epoch + 1n;
    await executor.delete(activitySyncChanges).where(changeScopeWhere(input));
    // Tombstones only defend against stale frames inside an epoch. Rollover
    // makes those frames incomparable, so retaining old stones would turn the
    // bounded repair log into an unbounded second log.
    await executor.delete(activitySyncRows).where(and(
      rowScopeWhere(input),
      eq(activitySyncRows.active, false),
    ));
    scopeFact = { ...scopeFact, tombstones: [] };
    scopeDigest = digest(scopeFact);
    await executor.update(activitySyncScopes)
      .set({ epoch, watermark: 0n, scopeDigest: null, metadata: null, updatedAt: now })
      .where(scopeWhere(input));
    scope = { ...scope, epoch, watermark: 0n, scopeDigest: null };
  }

  let watermark = scope.watermark;
  for (const change of pending) {
    watermark += 1n;
    await executor.insert(activitySyncChanges).values({
      serverId: input.serverId,
      principalId: input.principalId,
      filter: input.filter,
      windowId: WINDOW_ID,
      seq: watermark,
      rowId: change.rowId,
      rowVersion: change.rowVersion,
      kind: change.kind,
      payload: change.payload,
      tombstoneReason: change.tombstoneReason,
    });
  }
  if (pending.length > 0) {
    await executor.update(activitySyncScopes)
      .set({
        watermark,
        scopeDigest,
        metadata: canonical.metadata,
        updatedAt: now,
      })
      .where(scopeWhere(input));
  }

  const scopeIdentity: ActivityScope = {
    serverId: input.serverId,
    principalId: input.principalId,
    filter: input.filter,
    windowId: WINDOW_ID,
  };
  return {
    scope: scopeIdentity,
    epoch: scope.epoch,
    watermark,
    window: await materializeWindow(executor, input, scope.epoch, watermark),
  };
}

async function withReconciledScope<T>(
  input: ReconcileOptions,
  callback: (executor: DatabaseExecutor, reconciled: ReconciledScope) => Promise<T>,
  runtime: Partial<ActivitySyncRuntime>,
): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      return await getDb().transaction(async (tx) => {
        const reconciled = await reconcileInTransaction(
          tx,
          input,
          (runtime.now ?? currentDate)(),
          attempt,
        );
        if (input.failAfterReconcileForTest) {
          throw new Error("Activity sync reconcile failpoint");
        }
        return callback(tx, reconciled);
      }, {
        isolationLevel: "repeatable read",
        accessMode: "read write",
      });
    } catch (error) {
      const code = sqlState(error);
      activitySyncTestHooks?.onSerializationFailure?.(code, attempt);
      if (
        code !== "40001"
        || activitySyncTestHooks?.disableSerializationRetry
        || attempt === SERIALIZATION_ATTEMPTS
      ) {
        throw error;
      }
      activitySyncTestHooks?.onSerializationRetry?.(attempt);
    }
  }
  throw new Error("Activity serialization retry loop exhausted");
}

export async function getActivitySnapshot(
  input: ReconcileOptions & { requestId?: string },
  runtime: Partial<ActivitySyncRuntime> = {},
): Promise<SnapshotIngress> {
  const requestId = input.requestId ?? (runtime.createId ?? randomUUID)();
  return withReconciledScope(input, async (_executor, reconciled) => ({
    type: "snapshot",
    requestId,
    scope: reconciled.scope,
    epoch: exactWire(reconciled.epoch),
    watermark: exactWire(reconciled.watermark),
    activityVersion: exactWire(reconciled.watermark),
    window: reconciled.window,
  }), runtime);
}

export async function getActivityDifference(
  input: ReconcileOptions & {
    requestId?: string;
    epoch: string;
    afterWatermark: string;
  },
  runtime: Partial<ActivitySyncRuntime> = {},
): Promise<ActivityDifferenceResult> {
  const requestId = input.requestId ?? (runtime.createId ?? randomUUID)();
  const requestedEpoch = BigInt(input.epoch);
  const after = BigInt(input.afterWatermark);
  return withReconciledScope(input, async (executor, reconciled) => {
    const snapshotRequired = (): ActivityDifferenceResult => ({
      status: 409,
      body: {
        snapshotRequired: true,
        requestId,
        scope: reconciled.scope,
        epoch: exactWire(reconciled.epoch),
        watermark: exactWire(reconciled.watermark),
        activityVersion: exactWire(reconciled.watermark),
      },
    });
    if (
      requestedEpoch !== reconciled.epoch
      || after > reconciled.watermark
      || (after < reconciled.watermark && after + 1n < 1n)
    ) {
      return snapshotRequired();
    }
    if (after === reconciled.watermark) {
      const body: NotModifiedIngress = {
        type: "notModified",
        requestId,
        scope: reconciled.scope,
        epoch: exactWire(reconciled.epoch),
        watermark: exactWire(reconciled.watermark),
        activityVersion: exactWire(reconciled.watermark),
      };
      return { status: 200, body };
    }
    const rawChanges = await executor
      .select({
        seqText: exactText(activitySyncChanges.seq, "changeSeq"),
        rowId: activitySyncChanges.rowId,
        rowVersionText: exactText(activitySyncChanges.rowVersion, "changeRowVersion"),
        kind: activitySyncChanges.kind,
        payload: activitySyncChanges.payload,
        tombstoneReason: activitySyncChanges.tombstoneReason,
      })
      .from(activitySyncChanges)
      .where(and(changeScopeWhere(input), gt(activitySyncChanges.seq, after)))
      .orderBy(asc(activitySyncChanges.seq));
    const changes = rawChanges.map((change) => ({
      ...change,
      seq: exactDatabaseInt8(change.seqText, "activity_sync_changes.seq"),
      rowVersion: change.rowVersionText === null
        ? null
        : exactDatabaseInt8(change.rowVersionText, "activity_sync_changes.row_version"),
    }));
    if (changes.length === 0 || changes[0]!.seq !== after + 1n) return snapshotRequired();

    const latestByRow = new Map<string, (typeof changes)[number]>();
    for (const change of changes) {
      if (change.rowId) latestByRow.set(change.rowId, change);
    }
    const rows: ActivityRow[] = [];
    const tombstones: ActivityRowTombstone[] = [];
    for (const change of latestByRow.values()) {
      if (change.kind === "upsert" && change.payload && change.rowVersion !== null) {
        rows.push({ ...change.payload, rowVersion: exactWire(change.rowVersion) } as ActivityRow);
      } else if (
        change.kind === "tombstone"
        && change.rowId
        && change.rowVersion !== null
        && change.tombstoneReason
      ) {
        tombstones.push({
          rowId: change.rowId,
          rowVersion: exactWire(change.rowVersion),
          reason: change.tombstoneReason,
        });
      }
    }
    const metadata: ScopeMetadata = {
      nextCursor: reconciled.window.nextCursor,
      hasMore: reconciled.window.hasMore,
      complete: reconciled.window.complete,
      totalCount: reconciled.window.totalCount,
      totalUnreadCount: reconciled.window.totalUnreadCount,
    };
    const body: DifferenceIngress = {
      type: "difference",
      requestId,
      scope: reconciled.scope,
      epoch: exactWire(reconciled.epoch),
      fromSeq: exactWire(after + 1n),
      toSeq: exactWire(reconciled.watermark),
      activityVersion: exactWire(reconciled.watermark),
      rows,
      tombstones,
      ...metadata,
      nextFromSeq: null,
    };
    return { status: 200, body };
  }, runtime);
}

// Test-only exports for the Gate B1 same-source id/seq teeth. normalizeRow is
// the single mapper every row-kind (channel/dm/mention/thread) flows through;
// requireLatestActivitySeq is the fail-closed guard that hard-rejects an RW
// join-miss without a canonical-PG fallback (no "0", no silent drop).
export const normalizeRowForTest = normalizeRow;
export const requireLatestActivitySeqForTest = requireLatestActivitySeq;
