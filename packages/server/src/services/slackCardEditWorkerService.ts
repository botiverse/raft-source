// RFC 082 §4.6: the worker that edits a card message's bridged Slack copy.
//
// One sync row per original delivery (slackCardEditSync.ts) holds the latest
// revision to show. The worker leases one sync at a time, so a message has at
// most one edit in flight; revisions committed meanwhile merge into the latest.
// It edits only a confirmed original (its stored ts), re-checks every edit like
// a send, commits a durable `sending` attempt before the network call, and
// records the outcome only while it is still the lease's current, unexpired
// holder. After an unknown outcome it waits a quiet period, reads the message
// back by ts, and later reads it once more: best-effort repair, never proof.
//
// Lock order: the global order in slackCardEditSync.ts (message, sync rows,
// authority rows, attempt rows, pair notice locks last). Here the claim and
// every fenced write take the sync row (FOR UPDATE) first; the attempt start
// takes the message FOR SHARE, then the sync row, then the authority rows in
// their writers' order (the master flag's shared lock, the installation, the
// binding, the latest audience row, the sender agent, the sender's channel
// membership rows); every transaction ends with the pair's notice refresh. No
// delivery row is locked. A Joint Channel's card (stored in canonical storage)
// is checked on the bridged host's own conversation: the "conversation" row
// locked first is the host projection's channel row, a joint thread's too (its
// local parent), resolved by plain reads just before it (no lock taken
// earlier, none on the canonical row).
//
// Changes after I/O starts: a request already sent cannot be recalled. A
// pause, revocation, identity change or deletion committed after the attempt
// row exists leaves that request's outcome to the unknown / definite rules
// below; no new attempt starts once the change is observed.

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { clearClockInterval, currentDate, setClockInterval, SLACK_BRIDGE_FEATURE_FLAG_KEYS, type Tracer } from "@botiverse/raft-shared";

