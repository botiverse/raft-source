/**
 * The WeChat bridge's poll and mirror worker (design "微信接入 Ottie" v8-v11,
 * task #proj-assistant:#14). The binding flow is wechatBridgeService.ts.
 *
 * One runner per active binding across all replicas: a replica claims the
 * binding's lease (lease_owner, lease_generation + 1, lease_expires_at) and
 * then long-polls iLink's getupdates for it while it holds the lease. Every
 * cursor the runner moves (get_updates_buf, outbound_seq), every tag and
 * outbound record it writes and every claim it makes (greeting, count note,
 * no-reply notice) is fenced by `id AND lease_owner AND lease_generation` in
 * the same statement or transaction (the exported functions below), so a
 * replica whose lease was taken over changes nothing. The gate (both flags
 * for the owner, fail closed; the assistant still the owner's; the owner able
 * to post in the DM) is checked before every long poll, again before what a
 * poll returned is tagged or posted, and before anything is sent. Either flag
 * going off is a kill switch: the runner stops at that check and the bridge
 * sends nothing more for the binding, not even a no-reply notice.
 *
 * Inbound (getupdates): only text from the bound WeChat user is accepted;
 * anything else is dropped without its content and counted in the audit event
 * `assistant.wechat_messages_dropped` (the bot's own echoes are ignored). Each
 * accepted message is tagged FIRST (wechat_bridge_inbound_messages, random_id
 * `wechat:<uuid>`, deduped on (binding_id, wechat_message_key)), then posted
 * into the owner's DM with Ottie as the owner with that randomId (idempotent
 * per sender), then its message_id is filled. The cursor moves only after
 * every accepted message is posted, so a crash anywhere in between makes iLink
 * hand the same messages again and the replay finds the tag (one message).
 * Then, answering the newest message: the greeting "已连接到 <owner> 的 Ottie。"
 * (once per binding: greeted_at is claimed before the send and given back when
 * the send failed, so the next message tries again) and, when replies were
 * left in Raft, the count-only note "还有 N 条回复在 Raft 里。".
 *
 * Outbound (every few seconds while the lease is held): the DM is read by seq
 * from outbound_seq (plus the rows that committed late below it, from the
 * previous read's horizon; syncHorizon.ts). Each top-level chat message of the
 * binding's assistant is asked getWeChatMirrorDecision: only a message marked
 * during a turn a WeChat message triggered or was merged into, answering an inbound of this binding whose
 * context token is still there and inside its 24-hour window, is sent
 * (client_id = the Raft message id), after its wechat_bridge_outbound_messages
 * row is written (a crash or a retry never sends twice; a row a crash left
 * `sending` for longer than a lease counts as failed). Everything else stays
 * in Raft and counts toward the note. Thread replies (other channels), the
 * owner's messages and anyone else's are never read.
 *
 * No-reply notice: an inbound batch is the owner's WeChat messages that reached
 * Raft (received_at) since the last mirrored reply or the last notice; a
 * message iLink delivers late is timed from its arrival. Ten minutes after a
 * batch began with no mirrored reply since, "Ottie 暂时还没有回复，可以稍后再发一次。"
 * answers its newest message, once (no_reply_notice_at is claimed first); a
 * message arriving after the notice starts the next batch. When the
 * assistant's pushes have stopped (agent_inbox_push_registrations.disabled_at),
 * asking again won't help, so it says "Ottie 暂时收不到消息，请到 Raft 里查看。" instead.
 *
 * iLink -14 (stale token) on any call: the binding becomes reconnect_required
 * (polling stops), `assistant.wechat_token_stale` is audited and one system
 * notice in the DM asks the owner to reconnect.
 *
 * The 24-hour reply window starts at the earlier of iLink's send time (sent_at)
 * and the arrival (received_at); a sweep clears context tokens when it closes
 * (the tags stay: they are what makes a turn a WeChat turn) and forgets old outbound
 * records.
 *
 * Off without WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY, or with
 * WECHAT_BRIDGE_WORKER_DISABLED=1 (the deployment kill switch). Nothing here
 * logs or traces message text, tokens or iLink ids.
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Tracer } from "@botiverse/raft-shared";
import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import { assistantOwnerPassesSso } from "./sso/ssoEnforcement";
import { agentInboxPushRegistrations, agents, channels, messages, users, wechatBridgeBindings, wechatBridgeInboundMessages, wechatBridgeOutboundMessages } from "../db/schema";
import { recordTraceEvent } from "../tracing/semanticTrace";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { resolveAssistantOwner } from "./assistantService";
import * as channelService from "./channelService";
import { ChannelArchivedError } from "./channelService";
import { DmPeerNotMemberError } from "./dmSendPolicy";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "./planService";
import * as messageService from "./messageService";
import { readMessagesAcrossSyncHorizon, syncHorizonFromDatabase, type SyncHorizon } from "./syncHorizon";
import { broadcastWeChatNotice, isWeChatBridgeAvailable } from "./wechatBridgeService";
import { wechatBridgeCredentialCipher } from "./wechatBridgeCredentialCipher";
import {
  ILINK_STALE_TOKEN_CODE,
  ILinkRequestError,
  ILinkStaleTokenError,
  wechatILinkClient,
  type ILinkBotToken,
  type ILinkInboundMessage,
  type ILinkUpdates,
  type WeChatContextToken,
  type WeChatILinkClient,
} from "./wechatILinkClient";
import { getWeChatMirrorDecision } from "./wechatMirrorDecision";

// ── Settings ────────────────────────────────────────────────────────────────

/** Kill switch: `1`/`true` stops every replica's worker from polling or sending. */
export const WECHAT_BRIDGE_WORKER_DISABLED_ENV = "WECHAT_BRIDGE_WORKER_DISABLED";
/** A reply's context token is good for 24 hours after the message it answers was sent. */
export const WECHAT_CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60_000;
/** The no-reply notice goes this long after a batch began with no mirrored reply. */
export const WECHAT_NO_REPLY_NOTICE_AFTER_MS = 10 * 60_000;
export const WECHAT_BRIDGE_LEASE_MS = 90_000;
const SCAN_INTERVAL_MS = 10_000;
const OUTBOUND_INTERVAL_MS = 2_000;
/** A poll answered sooner than this with nothing (or without a new cursor) waits, so iLink is not hammered. */
const MIN_POLL_INTERVAL_MS = 1_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A binding whose gate is closed (or whose token does not open) is not tried again here for this long. */
const GATE_RETRY_MS = 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Outbound records past this are forgotten: the cursor and the horizon are long past them. */
const OUTBOUND_RECORD_TTL_MS = 30 * 24 * 60 * 60_000;
const SCAN_BATCH = 200;
const OUTBOUND_PAGE = 50;
const OUTBOUND_PAGES_PER_PASS = 10;
const LATE_CAP = 200;
const SHUTDOWN_WAIT_MS = 5_000;
/** Core's longest message (routes/messages.ts MAX_MESSAGE_LENGTH). */
const MAX_MESSAGE_LENGTH = 32_000;

