import {
  formatInboxScopeCorruptionLine,
  makeInboxScopeReadFrontier,
  type InboxScopeCursorCorruption,
  type InboxScopeCursorRow,
  type InboxScopeReadFrontier,
} from "@botiverse/raft-shared";

export type InboxPolicyFilter = "all" | "unread" | "mentions";
export type InboxPolicyChannelType = "channel" | "private" | "joint" | "dm" | "thread";
export type InboxPolicyActorType = "user" | "agent" | "system" | "external_projection";

export type InboxPolicyChannel = {
  id: string;
  name: string;
  type: InboxPolicyChannelType;
  parentMessageId?: string;
  deleted?: boolean;
  archived?: boolean;
};

export type InboxPolicyMessage = {
  id: string;
  channelId: string;
  seq: number;
  createdAt: number;
  content?: string;
  senderType: InboxPolicyActorType;
  senderId: string;
};

export type InboxPolicyMentionFact = {
  messageId: string;
  messageSeq: number;
  channelId: string;
  targetType: "user" | "agent";
  targetId: string;
  mentionKind?: "personal" | "broadcast";
  notifiableAtSend?: boolean;
  notified?: boolean;
};

export type InboxPolicyThreadFollow = {
  threadChannelId: string;
  followerType: "user" | "agent";
  followerId: string;
  done?: boolean;
  unfollowed?: boolean;
};

export type InboxPolicyModel = {
  receiverType?: "user" | "agent";
  receiverId?: string;
  userId: string;
  channels: InboxPolicyChannel[];
  messages: InboxPolicyMessage[];
  channelMemberUserIds: Record<string, string[]>;
  channelMemberAgentIds?: Record<string, string[]>;
  lastReadSeqByChannel: Record<string, number>;
  doneChannelIds: string[];
  threadFollows: InboxPolicyThreadFollow[];
  mentionFacts: InboxPolicyMentionFact[];
  // Per-receiver channel/DM mute state for the modeled actor. It is never a
  // channel-global flag; user and agent receivers choose independently.
  // Followed-thread ordinary replies are independent from their parent
  // channel's mute state; explicit thread quieting is modeled by
  // threadFollows.unfollowed/done.
  mutedChannelIds?: string[];
  // Optional inclusive message seq where mute begins for a receiver/channel.
  // Ordinary messages before this seq remain receiver Activity history.
  muteFromSeqByChannel?: Record<string, number>;
  doNotDisturbUserIds?: string[];
};

export type InboxPolicyRow =
  | {
      kind: "channel" | "dm";
      sourceChannelId: string;
      storageChannelId: string;
      activityAt: number;
      latestMessageId: string;
      firstUnreadMessageId: string | null;
      unreadCount: number;
      hasMention: boolean;
      hasAnyMention: boolean;
      mentionOnly: boolean;
    }
  | {
      kind: "thread";
      sourceChannelId: string;
      storageChannelId: string;
      parentChannelId: string;
      parentMessageId: string;
      activityAt: number;
      latestActivityMessageId: string;
      firstUnreadMessageId: string | null;
      replyCount: number;
      unreadCount: number;
      hasMention: boolean;
      hasAnyMention: boolean;
      mentionOnly: boolean;
    };

export type InboxPolicyProjection = {
  rows: InboxPolicyRow[];
  totalCount: number;
  totalUnreadCount: number;
};

export type InboxPolicyNotificationClass = "none" | "unread" | "personal_mention";

export type InboxPolicyReceiverEffect = {
  key: string;
  kind: InboxPolicyRow["kind"];
  sourceChannelId: string;
  inAll: boolean;
  inUnread: boolean;
  inMentions: boolean;
  unreadCount: number;
  hasMention: boolean;
  mentionOnly: boolean;
  notification: InboxPolicyNotificationClass;
};

export type InboxPolicyReceiverEffects = {
  receiverType: "user" | "agent";
  receiverId: string;
  rows: InboxPolicyReceiverEffect[];
};

export type InboxPolicyNotificationFact = {
  receiverType: "user" | "agent";
  receiverId: string;
  kind: "channel" | "dm" | "thread";
  sourceChannelId: string;
  seq: number;
  messageId: string;
  activityAt: Date | number | string;
  personalMention: boolean;
  unreadEligible?: boolean;
};