import type { Database, DatabaseExecutor } from "../db/index";
import {
  agents,
  attachments,
  externalAppInstalls,
  externalBindingAudienceSnapshots,
  externalCardEditAttempts,
  externalCardEditPairNotices,
  externalCardEditSyncs,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
  messageCardRevisions,
  messages,
  EXTERNAL_CARD_EDIT_END_REASONS,
  EXTERNAL_CARD_EDIT_NOTICE_KINDS,
} from "../db/schema";
import { withTraceRoot } from "../tracing/semanticTrace";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import type { SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import { parseExternalDeliveryFrozenSnapshot } from "./externalDeliveryWorkerService";
import { acquireFeatureFlagReadLock } from "./featureFlagService";
import { canAgentPostToChannel, getChannel, isChannelArchived } from "./channelService";
import { resolveCardMessageConversation } from "./messageCardConversation";
import { getChannelBillingReadOnly, isChannelReadOnlyByQuota } from "./planService";
import { resolveCurrentOutboundAuthority } from "./slackBridgeDatabaseOutboundRuntime";
import { listSlackPairRecoveryWaits } from "./slackBridgePairQueue";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import {
  SLACK_CARD_EDIT_LATER_RECHECK_MS,
  SLACK_CARD_EDIT_LEASE_MS,
  SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS,
  SLACK_CARD_EDIT_ORIGINAL_WAIT_MS,
  SLACK_CARD_EDIT_QUIET_PERIOD_MS,
  refreshSlackCardEditPairNotices,
  slackCardEditNeedsSend,
  sortSlackCardEditPairs,
  slackCardEditRetryDelayMs,
  slackCardEditSyncStatus,
} from "./slackCardEditSync";
import {
  buildSlackCardEditRequest,
  classifySlackCardEditResult,
  readBackSlackCardRevision,
  slackBridgeTextWithinSendRule,
  type SlackBridgeCredentialHandle,
  type SlackCardEditOutcome,
  type SlackCardReadBack,
  type SlackProviderAuthorityFence,
  type SlackWebApiTransport,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter";

type Sync = typeof externalCardEditSyncs.$inferSelect;
type Delivery = typeof externalOutboundDeliveries.$inferSelect;
type Link = typeof externalMessageLinks.$inferSelect;
type EndReason = (typeof EXTERNAL_CARD_EDIT_END_REASONS)[number];
type NoticeKind = (typeof EXTERNAL_CARD_EDIT_NOTICE_KINDS)[number];

const LEASE_EXPIRED_AFTER_PROVIDER_IO = "lease_expired_after_provider_io";
const SLACK_CARD_EDIT_NOTICE_SWEEP_MS = 60_000;

/** A pair-level block that means the bridge cannot write to the conversation now: no new edit starts. */
const PAIR_WRITE_BLOCKS = new Set([
  "slack_not_in_channel", "slack_channel_not_found", "slack_permission_missing", "slack_workspace_admin_required",
  "slack_channel_archived", "provider_credential_revoked", "binding_paused_bot_removed", "binding_paused_archived",
  "provider_app_identity_conflict", "provider_authority_identity_conflict", "provider_conversation_identity_conflict",
]);

export interface SlackCardEditWorkerDependencies {
  registrationId: string;
  transport: SlackWebApiTransport;
  /** A one-use write credential for exactly this fence, or null (production: the binding's current authority, then the provider lease). */
  leaseCredential(input: { fence: SlackProviderAuthorityFence; serverId: string; now: Date }): Promise<SlackBridgeCredentialHandle | null>;
  releaseCredential(handle: SlackBridgeCredentialHandle): Promise<void>;
  now?(): Date;
}

export type SlackCardEditWorkerResult =
  | { kind: "empty" }
  | { kind: "recovered_unknown"; syncId: string; attemptIds: string[] }
  | { kind: "ended"; syncId: string; reason: EndReason }
  | { kind: "waiting"; syncId: string; reason: string }
  | { kind: "idle"; syncId: string }
  | { kind: "read_back"; syncId: string; result: SlackCardReadBack }
  | { kind: "refused"; syncId: string; revision: number; reason: string }
  | { kind: "attempted"; syncId: string; attemptId: string; revision: number; outcome: SlackCardEditOutcome["kind"] }
  /** The outcome arrived after this worker stopped being the lease's current, unexpired holder: nothing recorded. */
  | { kind: "outcome_fenced"; syncId: string; attemptId: string }
  | { kind: "lease_lost"; syncId: string };

let afterProviderIoHookForTests: ((input: { syncId: string; attemptId: string }) => Promise<void> | void) | null = null;

/** Tests only: runs after the Slack call returned and before its outcome transaction (a throw models a crash). */
export function __setSlackCardEditAfterProviderIoHookForTests(
  hook: ((input: { syncId: string; attemptId: string }) => Promise<void> | void) | null,
): void {
  afterProviderIoHookForTests = hook;
}

function holdsLease(row: Sync | undefined, owner: string, generation: number, at: Date): row is Sync {
  // The outcome path's own check: the lease's CURRENT holder, at its CURRENT
  // generation, not yet expired. A lease that expired and that nobody has
  // reclaimed yet fails here too; no new holder has to invalidate anything.
  return Boolean(row && row.state === "open" && row.leaseOwner === owner && row.leaseGeneration === generation
    && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > at.getTime());
}

const releaseLease = { leaseOwner: null, leaseExpiresAt: null } as const;

/** What an unknown outcome does: the latch (never cleared), the quiet period, then the first read-back. */
function unknownOutcomeSet(at: Date) {
  const quietUntil = new Date(at.getTime() + SLACK_CARD_EDIT_QUIET_PERIOD_MS);
  return {
    uncertainAt: sql<Date>`coalesce(${externalCardEditSyncs.uncertainAt}, ${at.toISOString()}::timestamptz)`,
    quietUntil,
    readbackStage: 1,
    readbackDueAt: quietUntil,
    nextAttemptAt: quietUntil,
    notConfirmedSince: sql<Date>`coalesce(${externalCardEditSyncs.notConfirmedSince}, ${at.toISOString()}::timestamptz)`,
    holdReason: null,
    ...releaseLease,
    updatedAt: at,
  };
}

function endSet(reason: EndReason, at: Date) {
  return {
    state: "ended" as const,
    endReason: reason,
    nextAttemptAt: null,
    readbackStage: 0,
    readbackDueAt: null,
    holdReason: null,
    ...releaseLease,
    updatedAt: at,
  };
}

/** When the worker should next look at a sync after this change (null: nothing to do until a new revision). */
function nextLook(after: Pick<Sync, "latestRevision" | "shownRevision" | "refusedRevision" | "readbackStage" | "readbackDueAt" | "quietUntil">, at: Date): Date | null {
  if (slackCardEditNeedsSend(after)) {
    return after.quietUntil && after.quietUntil > at ? after.quietUntil : at;
  }
  return after.readbackStage > 0 ? after.readbackDueAt : null;
}

type SyncSet = PgUpdateSetSource<typeof externalCardEditSyncs>;

/**
 * Every change of a sync goes through here, inside the transaction that holds
 * its row: the pair's notices are recomputed from the syncs' current state in
 * that same transaction.
 */
async function writeSync(tx: DatabaseExecutor, row: Pick<Sync, "id" | "bindingId" | "bindingEpoch">, set: SyncSet, at: Date): Promise<void> {
  await tx.update(externalCardEditSyncs).set(set).where(eq(externalCardEditSyncs.id, row.id));
  await refreshSlackCardEditPairNotices(tx, row, at);
}

/** A held sync waits with its reason, backs off, and is shown to the pair's admins (edit_waiting). */
function holdSet(row: Pick<Sync, "retryCount">, reason: string, at: Date): SyncSet {
  return {
    holdReason: reason.slice(0, 160), retryCount: row.retryCount + 1,
    nextAttemptAt: new Date(at.getTime() + slackCardEditRetryDelayMs(row.retryCount)),
    noticeKind: "edit_waiting", noticeAt: at, ...releaseLease, updatedAt: at,
  };
}

/**
 * Claim one due sync. A sync whose lease expired with a `sending` attempt is
 * not claimed for a new edit: that attempt is recovered as unknown (a crash
 * or lease loss after sending is never treated as unsent, never confirmed).
 */
async function claimDueSync(db: Database, input: { registrationId: string; leaseOwner: string; at: Date }): Promise<
  | { kind: "empty" }
  | { kind: "recovered_unknown"; syncId: string; attemptIds: string[] }
  | { kind: "claimed"; sync: Sync; generation: number }
> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(externalCardEditSyncs).where(and(
      eq(externalCardEditSyncs.state, "open"),
      or(
        and(isNull(externalCardEditSyncs.leaseOwner), lte(externalCardEditSyncs.nextAttemptAt, input.at)),
        and(isNotNull(externalCardEditSyncs.leaseOwner), lte(externalCardEditSyncs.leaseExpiresAt, input.at)),
      ),
      sql`EXISTS (SELECT 1 FROM ${externalChannelBindings}
        WHERE ${externalChannelBindings.id}::text = ${externalCardEditSyncs.bindingId}
          AND ${externalChannelBindings.registrationId} = ${input.registrationId}::uuid)`,
    )).orderBy(asc(sql`coalesce(${externalCardEditSyncs.leaseExpiresAt}, ${externalCardEditSyncs.nextAttemptAt})`))
      .for("update", { skipLocked: true }).limit(1);
    if (!candidate) return { kind: "empty" as const };
    // Any attempt still `sending` while nobody holds a live lease is unknown.
    const orphaned = await tx.select({ id: externalCardEditAttempts.id }).from(externalCardEditAttempts).where(and(
      eq(externalCardEditAttempts.syncId, candidate.id),
      eq(externalCardEditAttempts.state, "sending"),
    )).for("update");
    if (orphaned.length > 0) {
      await tx.update(externalCardEditAttempts).set({
        state: "unknown", outcomeReason: LEASE_EXPIRED_AFTER_PROVIDER_IO, completedAt: input.at, updatedAt: input.at,
      }).where(inArray(externalCardEditAttempts.id, orphaned.map((attempt) => attempt.id)));
      await writeSync(tx, candidate, unknownOutcomeSet(input.at), input.at);
      return { kind: "recovered_unknown" as const, syncId: candidate.id, attemptIds: orphaned.map((attempt) => attempt.id) };
    }
    const generation = candidate.leaseGeneration + 1;
    const [claimed] = await tx.update(externalCardEditSyncs).set({
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: new Date(input.at.getTime() + SLACK_CARD_EDIT_LEASE_MS),
      leaseGeneration: generation,
      updatedAt: input.at,
    }).where(eq(externalCardEditSyncs.id, candidate.id)).returning();
    return { kind: "claimed" as const, sync: claimed!, generation };
  });
}

type OriginalState =
  | { kind: "confirmed"; providerMessageId: string; providerThreadId: string | null }
  | { kind: "waiting"; reason: string }
  | { kind: "ended"; reason: Extract<EndReason, "original_not_sent" | "original_unknown_skipped" | "original_unknown_ended"> };

/**
 * The original delivery's fate. Its stored ts is the only Slack id an edit
 * may use; an original whose outcome is unknown keeps reconciling and is never
 * edited. Known never sent: no attempt could have posted (none started, or
 * Slack definitely refused each, and no unknown receipt is on its link).
 */