export const WECHAT_NO_REPLY_NOTICE_TEXT = "Ottie 暂时还没有回复，可以稍后再发一次。";
/** The no-reply notice while the assistant's pushes have stopped: no retry advice (Antx). */
export const WECHAT_PUSH_STOPPED_NOTICE_TEXT = "Ottie 暂时收不到消息，请到 Raft 里查看。";
export function wechatGreetingText(ownerName: string): string {
  return `已连接到 ${ownerName} 的 Ottie。`;
}
export function wechatLeftInRaftText(count: number): string {
  return `还有 ${count} 条回复在 Raft 里。`;
}
/** The DM notice after iLink answered -14; final copy is settled with the web dialog (PR 3). */
export const WECHAT_RECONNECT_NOTICE_TEXT = "微信连接已失效，Ottie 收不到也发不出微信消息了。请在 Ottie 设置里重新连接微信。";

const RECONNECT_NOTICE_POLICY = {
  mode: "record",
  producer: "assistant.wechat_reconnect_required",
  reason: "the owner learns their WeChat stopped working and must reconnect it",
} as const;

export function weChatBridgeWorkerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[WECHAT_BRIDGE_WORKER_DISABLED_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

// ── The lease and the fenced writes ─────────────────────────────────────────

const b = wechatBridgeBindings;
type BindingRow = typeof wechatBridgeBindings.$inferSelect;
type InboundRow = typeof wechatBridgeInboundMessages.$inferSelect;

export interface WeChatBindingLease {
  bindingId: string;
  owner: string;
  generation: number;
}

function heldBy(lease: WeChatBindingLease) {
  return and(eq(b.id, lease.bindingId), eq(b.leaseOwner, lease.owner), eq(b.leaseGeneration, lease.generation));
}

/** Take an active binding's lease when nobody holds it (or it expired). Exactly one of racing claims wins. */
export async function claimWeChatBindingLease(input: { bindingId: string; owner: string; now: Date; leaseMs?: number }): Promise<WeChatBindingLease | null> {
  const [row] = await getDb().update(b).set({
    leaseOwner: input.owner,
    leaseGeneration: sql`${b.leaseGeneration} + 1`,
    leaseExpiresAt: new Date(input.now.getTime() + (input.leaseMs ?? WECHAT_BRIDGE_LEASE_MS)),
  }).where(and(
    eq(b.id, input.bindingId),
    eq(b.state, "active"),
    or(isNull(b.leaseExpiresAt), lt(b.leaseExpiresAt, input.now)),
  )).returning({ generation: b.leaseGeneration });
  return row ? { bindingId: input.bindingId, owner: input.owner, generation: row.generation } : null;
}

/** Extend the lease while it is still this holder's and the binding active; the fresh row, or null when lost. */
export async function renewWeChatBindingLease(lease: WeChatBindingLease, now: Date, leaseMs: number = WECHAT_BRIDGE_LEASE_MS): Promise<BindingRow | null> {
  const [row] = await getDb().update(b)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs) })
    .where(and(heldBy(lease), eq(b.state, "active")))
    .returning();
  return row ?? null;
}