export type InboxPolicyServingRow = InboxPolicySqlRow & {
  key: string;
  kind: "channel" | "dm" | "thread";
  sourceChannelId: string;
  channelId?: string;
  threadChannelId?: string;
  activityAt: Date | number | string;
  latestMessageId: string;
  firstUnreadMessageId: string | null;
  latestNotifiedSeq: number;
  firstUnreadSeq: number | null;
  unreadCount: number;
  latestPersonalMentionSeq: number | null;
  unreadMentionCount: number;
  hasMention: boolean;
  hasAnyMention: boolean;
  mentionOnly: boolean;
};

export type InboxPolicyApiItem =
  | {
      kind: "channel" | "dm";
      channelId: string;
      channelName: string;
      channelType: string;
      lastMessageId: string;
      latestActivitySeq: string | null;
      /** Frontier in the storage sequence space consumed by the Done guard. */
      doneFrontierSeq: string | null;
      firstUnreadMessageId: string | null;
      firstMentionMessageId: string | null;
      lastMessageAt: string;
      lastMessagePreview: string;
      lastMessageSenderType: string;
      lastMessageSenderId: string;
      lastMessageSenderName: string | null;
      unreadCount: number;
      hasMention: boolean;
      /** SSOT per-scope read state (#632); same field name as the other exits. */
      readState: InboxScopeReadFrontier;
    }
  | {
      kind: "thread";
      threadChannelId: string;
      parentMessageId: string;
      parentChannelId: string;
      parentChannelName: string;
      parentChannelType: string;
      parentMessagePreview: string;
      parentMessageSenderType: string;
      parentMessageSenderId: string;
      latestActivityPreview: string;
      latestActivitySenderType: string;
      latestActivitySenderId: string;
      latestActivitySenderName: string | null;
      latestActivityMessageId: string;
      latestActivitySeq: string | null;
      /** Frontier in the storage sequence space consumed by the Done guard. */
      doneFrontierSeq: string | null;
      firstUnreadMessageId: string | null;
      firstMentionMessageId: string | null;
      lastActivityAt: string;
      lastReplyAt: string | null;
      replyCount: number;
      unreadCount: number;
      hasMention: boolean;
      taskNumber: number | null;
      taskStatus: string | null;
      taskClaimedByName: string | null;
      /** SSOT per-scope read state (#632); same field name as the other exits. */
      readState: InboxScopeReadFrontier;
    };

export type InboxPolicySqlRow = Record<string, unknown> & {
  kind?: string | null;
  totalCount?: number | string | null;
  totalUnreadCount?: number | string | null;
  activeUnreadCount?: number | string | null;
  activityAt?: Date | number | string | null;
  unreadCount?: number | string | null;
  hasMention?: boolean | null;
  hasAnyMention?: boolean | null;
  mentionOnly?: boolean | null;
  firstMentionMessageId?: string | null;
};

export type InboxPolicyPageSelection<T extends InboxPolicySqlRow> = {
  rows: T[];
  hasMore: boolean;
  totalCount: number;
  totalUnreadCount: number;
};