export function classifySlackCardOriginal(input: {
  delivery: Pick<Delivery, "id" | "state" | "stateReason" | "providerMessageId" | "providerAttempts">;
  link: Pick<Link, "deliveryId" | "outcomeState" | "providerMessageId" | "providerThreadId"> | null;
  attemptOutcomes: readonly (typeof externalDeliveryAttempts.$inferSelect)["outcome"][];
}): OriginalState {
  const { delivery, link } = input;
  if (delivery.state === "accepted") {
    return delivery.providerMessageId && link && link.deliveryId === delivery.id && link.outcomeState === "accepted"
      && link.providerMessageId === delivery.providerMessageId
      ? { kind: "confirmed", providerMessageId: delivery.providerMessageId, providerThreadId: link.providerThreadId }
      // The queue itself blocks on an inconsistent receipt; never guess a ts.
      : { kind: "waiting", reason: "original_receipt_inconsistent" };
  }
  if (delivery.state !== "skipped" && delivery.state !== "revoked" && delivery.state !== "not_queued") {
    return { kind: "waiting", reason: `original_${delivery.state}` };
  }
  const knownNotSent = input.attemptOutcomes.length === delivery.providerAttempts
    && input.attemptOutcomes.every((outcome) => outcome === "rate_limited" || outcome === "transient_failure"
      || outcome === "deterministic_failure")
    && link?.outcomeState !== "unknown";
  if (knownNotSent) return { kind: "ended", reason: "original_not_sent" };
  return { kind: "ended", reason: delivery.stateReason === "operator_audited_skip" ? "original_unknown_skipped" : "original_unknown_ended" };
}

type AuthorityDecision =
  | { kind: "current"; fence: SlackProviderAuthorityFence; serverId: string; audienceExpiresAt: Date }
  | { kind: "wait"; reason: string }
  | { kind: "end"; reason: Extract<EndReason, "identity_changed" | "sender_removed"> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** An edit needs this audience: the binding epoch's latest observation matched and still fresh (unlike a send, which only refuses a mismatch). */
export const SLACK_CARD_EDIT_AUDIENCE_NOT_MATCHED = "slack_audience_not_matched";
/** An admitted attempt closed before its call: the matched audience it was admitted under expired first. */
export const SLACK_CARD_EDIT_NOT_SENT_AUDIENCE_EXPIRED = "not_sent_audience_expired";

let beforeProviderIoAdmissionHookForTests: (() => Promise<void> | void) | null = null;

/** Tests only: runs in the admitting transaction (an edit's attempt start or a read-back's), before any of its authority locks. */
export function __setSlackCardEditBeforeProviderIoAdmissionHookForTests(hook: (() => Promise<void> | void) | null): void {
  beforeProviderIoAdmissionHookForTests = hook;
}

let beforeSenderPostingCheckHookForTests: (() => Promise<void> | void) | null = null;

/** Tests only: runs in the attempt start's transaction right before the sender's locked posting check. */
export function __setSlackCardEditBeforeSenderPostingCheckHookForTests(hook: (() => Promise<void> | void) | null): void {
  beforeSenderPostingCheckHookForTests = hook;
}

/**
 * Re-check an edit like a send: the original's pair epoch, installation and
 * bot identity (a reinstall or new bot moves the connection epoch), a MATCHED
 * audience (fail closed: missing, expired, unavailable or mismatch waits),
 * the pair not paused or blocked from writing, the master switch, and the
 * sender still allowed. An identity change ends the sync (never a new post);
 * anything that may recover waits.
 *
 * The card's conversation is held to the card update route's own boundaries:
 * not archived (it or its root channel), the plan's read-only rules (the free
 * plan's external freeze, a joint over its limit, the channel quota). Each
 * one waits: unarchiving or an upgrade lets the edit through.
 *
 * A Joint Channel's card is checked on the host's own conversation, the one
 * the binding bridges (slackCardEditConversationId): the host projection, or
 * the host's local face of the thread. Any other mapping (another Server's
 * projection, a disconnected or closed joint) ends the sync as an identity
 * change: no other Server's side ever edits a Slack copy through here.
 *
 * `lock`: the attempt-start transaction's final check, against current rows
 * locked in their writers' order: the master flag's shared lock (flag
 * writers take it exclusively), the conversation's root channel row (FOR
 * SHARE: archiveChannel updates it; conversion locks it FOR UPDATE before the
 * bindings, so it comes first here too), the installation, then the binding (FOR SHARE;
 * the lifecycle and audience writers lock install, then binding, FOR UPDATE),
 * the binding epoch's latest audience row, then the sender agent and the
 * membership rows its posting verdict rests on. A concurrent
 * revocation either commits before this check (refused) or waits until the
 * attempt row exists (then it is an in-flight request).
 */
async function checkSlackCardEditAuthority(executor: DatabaseExecutor, input: {
  registrationId: string; delivery: Delivery; link: Link; frozen: SlackBridgeRenderSnapshot; now: Date; lock: boolean;
  /** The card message's stored conversation, its `channel_id` (a thread reply: its thread). */
  conversationId: string;
}): Promise<AuthorityDecision> {
  const { delivery, link, frozen, lock } = input;
  const changed = (): AuthorityDecision => ({ kind: "end", reason: "identity_changed" });
  if (!UUID_PATTERN.test(delivery.bindingId) || !UUID_PATTERN.test(link.installId)) return changed();
  if (lock) {
    // The switch this check reads, shared; its flag writer takes the lock
    // exclusively (withFeatureFlagLock), so a switch turned off either
    // committed first (seen below) or waits for this commit.
    await acquireFeatureFlagReadLock(executor, SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);
  }
  // The conversation the checks run on (plain reads; a Joint card: the bridged host's own).
  const conversationId = await slackCardEditConversationId(input.conversationId, frozen.bindingAuthority.raftChannelId);
  if (!conversationId) return changed();
  // Conversation-first, as conversion and the archive writer lock it.
  if (await isChannelArchived(conversationId, { lockRoot: lock })) return { kind: "wait", reason: "channel_archived" };
  const installRead = executor.select().from(externalAppInstalls).where(eq(externalAppInstalls.id, link.installId)).limit(1);
  const [install] = lock ? await installRead.for("share") : await installRead;
  const bindingRead = executor.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, delivery.bindingId),
    eq(externalChannelBindings.registrationId, input.registrationId),
  )).limit(1);
  const [binding] = lock ? await bindingRead.for("share") : await bindingRead;
  if (!binding || binding.state === "revoked" || binding.bindingEpoch !== delivery.bindingEpoch
    || binding.installId !== link.installId || binding.connectionEpoch !== link.connectionEpoch
    || binding.providerConversationId !== link.providerConversationId
    || binding.channelId !== frozen.bindingAuthority.raftChannelId) return changed();
  if (!install || install.state === "revoked" || install.connectionEpoch !== link.connectionEpoch
    || install.providerAuthorityId !== link.providerAuthorityId) return changed();
  const current = await resolveCurrentOutboundAuthority({
    executor,
    bindingId: binding.id,
    expectedConnectionEpoch: link.connectionEpoch,
    expectedBindingEpoch: delivery.bindingEpoch,
    expectedAudienceRevision: frozen.bindingAuthority.memberRevision,
    senderType: frozen.senderType,
    senderId: frozen.senderId,
    now: input.now,
    registrationId: input.registrationId,
  });
  if (!current.current) {
    return ["binding_missing_for_registration", "epoch_mismatch", "install_missing", "registration_missing"].includes(current.reason)
      ? changed() : { kind: "wait", reason: current.reason };
  }
  const neutral = current.authority.neutral;
  const pinned = frozen.bindingAuthority;
  if (neutral.provider !== pinned.provider || neutral.environment !== pinned.environment
    || neutral.appRegistrationId !== pinned.appRegistrationId || neutral.workspaceId !== pinned.workspaceId
    || neutral.raftChannelId !== pinned.raftChannelId || neutral.providerAuthorityId !== pinned.providerAuthorityId
    || neutral.providerConversationId !== pinned.providerConversationId || neutral.installId !== link.installId) {
    return changed();
  }
  if (install.state !== "active") return { kind: "wait", reason: "installation_inactive" };
  // RFC 082 §4.6 "matched audience", fail closed. The send path's own rule
  // (resolveCurrentOutboundAuthority: only an explicit mismatch blocks) is unchanged.
  const audienceRead = executor.select({
    status: externalBindingAudienceSnapshots.status, expiresAt: externalBindingAudienceSnapshots.expiresAt,
  }).from(externalBindingAudienceSnapshots).where(and(
    eq(externalBindingAudienceSnapshots.bindingId, binding.id),
    eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
  )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1);
  const [audience] = lock ? await audienceRead.for("share") : await audienceRead;
  if (!audience || audience.status !== "matched" || audience.expiresAt.getTime() <= input.now.getTime()) {
    return { kind: "wait", reason: SLACK_CARD_EDIT_AUDIENCE_NOT_MATCHED };
  }
  // Once the bridge can no longer write to the conversation, no new edit
  // starts. (A queue-observed block: read, not locked; the send queue's own
  // writers lock the partition first.)
  const [partition] = await executor.select({ reason: externalDeliveryPartitions.authorityBlockedReason })
    .from(externalDeliveryPartitions).where(and(
      eq(externalDeliveryPartitions.bindingId, delivery.bindingId),
      eq(externalDeliveryPartitions.bindingEpoch, delivery.bindingEpoch),
    )).limit(1);
  if (partition?.reason && PAIR_WRITE_BLOCKS.has(partition.reason)) return { kind: "wait", reason: partition.reason };
  if ((await listSlackPairRecoveryWaits(executor, pinned)).length > 0) {
    return { kind: "wait", reason: "slack_audience_revalidation_required" };
  }
  if (frozen.senderType === "agent") {
    const senderRead = executor.select({ id: agents.id }).from(agents).where(and(
      eq(agents.id, frozen.senderId), eq(agents.serverId, binding.serverId), isNull(agents.deletedAt),
    )).limit(1);
    const [sender] = lock ? await senderRead.for("share") : await senderRead;
    if (!sender) return { kind: "end", reason: "sender_removed" };
    // The sender's CURRENT posting authority, by the posting rule itself
    // (canAgentPostToChannel: membership of an ordinary or private channel, a
    // thread's or task's parent, a DM's own rules, an assistant's owner DM;
    // it reads through this transaction). When locking, the rule reads the
    // rows it decides on FOR SHARE in the deciding statement, so the verdict
    // and the rows that grant it are one fact: a removal (a DELETE) either
    // committed before this check (refused) or waits until the attempt row
    // exists (then it is an in-flight request). A separate lock query first
    // left a gap: a row added after it was read but not locked (peng, #12710).
    if (lock && beforeSenderPostingCheckHookForTests) await beforeSenderPostingCheckHookForTests();
    if (!await canAgentPostToChannel(conversationId, frozen.senderId, { lockMembership: lock })) {
      return { kind: "end", reason: "sender_removed" };
    }
  }
  // The plan's read-only rules, read as the update route and the send path
  // read them: their writers start with the server admission lock, which no
  // transaction may take after a row lock (planService ADMISSION_LOCK_ORDER),
  // and the quota is a count over the server's channels. One committed during
  // this transaction counts as just after it.
  const billingReadOnly = await getChannelBillingReadOnly(conversationId, binding.serverId, input.now);
  if (billingReadOnly) return { kind: "wait", reason: `channel_read_only:${billingReadOnly.reason}` };
  if (await isChannelReadOnlyByQuota(conversationId, binding.serverId, input.now)) {
    return { kind: "wait", reason: "channel_read_only:quota" };
  }
  return {
    kind: "current",
    serverId: binding.serverId,
    audienceExpiresAt: audience.expiresAt,
    fence: {
      installId: install.id,
      providerAppId: install.providerAppId,
      providerAuthorityId: install.providerAuthorityId,
      providerConversationId: binding.providerConversationId,
      connectionEpoch: install.connectionEpoch,
      credentialRevision: install.credentialRevision,
      bindingId: delivery.bindingId,
      bindingEpoch: delivery.bindingEpoch,
    },
  };
}