/** Move get_updates_buf, only for the lease's holder. False: the lease is gone and the cursor did not move. */
export async function advanceWeChatUpdatesCursor(lease: WeChatBindingLease, getUpdatesBuf: string, now: Date, leaseMs: number = WECHAT_BRIDGE_LEASE_MS): Promise<boolean> {
  const [row] = await getDb().update(b)
    .set({ getUpdatesBuf, leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(and(heldBy(lease), eq(b.state, "active")))
    .returning({ id: b.id });
  return Boolean(row);
}

/** Move outbound_seq (and the read horizon), only for the lease's holder. */
export async function advanceWeChatOutboundCursor(lease: WeChatBindingLease, cursor: { seq: number; horizon: SyncHorizon | null }): Promise<boolean> {
  const [row] = await getDb().update(b)
    .set({ outboundSeq: cursor.seq, outboundHorizon: cursor.horizon })
    .where(and(heldBy(lease), eq(b.state, "active")))
    .returning({ id: b.id });
  return Boolean(row);
}

export async function releaseWeChatBindingLease(lease: WeChatBindingLease): Promise<void> {
  await getDb().update(b).set({ leaseOwner: null, leaseExpiresAt: null }).where(heldBy(lease));
}

export interface WeChatInboundToTag {
  key: string;
  contextToken: WeChatContextToken | null;
  /** When it reached Raft (received_at): the no-reply notice's clock. */
  receivedAt: Date;
  /** iLink's send time (sent_at), null when it named none: only the reply window uses it. */
  sentAt: Date | null;
}

/**
 * Step 1 of the tag-first contract, fenced: one transaction checks (and
 * extends) the lease, inserts the tags (an existing tag is kept: a replay
 * posts with its randomId) and audits the dropped count. The binding's tags
 * for these keys, or null when the lease is gone (nothing written).
 */
export async function tagWeChatInbound(lease: WeChatBindingLease, input: {
  binding: Pick<BindingRow, "id" | "serverId" | "userId" | "agentId" | "dmChannelId">;
  accepted: readonly WeChatInboundToTag[];
  dropped: number;
  now: Date;
  leaseMs?: number;
}): Promise<InboundRow[] | null> {
  const { binding } = input;
  return getDb().transaction(async (tx) => {
    const [held] = await tx.update(b)
      .set({ leaseExpiresAt: new Date(input.now.getTime() + (input.leaseMs ?? WECHAT_BRIDGE_LEASE_MS)) })
      .where(and(heldBy(lease), eq(b.state, "active")))
      .returning({ id: b.id });
    if (!held) return null;
    if (input.accepted.length > 0) {
      await tx.insert(wechatBridgeInboundMessages).values(input.accepted.map((message) => ({
        bindingId: binding.id,
        ownerUserId: binding.userId,
        dmChannelId: binding.dmChannelId,
        wechatMessageKey: message.key,
        randomId: `wechat:${randomUUID()}`,
        contextToken: message.contextToken,
        receivedAt: message.receivedAt,
        sentAt: message.sentAt,
      }))).onConflictDoNothing({ target: [wechatBridgeInboundMessages.bindingId, wechatBridgeInboundMessages.wechatMessageKey] });
    }
    if (input.dropped > 0) {
      await recordIntegrationAuditEvent({
        serverId: binding.serverId,
        eventType: "assistant.wechat_messages_dropped",
        outcome: "failure",
        source: "system",
        actor: { type: "system", id: null },
        subject: { type: "human", id: binding.userId },
        target: { type: "wechat_bridge_binding", id: binding.id },
        metadata: { agentId: binding.agentId, droppedCount: input.dropped },
      }, tx);
    }
    if (input.accepted.length === 0) return [];
    return tx.select().from(wechatBridgeInboundMessages).where(and(
      eq(wechatBridgeInboundMessages.bindingId, binding.id),
      inArray(wechatBridgeInboundMessages.wechatMessageKey, input.accepted.map((message) => message.key)),
    ));
  });
}

/**
 * The outbound record for one of the assistant's messages, written before
 * anything is sent, fenced. `not_mirrored` counts toward the note in the same
 * transaction. "seen": a record already exists (never handled twice).
 */
export async function recordWeChatOutbound(lease: WeChatBindingLease, input: {
  messageId: string;
  state: "sending" | "not_mirrored";
  now: Date;
}): Promise<"recorded" | "seen" | "lost"> {
  return getDb().transaction(async (tx) => {
    const [held] = await tx.select({ id: b.id }).from(b).where(and(heldBy(lease), eq(b.state, "active"))).for("update");
    if (!held) return "lost";
    const [inserted] = await tx.insert(wechatBridgeOutboundMessages)
      .values({ messageId: input.messageId, bindingId: lease.bindingId, state: input.state, createdAt: input.now, updatedAt: input.now })
      .onConflictDoNothing()
      .returning({ messageId: wechatBridgeOutboundMessages.messageId });
    if (!inserted) return "seen";
    if (input.state === "not_mirrored") {
      await tx.update(b).set({ unmirroredCount: sql`${b.unmirroredCount} + 1` }).where(eq(b.id, lease.bindingId));
    }
    return "recorded";
  });
}

/**
 * A reply a crash left `sending` (recorded, then the replica died) for longer
 * than `olderThanMs`: failed, never resent, counted toward the note. Fenced;
 * how many, or null when the lease is gone.
 */
export async function failStaleWeChatOutbound(lease: WeChatBindingLease, input: { now: Date; olderThanMs: number }): Promise<number | null> {
  return getDb().transaction(async (tx) => {
    const [held] = await tx.select({ id: b.id }).from(b).where(and(heldBy(lease), eq(b.state, "active"))).for("update");
    if (!held) return null;
    const failed = await tx.update(wechatBridgeOutboundMessages)
      .set({ state: "failed", updatedAt: input.now })
      .where(and(
        eq(wechatBridgeOutboundMessages.bindingId, lease.bindingId),
        eq(wechatBridgeOutboundMessages.state, "sending"),
        lt(wechatBridgeOutboundMessages.updatedAt, new Date(input.now.getTime() - input.olderThanMs)),
      ))
      .returning({ messageId: wechatBridgeOutboundMessages.messageId });
    if (failed.length > 0) {
      await tx.update(b).set({ unmirroredCount: sql`${b.unmirroredCount} + ${failed.length}` }).where(eq(b.id, lease.bindingId));
    }
    return failed.length;
  });
}

/** Claim the binding's greeting (once per binding), fenced. */
export async function claimWeChatGreeting(lease: WeChatBindingLease, now: Date): Promise<boolean> {
  const [claimed] = await getDb().update(b)
    .set({ greetedAt: now })
    .where(and(heldBy(lease), eq(b.state, "active"), isNull(b.greetedAt)))
    .returning({ id: b.id });
  return Boolean(claimed);
}

/** Give a claimed greeting back after its send failed: the next inbound message tries again. */
async function releaseWeChatGreeting(bindingId: string, claimedAt: Date): Promise<void> {
  await getDb().update(b).set({ greetedAt: null })
    .where(and(eq(b.id, bindingId), sql`${b.greetedAt} = ${claimedAt.toISOString()}::timestamptz`));
}

/** Take the count of replies left in Raft (reset to 0), fenced: the count, or null when the lease is gone. */
export async function takeWeChatUnmirroredCount(lease: WeChatBindingLease): Promise<number | null> {
  return getDb().transaction(async (tx) => {
    const [current] = await tx.select({ count: b.unmirroredCount }).from(b)
      .where(and(heldBy(lease), eq(b.state, "active")))
      .for("update");
    if (!current) return null;
    if (current.count > 0) await tx.update(b).set({ unmirroredCount: 0 }).where(eq(b.id, lease.bindingId));
    return current.count;
  });
}

/**
 * Claim the no-reply notice of the batch that began after `lastMirroredAt`
 * and `noReplyNoticeAt` (as read): fenced, and only while neither moved.
 */
export async function claimWeChatNoReplyNotice(lease: WeChatBindingLease, input: {
  lastMirroredAt: Date | null;
  noReplyNoticeAt: Date | null;
  now: Date;
}): Promise<boolean> {
  const unchanged = (column: typeof b.lastMirroredAt | typeof b.noReplyNoticeAt, value: Date | null) => value
    ? sql`${column} = ${value.toISOString()}::timestamptz`
    : isNull(column);
  const [claimed] = await getDb().update(b)
    .set({ noReplyNoticeAt: input.now })
    .where(and(heldBy(lease), eq(b.state, "active"), unchanged(b.lastMirroredAt, input.lastMirroredAt), unchanged(b.noReplyNoticeAt, input.noReplyNoticeAt)))
    .returning({ id: b.id });
  return Boolean(claimed);
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Whether this binding may be polled now: the key is configured, both flags
 * are on for the owner, the agent is still the owner's live assistant in a
 * server they belong to, and the owner could post in the DM right now (as
 * firstPartyAppMessages.postMessageAsReader checks: not deleted or archived,
 * may post, not read-only by billing or quota), and their organization's
 * require-SSO lets them now. A closed gate polls nothing,
 * so iLink keeps the messages until it opens. Any error reads as no.
 */
export async function weChatBindingGateOpen(binding: { serverId: string; userId: string; agentId: string; dmChannelId: string }): Promise<boolean> {
  try {
    if (!await isWeChatBridgeAvailable(binding.serverId, binding.userId)) return false;
    if ((await resolveAssistantOwner(binding.agentId, binding.serverId)) !== binding.userId) return false;
    const channel = await channelService.getChannel(binding.dmChannelId);
    if (!channel || channel.serverId !== binding.serverId || channel.deletedAt || channel.archivedAt) return false;
    if (!await channelService.canUserPostToChannel(channel.id, binding.userId)) return false;
    // The bridge writes as the owner: only while their organization lets them (RFC 083 §6.2).
    const [owner] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, binding.userId));
    if (!owner || !(await assistantOwnerPassesSso({ userId: binding.userId, email: owner.email })).ok) return false;
    return !(await isChannelReadOnlyByBillingFeature(channel.id, binding.serverId) || await isChannelReadOnlyByQuota(channel.id, binding.serverId));
  } catch {
    return false;
  }
}

// ── -14 ─────────────────────────────────────────────────────────────────────

/**
 * iLink answered -14: the bot token is dead. Once per binding (only an active
 * binding moves): reconnect_required, the lease dropped, audited, and a system
 * notice in the owner's DM (committed together, broadcast after). True when
 * this call made the change.
 */
export async function markWeChatBindingStale(input: {
  binding: Pick<BindingRow, "id" | "serverId" | "userId" | "agentId" | "dmChannelId">;
  now: Date;
  io?: SocketServer;
  orchestrator?: AgentOrchestrator;
}): Promise<boolean> {
  const { binding, now } = input;
  const notice = await getDb().transaction(async (tx) => {
    const [moved] = await tx.update(b)
      .set({ state: "reconnect_required", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(b.id, binding.id), eq(b.state, "active")))
      .returning({ id: b.id });
    if (!moved) return null;
    await recordIntegrationAuditEvent({
      serverId: binding.serverId,
      eventType: "assistant.wechat_token_stale",
      outcome: "failure",
      source: "system",
      actor: { type: "system", id: null },
      subject: { type: "human", id: binding.userId },
      target: { type: "wechat_bridge_binding", id: binding.id },
      metadata: { agentId: binding.agentId, errorCode: ILINK_STALE_TOKEN_CODE },
    }, tx);
    const created = await messageService.createMessage(binding.dmChannelId, "user", "system", WECHAT_RECONNECT_NOTICE_TEXT, "system", undefined, {
      randomId: `wechat-reconnect:${binding.id}`,
      systemSubtype: RECONNECT_NOTICE_POLICY.producer,
    }, tx);
    await messageService.recordInboxFactsForPersistedMessages([created], { inboxFactPolicy: RECONNECT_NOTICE_POLICY, executor: tx });
    return created;
  });
  if (!notice) return false;
  recordTraceEvent("server.assistant.wechat.worker.token_stale", { binding_id: binding.id, agent_id: binding.agentId });
  await broadcastWeChatNotice({
    io: input.io,
    orchestrator: input.orchestrator,
    notice,
    ownerUserId: binding.userId,
    agentId: binding.agentId,
    policy: RECONNECT_NOTICE_POLICY,
    traceName: "server.assistant.wechat.reconnect_notice",
  });
  return true;
}

// ── The sweep ───────────────────────────────────────────────────────────────

/**
 * Clear every context token 24 hours after its message was sent (the rows
 * stay: they mark the turns they triggered) and forget outbound records
 * past their use. Idempotent; any replica may run it.
 */
export async function sweepWeChatBridgeExpiry(now: Date): Promise<{ tokensCleared: number; outboundForgotten: number }> {
  const cleared = await getDb().update(wechatBridgeInboundMessages)
    .set({ contextToken: null })
    .where(and(
      isNotNull(wechatBridgeInboundMessages.contextToken),
      // The window starts at the earlier of iLink's send time and the arrival (LEAST skips a null).
      sql`LEAST(${wechatBridgeInboundMessages.sentAt}, ${wechatBridgeInboundMessages.receivedAt}) < ${new Date(now.getTime() - WECHAT_CONTEXT_TOKEN_TTL_MS).toISOString()}::timestamptz`,
    ))
    .returning({ id: wechatBridgeInboundMessages.id });
  const forgotten = await getDb().delete(wechatBridgeOutboundMessages)
    .where(lt(wechatBridgeOutboundMessages.createdAt, new Date(now.getTime() - OUTBOUND_RECORD_TTL_MS)))
    .returning({ id: wechatBridgeOutboundMessages.messageId });
  if (cleared.length > 0 || forgotten.length > 0) {
    recordTraceEvent("server.assistant.wechat.worker.swept", { tokens_cleared: cleared.length, outbound_forgotten: forgotten.length });
  }
  return { tokensCleared: cleared.length, outboundForgotten: forgotten.length };
}

// ── The outbound read ───────────────────────────────────────────────────────

interface OutboundCandidate {
  id: string;
  seq: number;
  content: string;
  late: boolean;
}

/**
 * The assistant's top-level chat messages in the DM above `afterSeq` whose
 * transaction finished (the page) and, with the previous read's horizon,
 * those at or below it that finished since (the late rows), minus any the
 * outbound mirror already recorded: syncHorizon.readMessagesAcrossSyncHorizon.
 */
async function readOutboundCandidates(input: {
  dmChannelId: string;
  agentId: string;
  afterSeq: number;
  sinceHorizon: SyncHorizon | null;
}): Promise<{ horizon: SyncHorizon; page: OutboundCandidate[]; late: OutboundCandidate[] }> {
  const read = await readMessagesAcrossSyncHorizon({
    where: sql`${messages.channelId} = ${input.dmChannelId}
      AND ${messages.senderType} = 'agent'
      AND ${messages.senderId} = ${input.agentId}
      AND ${messages.messageType} = 'chat'
      AND ${messages.deletedAt} IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${wechatBridgeOutboundMessages} o WHERE o.message_id = ${messages.id})`,
    columns: sql`${messages.id} AS "id", ${messages.seq}::text AS "seq", ${messages.content} AS "content"`,
    afterSeq: input.afterSeq,
    sinceHorizon: input.sinceHorizon,
    pageLimit: OUTBOUND_PAGE,
    lateLimit: LATE_CAP,
  });
  const page: OutboundCandidate[] = [];
  const late: OutboundCandidate[] = [];
  for (const row of read.rows) {
    if (typeof row.id !== "string") continue;
    const candidate = { id: row.id, seq: Number(row.seq), content: typeof row.content === "string" ? row.content : "", late: row.late };
    (candidate.late ? late : page).push(candidate);
  }
  return { horizon: read.horizon, page, late };
}

// ── One binding's runner ────────────────────────────────────────────────────

export type WeChatRunnerStopReason =
  | "stopping"
  | "lease_lost"
  | "gate_closed"
  | "credential_unreadable"
  | "token_stale";

class StopRunner extends Error {
  override readonly name = "StopRunner";
  constructor(readonly reason: WeChatRunnerStopReason) {
    super(reason);
  }
}

export interface WeChatRunnerDeps {
  io?: SocketServer;
  orchestrator?: AgentOrchestrator;
  client: WeChatILinkClient;
  now: () => Date;
  tracer?: Tracer;
  leaseMs: number;
  outboundIntervalMs: number;
  noReplyAfterMs: number;
  minPollIntervalMs: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Full jitter: anywhere in [base/2, base] of an exponential step, capped. */
function backoffMs(failures: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** The dedupe key of an inbound message: iLink's message id, else its context token's digest. */
function inboundMessageKey(message: ILinkInboundMessage): string | null {
  if (message.messageId) return `id:${message.messageId}`;
  if (message.contextToken) return `ctx:${createHash("sha256").update(message.contextToken).digest("hex")}`;
  return null;
}

/** iLink's send time (create_time_ms), or null when it named none or a time still to come. */
function iLinkSentAt(message: ILinkInboundMessage, now: Date): Date | null {
  const created = message.createTimeMs;
  return created !== null && created > 0 && created <= now.getTime() ? new Date(created) : null;
}

/** Where a message's 24-hour reply window starts: the earlier of iLink's send time and its arrival. */
function replyWindowStart(row: { receivedAt: Date; sentAt: Date | null }): Date {
  return row.sentAt && row.sentAt < row.receivedAt ? row.sentAt : row.receivedAt;
}

function replyWindowOpen(row: { receivedAt: Date; sentAt: Date | null }, now: Date): boolean {
  return replyWindowStart(row).getTime() > now.getTime() - WECHAT_CONTEXT_TOKEN_TTL_MS;
}

function errorKind(err: unknown): string {
  if (err instanceof ILinkRequestError) return err.kind;
  return err instanceof Error ? err.name : "error";
}

/**
 * Polls and mirrors one binding while it holds the binding's lease. The
 * worker runs `run()`; tests drive `pollOnce()` and `outboundOnce()`. The
 * poll's processing and the outbound pass take turns (one at a time per
 * binding); the long poll itself does not hold that turn.
 */
export class WeChatBindingRunner {
  private readonly controller = new AbortController();
  private turn: Promise<unknown> = Promise.resolve();
  private iLinkLongPollMs: number | null = null;
  private lastRenewedMs = 0;
  private gateCheckedMs = 0;
  stopReason: WeChatRunnerStopReason | null = null;

  constructor(readonly lease: WeChatBindingLease, private readonly deps: WeChatRunnerDeps) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Stop: aborts the long poll and any request in flight. */
  abort(reason: WeChatRunnerStopReason = "stopping"): void {
    this.stopReason ??= reason;
    this.controller.abort();
  }

  /** Before every claim: a runner being stopped claims nothing it could then fail to send. */
  private assertRunning(): void {
    if (this.signal.aborted) throw new StopRunner("stopping");
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turn.then(fn, fn);
    this.turn = run.catch(() => undefined);
    return run;
  }

  private trace(name: string, attrs: Record<string, string | number | boolean> = {}): void {
    recordTraceEvent(`server.assistant.wechat.worker.${name}`, { binding_id: this.lease.bindingId, ...attrs }, this.deps.tracer);
  }

  /** The binding as this holder sees it now (renewing the lease when due), or StopRunner. */
  private async current(forceRenew: boolean): Promise<BindingRow> {
    const now = this.deps.now();
    let row: BindingRow | null;
    if (forceRenew || now.getTime() - this.lastRenewedMs >= this.deps.leaseMs / 3) {
      row = await renewWeChatBindingLease(this.lease, now, this.deps.leaseMs);
      if (row) this.lastRenewedMs = now.getTime();
    } else {
      [row = null] = await getDb().select().from(b).where(and(heldBy(this.lease), eq(b.state, "active"))).limit(1);
    }
    if (!row) throw new StopRunner("lease_lost");
    return row;
  }

  /** The gate, or StopRunner("gate_closed"). `force: false` reuses an answer under a few seconds old (passes that send nothing). */
  private async checkGate(binding: BindingRow, force: boolean): Promise<void> {
    const nowMs = this.deps.now().getTime();
    if (!force && nowMs - this.gateCheckedMs < this.deps.outboundIntervalMs * 5) return;
    if (!await weChatBindingGateOpen(binding)) throw new StopRunner("gate_closed");
    this.gateCheckedMs = nowMs;
  }

  private botToken(binding: BindingRow): ILinkBotToken {
    const token = wechatBridgeCredentialCipher()?.unseal({
      bindingId: binding.id,
      userId: binding.userId,
      ilinkBotId: binding.ilinkBotId,
      encryptedBotToken: binding.encryptedBotToken,
      envelopeKeyId: binding.envelopeKeyId,
      aadVersion: binding.aadVersion,
    }) ?? null;
    if (!token) throw new StopRunner("credential_unreadable");
    return token;
  }

  private async onILinkError(binding: BindingRow, err: unknown): Promise<void> {
    if (err instanceof ILinkStaleTokenError) {
      await markWeChatBindingStale({ binding, now: this.deps.now(), io: this.deps.io, orchestrator: this.deps.orchestrator });
      throw new StopRunner("token_stale");
    }
  }

  /** Send one text to the owner's WeChat. False when iLink refused, could not be reached or the runner stopped (-14 stops the runner). */
  private async send(binding: BindingRow, botToken: ILinkBotToken, input: { kind: string; clientId: string; contextToken: WeChatContextToken; text: string }): Promise<boolean> {
    try {
      await this.deps.client.sendTextMessage({
        baseUrl: binding.baseUrl,
        botToken,
        toUserId: binding.ilinkUserId,
        clientId: input.clientId,
        contextToken: input.contextToken,
        text: input.text,
        signal: this.signal,
      });
      return true;
    } catch (err) {
      await this.onILinkError(binding, err);
      this.trace("send_failed", { kind: input.kind, reason: this.signal.aborted ? "aborted" : errorKind(err) });
      return false;
    }
  }

  // ── Inbound ──

  /**
   * One getupdates round: gate, long poll, then (in this binding's turn) the
   * gate again, tag, post, move the cursor, greet and send the count note.
   * Returns false when the runner must stop.
   */
  async pollOnce(): Promise<boolean> {
    try {
      const binding = await this.current(true);
      await this.checkGate(binding, true);
      const botToken = this.botToken(binding);
      const started = this.deps.now().getTime();
      let updates: ILinkUpdates;
      try {
        updates = await this.deps.client.getUpdates({
          baseUrl: binding.baseUrl,
          botToken,
          getUpdatesBuf: binding.getUpdatesBuf,
          // iLink's suggestion once it made one; the client's default (and its cap) otherwise.
          longPollTimeoutMs: this.iLinkLongPollMs,
          signal: this.signal,
        });
      } catch (err) {
        if (this.signal.aborted) throw new StopRunner("stopping");
        await this.onILinkError(binding, err);
        throw err;
      }
      if (this.signal.aborted) throw new StopRunner("stopping");
      if (updates.longPollingTimeoutMs) this.iLinkLongPollMs = updates.longPollingTimeoutMs;
      const cursorMoved = await this.exclusive(() => this.acceptUpdates(botToken, updates));
      if (updates.messages.length === 0) {
        await sleep(started + this.deps.minPollIntervalMs - this.deps.now().getTime(), this.signal);
      } else if (!cursorMoved) {
        // Messages without a new cursor come back on the next poll: not at once.
        await sleep(this.deps.minPollIntervalMs, this.signal);
      }
      return true;
    } catch (err) {
      if (err instanceof StopRunner) {
        this.abort(err.reason);
        return false;
      }
      throw err;
    }
  }

  /** What one getupdates answer brought. True when it moved the cursor. */
  private async acceptUpdates(botToken: ILinkBotToken, updates: ILinkUpdates): Promise<boolean> {
    // Fresh after the long poll: the lease may have moved, and the gate closed, while it ran.
    // A closed gate here posts nothing and leaves the cursor where it is (iLink keeps the messages).
    const binding = await this.current(true);
    await this.checkGate(binding, true);
    this.assertRunning();
    const now = this.deps.now();
    const cursorMoves = Boolean(updates.getUpdatesBuf) && updates.getUpdatesBuf !== binding.getUpdatesBuf;
    const accepted = new Map<string, { message: ILinkInboundMessage; text: string }>();
    let dropped = 0;
    let ignored = 0;
    for (const message of updates.messages) {
      // The bot's own messages (an echo of a reply): never posted, not a stranger either.
      if (message.messageType === 2 || (message.fromUserId !== null && String(message.fromUserId) === String(binding.ilinkBotId))) {
        ignored += 1;
        continue;
      }
      const key = inboundMessageKey(message);
      // Text only, and it must stay so for now: bridging WeChat attachments
      // into the DM is not designed yet. A message without text (an image,
      // voice, a file) is dropped here and counted; a message's non-text items
      // are never posted.
      const text = message.text?.trim() ? message.text.slice(0, MAX_MESSAGE_LENGTH) : null;
      if (message.fromUserId !== binding.ilinkUserId || !text || !key) {
        dropped += 1;
        continue;
      }
      if (!accepted.has(key)) accepted.set(key, { message, text });
    }

    // Tag first, fenced. Drops are audited with the answer that moves past them,
    // so an answer iLink repeats (no new cursor) is not audited again each poll.
    const tagged = await tagWeChatInbound(this.lease, {
      binding,
      accepted: [...accepted].map(([key, { message }]) => ({ key, contextToken: message.contextToken, receivedAt: now, sentAt: iLinkSentAt(message, now) })),
      dropped: cursorMoves ? dropped : 0,
      now,
      leaseMs: this.deps.leaseMs,
    });
    if (!tagged) throw new StopRunner("lease_lost");

    // Then post, in iLink's order; a row already posted is a redelivery.
    const rowByKey = new Map(tagged.map((row) => [row.wechatMessageKey, row]));
    const posted: InboundRow[] = [];
    let duplicates = 0;
    let unposted = 0;
    let ownerName: string | null = null;
    for (const [key, { text }] of accepted) {
      const row = rowByKey.get(key);
      if (!row) continue;
      if (row.messageId) {
        duplicates += 1;
        continue;
      }
      ownerName ??= await ownerDisplayName(binding.userId);
      const outcome = await this.postInbound(binding, row, text, ownerName);
      if (outcome === "posted") posted.push(row);
      else unposted += 1;
    }
    this.trace("inbound", { accepted: posted.length, duplicates, dropped, ignored, refused: unposted });

    // Every accepted message is posted (or refused for good): the cursor may move.
    if (cursorMoves && !await advanceWeChatUpdatesCursor(this.lease, updates.getUpdatesBuf!, this.deps.now(), this.deps.leaseMs)) {
      throw new StopRunner("lease_lost");
    }

    const newest = [...posted].reverse().find((row) => row.contextToken);
    const contextToken = newest?.contextToken;
    if (newest && contextToken) {
      if (!binding.greetedAt) await this.greet(binding, botToken, contextToken, ownerName ?? await ownerDisplayName(binding.userId));
      // Ottie's replies up to now are counted before the note is taken.
      await this.mirrorPass(botToken);
      await this.sendLeftInRaftNote(binding, botToken, { id: newest.id, contextToken });
    }
    return cursorMoves;
  }

  /**
   * Post one tagged message as the owner (its randomId makes a replay the same
   * message), then fill the tag's message_id. A refusal that will not change
   * (the DM archived, the owner gone from it) leaves the tag unposted; anything
   * else throws, the cursor stays and iLink hands the message again.
   */
  private async postInbound(binding: BindingRow, row: InboundRow, text: string, ownerName: string): Promise<"posted" | "refused"> {
    const { io, orchestrator } = this.deps;
    if (!io || !orchestrator) throw new Error("posting a WeChat message needs the socket server and agent orchestrator");
    let messageId: string;
    try {
      // Load-bearing order: the DM message is written first, and the push to
      // the assistant follows from that write (broadcastAndDeliver). The
      // no-reply notice, ten minutes on, reads that push's outcome: pushes
      // stopped means "暂时收不到消息", not "try again".
      // slack-bridge-ordinary-message-producer: wechat_bridge.inbound
      const message = await messageService.broadcastAndDeliver(io, orchestrator, {
        channelId: binding.dmChannelId,
        senderType: "user",
        senderId: binding.userId,
        senderName: ownerName,
        content: text,
        randomId: row.randomId,
      });
      messageId = message.id;
    } catch (err) {
      if (err instanceof DmPeerNotMemberError || err instanceof ChannelArchivedError || err instanceof messageService.UserRandomIdConflictError) {
        this.trace("post_refused", { reason: err.name });
        return "refused";
      }
      throw err;
    }
    await getDb().update(wechatBridgeInboundMessages)
      .set({ messageId })
      .where(and(eq(wechatBridgeInboundMessages.id, row.id), isNull(wechatBridgeInboundMessages.messageId)));
    return "posted";
  }

  /**
   * "已连接到 X 的 Ottie。" (the scanner's sign of whose Ottie this is), once per
   * binding: claimed before the send, given back when the send failed (refused,
   * unreachable, or the runner stopping), so the next inbound message tries again.
   */
  private async greet(binding: BindingRow, botToken: ILinkBotToken, contextToken: WeChatContextToken, ownerName: string): Promise<void> {
    this.assertRunning();
    const claimedAt = this.deps.now();
    if (!await claimWeChatGreeting(this.lease, claimedAt)) return;
    const sent = await this.send(binding, botToken, { kind: "greeting", clientId: `raft-wechat-greeting:${binding.id}`, contextToken, text: wechatGreetingText(ownerName) });
    if (!sent) await releaseWeChatGreeting(binding.id, claimedAt);
  }

  /** The count-only note answering `row`: taken (reset) first; put back when the send failed. */
  private async sendLeftInRaftNote(binding: BindingRow, botToken: ILinkBotToken, row: { id: string; contextToken: WeChatContextToken }): Promise<void> {
    this.assertRunning();
    const taken = await takeWeChatUnmirroredCount(this.lease);
    if (taken === null) throw new StopRunner("lease_lost");
    if (taken <= 0) return;
    const sent = await this.send(binding, botToken, { kind: "left_in_raft", clientId: `raft-wechat-left:${row.id}`, contextToken: row.contextToken, text: wechatLeftInRaftText(taken) });
    if (!sent) {
      await getDb().update(b).set({ unmirroredCount: sql`${b.unmirroredCount} + ${taken}` }).where(eq(b.id, binding.id));
    }
  }

  // ── Outbound ──

  /** One outbound round in this binding's turn: settle crashed sends, mirror what is new, then the no-reply notice. */
  async outboundOnce(): Promise<boolean> {
    if (this.signal.aborted) return false;
    try {
      await this.exclusive(async () => {
        const binding = await this.current(false);
        await this.checkGate(binding, false);
        const botToken = this.botToken(binding);
        const failed = await failStaleWeChatOutbound(this.lease, { now: this.deps.now(), olderThanMs: this.deps.leaseMs });
        if (failed === null) throw new StopRunner("lease_lost");
        if (failed > 0) this.trace("sending_expired", { count: failed });
        await this.mirrorPass(botToken);
        await this.noReplyNotice(botToken);
      });
      return true;
    } catch (err) {
      if (err instanceof StopRunner) {
        this.abort(err.reason);
        return false;
      }
      throw err;
    }
  }

  private async mirrorPass(botToken: ILinkBotToken): Promise<void> {
    let binding = await this.current(false);
    let cursor = binding.outboundSeq;
    let horizon = binding.outboundHorizon;
    for (let page = 0; page < OUTBOUND_PAGES_PER_PASS; page += 1) {
      const read = await readOutboundCandidates({ dmChannelId: binding.dmChannelId, agentId: binding.agentId, afterSeq: cursor, sinceHorizon: horizon });
      const candidates = [...read.late, ...read.page].sort((left, right) => left.seq - right.seq);
      for (const candidate of candidates) {
        await this.mirrorOne(binding, botToken, candidate);
      }
      const nextSeq = read.page.reduce((max: number, row) => Math.max(max, row.seq), cursor);
      // More late rows than one read takes: keep the old horizon so the rest are read next time.
      const nextHorizon = read.late.length > LATE_CAP ? horizon : read.horizon;
      if (!await advanceWeChatOutboundCursor(this.lease, { seq: nextSeq, horizon: nextHorizon })) throw new StopRunner("lease_lost");
      cursor = nextSeq;
      horizon = nextHorizon;
      if (read.page.length < OUTBOUND_PAGE && read.late.length <= LATE_CAP) break;
      binding = await this.current(false);
    }
  }

  /** Where a message may be mirrored: its mark's inbound, of this binding, its context token present and in its window. */
  private async mirrorTarget(binding: BindingRow, messageId: string): Promise<{ contextToken: WeChatContextToken } | null> {
    const decision = await getWeChatMirrorDecision(messageId);
    if (!decision.mirror) return null;
    const [inbound] = await getDb().select({
      bindingId: wechatBridgeInboundMessages.bindingId,
      dmChannelId: wechatBridgeInboundMessages.dmChannelId,
      contextToken: wechatBridgeInboundMessages.contextToken,
      receivedAt: wechatBridgeInboundMessages.receivedAt,
      sentAt: wechatBridgeInboundMessages.sentAt,
    }).from(wechatBridgeInboundMessages).where(eq(wechatBridgeInboundMessages.randomId, decision.inboundRandomId)).limit(1);
    // Another binding's message (an earlier one this owner replaced) is never answered here.
    if (!inbound?.contextToken || inbound.bindingId !== binding.id || inbound.dmChannelId !== binding.dmChannelId) return null;
    if (!replyWindowOpen(inbound, this.deps.now())) return null;
    return { contextToken: inbound.contextToken };
  }

  /**
   * One of the assistant's messages: recorded first (the row is the guard
   * against a second send), then sent, or left in Raft and counted. The gate
   * is checked again before a send.
   */
  private async mirrorOne(binding: BindingRow, botToken: ILinkBotToken, candidate: OutboundCandidate): Promise<void> {
    const target = candidate.content.trim() ? await this.mirrorTarget(binding, candidate.id) : null;
    if (target) await this.checkGate(binding, true);
    this.assertRunning();
    const recorded = await recordWeChatOutbound(this.lease, { messageId: candidate.id, state: target ? "sending" : "not_mirrored", now: this.deps.now() });
    if (recorded === "lost") throw new StopRunner("lease_lost");
    if (recorded === "seen" || !target) return;
    let sent = false;
    try {
      sent = await this.send(binding, botToken, { kind: "reply", clientId: candidate.id, contextToken: target.contextToken, text: candidate.content });
    } finally {
      const now = this.deps.now();
      await getDb().update(wechatBridgeOutboundMessages)
        .set({ state: sent ? "sent" : "failed", updatedAt: now })
        .where(eq(wechatBridgeOutboundMessages.messageId, candidate.id));
      await getDb().update(b)
        .set(sent ? { lastMirroredAt: now } : { unmirroredCount: sql`${b.unmirroredCount} + 1` })
        .where(eq(b.id, binding.id));
    }
    if (sent) this.trace("mirrored", { message_id: candidate.id });
  }

  /** Ten minutes into a batch with no mirrored reply: one notice answering its newest message. */
  private async noReplyNotice(botToken: ILinkBotToken): Promise<void> {
    const binding = await this.current(false);
    const now = this.deps.now();
    const boundary = [binding.lastMirroredAt, binding.noReplyNoticeAt].reduce<Date | null>(
      (latest, at) => (at && (!latest || at > latest) ? at : latest),
      null,
    );
    const inBatch = and(
      eq(wechatBridgeInboundMessages.bindingId, binding.id),
      boundary ? sql`${wechatBridgeInboundMessages.receivedAt} > ${boundary.toISOString()}::timestamptz` : undefined,
    );
    const [oldest] = await getDb().select({ receivedAt: wechatBridgeInboundMessages.receivedAt })
      .from(wechatBridgeInboundMessages).where(inBatch)
      .orderBy(wechatBridgeInboundMessages.receivedAt).limit(1);
    if (!oldest || oldest.receivedAt.getTime() + this.deps.noReplyAfterMs > now.getTime()) return;
    // The newest: by arrival, then (one getupdates answer arrives at once) by its place in the DM.
    const [newest] = await getDb().select({
      id: wechatBridgeInboundMessages.id,
      contextToken: wechatBridgeInboundMessages.contextToken,
      receivedAt: wechatBridgeInboundMessages.receivedAt,
      sentAt: wechatBridgeInboundMessages.sentAt,
    }).from(wechatBridgeInboundMessages)
      .leftJoin(messages, eq(messages.id, wechatBridgeInboundMessages.messageId))
      .where(inBatch)
      .orderBy(desc(wechatBridgeInboundMessages.receivedAt), sql`${messages.seq} DESC NULLS LAST`)
      .limit(1);
    await this.checkGate(binding, true);
    this.assertRunning();
    // Claimed first: one notice per batch even when the send fails.
    if (!await claimWeChatNoReplyNotice(this.lease, { lastMirroredAt: binding.lastMirroredAt, noReplyNoticeAt: binding.noReplyNoticeAt, now })) return;
    if (!newest?.contextToken || !replyWindowOpen(newest, now)) {
      this.trace("no_reply_notice_skipped", { reason: "no_context_token" });
      return;
    }
    // Its pushes stopped (agentInboxPushService disabled the registration): it
    // will not see a message sent again either, so the notice points to Raft.
    const [push] = await getDb().select({ disabledAt: agentInboxPushRegistrations.disabledAt })
      .from(agentInboxPushRegistrations).where(eq(agentInboxPushRegistrations.agentId, binding.agentId)).limit(1);
    const text = push?.disabledAt ? WECHAT_PUSH_STOPPED_NOTICE_TEXT : WECHAT_NO_REPLY_NOTICE_TEXT;
    await this.send(binding, botToken, { kind: "no_reply", clientId: `raft-wechat-no-reply:${newest.id}`, contextToken: newest.contextToken, text });
  }

  // ── The loop ──

  /** Poll until stopped, the lease is lost, the gate closes or the token goes stale; then release the lease. */
  async run(): Promise<WeChatRunnerStopReason> {
    const outbound = this.outboundLoop();
    let failures = 0;
    try {
      while (!this.signal.aborted) {
        try {
          if (!await this.pollOnce()) break;
          failures = 0;
        } catch (err) {
          if (this.signal.aborted) break;
          failures += 1;
          this.trace("poll_failed", { reason: errorKind(err), failures });
          await sleep(backoffMs(failures), this.signal);
        }
      }
    } finally {
      this.abort("stopping");
      await outbound;
      await this.turn;
      await releaseWeChatBindingLease(this.lease).catch(() => undefined);
    }
    return this.stopReason ?? "stopping";
  }

  private async outboundLoop(): Promise<void> {
    while (!this.signal.aborted) {
      await sleep(this.deps.outboundIntervalMs, this.signal);
      if (this.signal.aborted) return;
      try {
        if (!await this.outboundOnce()) return;
      } catch (err) {
        this.trace("outbound_failed", { reason: errorKind(err) });
      }
    }
  }
}

async function ownerDisplayName(userId: string): Promise<string> {
  const [owner] = await getDb().select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  return owner?.displayName || owner?.name || "Raft";
}

// ── The worker ──────────────────────────────────────────────────────────────

export interface WeChatBridgeWorkerOptions {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  tracer?: Tracer;
  env?: NodeJS.ProcessEnv;
  /** Tests: the iLink client (default: the real one, or the test transport). */
  client?: WeChatILinkClient;
  now?: () => Date;
  leaseOwner?: string;
  scanIntervalMs?: number;
  /** Tests: how many bindings one scan reads. */
  scanBatch?: number;
  outboundIntervalMs?: number;
  leaseMs?: number;
  noReplyAfterMs?: number;
  minPollIntervalMs?: number;
  shutdownWaitMs?: number;
}

export interface WeChatBridgeWorker {
  /** Stop claiming, abort every long poll and send in flight, release the leases (bounded wait). */
  stop(): Promise<void>;
}

const defaultLeaseOwner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * Every few seconds: sweep expired context tokens (now and then), then claim
 * each active binding nobody holds whose gate is open and run it until it
 * stops. What SQL can see of the gate (the assistant still the owner's, the DM
 * not deleted or archived) is filtered there; a binding whose full gate was
 * closed is left out of the next scans here for a minute, so closed bindings
 * cannot fill every batch and starve the rest.
 */
export function startWeChatBridgeWorker(input: WeChatBridgeWorkerOptions): WeChatBridgeWorker {
  const env = input.env ?? process.env;
  if (weChatBridgeWorkerDisabled(env)) {
    console.warn(`[wechat-bridge] worker disabled (${WECHAT_BRIDGE_WORKER_DISABLED_ENV})`);
    return { stop: async () => undefined };
  }
  const now = input.now ?? (() => new Date());
  const leaseOwner = input.leaseOwner ?? defaultLeaseOwner;
  const deps: WeChatRunnerDeps = {
    io: input.io,
    orchestrator: input.orchestrator,
    client: input.client ?? wechatILinkClient(),
    now,
    tracer: input.tracer,
    leaseMs: input.leaseMs ?? WECHAT_BRIDGE_LEASE_MS,
    outboundIntervalMs: input.outboundIntervalMs ?? OUTBOUND_INTERVAL_MS,
    noReplyAfterMs: input.noReplyAfterMs ?? WECHAT_NO_REPLY_NOTICE_AFTER_MS,
    minPollIntervalMs: input.minPollIntervalMs ?? MIN_POLL_INTERVAL_MS,
  };
  const runners = new Map<string, { runner: WeChatBindingRunner; done: Promise<void> }>();
  const retryAfter = new Map<string, number>();
  let stopping = false;
  let scanning: Promise<void> | null = null;
  let lastSweepMs = 0;

  const startRunner = (lease: WeChatBindingLease) => {
    const runner = new WeChatBindingRunner(lease, deps);
    recordTraceEvent("server.assistant.wechat.worker.claimed", { binding_id: lease.bindingId }, input.tracer);
    const done = runner.run()
      .then((reason) => {
        recordTraceEvent("server.assistant.wechat.worker.released", { binding_id: lease.bindingId, reason }, input.tracer);
        if (reason === "gate_closed" || reason === "credential_unreadable") retryAfter.set(lease.bindingId, now().getTime() + GATE_RETRY_MS);
      })
      .catch((err: unknown) => {
        console.error("[wechat-bridge] runner failed:", err instanceof Error ? err.name : "error");
      })
      .finally(() => { runners.delete(lease.bindingId); });
    runners.set(lease.bindingId, { runner, done });
  };

  const scan = async () => {
    // No key configured: the bridge does nothing at all.
    if (!wechatBridgeCredentialCipher(env)) return;
    const at = now();
    if (at.getTime() - lastSweepMs >= SWEEP_INTERVAL_MS) {
      lastSweepMs = at.getTime();
      await sweepWeChatBridgeExpiry(at);
    }
    for (const [id, until] of retryAfter) if (until <= at.getTime()) retryAfter.delete(id);
    const skipped = [...retryAfter.keys(), ...runners.keys()];
    const due = await getDb()
      .select({ id: b.id, serverId: b.serverId, userId: b.userId, agentId: b.agentId, dmChannelId: b.dmChannelId })
      .from(b)
      .innerJoin(agents, and(eq(agents.id, b.agentId), eq(agents.assistantOwnerUserId, b.userId), isNull(agents.deletedAt)))
      .innerJoin(channels, and(eq(channels.id, b.dmChannelId), isNull(channels.deletedAt), isNull(channels.archivedAt)))
      .where(and(
        eq(b.state, "active"),
        or(isNull(b.leaseExpiresAt), lt(b.leaseExpiresAt, at)),
        skipped.length > 0 ? notInArray(b.id, skipped) : undefined,
      ))
      .orderBy(sql`${b.leaseExpiresAt} ASC NULLS FIRST`, b.id)
      .limit(input.scanBatch ?? SCAN_BATCH);
    for (const binding of due) {
      if (stopping) return;
      if (!await weChatBindingGateOpen(binding)) {
        retryAfter.set(binding.id, now().getTime() + GATE_RETRY_MS);
        continue;
      }
      const lease = await claimWeChatBindingLease({ bindingId: binding.id, owner: leaseOwner, now: now(), leaseMs: deps.leaseMs });
      if (lease && !stopping) startRunner(lease);
      else if (lease) await releaseWeChatBindingLease(lease);
    }
  };

  const tick = () => {
    if (stopping || scanning) return;
    scanning = scan()
      .catch((err: unknown) => {
        console.error("[wechat-bridge] scan failed:", err instanceof Error ? err.name : "error");
      })
      .finally(() => { scanning = null; });
  };
  tick();
  const handle = setInterval(tick, input.scanIntervalMs ?? SCAN_INTERVAL_MS);
  handle.unref?.();

  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(handle);
      for (const { runner } of runners.values()) runner.abort("stopping");
      const settled = (async () => {
        await scanning;
        for (const { done } of [...runners.values()]) await done;
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        settled.then(() => "settled" as const),
        new Promise<"timed_out">((resolve) => { timer = setTimeout(() => resolve("timed_out"), input.shutdownWaitMs ?? SHUTDOWN_WAIT_MS); }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome === "timed_out") console.warn("[wechat-bridge] shutdown gave up waiting for runners; their leases expire on their own");
    },
  };
}