function asCount(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function selectInboxPolicyActiveUnreadCount(
  rawRows: readonly InboxPolicySqlRow[],
  fallback: number,
): number {
  const value = rawRows[0]?.activeUnreadCount;
  return value == null ? fallback : asCount(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function truncatePreview(value: unknown, maxLength: number): string {
  const text = asString(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function selectInboxPolicyPageRows<T extends InboxPolicySqlRow>(
  rawRows: readonly T[],
  limit: number,
): InboxPolicyPageSelection<T> {
  const rows = rawRows.filter((row) => row.kind != null);
  const hasMore = rows.length > limit;
  return {
    rows: hasMore ? rows.slice(0, limit) : rows,
    hasMore,
    totalCount: asCount(rawRows[0]?.totalCount),
    totalUnreadCount: asCount(rawRows[0]?.totalUnreadCount),
  };
}

function asTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sqlRowKey(row: InboxPolicySqlRow): string {
  const kind = asString(row.kind);
  if (kind === "thread") return `thread:${asString(row.threadChannelId)}`;
  return `${kind}:${asString(row.channelId)}`;
}

function sqlRowPassesFilter(row: InboxPolicySqlRow, filter: InboxPolicyFilter): boolean {
  const unreadCount = asCount(row.unreadCount);
  const hasAnyMention = row.hasAnyMention === true || row.hasMention === true;
  if (filter === "all") return true;
  if (filter === "unread") return row.mentionOnly !== true && unreadCount > 0;
  return hasAnyMention;
}

export function applyInboxPolicyFilterPageRows<T extends InboxPolicySqlRow>(
  candidateRows: readonly T[],
  opts: { filter: InboxPolicyFilter; limit: number; offset?: number },
): InboxPolicyPageSelection<T> {
  const offset = Math.max(opts.offset ?? 0, 0);
  const filtered = candidateRows
    .filter((row) => row.kind != null && sqlRowPassesFilter(row, opts.filter))
    .sort((a, b) => asTime(b.activityAt) - asTime(a.activityAt) || sqlRowKey(a).localeCompare(sqlRowKey(b)));
  const pageRows = filtered.slice(offset, offset + opts.limit + 1);
  const hasMore = pageRows.length > opts.limit;
  return {
    rows: hasMore ? pageRows.slice(0, opts.limit) : pageRows,
    hasMore,
    totalCount: filtered.length,
    totalUnreadCount: filtered.reduce((sum, row) => sum + asCount(row.unreadCount), 0),
  };
}

function servingRowKey(fact: Pick<InboxPolicyNotificationFact, "kind" | "sourceChannelId">): string {
  return `${fact.kind}:${fact.sourceChannelId}`;
}

export function projectInboxServingRowsFromNotificationFacts(opts: {
  receiverType: "user" | "agent";
  receiverId: string;
  facts: readonly InboxPolicyNotificationFact[];
  lastReadSeqByChannel: Record<string, number>;
  filter?: InboxPolicyFilter;
}): InboxPolicyServingRow[] {
  const rowsByKey = new Map<string, InboxPolicyNotificationFact[]>();
  for (const fact of opts.facts) {
    if (fact.receiverType !== opts.receiverType || fact.receiverId !== opts.receiverId) continue;
    const key = servingRowKey(fact);
    const rows = rowsByKey.get(key);
    if (rows) rows.push(fact);
    else rowsByKey.set(key, [fact]);
  }

  const rows = [...rowsByKey.entries()].flatMap(([key, facts]) => {
    const orderedFacts = [...facts].sort((a, b) => a.seq - b.seq || asTime(a.activityAt) - asTime(b.activityAt));
    const latest = orderedFacts[orderedFacts.length - 1];
    if (!latest) return [];
    const readSeq = opts.lastReadSeqByChannel[latest.sourceChannelId] ?? 0;
    const unread = orderedFacts.filter((fact) => fact.seq > readSeq && fact.unreadEligible !== false);
    const personalMentions = orderedFacts.filter((fact) => fact.personalMention);
    const unreadMentions = personalMentions.filter((fact) => fact.seq > readSeq);
    const row: InboxPolicyServingRow = {
      key,
      kind: latest.kind,
      sourceChannelId: latest.sourceChannelId,
      channelId: latest.kind === "thread" ? undefined : latest.sourceChannelId,
      threadChannelId: latest.kind === "thread" ? latest.sourceChannelId : undefined,
      activityAt: latest.activityAt,
      latestMessageId: latest.messageId,
      firstUnreadMessageId: unread[0]?.messageId ?? null,
      firstMentionMessageId: unreadMentions[0]?.messageId ?? null,
      latestNotifiedSeq: latest.seq,
      firstUnreadSeq: unread[0]?.seq ?? null,
      unreadCount: unread.length,
      latestPersonalMentionSeq: personalMentions[personalMentions.length - 1]?.seq ?? null,
      unreadMentionCount: unreadMentions.length,
      hasMention: unreadMentions.length > 0,
      hasAnyMention: personalMentions.length > 0,
      mentionOnly: false,
    };
    return [row];
  });

  return applyInboxPolicyFilterPageRows(rows, {
    filter: opts.filter ?? "all",
    limit: Math.max(rows.length, 1),
  }).rows;
}

/**
 * Where the readState union's frontier pair comes from — an EXPLICIT caller
 * fact, never inferred from which columns happen to exist on the row:
 *   - "authority": PG paths after enrichInboxRowsWithReadCursorAuthority —
 *     the pair is the authority read's lateral over the scope's OWN storage
 *     channel (NULL when the scope has no messages).
 *   - "servingPair" (default): RW serving rows — the pair is the serving
 *     query's same-source (id, seq) with the zero-reply parent fallback
 *     EXCLUDED (see inboxScopeCursorFromRow).
 */
export type InboxReadStateFrontierSource = "authority" | "servingPair";

function doneFrontierSeqFromRow(
  row: InboxPolicySqlRow,
  frontierSource: InboxReadStateFrontierSource,
): string | null {
  // PG rows receive this dedicated field from the same authority read used to
  // resolve joint projections to canonical storage. RW's served latest pair is
  // already storage-scoped, so it is safe to carry that pair into the explicit
  // Done contract. Never infer the PG value from the display pair: that is the
  // cross-space bug this field exists to prevent.
  return frontierSource === "authority"
    ? asNullableString(row.doneFrontierSeq)
    : asNullableString(row.latestActivitySeq);
}

export function mapInboxPolicyRowsToItems(
  rows: readonly InboxPolicySqlRow[],
  onCorrupt?: (scopeId: string, corruption: InboxScopeCursorCorruption) => void | PromiseLike<void>,
  frontierSource: InboxReadStateFrontierSource = "servingPair",
): InboxPolicyApiItem[] {
  return rows.map((row) => {
    if (row.kind === "thread") {
      const parentMessagePreview = asString(row.parentMessagePreview);
      const latestActivityPreview = asString(row.latestActivityPreview) || parentMessagePreview;
      const threadChannelId = asString(row.threadChannelId);
      return {
        kind: "thread",
        threadChannelId,
        parentMessageId: asString(row.parentMessageId),
        parentChannelId: asString(row.parentChannelId),
        parentChannelName: asString(row.parentChannelName),
        parentChannelType: asString(row.parentChannelType),
        parentMessagePreview: truncatePreview(parentMessagePreview, 100),
        parentMessageSenderType: asString(row.parentMessageSenderType),
        parentMessageSenderId: asString(row.parentMessageSenderId),
        latestActivityPreview: truncatePreview(latestActivityPreview, 140),
        latestActivitySenderType: asString(row.latestActivitySenderType),
        latestActivitySenderId: asString(row.latestActivitySenderId),
        latestActivitySenderName: asNullableString(row.latestActivitySenderName),
        latestActivityMessageId: asString(row.latestActivityMessageId),
        latestActivitySeq: asNullableString(row.latestActivitySeq),
        doneFrontierSeq: doneFrontierSeqFromRow(row, frontierSource),
        firstUnreadMessageId: asNullableString(row.firstUnreadMessageId),
        firstMentionMessageId: asNullableString(row.firstMentionMessageId),
        lastActivityAt: asString(row.lastActivityAt),
        lastReplyAt: asNullableString(row.lastReplyAt),
        replyCount: asNumber(row.replyCount),
        unreadCount: asNumber(row.unreadCount),
        hasMention: row.hasMention === true,
        taskNumber: typeof row.taskNumber === "number" ? row.taskNumber : null,
        taskStatus: asNullableString(row.taskStatus),
        taskClaimedByName: asNullableString(row.taskClaimedByName),
        readState: buildReadState(row, threadChannelId, onCorrupt, frontierSource),
      };
    }

    const channelId = asString(row.channelId);
    return {
      kind: row.kind === "dm" ? "dm" : "channel",
      channelId,
      channelName: asString(row.channelName),
      channelType: asString(row.channelType),
      lastMessageId: asString(row.lastMessageId),
      latestActivitySeq: asNullableString(row.latestActivitySeq),
      doneFrontierSeq: doneFrontierSeqFromRow(row, frontierSource),
      firstUnreadMessageId: asNullableString(row.firstUnreadMessageId),
      firstMentionMessageId: asNullableString(row.firstMentionMessageId),
      lastMessageAt: asString(row.lastMessageAt),
      lastMessagePreview: truncatePreview(row.lastMessagePreview, 140),
      lastMessageSenderType: asString(row.lastMessageSenderType),
      lastMessageSenderId: asString(row.lastMessageSenderId),
      lastMessageSenderName: asNullableString(row.lastMessageSenderName),
      unreadCount: asNumber(row.unreadCount),
      hasMention: row.hasMention === true,
      readState: buildReadState(row, channelId, onCorrupt, frontierSource),
    };
  });
}

/**
 * Build the SSOT per-scope read state union (#632) from a serving row.
 *
 * Presence is a STRUCTURAL input fact: the serving query sets `readCursorPresent`
 * (the read-cursor row exists) rather than letting presence be guessed from which
 * value columns happen to be NULL. No cursor row → `null` → `{kind:"absent"}`.
 * A present row whose own version/seq is corrupt is handled by the shared total
 * constructor (`{kind:"corrupt"}`, onCorrupt exactly once) — never demoted to
 * absent. The frontier pair (latestActivityMessageId + latestActivitySeq) is
 * same-source; the constructor fails it closed to null on any half-missing.
 */
function buildReadState(
  row: InboxPolicySqlRow,
  scopeId: string,
  onCorrupt?: (scopeId: string, corruption: InboxScopeCursorCorruption) => void | PromiseLike<void>,
  frontierSource: InboxReadStateFrontierSource = "servingPair",
): InboxScopeReadFrontier {
  const cursor = inboxScopeCursorFromRow(row, frontierSource);
  return makeInboxScopeReadFrontier(
    cursor,
    onCorrupt ? (corruption) => onCorrupt(scopeId, corruption) : undefined,
  );
}

function inboxScopeCursorFromRow(
  row: InboxPolicySqlRow,
  frontierSource: InboxReadStateFrontierSource,
): InboxScopeCursorRow | null {
  // Presence is structural: the serving query reports whether the read-cursor row
  // exists. Without a cursor row the scope is `absent` (must not be treated as read).
  if (row.readCursorPresent !== true) return null;
  // Value columns flow into the total constructor RAW (typed casts only): the
  // constructor is the one place that classifies present-vs-corrupt. Coercing
  // here (e.g. asNumber's null→0) would silently pad a corrupt present row into
  // a clean-looking one and kill the alarm the contract demands.
  let latestActivityMessageId: string | null;
  let latestActivitySeq: string | null;
  if (frontierSource === "authority") {
    // PG paths: the authority read's lateral over the scope's OWN storage
    // channel (NULL when the scope has no messages) — the identical union
    // semantics as the list/DM/thread and unread exits. Rows the enrichment
    // never stamped (e.g. its empty-scope early return) read as NULL here:
    // the union fails closed to a null frontier rather than silently falling
    // back to a different source's semantics.
    latestActivityMessageId = asNullableString(row.readStateActivityMessageId);
    latestActivitySeq = asNullableString(row.readStateActivitySeq);
  } else {
    // RW path: the serving row's same-source pair, EXCLUDING the zero-reply
    // parent fallback. Today's served views define the thread activity id as
    // COALESCE(latest.message_id, parent_message.id) (rfcs/024 base, carried
    // through rw_inbox_items_v3_2 and rw_inbox_items_v2_suppressed_v3_4), so
    // a zero-reply thread's pair id IS the parent id — a reply id never
    // equals it, and a mention-only pair is a thread message so it cannot
    // collide either. Equality therefore marks the fallback: authority
    // semantics say null (and the parent seq lives in a different seq domain
    // than the scope's cursor — it must never be compared against it).
    // This reachability is a DOCUMENTED DEFENSIVE ASSUMPTION about the MV
    // shape, not a tested one: no unit/pglite harness runs a real
    // RisingWave, and source-scanning the DDL is a known false-green pattern
    // (the served views moved twice already). If the MV drops the fallback,
    // the regression WOULD surface as a readState.latestActivity PG/RW
    // mismatch in scripts/verify-risingwave-inbox-parity.ts (its
    // comparableItems deep-equals the whole InboxItem payload) — but note
    // that check is on-demand ops only, wired to no CI workflow or cron:
    // it can find the drift, it will not find it by itself. If the MV ever
    // gains a structural zero-reply flag, this rule should move to it.
    const pairId = asNullableString(row.latestActivityMessageId);
    const parentFallback = row.kind === "thread" && pairId !== null && pairId === asString(row.parentMessageId);
    latestActivityMessageId = parentFallback ? null : pairId;
    latestActivitySeq = parentFallback ? null : asNullableString(row.latestActivitySeq);
  }
  return {
    readStateVersion: row.readStateVersion as number,
    maxReadSeq: row.maxReadSeq as string,
    latestActivityMessageId,
    latestActivitySeq,
  };
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function receiverType(model: InboxPolicyModel): "user" | "agent" {
  return model.receiverType ?? "user";
}

function receiverId(model: InboxPolicyModel): string {
  return model.receiverId ?? model.userId;
}

function isCurrentReceiverMember(model: InboxPolicyModel, channelId: string): boolean {
  const id = receiverId(model);
  if (receiverType(model) === "agent") {
    return (model.channelMemberAgentIds?.[channelId] ?? []).includes(id);
  }
  return (model.channelMemberUserIds[channelId] ?? []).includes(id);
}

function lastReadSeq(model: InboxPolicyModel, channelId: string): number {
  return model.lastReadSeqByChannel[channelId] ?? 0;
}

function isDone(model: InboxPolicyModel, channelId: string): boolean {
  return model.doneChannelIds.includes(channelId);
}

function channelMessages(model: InboxPolicyModel, channelId: string): InboxPolicyMessage[] {
  return model.messages
    .filter((message) => message.channelId === channelId)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function unreadMessages(model: InboxPolicyModel, channelId: string): InboxPolicyMessage[] {
  const cursor = lastReadSeq(model, channelId);
  const currentReceiverType = receiverType(model);
  const currentReceiverId = receiverId(model);
  return channelMessages(model, channelId).filter((message) =>
    message.seq > cursor && !(message.senderType === currentReceiverType && message.senderId === currentReceiverId)
  );
}

function isVisibleMentionForReceiver(model: InboxPolicyModel, mention: InboxPolicyMentionFact): boolean {
  return (mention.mentionKind ?? "personal") === "personal"
    && mention.targetType === receiverType(model)
    && mention.targetId === receiverId(model)
    && (mention.notifiableAtSend === true || mention.notified === true);
}

function hasUnreadMention(model: InboxPolicyModel, sourceChannelId: string): boolean {
  const cursor = lastReadSeq(model, sourceChannelId);
  return model.mentionFacts.some((mention) =>
    mention.channelId === sourceChannelId
      && isVisibleMentionForReceiver(model, mention)
      && mention.messageSeq > cursor
  );
}

function hasAnyMention(model: InboxPolicyModel, sourceChannelId: string): boolean {
  return model.mentionFacts.some((mention) =>
    mention.channelId === sourceChannelId && isVisibleMentionForReceiver(model, mention)
  );
}

function latestMentionMessage(model: InboxPolicyModel, sourceChannelId: string): InboxPolicyMessage | null {
  const mentionSeq = Math.max(
    0,
    ...model.mentionFacts
      .filter((mention) => mention.channelId === sourceChannelId && isVisibleMentionForReceiver(model, mention) && mention.notified === true)
      .map((mention) => mention.messageSeq),
  );
  return channelMessages(model, sourceChannelId).find((message) => message.seq === mentionSeq) ?? null;
}

function visibleMentionMessages(model: InboxPolicyModel, sourceChannelId: string): InboxPolicyMessage[] {
  const mentionSeqs = new Set(
    model.mentionFacts
      .filter((mention) => mention.channelId === sourceChannelId && isVisibleMentionForReceiver(model, mention))
      .map((mention) => mention.messageSeq),
  );
  return channelMessages(model, sourceChannelId).filter((message) => mentionSeqs.has(message.seq));
}

function unreadVisibleMentionMessages(model: InboxPolicyModel, sourceChannelId: string): InboxPolicyMessage[] {
  const cursor = lastReadSeq(model, sourceChannelId);
  return visibleMentionMessages(model, sourceChannelId).filter((message) => message.seq > cursor);
}

function receiverActivityMessages(model: InboxPolicyModel, sourceChannelId: string): InboxPolicyMessage[] {
  const muteStartSeq = receiverMuteStartSeq(model, sourceChannelId);
  if (muteStartSeq == null) return channelMessages(model, sourceChannelId);
  const mentionSeqs = new Set(visibleMentionMessages(model, sourceChannelId).map((message) => message.seq));
  return channelMessages(model, sourceChannelId).filter((message) =>
    message.seq < muteStartSeq || mentionSeqs.has(message.seq)
  );
}

function unreadReceiverActivityMessages(model: InboxPolicyModel, sourceChannelId: string): InboxPolicyMessage[] {
  const cursor = lastReadSeq(model, sourceChannelId);
  const currentReceiverType = receiverType(model);
  const currentReceiverId = receiverId(model);
  return receiverActivityMessages(model, sourceChannelId).filter((message) =>
    message.seq > cursor && !(message.senderType === currentReceiverType && message.senderId === currentReceiverId)
  );
}

function latestMessage(messages: readonly InboxPolicyMessage[]): InboxPolicyMessage | null {
  return messages.length > 0 ? messages[messages.length - 1]! : null;
}

function parentChannelForThread(
  channelsById: Map<string, InboxPolicyChannel>,
  messagesById: Map<string, InboxPolicyMessage>,
  thread: InboxPolicyChannel,
): InboxPolicyChannel | null {
  const parentMessageId = thread.parentMessageId;
  if (!parentMessageId) return null;
  const parentMessage = messagesById.get(parentMessageId);
  if (!parentMessage) return null;
  return channelsById.get(parentMessage.channelId) ?? null;
}

function parentMessageForThread(
  messagesById: Map<string, InboxPolicyMessage>,
  thread: InboxPolicyChannel,
): InboxPolicyMessage | null {
  return thread.parentMessageId ? messagesById.get(thread.parentMessageId) ?? null : null;
}

function threadParentVisible(model: InboxPolicyModel, parent: InboxPolicyChannel): boolean {
  return !parent.deleted
    && !parent.archived
    && (parent.type === "channel" || isCurrentReceiverMember(model, parent.id));
}

function activeThreadFollow(model: InboxPolicyModel, threadChannelId: string): boolean {
  const currentReceiverType = receiverType(model);
  const currentReceiverId = receiverId(model);
  return model.threadFollows.some((follow) =>
    follow.threadChannelId === threadChannelId
      && follow.followerType === currentReceiverType
      && follow.followerId === currentReceiverId
      && !follow.done
      && !follow.unfollowed
  );
}

function chatTypesForCurrentFramework(filter: InboxPolicyFilter): Set<InboxPolicyChannelType> {
  // Mirrors the current bifurcated PG/RW contract: the all route excludes private
  // chat rows, while unread/mentions use the wider legacy query.
  return filter === "all"
    ? new Set(["channel", "joint", "dm"])
    : new Set(["channel", "private", "joint", "dm"]);
}

function projectChatRows(model: InboxPolicyModel, filter: InboxPolicyFilter): InboxPolicyRow[] {
  const eligibleTypes = chatTypesForCurrentFramework(filter);
  const rows: InboxPolicyRow[] = [];
  for (const channel of model.channels) {
    if (!eligibleTypes.has(channel.type) || channel.deleted || channel.archived) continue;
    if (!isCurrentReceiverMember(model, channel.id) || isDone(model, channel.id)) continue;
    const messages = receiverActivityMessages(model, channel.id);
    const latest = latestMessage(messages);
    if (!latest) continue;
    const unread = unreadReceiverActivityMessages(model, channel.id);
    rows.push({
      kind: channel.type === "dm" ? "dm" : "channel",
      sourceChannelId: channel.id,
      storageChannelId: channel.id,
      activityAt: latest.createdAt,
      latestMessageId: latest.id,
      firstUnreadMessageId: unread[0]?.id ?? null,
      unreadCount: unread.length,
      hasMention: hasUnreadMention(model, channel.id),
      hasAnyMention: hasAnyMention(model, channel.id),
      mentionOnly: false,
    });
  }
  return rows;
}

function projectFollowedThreadRows(model: InboxPolicyModel): InboxPolicyRow[] {
  const channelsById = byId(model.channels);
  const messagesById = byId(model.messages);
  const rows: InboxPolicyRow[] = [];
  for (const channel of model.channels) {
    if (channel.type !== "thread" || channel.deleted) continue;
    if (!activeThreadFollow(model, channel.id)) continue;
    const parent = parentChannelForThread(channelsById, messagesById, channel);
    const parentMessage = parentMessageForThread(messagesById, channel);
    if (!parent || !parentMessage || !threadParentVisible(model, parent)) continue;
    const replies = channelMessages(model, channel.id);
    const latestReply = latestMessage(replies);
    const latest = latestReply ?? parentMessage;
    const unread = unreadMessages(model, channel.id);
    rows.push({
      kind: "thread",
      sourceChannelId: channel.id,
      storageChannelId: channel.id,
      parentChannelId: parent.id,
      parentMessageId: parentMessage.id,
      activityAt: latest.createdAt,
      latestActivityMessageId: latest.id,
      firstUnreadMessageId: unread[0]?.id ?? null,
      replyCount: replies.length,
      unreadCount: unread.length,
      hasMention: hasUnreadMention(model, channel.id),
      hasAnyMention: hasAnyMention(model, channel.id),
      mentionOnly: false,
    });
  }
  return rows;
}

function projectMentionOnlyRows(model: InboxPolicyModel, filter: InboxPolicyFilter): InboxPolicyRow[] {
  const channelsById = byId(model.channels);
  const messagesById = byId(model.messages);
  const rows: InboxPolicyRow[] = [];

  for (const channel of model.channels) {
    if (channel.deleted || channel.archived) continue;
    if (channel.type === "channel" && !isCurrentReceiverMember(model, channel.id) && !isDone(model, channel.id)) {
      const latest = latestMentionMessage(model, channel.id);
      if (latest) {
        rows.push({
          kind: "channel",
          sourceChannelId: channel.id,
          storageChannelId: channel.id,
          activityAt: latest.createdAt,
          latestMessageId: latest.id,
          firstUnreadMessageId: latest.id,
          unreadCount: 0,
          hasMention: true,
          hasAnyMention: true,
          mentionOnly: true,
        });
      }
    }

    if (channel.type === "thread" && !activeThreadFollow(model, channel.id)) {
      const parent = parentChannelForThread(channelsById, messagesById, channel);
      const parentMessage = parentMessageForThread(messagesById, channel);
      const latest = latestMentionMessage(model, channel.id);
      if (parent && parent.type === "channel" && !parent.deleted && !parent.archived && parentMessage && latest) {
        rows.push({
          kind: "thread",
          sourceChannelId: channel.id,
          storageChannelId: channel.id,
          parentChannelId: parent.id,
          parentMessageId: parentMessage.id,
          activityAt: latest.createdAt,
          latestActivityMessageId: latest.id,
          firstUnreadMessageId: latest.id,
          replyCount: 0,
          unreadCount: 0,
          hasMention: true,
          hasAnyMention: true,
          mentionOnly: true,
        });
      }
    }
  }

  return rows;
}

function rowPassesFilter(row: InboxPolicyRow, filter: InboxPolicyFilter): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return !row.mentionOnly && row.unreadCount > 0;
  return row.hasAnyMention;
}

function rowKey(row: InboxPolicyRow): string {
  return `${row.kind}:${row.sourceChannelId}`;
}

export function projectCurrentInboxPolicy(
  model: InboxPolicyModel,
  filter: InboxPolicyFilter = "all",
): InboxPolicyProjection {
  const rows = [
    ...projectChatRows(model, filter),
    ...projectFollowedThreadRows(model),
    ...projectMentionOnlyRows(model, filter),
  ]
    .filter((row) => rowPassesFilter(row, filter))
    .sort((a, b) => b.activityAt - a.activityAt || rowKey(a).localeCompare(rowKey(b)));

  return {
    rows,
    totalCount: rows.length,
    totalUnreadCount: rows.reduce((sum, row) => sum + row.unreadCount, 0),
  };
}

function receiverMuted(model: InboxPolicyModel, sourceChannelId: string): boolean {
  return (model.mutedChannelIds?.includes(sourceChannelId) ?? false) || model.muteFromSeqByChannel?.[sourceChannelId] != null;
}

function receiverMuteStartSeq(model: InboxPolicyModel, sourceChannelId: string): number | null {
  const explicitStart = model.muteFromSeqByChannel?.[sourceChannelId];
  if (typeof explicitStart === "number" && Number.isFinite(explicitStart)) return explicitStart;
  return model.mutedChannelIds?.includes(sourceChannelId) ? 0 : null;
}

function receiverDoNotDisturb(model: InboxPolicyModel): boolean {
  return receiverType(model) === "user" && (model.doNotDisturbUserIds?.includes(receiverId(model)) ?? false);
}

function notificationClassForRow(model: InboxPolicyModel, row: InboxPolicyRow): InboxPolicyNotificationClass {
  if (row.hasMention) return "personal_mention";
  if (row.unreadCount <= 0) return "none";
  if (row.mentionOnly) return "none";
  if (receiverMuted(model, row.sourceChannelId)) return "none";
  if (receiverDoNotDisturb(model)) return "none";
  return "unread";
}

export function projectInboxReceiverEffects(model: InboxPolicyModel): InboxPolicyReceiverEffects {
  const all = projectCurrentInboxPolicy(model, "all").rows;
  const unread = projectCurrentInboxPolicy(model, "unread").rows;
  const mentions = projectCurrentInboxPolicy(model, "mentions").rows;
  const byKey = new Map<string, InboxPolicyReceiverEffect>();

  for (const [filter, rows] of [
    ["all", all],
    ["unread", unread],
    ["mentions", mentions],
  ] as const) {
    for (const row of rows) {
      const key = rowKey(row);
      const existing = byKey.get(key);
      const effect: InboxPolicyReceiverEffect = existing ?? {
        key,
        kind: row.kind,
        sourceChannelId: row.sourceChannelId,
        inAll: false,
        inUnread: false,
        inMentions: false,
        unreadCount: row.unreadCount,
        hasMention: row.hasMention,
        mentionOnly: row.mentionOnly,
        notification: notificationClassForRow(model, row),
      };
      if (filter === "all") effect.inAll = true;
      if (filter === "unread") effect.inUnread = true;
      if (filter === "mentions") effect.inMentions = true;
      byKey.set(key, effect);
    }
  }

  return {
    receiverType: receiverType(model),
    receiverId: receiverId(model),
    rows: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}