/**
 * The conversation a card's Slack edit is checked on. A card stored on the
 * bridged channel's own Server: its own conversation, as before. A Joint
 * Channel's card (canonical storage, another Server): the conversation of the
 * Server the binding belongs to (messageCardConversation.ts), only when that
 * is the joint's HOST and the binding's channel is that projection (a thread:
 * its local parent), the one side a Slack bridge is provisioned on; null for
 * anything else.
 */
async function slackCardEditConversationId(storageChannelId: string, boundChannelId: string): Promise<string | null> {
  // Not a channel id: the binding check below could only call it a change.
  if (!UUID_PATTERN.test(boundChannelId)) return null;
  const storage = await getChannel(storageChannelId);
  const bound = await getChannel(boundChannelId);
  if (!storage || !bound || storage.serverId === bound.serverId) return storageChannelId;
  const mapped = await resolveCardMessageConversation(storageChannelId, bound.serverId);
  if (!mapped?.joint || mapped.joint.role !== "host" || mapped.joint.postingAuthorityChannelId !== bound.id) return null;
  return mapped.conversationId;
}

function sameFence(left: SlackProviderAuthorityFence, right: SlackProviderAuthorityFence): boolean {
  return left.installId === right.installId && left.providerAppId === right.providerAppId
    && left.providerAuthorityId === right.providerAuthorityId && left.providerConversationId === right.providerConversationId
    && left.connectionEpoch === right.connectionEpoch && left.credentialRevision === right.credentialRevision
    && left.bindingId === right.bindingId && left.bindingEpoch === right.bindingEpoch;
}

/**
 * One step of the card edit worker: recover, wait, end, read back, or edit
 * one sync. Every write after the claim is fenced by the lease.
 */
export async function processSlackCardEditSyncOnce(input: {
  db: Database;
  leaseOwner: string;
  dependencies: SlackCardEditWorkerDependencies;
}): Promise<SlackCardEditWorkerResult> {
  const { db, dependencies } = input;
  const now = dependencies.now ?? currentDate;
  const claimAt = now();
  if (!Number.isFinite(claimAt.getTime()) || !input.leaseOwner.trim() || input.leaseOwner.length > 160) return { kind: "empty" };
  const claim = await claimDueSync(db, { registrationId: dependencies.registrationId, leaseOwner: input.leaseOwner, at: claimAt });
  if (claim.kind !== "claimed") return claim;
  const { generation } = claim;
  const syncId = claim.sync.id;

  /** A write of this sync under the exact live lease; false when the lease is gone. */
  const fenced = async (work: (tx: DatabaseExecutor, row: Sync, at: Date) => Promise<void>): Promise<boolean> =>
    db.transaction(async (tx) => {
      const [row] = await tx.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.id, syncId)).for("update").limit(1);
      const at = now();
      if (!holdsLease(row, input.leaseOwner, generation, at)) return false;
      await work(tx, row, at);
      return true;
    });
  const endWithin = async (tx: DatabaseExecutor, row: Sync, reason: EndReason, at: Date) => {
    await writeSync(tx, row, {
      ...endSet(reason, at),
      ...(reason === "card_has_files" ? { noticeKind: "updates_cannot_be_shown" as const, noticeAt: at } : {}),
    }, at);
  };
  const end = async (reason: EndReason): Promise<SlackCardEditWorkerResult> => {
    const done = await fenced((tx, row, at) => endWithin(tx, row, reason, at));
    return done ? { kind: "ended", syncId, reason } : { kind: "lease_lost", syncId };
  };
  /** Wait without a hold (the original is unresolved, a quiet period, nothing to do). */
  const wait = async (reason: string, until: Date | null): Promise<SlackCardEditWorkerResult> => {
    const done = await fenced((tx, row, at) => writeSync(tx, row, { nextAttemptAt: until, ...releaseLease, updatedAt: at }, at));
    return done ? (until === null ? { kind: "idle", syncId } : { kind: "waiting", syncId, reason }) : { kind: "lease_lost", syncId };
  };
  /** Held: no edit starts; shown to the pair's admins (edit_waiting); tried again with backoff. */
  const hold = async (reason: string): Promise<SlackCardEditWorkerResult> => {
    const done = await fenced((tx, row, at) => writeSync(tx, row, holdSet(row, reason, at), at));
    return done ? { kind: "waiting", syncId, reason } : { kind: "lease_lost", syncId };
  };

  // Facts. Plain reads: the lease serializes this sync's writers.
  const [delivery] = await db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, claim.sync.deliveryId)).limit(1);
  if (!delivery) return end("original_not_sent");
  const [message] = await db.select({ id: messages.id, deletedAt: messages.deletedAt, channelId: messages.channelId }).from(messages)
    .where(eq(messages.id, claim.sync.sourceMessageId)).limit(1);
  // Once Raft sees the message deleted or retracted, no new edit starts. An
  // edit already sent stays not confirmed; nothing claims Slack withdrew it.
  if (!message || message.deletedAt) return end("source_deleted");
  const frozen = parseExternalDeliveryFrozenSnapshot(delivery);
  const [file] = await db.select({ id: attachments.id }).from(attachments)
    .where(eq(attachments.messageId, claim.sync.sourceMessageId)).limit(1);
  // No card message carries files (§4.1): one stored with files anyway is never edited or re-sent.
  if (file || (frozen && frozen.attachments.length > 0)) return end("card_has_files");
  if (!frozen || frozen.bindingAuthority.provider !== "slack") return hold("original_snapshot_invalid");
  const [link] = await db.select().from(externalMessageLinks).where(eq(externalMessageLinks.deliveryId, delivery.id)).limit(1);
  const originalAttempts = await db.select({ outcome: externalDeliveryAttempts.outcome }).from(externalDeliveryAttempts)
    .where(eq(externalDeliveryAttempts.deliveryId, delivery.id));
  const original = classifySlackCardOriginal({ delivery, link: link ?? null, attemptOutcomes: originalAttempts.map((row) => row.outcome) });
  if (original.kind === "ended") return end(original.reason);
  // The pending sync belongs to the original's pair epoch and never moves to another.
  const [pair] = await db.select({ state: externalChannelBindings.state, bindingEpoch: externalChannelBindings.bindingEpoch })
    .from(externalChannelBindings).where(and(
      sql`${externalChannelBindings.id}::text = ${delivery.bindingId}`,
      eq(externalChannelBindings.registrationId, dependencies.registrationId),
    )).limit(1);
  if (!pair || pair.state === "revoked" || pair.bindingEpoch !== delivery.bindingEpoch) {
    return end(original.kind === "waiting" && delivery.providerAttempts === 0 && (!pair || pair.state === "revoked")
      ? "original_not_sent" : "identity_changed");
  }
  if (original.kind === "waiting") {
    return wait(original.reason, new Date(claimAt.getTime() + SLACK_CARD_EDIT_ORIGINAL_WAIT_MS));
  }
  const sync = claim.sync;
  if (sync.quietUntil && sync.quietUntil > claimAt) return wait("quiet_period", sync.quietUntil);
  const readbackDue = sync.readbackStage > 0 && sync.readbackDueAt !== null && sync.readbackDueAt <= claimAt;
  if (!readbackDue && !slackCardEditNeedsSend(sync)) {
    return wait(sync.readbackStage > 0 ? "readback_not_due" : "idle", sync.readbackStage > 0 ? sync.readbackDueAt : null);
  }
  if (!link) return wait("original_receipt_inconsistent", new Date(claimAt.getTime() + SLACK_CARD_EDIT_ORIGINAL_WAIT_MS));

  // A first check, read-only, before leasing a credential. The attempt start
  // below checks everything again against locked current rows.
  const authority = await db.transaction((tx) => checkSlackCardEditAuthority(tx, {
    registrationId: dependencies.registrationId, delivery, link, frozen, now: claimAt, lock: false,
    conversationId: message.channelId,
  }), { isolationLevel: "repeatable read", accessMode: "read only" });
  if (authority.kind === "end") return end(authority.reason);
  if (authority.kind === "wait") return hold(authority.reason);

  const credential = await dependencies.leaseCredential({ fence: authority.fence, serverId: authority.serverId, now: now() });
  if (!credential) return hold("credential_unavailable");

  /**
   * The final admission of one Slack call, an edit or a read-back, in the
   * caller's transaction (it holds the source message FOR SHARE, then the
   * sync row FOR UPDATE, under the live lease). Everything is checked again
   * against locked current rows; that check can wait on its locks, so what
   * depends on time is judged again at a fresh clock, against the rows now
   * held (peng, #12710): the worker lease, the same check unlocked (the
   * audience's freshness; plain reads that wait on nothing), then the
   * credential lease. A refusal is written to the sync here.
   */
  const admitProviderIo = async (tx: DatabaseExecutor, row: Sync, conversationId: string, at: Date): Promise<
    | { kind: "lease_lost" }
    | { kind: "ended"; reason: EndReason }
    | { kind: "held"; reason: string }
    | { kind: "admitted"; admitAt: Date; audienceExpiresAt: Date }
  > => {
    if (beforeProviderIoAdmissionHookForTests) await beforeProviderIoAdmissionHookForTests();
    const authorityInput = { registrationId: dependencies.registrationId, delivery, link, frozen, conversationId };
    const locked = await checkSlackCardEditAuthority(tx, { ...authorityInput, now: at, lock: true });
    const admitAt = now();
    if (locked.kind === "current" && !holdsLease(row, input.leaseOwner, generation, admitAt)) return { kind: "lease_lost" };
    const recheck = locked.kind === "current"
      ? await checkSlackCardEditAuthority(tx, { ...authorityInput, now: admitAt, lock: false })
      : locked;
    if (recheck.kind === "end") {
      await endWithin(tx, row, recheck.reason, admitAt);
      return { kind: "ended", reason: recheck.reason };
    }
    // The credential was leased for the first check's fence: a changed fence is a new check.
    if (recheck.kind === "current" && sameFence(recheck.fence, authority.fence)
      && credential.leaseExpiresAt.getTime() > admitAt.getTime()) {
      return { kind: "admitted", admitAt, audienceExpiresAt: recheck.audienceExpiresAt };
    }
    const reason = recheck.kind === "wait" ? recheck.reason
      : !sameFence(recheck.fence, authority.fence) ? "authority_changed_before_send" : "credential_expired_before_send";
    await writeSync(tx, row, holdSet(row, reason, admitAt), admitAt);
    return { kind: "held", reason };
  };
  /**
   * Right before the call: the admitting transaction's commit may have
   * waited (the pair notice lock), so no call once the worker lease, the
   * credential or the matched audience it was admitted under has run out
   * (peng, Cardy, #12710).
   */
  const expiredBeforeIo = (admitted: { leaseExpiresAt: Date; audienceExpiresAt: Date }): "lease" | "audience" | null => {
    const ioAt = now().getTime();
    if (admitted.leaseExpiresAt.getTime() <= ioAt || credential.leaseExpiresAt.getTime() <= ioAt) return "lease";
    return admitted.audienceExpiresAt.getTime() <= ioAt ? "audience" : null;
  };

  if (readbackDue) {
    // A read-back is provider I/O too, so it is admitted like an edit, under
    // the same locks (peng, #12710): a switch-off or pause committed first
    // means no call; one committed after the admission meets a read already
    // in flight, which writes nothing to Slack.
    const readAdmission = await db.transaction(async (tx) => {
      const [source] = await tx.select({ channelId: messages.channelId, deletedAt: messages.deletedAt }).from(messages)
        .where(eq(messages.id, sync.sourceMessageId)).for("share").limit(1);
      const [row] = await tx.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.id, syncId)).for("update").limit(1);
      const at = now();
      if (!holdsLease(row, input.leaseOwner, generation, at)) return { kind: "lease_lost" } as const;
      // Deleted or retracted: the sync ends, as at the attempt start, and nothing is read (peng, #12710).
      if (!source || source.deletedAt) {
        await endWithin(tx, row, "source_deleted", at);
        return { kind: "ended", reason: "source_deleted" } as const;
      }
      const admitted = await admitProviderIo(tx, row, source.channelId, at);
      return admitted.kind === "admitted" ? { ...admitted, leaseExpiresAt: row.leaseExpiresAt! } : admitted;
    });
    if (readAdmission.kind !== "admitted") {
      await dependencies.releaseCredential(credential);
      if (readAdmission.kind === "ended") return { kind: "ended", syncId, reason: readAdmission.reason };
      return readAdmission.kind === "held" ? { kind: "waiting", syncId, reason: readAdmission.reason } : { kind: "lease_lost", syncId };
    }
    const expired = expiredBeforeIo(readAdmission);
    if (expired) {
      await dependencies.releaseCredential(credential);
      return expired === "audience" ? hold(SLACK_CARD_EDIT_AUDIENCE_NOT_MATCHED) : { kind: "lease_lost", syncId };
    }
    let result: SlackCardReadBack;
    try {
      result = await readBackSlackCardRevision({
        transport: dependencies.transport, credentialHandle: credential, authority: authority.fence,
        providerMessageId: original.providerMessageId, providerThreadId: original.providerThreadId, deliveryId: delivery.id,
      });
    } finally {
      await dependencies.releaseCredential(credential);
    }
    const done = await fenced(async (tx, row, at) => {
      if (result.kind === "retry") {
        await writeSync(tx, row, {
          nextAttemptAt: new Date(at.getTime() + Math.max(result.retryAfterMs, 1_000)), ...releaseLease, updatedAt: at,
        }, at);
        return;
      }
      const shown = result.kind === "shown" && result.revision <= row.latestRevision ? result.revision : null;
      const stage = row.readbackStage === 1 ? 2 : 0;
      const after = {
        ...row,
        shownRevision: shown ?? row.shownRevision,
        readbackStage: stage,
        readbackDueAt: stage === 2 ? new Date(at.getTime() + SLACK_CARD_EDIT_LATER_RECHECK_MS) : null,
      };
      // An older revision this check cannot replace (Slack refused the
      // latest), or no read-back at all: the pair's "not confirmed" notice at
      // once (readback_problem_at), not only after T.
      const unconfirmable = shown === null || (shown !== row.latestRevision && row.refusedRevision === row.latestRevision);
      await writeSync(tx, row, {
        shownRevision: after.shownRevision,
        readbackStage: after.readbackStage,
        readbackDueAt: after.readbackDueAt,
        nextAttemptAt: nextLook(after, at),
        holdReason: null,
        ...(unconfirmable ? { noticeKind: "not_confirmed" as const, noticeAt: at,
          readbackProblemAt: row.readbackProblemAt ?? at } : {}),
        ...releaseLease,
        updatedAt: at,
      }, at);
    });
    return done ? { kind: "read_back", syncId, result } : { kind: "lease_lost", syncId };
  }

  // Attempt start, in its own transaction, the last database step before the
  // network call. It re-checks everything against current, locked rows (see
  // the lock order at the top of this file), then commits the `sending` row.
  // The revision is the latest at this moment: everything committed so far
  // merges into it, and a newer one never reuses this attempt.
  const start: {
    started?: { attemptId: string; revision: number; request: NonNullable<ReturnType<typeof buildSlackCardEditRequest>>; leaseExpiresAt: Date; audienceExpiresAt: Date };
    refused?: { revision: number; reason: string };
    ended?: EndReason;
    held?: string;
  } = {};
  const admitted = await db.transaction(async (tx) => {
    const [source] = await tx.select({ deletedAt: messages.deletedAt, channelId: messages.channelId }).from(messages)
      .where(eq(messages.id, claim.sync.sourceMessageId)).for("share").limit(1);
    const [row] = await tx.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.id, syncId)).for("update").limit(1);
    const at = now();
    if (!holdsLease(row, input.leaseOwner, generation, at)) return false;
    if (!slackCardEditNeedsSend(row) || (row.quietUntil && row.quietUntil > at)) {
      await writeSync(tx, row, { nextAttemptAt: nextLook(row, at), ...releaseLease, updatedAt: at }, at);
      return true;
    }
    if (!source || source.deletedAt) {
      start.ended = "source_deleted";
      await endWithin(tx, row, "source_deleted", at);
      return true;
    }
    const [attached] = await tx.select({ id: attachments.id }).from(attachments)
      .where(eq(attachments.messageId, row.sourceMessageId)).limit(1);
    if (attached) {
      start.ended = "card_has_files";
      await endWithin(tx, row, "card_has_files", at);
      return true;
    }
    const admission = await admitProviderIo(tx, row, source.channelId, at);
    if (admission.kind === "lease_lost") return false;
    if (admission.kind === "ended") {
      start.ended = admission.reason;
      return true;
    }
    if (admission.kind === "held") {
      start.held = admission.reason;
      return true;
    }
    const { admitAt } = admission;
    const revision = row.latestRevision;
    const [stored] = await tx.select({ content: messageCardRevisions.content }).from(messageCardRevisions).where(and(
      eq(messageCardRevisions.messageId, row.sourceMessageId), eq(messageCardRevisions.revision, revision),
    )).limit(1);
    // The send path's Slack length rule applies to the new fallback; no silent truncation.
    const reason = !stored ? "card_revision_unavailable"
      : !slackBridgeTextWithinSendRule(stored.content) ? "slack_text_length_rule" : null;
    const request = stored && !reason ? buildSlackCardEditRequest({
      credentialHandle: credential,
      authority: authority.fence,
      providerMessageId: original.providerMessageId,
      content: stored.content,
      cardRevision: revision,
      original: {
        deliveryId: delivery.id,
        reconciliationMarker: delivery.reconciliationMarker,
        sourceMessageId: frozen.sourceMessageId,
        sourcePermalink: frozen.sourcePermalink,
        senderType: frozen.senderType,
        connectionEpoch: link.connectionEpoch,
        bindingEpoch: delivery.bindingEpoch,
      },
    }) : null;
    if (!request) {
      start.refused = { revision, reason: reason ?? "card_edit_request_invalid" };
      const after = { ...row, refusedRevision: revision };
      await writeSync(tx, row, {
        refusedRevision: revision, refusedReason: start.refused.reason, nextAttemptAt: nextLook(after, at), holdReason: null,
        noticeKind: "latest_update_not_shown", noticeAt: at, ...releaseLease, updatedAt: at,
      }, at);
      return true;
    }
    const [attempt] = await tx.insert(externalCardEditAttempts).values({
      syncId: row.id, deliveryId: row.deliveryId, sourceMessageId: row.sourceMessageId,
      bindingId: row.bindingId, bindingEpoch: row.bindingEpoch, cardRevision: revision,
      leaseGeneration: generation, state: "sending", providerIoStartedAt: admitAt, createdAt: admitAt, updatedAt: admitAt,
    }).returning({ id: externalCardEditAttempts.id });
    // In flight, no longer held.
    await writeSync(tx, row, { holdReason: null, updatedAt: admitAt }, admitAt);
    start.started = { attemptId: attempt!.id, revision, request, leaseExpiresAt: row.leaseExpiresAt!, audienceExpiresAt: admission.audienceExpiresAt };
    return true;
  });
  if (!admitted) {
    await dependencies.releaseCredential(credential);
    return { kind: "lease_lost", syncId };
  }
  const startedAttempt = start.started;
  if (!startedAttempt) {
    await dependencies.releaseCredential(credential);
    if (start.refused) return { kind: "refused", syncId, ...start.refused };
    if (start.held) return { kind: "waiting", syncId, reason: start.held };
    return start.ended ? { kind: "ended", syncId, reason: start.ended } : { kind: "idle", syncId };
  }

  // A lease or credential gone: the attempt stays `sending`, recovered as
  // unknown, as after a crash before the call. Only the audience gone: the
  // attempt was never sent, so it is closed as failed under the lease and
  // the edit waits for a matched audience.
  const expired = expiredBeforeIo(startedAttempt);
  if (expired) {
    await dependencies.releaseCredential(credential);
    const closed = expired === "audience" && await fenced(async (tx, row, at) => {
      await tx.update(externalCardEditAttempts).set({
        state: "failed", outcomeReason: SLACK_CARD_EDIT_NOT_SENT_AUDIENCE_EXPIRED, completedAt: at, updatedAt: at,
      }).where(and(eq(externalCardEditAttempts.id, startedAttempt.attemptId), eq(externalCardEditAttempts.state, "sending")));
      await writeSync(tx, row, holdSet(row, SLACK_CARD_EDIT_AUDIENCE_NOT_MATCHED, at), at);
    });
    return closed ? { kind: "waiting", syncId, reason: SLACK_CARD_EDIT_AUDIENCE_NOT_MATCHED } : { kind: "lease_lost", syncId };
  }
  let response: SlackWebApiTransportResult;
  try {
    response = await dependencies.transport.call(startedAttempt.request);
  } catch {
    response = { kind: "transport_failure", phase: "unknown", code: "unavailable" };
  } finally {
    await dependencies.releaseCredential(credential);
  }
  // A lease fences only Raft's writes. It cannot recall a request Slack
  // already received: if this worker stops here, recovery marks it unknown.
  if (afterProviderIoHookForTests) await afterProviderIoHookForTests({ syncId, attemptId: startedAttempt.attemptId });
  const outcome = classifySlackCardEditResult(response, {
    authority: authority.fence, providerMessageId: original.providerMessageId,
  });
  const recorded = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.id, syncId)).for("update").limit(1);
    const [attempt] = await tx.select().from(externalCardEditAttempts).where(and(
      eq(externalCardEditAttempts.id, startedAttempt.attemptId),
      eq(externalCardEditAttempts.syncId, syncId),
      eq(externalCardEditAttempts.leaseGeneration, generation),
      eq(externalCardEditAttempts.state, "sending"),
    )).for("update").limit(1);
    const at = now();
    // One transaction: this attempt, still sending, and the lease's current
    // holder, current generation and unexpired lease. Otherwise nothing is
    // written and the attempt waits for recovery to call it unknown.
    if (!attempt || !holdsLease(row, input.leaseOwner, generation, at)) return false;
    const revision = startedAttempt.revision;
    const attemptState = outcome.kind === "succeeded" ? "succeeded" as const : outcome.kind === "unknown" ? "unknown" as const : "failed" as const;
    const reason = outcome.kind === "succeeded" ? "slack_accepted" : outcome.kind === "message_not_found" ? "message_not_found"
      : outcome.reason;
    await tx.update(externalCardEditAttempts).set({ state: attemptState, outcomeReason: reason, completedAt: at, updatedAt: at })
      .where(eq(externalCardEditAttempts.id, attempt.id));
    // Deleted or retracted while this edit was in flight: no new edit starts,
    // and the sync is never reported confirmed (nor the Slack copy withdrawn).
    const [source] = await tx.select({ deletedAt: messages.deletedAt }).from(messages)
      .where(eq(messages.id, row.sourceMessageId)).limit(1);
    const deleted = !source || source.deletedAt !== null;
    const set = outcomeSet(row, at, revision);
    await writeSync(tx, row, deleted && outcome.kind !== "message_not_found" && outcome.kind !== "identity_changed"
      ? { ...set, ...endSet("source_deleted", at) } : set, at);
    return true;
  });
  if (!recorded) return { kind: "outcome_fenced", syncId, attemptId: startedAttempt.attemptId };
  return { kind: "attempted", syncId, attemptId: startedAttempt.attemptId, revision: startedAttempt.revision, outcome: outcome.kind };

  function outcomeSet(row: Sync, at: Date, revision: number): SyncSet {
    switch (outcome.kind) {
      case "succeeded": {
        // A success records only its own revision: a newer one committed meanwhile stays pending.
        const after = { ...row, shownRevision: revision, succeededRevision: Math.max(row.succeededRevision ?? 0, revision) };
        const confirmed = slackCardEditSyncStatus(after, false).confirmed;
        return {
          shownRevision: after.shownRevision, succeededRevision: after.succeededRevision,
          holdReason: null, retryCount: 0, nextAttemptAt: nextLook(after, at),
          ...(confirmed ? { notConfirmedSince: null, noticeKind: null, noticeAt: null } : {}),
          ...releaseLease, updatedAt: at,
        };
      }
      case "unknown":
        return unknownOutcomeSet(at);
      case "refused": {
        // Final for this revision: never retried, never re-sent by repair; a newer revision still goes.
        const after = { ...row, refusedRevision: Math.max(row.refusedRevision ?? 0, revision) };
        const latest = revision === row.latestRevision;
        return {
          refusedRevision: after.refusedRevision, refusedReason: outcome.reason.slice(0, 160),
          holdReason: null, retryCount: 0, nextAttemptAt: nextLook(after, at),
          ...(latest ? { noticeKind: "latest_update_not_shown" as const, noticeAt: at } : {}),
          ...releaseLease, updatedAt: at,
        };
      }
      case "not_sent":
        return {
          retryCount: row.retryCount + 1,
          nextAttemptAt: new Date(at.getTime() + Math.max(outcome.retryAfterMs, 1_000, outcome.reason === "slack_rate_limited"
            ? 0 : slackCardEditRetryDelayMs(row.retryCount))),
          ...releaseLease, updatedAt: at,
        };
      case "kept":
        // Kept and shown, like the pair states (a recoverable channel state
        // too): the SAME revision is tried again once the pair is usable,
        // under every check. On its own it never proves the channel is gone.
        return holdSet(row, outcome.reason, at);
      case "message_not_found":
        // Slack proved the stored ts is gone: the only provider answer that ends a confirmed original's sync.
        return endSet("message_not_found", at);
      case "identity_changed":
        return endSet("identity_changed", at);
    }
  }
}

/**
 * The pair's one "not confirmed in Slack" notice (deduplicated across the
 * pair's messages) is driven only by the uncertainty latch: once a sync's
 * unknown outcome is at least T old, even when its read-backs looked right (a
 * late old request can still leave Slack wrong with no check left to catch
 * it). A definite refusal keeps its own notice; plain pending is pending.
 * This records it per message for operators and refreshes the pairs' notice
 * rows; the panel recomputes the same projection when it reads.
 */
export async function raiseSlackCardEditNotConfirmedNotices(db: Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS);
  return db.transaction(async (tx) => {
    const raised = await tx.update(externalCardEditSyncs).set({ noticeKind: "not_confirmed", noticeAt: now })
      .where(and(
        eq(externalCardEditSyncs.state, "open"),
        lte(externalCardEditSyncs.uncertainAt, cutoff),
        // Not yet recorded for this message, or its pair's notice row is not there yet (a read-back recorded it first).
        or(isNull(externalCardEditSyncs.noticeKind), sql`${externalCardEditSyncs.noticeKind} <> 'not_confirmed'`,
          sql`NOT EXISTS (SELECT 1 FROM ${externalCardEditPairNotices}
            WHERE ${externalCardEditPairNotices.bindingId} = ${externalCardEditSyncs.bindingId}
              AND ${externalCardEditPairNotices.bindingEpoch} = ${externalCardEditSyncs.bindingEpoch}
              AND ${externalCardEditPairNotices.kind} = 'not_confirmed')`),
      )).returning({ bindingId: externalCardEditSyncs.bindingId, bindingEpoch: externalCardEditSyncs.bindingEpoch });
    // Pair locks after every sync row, in one order (the global lock order).
    for (const pair of sortSlackCardEditPairs(raised)) await refreshSlackCardEditPairNotices(tx, pair, now);
    return raised.length;
  });
}

/**
 * Production wiring: an edit's write credential is leased the way a send's
 * is, only while the binding's full authority (grant, install, credential,
 * channel) still resolves at the original's epochs and credential revision.
 */
export function createSlackCardEditProductionDependencies(input: {
  db: Database;
  provider: Pick<SlackBridgeProviderRuntime, "transport" | "credentialResolver" | "releaseCredential">;
  registrationId: string;
  now?: () => Date;
}): SlackCardEditWorkerDependencies {
  return {
    registrationId: input.registrationId,
    transport: input.provider.transport,
    async leaseCredential({ fence, serverId, now }) {
      const decision = await resolveExternalBindingAuthority({
        serverId, bindingId: fence.bindingId, expectedConnectionEpoch: fence.connectionEpoch,
        expectedBindingEpoch: fence.bindingEpoch, now,
      }, input.db);
      if (!decision.active || decision.fact.installId !== fence.installId || decision.fact.providerAppId !== fence.providerAppId
        || decision.fact.credentialRevision !== fence.credentialRevision
        || decision.fact.providerAuthorityId !== fence.providerAuthorityId
        || decision.fact.providerConversationId !== fence.providerConversationId) return null;
      return input.provider.credentialResolver.resolve({ authority: fence, now });
    },
    releaseCredential: (handle) => input.provider.releaseCredential(handle),
    ...(input.now ? { now: input.now } : {}),
  };
}

/** The card edit worker loop: one sync per step, a few steps per tick, and the T notice sweep. */
export function createSlackCardEditWorkerRuntime(input: {
  db: Database;
  leaseOwner: string;
  dependencies: SlackCardEditWorkerDependencies;
  intervalMs?: number;
  maxStepsPerTick?: number;
  onError?(error: unknown): void;
  tracer?: Tracer;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastNoticeSweepAt = Number.NEGATIVE_INFINITY;
  const now = input.dependencies.now ?? currentDate;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await withTraceRoot(input.tracer, "server.slack_bridge.card_edit.tick", { surface: "server", kind: "internal" }, async () => {
        try {
          for (let step = 0; step < (input.maxStepsPerTick ?? 10); step += 1) {
            const result = await processSlackCardEditSyncOnce(input);
            if (result.kind === "empty") break;
          }
          // T is half an hour: a sweep a minute is plenty.
          const sweepAt = now();
          if (sweepAt.getTime() - lastNoticeSweepAt >= SLACK_CARD_EDIT_NOTICE_SWEEP_MS) {
            lastNoticeSweepAt = sweepAt.getTime();
            await raiseSlackCardEditNotConfirmedNotices(input.db, sweepAt);
          }
        } catch (error) {
          input.onError?.(error);
          throw error;
        }
      });
    } catch {
      // Already reported through onError inside the span.
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (timer) return;
      timer = setClockInterval(() => { void tick(); }, input.intervalMs ?? 1_000) as ReturnType<typeof setInterval>;
      void tick();
    },
    async stop() {
      if (timer) clearClockInterval(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 5));
    },
    tick,
  };
}
