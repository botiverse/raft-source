import { lockSlackConversations, slackConversationAdvisoryKey } from "./slackBridgeRowLocks";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import { evaluateFeatureFlag } from "./featureFlagService";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDb, type Database, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  externalAppCredentials, externalAppInstalls, externalAppRegistrations, externalBindingAudienceSnapshots, externalDeliveryPartitions, slackChannelDeletions,
  externalChannelBindings, externalActorProjections, externalAddressabilityProjections,
} from "../db/schema";
import { clearResumedSlackPairControlWait, isSlackControlWaitReason, lockPartitionAndHead } from "./externalDeliveryWorkerService";
import { findSlackPairRecoveryIdentity, listSlackPairHeads, listSlackPairRecoveryWaits, readSlackPairRecoveryFence,
  sameSlackPairRecoveryFence, type SlackPairRecoveryFence } from "./slackBridgePairQueue";
import { slackAudienceEventRevision, slackLifecycleClockAt, slackLifecycleClockIsNewer, latestSlackLifecycleClock, slackLifecycleClockDate, type SlackLifecycleClock, type SlackLifecycleMemberProfile } from "./slackChannelLifecycleObservation";
import { grantMatchesCurrentRegistration, resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";
import { currentConversationAuthorityStatus } from "./slackBridgeConversationAuthorityStatus";

export type SlackBindingProductState = "connected" | "paused" | "disconnected";

export type SlackBindingRecoveryAction =
  | "none"
  | "unarchive_slack_channel"
  | "select_replacement_slack_channel"
  | "reinstall_slack_app"
  | "reauthorize_slack_app"
  | "review_and_resume_binding";

export interface SlackBindingLifecycleProjection {
  state: SlackBindingProductState;
  reason: string | null;
  recoveryAction: SlackBindingRecoveryAction;
}

export type SlackChannelLifecycleEvent =
  | { kind: "archived" }
  | { kind: "renamed"; name: string }
  | { kind: "available"; name: string }
  | { kind: "member_joined" | "member_left"; userId: string; profile?: SlackLifecycleMemberProfile };

export type SlackChannelLifecycleResult =
  | {
      kind: "applied" | "unchanged";
      bindingId: string;
      bindingEpoch: number;
      projection: SlackBindingLifecycleProjection;
    }
  | { kind: "ignored"; bindingId: string; bindingEpoch: number; reason: "lifecycle_metadata_stale_authority" }
  | { kind: "fence_mismatch" };

export function projectSlackBindingLifecycle(input: {
  installState: typeof externalAppInstalls.$inferSelect["state"];
  installStateReason: string | null;
  bindingState: typeof externalChannelBindings.$inferSelect["state"];
  bindingStateReason: string | null;
}): SlackBindingLifecycleProjection {
  if (input.installState !== "active") {
    const recoveryAction = input.installState === "reauth_required"
      ? "reauthorize_slack_app"
      : input.installState === "revoked" || input.installState === "disconnected"
        ? "reinstall_slack_app"
        : "review_and_resume_binding";
    return {
      state: "disconnected",
      reason: input.installStateReason,
      recoveryAction,
    };
  }
  if (input.bindingState === "revoked") {
    return {
      state: "disconnected",
      reason: input.bindingStateReason,
      recoveryAction: input.bindingStateReason === "provider_app_uninstalled"
        ? "reinstall_slack_app"
        : "review_and_resume_binding",
    };
  }
  if (input.bindingState === "paused" || input.bindingState === "quarantined") {
    const recoveryAction = input.bindingStateReason === "provider_channel_archived"
      ? "unarchive_slack_channel"
      : input.bindingStateReason === "provider_channel_deleted"
        ? "select_replacement_slack_channel"
        : "review_and_resume_binding";
    return {
      state: "paused",
      reason: input.bindingStateReason,
      recoveryAction,
    };
  }
  return { state: "connected", reason: null, recoveryAction: "none" };
}

interface SlackLifecycleCoordinates {
  serverId: string; registrationId: string; installId: string; bindingId: string;
  providerAuthorityId: string; providerConversationId: string;
  expectedConnectionEpoch: number; expectedBindingEpoch: number;
}

/** Registration and server grants are shared across installs; preserve this order. */
async function lockSlackLifecycleScope(tx: DatabaseTransaction, input: SlackLifecycleCoordinates, conversationAlreadyLocked = false, skipBusy = false) {
  // Shared stable conversation key before any install/binding/grant row lock.
  if (!conversationAlreadyLocked) await lockSlackConversations(tx, [{ registrationId: input.registrationId,
    providerAuthorityId: input.providerAuthorityId, providerConversationId: input.providerConversationId }]);
  const [install] = await tx.select().from(externalAppInstalls).where(and(
    eq(externalAppInstalls.id, input.installId), eq(externalAppInstalls.registrationId, input.registrationId),
    eq(externalAppInstalls.providerAuthorityId, input.providerAuthorityId),
    eq(externalAppInstalls.connectionEpoch, input.expectedConnectionEpoch),
  )).for("update", skipBusy ? { skipLocked: true } : undefined).limit(1);
  if (!install) return null;
  const [binding] = await tx.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, input.bindingId), eq(externalChannelBindings.serverId, input.serverId),
    eq(externalChannelBindings.registrationId, input.registrationId), eq(externalChannelBindings.installId, install.id),
    eq(externalChannelBindings.providerConversationId, input.providerConversationId),
    eq(externalChannelBindings.connectionEpoch, input.expectedConnectionEpoch),
    eq(externalChannelBindings.bindingEpoch, input.expectedBindingEpoch),
  )).for("update", skipBusy ? { skipLocked: true } : undefined).limit(1);
  if (!binding || binding.state === "revoked") return null;
  const [registration] = await tx.select().from(externalAppRegistrations).where(and(
    eq(externalAppRegistrations.id, binding.registrationId), eq(externalAppRegistrations.provider, "slack"),
    eq(externalAppRegistrations.providerAppId, install.providerAppId), eq(externalAppRegistrations.state, "active"),
  )).for("update").limit(1);
  const grant = await resolveExternalInstallServerGrantAuthority(tx, {
    installId: install.id, serverId: binding.serverId, registrationId: binding.registrationId,
  }, { lock: true });
  const mayResume = install.state === "active" && grant.current && binding.grantEpoch === grant.grant.grantEpoch && Boolean(registration);
  return { install, binding, mayResume, registration, grant, registrationCurrent: Boolean(registration) };
}

/** Verified metadata can restrict a pair; only current grants can resume it. */
export async function reconcileSlackChannelLifecycle(input: {
  serverId: string; registrationId: string; installId: string; bindingId: string;
  providerAuthorityId: string; providerConversationId: string;
  expectedConnectionEpoch: number; expectedBindingEpoch: number;
  event: SlackChannelLifecycleEvent; eventClock?: SlackLifecycleClock; now: Date;
  db?: Database;
  verifiedAudience?: { bindingEpoch: number; credentialRevision: number; audienceEventRevision: number; revision: number;
    queueFence: SlackPairRecoveryFence };
  persistReceipt?(executor: DatabaseExecutor, reason: "lifecycle_metadata_processed" | "lifecycle_metadata_stale_authority"): Promise<void>;
}): Promise<SlackChannelLifecycleResult> {
  if (!Number.isFinite(input.now.getTime()) || !Number.isSafeInteger(input.expectedConnectionEpoch)
    || !Number.isSafeInteger(input.expectedBindingEpoch) || input.expectedConnectionEpoch <= 0 || input.expectedBindingEpoch <= 0) {
    return { kind: "fence_mismatch" };
  }
  const clock = input.eventClock ?? slackLifecycleClockAt(input.now);
  const db = input.db ?? getDb();
  let resumed = false;
  const conversation = { registrationId: input.registrationId, providerAuthorityId: input.providerAuthorityId,
    providerConversationId: input.providerConversationId };
  try { slackConversationAdvisoryKey(conversation); } catch { return { kind: "fence_mismatch" }; }
  // Workers take the queue head before install/binding locks. Discover the
  // candidate without locks, then take the stable conversation and queue locks
  // in that order before the lifecycle scope. Recheck the head under those
  // locks: a changed or busy head must wait for a new verification pass.
  const verifiedRecovery = input.event.kind === "available" && Boolean(input.verifiedAudience);
  const recoveryIdentity = verifiedRecovery ? await findSlackPairRecoveryIdentity(db, {
    bindingId: input.bindingId, bindingEpoch: input.expectedBindingEpoch,
  }) : null;
  const [candidateWait] = recoveryIdentity ? await listSlackPairRecoveryWaits(db, recoveryIdentity) : [];
  const [candidateHead] = verifiedRecovery
    ? await listSlackPairHeads(db, [{ bindingId: input.bindingId, bindingEpoch: input.expectedBindingEpoch }])
    : [];
  const result = await db.transaction(async (tx): Promise<SlackChannelLifecycleResult> => {
    await lockSlackConversations(tx, [conversation]);
    const coordinates = [candidateHead, candidateWait].filter((item) => item !== undefined)
      .filter((item, index, all) => all.findIndex((other) => other.bindingId === item.bindingId && other.bindingEpoch === item.bindingEpoch) === index)
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId) || left.bindingEpoch - right.bindingEpoch);
    const lockedPartitions = new Map<string, NonNullable<Awaited<ReturnType<typeof lockPartitionAndHead>>>>();
    for (const item of coordinates) {
      const locked = await lockPartitionAndHead(tx, item.bindingId, item.bindingEpoch, { skipLocked: true });
      if (!locked) return { kind: "fence_mismatch" };
      lockedPartitions.set(`${item.bindingId}:${item.bindingEpoch}`, locked);
    }
    const lockedHead = candidateHead ? lockedPartitions.get(`${candidateHead.bindingId}:${candidateHead.bindingEpoch}`) : null;
    const lockedWait = candidateWait ? lockedPartitions.get(`${candidateWait.bindingId}:${candidateWait.bindingEpoch}`) : null;
    if (candidateHead && (!lockedHead?.delivery || lockedHead.delivery.id !== candidateHead.deliveryId
      || lockedHead.delivery.state === "dispatching")) return { kind: "fence_mismatch" };
    // Channel conversion locks the binding before a partition. Once this
    // transaction holds a partition, never wait for either install or binding.
    const scope = await lockSlackLifecycleScope(tx, input, true, lockedPartitions.size > 0);
    if (!scope) return { kind: "fence_mismatch" };
    const { install, binding, mayResume, registration, grant } = scope;
    if (verifiedRecovery) {
      const currentFence = await readSlackPairRecoveryFence(tx, { bindingId: binding.id, bindingEpoch: binding.bindingEpoch });
      if (!currentFence || !input.verifiedAudience?.queueFence
        || !sameSlackPairRecoveryFence(input.verifiedAudience.queueFence, currentFence)) return { kind: "fence_mismatch" };
      const [currentHead] = await listSlackPairHeads(tx, [{ bindingId: binding.id, bindingEpoch: binding.bindingEpoch }]);
      if (Boolean(currentHead) !== Boolean(candidateHead) || (currentHead && candidateHead
        && (currentHead.bindingId !== candidateHead.bindingId || currentHead.bindingEpoch !== candidateHead.bindingEpoch
          || currentHead.deliveryId !== candidateHead.deliveryId))) return { kind: "fence_mismatch" };
      const currentIdentity = await findSlackPairRecoveryIdentity(tx, { bindingId: binding.id, bindingEpoch: binding.bindingEpoch });
      const [currentWait] = currentIdentity ? await listSlackPairRecoveryWaits(tx, currentIdentity) : [];
      if (Boolean(currentWait) !== Boolean(candidateWait) || (currentWait && candidateWait && currentWait.id !== candidateWait.id)) {
        return { kind: "fence_mismatch" };
      }
    }
    if (install.state === "active" && !mayResume) {
      await input.persistReceipt?.(tx, "lifecycle_metadata_stale_authority");
      return { kind: "ignored", bindingId: binding.id, bindingEpoch: binding.bindingEpoch, reason: "lifecycle_metadata_stale_authority" };
    }
    const event = input.event;
    const audienceEventRevision = event.kind === "member_joined" || event.kind === "member_left"
      ? slackAudienceEventRevision(binding.slackLifecycleObservation) : null;
    if ((event.kind === "member_joined" || event.kind === "member_left") && audienceEventRevision === null) {
      return { kind: "fence_mismatch" };
    }
    await input.persistReceipt?.(tx, "lifecycle_metadata_processed");
    const observation = { ...binding.slackLifecycleObservation };
    let changed = false;
    if (event.kind === "available") {
      if (slackLifecycleClockIsNewer(clock, observation.archive?.clock)) {
        observation.archive = { archived: false, clock }; changed = true;
      }
      if (slackLifecycleClockIsNewer(clock, observation.botMembership?.clock)) {
        observation.botMembership = { member: true, clock }; changed = true;
      }
      if (slackLifecycleClockIsNewer(clock, observation.name?.clock)) { observation.name = { value: event.name, clock }; changed = true; }
    } else if (event.kind === "archived") {
      if (slackLifecycleClockIsNewer(clock, observation.archive?.clock)) {
        observation.archive = { archived: true, clock }; changed = true;
      }
    } else if (event.kind === "renamed") {
      if (slackLifecycleClockIsNewer(clock, observation.name?.clock)) {
        observation.name = { value: event.name, clock }; changed = true;
      }
    } else if (event.userId === install.botUserId) {
      if (slackLifecycleClockIsNewer(clock, observation.botMembership?.clock)) {
        observation.botMembership = { member: event.kind === "member_joined", clock }; changed = true;
        // A new signed self-join makes verification due now, not after the
        // previous failed read's backoff. A duplicate clock cannot reset it.
        if (event.kind === "member_joined" && mayResume && (binding.state === "active" || (binding.state === "paused"
          && (binding.stateReason === "provider_bot_removed" || binding.stateReason === "provider_channel_archived")))) {
          delete observation.recovery;
        }
      }
    } else if (mayResume && binding.state === "active") {
      changed = await recordMemberObservation(tx, binding, install, event, clock, input.now);
    }
    if (audienceEventRevision !== null && ((event.kind === "member_joined" || event.kind === "member_left")
      && (event.userId !== install.botUserId || changed))) {
      // The event may arrive during a paginated audience read. Remember even
      // paused-pair events so that a stale read cannot release the queue. A
      // stale self event is already ordered by botMembership and does not
      // invalidate a newer observation or make a replay look like a change.
      observation.audienceEventRevision = audienceEventRevision + 1;
      changed = true;
    }
    let state = binding.state;
    let stateReason = binding.stateReason;
    const lifecyclePause = state === "paused" && (stateReason === "provider_channel_archived" || stateReason === "provider_bot_removed");
    const ownBotEvent = (event.kind === "member_joined" || event.kind === "member_left") && event.userId === install.botUserId;
    const controlEvent = event.kind === "available" || event.kind === "archived" || ownBotEvent;
    let botRecoveryVerified = false;
    if ((state === "active" || (state === "paused" && stateReason === "provider_bot_removed"))
      && event.kind === "available" && input.verifiedAudience) {
      const proof = input.verifiedAudience;
      const [credential] = await tx.select().from(externalAppCredentials).where(and(
        eq(externalAppCredentials.installId, install.id), eq(externalAppCredentials.state, "active"),
        eq(externalAppCredentials.credentialRevision, install.credentialRevision),
      )).for("update").limit(1);
      const [snapshot] = await tx.select({ revision: externalBindingAudienceSnapshots.audienceRevision })
        .from(externalBindingAudienceSnapshots).where(and(eq(externalBindingAudienceSnapshots.bindingId, binding.id),
          eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch)))
        .orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1).for("update");
      botRecoveryVerified = Boolean(registration && grant.current && grantMatchesCurrentRegistration(grant.grant, registration))
        && (await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: input.serverId }, tx)).enabled
        && proof.bindingEpoch === binding.bindingEpoch
        && proof.credentialRevision === install.credentialRevision
        && Boolean(credential && (!credential.expiresAt || credential.expiresAt > input.now))
        && proof.audienceEventRevision === slackAudienceEventRevision(binding.slackLifecycleObservation)
        && proof.revision === snapshot?.revision
        && await currentConversationAuthorityStatus(tx, binding, input.now) === "matched";
    }
    const verifiedActive = state === "active" && mayResume && botRecoveryVerified;
    if (changed && controlEvent && (state === "active" || lifecyclePause)) {
      // Display/member observations never reinstate an obsolete cached pause.
      if (state === "active") {
        if (event.kind === "archived") { state = "paused"; stateReason = "provider_channel_archived"; }
        else if (event.kind === "member_left" && ownBotEvent) { state = "paused"; stateReason = "provider_bot_removed"; }
      } else if (observation.archive?.archived) { state = "paused"; stateReason = "provider_channel_archived"; }
      else if (observation.botMembership?.member === false) { state = "paused"; stateReason = "provider_bot_removed"; }
      else if (lifecyclePause && mayResume
        && event.kind === "available"
        && (stateReason === "provider_channel_archived" ? observation.archive?.archived === false
          : observation.botMembership?.member === true && botRecoveryVerified)) {
        state = "active"; stateReason = null;
      }
    }
    const stateChanged = state !== binding.state || stateReason !== binding.stateReason;
    resumed = stateChanged && state === "active";
    if (resumed) delete observation.recovery;
    if (botRecoveryVerified && candidateWait && !resumed) {
      // A pair can carry waits in several generations. Recheck the next one
      // on the next maintenance pass without waiting for the previous backoff.
      delete observation.recovery;
      changed = true;
    } else if (verifiedActive && !candidateWait && observation.recovery) {
      // A successful hint is not a failure: reset exponential backoff while
      // preserving the last-check timestamp for the 30-second hint throttle.
      observation.recovery = { ...observation.recovery, attempt: 0,
        nextCheckAt: new Date(input.now.getTime() + 5 * 60_000).toISOString() };
      changed = true;
    }
    const bindingEpoch = binding.bindingEpoch + (stateChanged ? 1 : 0);
    if (changed) await tx.update(externalChannelBindings).set({ slackLifecycleObservation: observation,
      state, stateReason, bindingEpoch, updatedAt: input.now,
    }).where(eq(externalChannelBindings.id, binding.id));
    const recoveryPartition = lockedWait ?? lockedHead;
    if (recoveryPartition && botRecoveryVerified && (resumed || verifiedActive)) {
      const reason = recoveryPartition.partition.authorityBlockedReason;
      if (isSlackControlWaitReason(reason) || reason === "slack_not_in_channel" || reason === "slack_channel_archived") {
        await tx.update(externalDeliveryPartitions).set({ authorityBlockedAt: null, authorityBlockedReason: null,
          authorityRetryAt: null, authorityOverdueAlertedAt: null, updatedAt: input.now,
        }).where(eq(externalDeliveryPartitions.id, recoveryPartition.partition.id));
      }
    }
    return { kind: changed ? "applied" : "unchanged", bindingId: binding.id, bindingEpoch,
      projection: projectSlackBindingLifecycle({ installState: install.state, installStateReason: install.stateReason,
        bindingState: state, bindingStateReason: stateReason }) };
  });
  // Archive recovery does not use the bot-audience proof; retain its existing
  // post-commit cleanup. Bot recovery cleared its head under the proof locks.
  if (resumed && !verifiedRecovery && (result.kind === "applied" || result.kind === "unchanged") && result.projection.state === "connected"
    && (await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: input.serverId }, db)).enabled) {
    const [head] = await listSlackPairHeads(db, [{ bindingId: result.bindingId, bindingEpoch: result.bindingEpoch }]);
    if (head) await clearResumedSlackPairControlWait({ db, registrationId: input.registrationId,
      currentBindingId: result.bindingId, currentBindingEpoch: result.bindingEpoch,
      bindingId: head.bindingId, bindingEpoch: head.bindingEpoch, now: input.now, verifiedConversationAvailable: true });
  }
  return result;
}

/** Join/leave proves Slack addressability, never Raft membership or profile data. */
async function recordMemberObservation(
  tx: DatabaseExecutor, binding: typeof externalChannelBindings.$inferSelect,
  install: typeof externalAppInstalls.$inferSelect,
  event: Extract<SlackChannelLifecycleEvent, { userId: string }>, clock: SlackLifecycleClock, now: Date,
): Promise<boolean> {
  const actorIdentity = and(
    eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.appRegistrationId, binding.registrationId),
    eq(externalActorProjections.installId, install.id), eq(externalActorProjections.workspaceId, install.providerAuthorityId),
    eq(externalActorProjections.externalActorId, event.userId),
  );
  // Discover without a row lock, then follow the shared order: install and
  // binding are already held, addressability rows precede actor rows.
  const [candidate] = await tx.select({ id: externalActorProjections.id }).from(externalActorProjections)
    .where(actorIdentity).limit(1);
  const addresses = candidate ? await tx.select().from(externalAddressabilityProjections).where(and(
    eq(externalAddressabilityProjections.projectionId, candidate.id),
    eq(externalAddressabilityProjections.bindingId, binding.id),
    eq(externalAddressabilityProjections.bindingEpoch, binding.bindingEpoch),
    eq(externalAddressabilityProjections.conversationId, binding.providerConversationId),
  )).orderBy(asc(externalAddressabilityProjections.id)).for("update") : [];
  const [existing] = await tx.select().from(externalActorProjections).where(actorIdentity).for("update").limit(1);
  if ((candidate?.id ?? null) !== (existing?.id ?? null)) return false;
  if (existing?.deactivated || existing?.state === "tombstoned" || (!existing && event.kind === "member_left")) return false;
  const profile = event.kind === "member_joined" ? event.profile : undefined;
  if (existing?.actorKind === "unknown" && profile) {
    await tx.update(externalActorProjections).set({ displayName: profile.displayName, handles: profile.handle ? [profile.handle] : [],
      actorKind: profile.actorKind, projectionRevision: existing.projectionRevision + 1, observedAt: now })
      .where(eq(externalActorProjections.id, existing.id));
  }
  const projection = existing ?? (await tx.insert(externalActorProjections).values({
    provider: "slack", appRegistrationId: binding.registrationId, installId: install.id,
    workspaceId: install.providerAuthorityId, externalActorId: event.userId,
    displayName: profile?.displayName ?? event.userId, handles: profile?.handle ? [profile.handle] : [],
    actorKind: profile?.actorKind ?? "unknown", projectionRevision: 1, observedAt: now,
  }).returning())[0]!;
  // Lock order is by id; choose the newest revision only after locking.
  addresses.sort((a, b) => b.contextRevision - a.contextRevision || a.id.localeCompare(b.id));
  const state = event.kind === "member_joined" ? "active" : "removed";
  if (addresses[0] && !slackLifecycleClockIsNewer(clock, latestSlackLifecycleClock(addresses[0].slackMemberEventClock, slackLifecycleClockAt(addresses[0].observedAt)))) return false;
  const values = { provider: "slack", appRegistrationId: binding.registrationId, installId: install.id,
    workspaceId: install.providerAuthorityId, connectionEpoch: install.connectionEpoch,
    bindingId: binding.id, bindingEpoch: binding.bindingEpoch, conversationId: binding.providerConversationId,
    state, slackMemberEventClock: clock,
    memberRevision: (addresses[0]?.memberRevision ?? 0) + (!addresses[0] || addresses[0].state !== state ? 1 : 0),
    contextRevision: (addresses[0]?.contextRevision ?? 0) + (!addresses[0] || addresses[0].state !== state ? 1 : 0),
    observedAt: slackLifecycleClockDate(clock), expiresAt: new Date(now.getTime() + 30 * 60_000), updatedAt: now } as const;
  if (addresses.length > 1) await tx.update(externalAddressabilityProjections).set({ state: "stale", updatedAt: now })
    .where(inArray(externalAddressabilityProjections.id, addresses.slice(1).map(row => row.id)));
  if (addresses[0]) await tx.update(externalAddressabilityProjections).set(values)
    .where(eq(externalAddressabilityProjections.id, addresses[0].id));
  else await tx.insert(externalAddressabilityProjections).values({ projectionId: projection.id, ...values });
  return true;
}

/**
 * Appends one exact private-channel audience observation and advances the
 * binding to that revision under an epoch/revision compare-and-set. The input
 * already contains provider ids resolved by the identity authority; this
 * function only compares and records them and cannot mutate either system's
 * membership.
 */
export async function readSlackBindingLifecycleProjection(input: {
  serverId: string;
  bindingId: string;
}, db: DatabaseExecutor = getDb()): Promise<SlackBindingLifecycleProjection | null> {
  const [row] = await db.select({
    installState: externalAppInstalls.state,
    installStateReason: externalAppInstalls.stateReason,
    bindingState: externalChannelBindings.state,
    bindingStateReason: externalChannelBindings.stateReason,
  }).from(externalChannelBindings).innerJoin(
    externalAppInstalls,
    eq(externalAppInstalls.id, externalChannelBindings.installId),
  ).where(and(
    eq(externalChannelBindings.id, input.bindingId),
    eq(externalChannelBindings.serverId, input.serverId),
  )).limit(1);
  return row ? projectSlackBindingLifecycle(row) : null;
}

/** Signature-verified deletion is retained even after the last pair was removed. */
export async function recordVerifiedSlackChannelDeletion(input: {
  registrationId: string; environment: "test" | "production"; providerAppId: string;
  providerAuthorityId: string; providerConversationId: string;
  providerEventId: string; providerEventType: "channel_deleted" | "group_deleted";
  signingSecretRevision: number; payloadSha256: string; now: Date;
  verifySource?(executor: DatabaseExecutor): Promise<boolean>;
}): Promise<{ duplicate: boolean; paused: boolean } | null> {
  const conversation = { registrationId: input.registrationId, providerAuthorityId: input.providerAuthorityId,
    providerConversationId: input.providerConversationId };
  try { slackConversationAdvisoryKey(conversation); } catch { return null; }
  return getDb().transaction(async (tx) => {
    await lockSlackConversations(tx, [conversation]);
    // Install before binding, including historical epochs. This fact is not
    // authorization to send: it only describes a permanently absent channel.
    const installs = await tx.select({ id: externalAppInstalls.id }).from(externalAppInstalls)
      .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalAppInstalls.registrationId))
      .where(and(eq(externalAppInstalls.registrationId, input.registrationId),
        eq(externalAppRegistrations.provider, "slack"), eq(externalAppRegistrations.environment, input.environment),
        eq(externalAppInstalls.providerAppId, input.providerAppId), eq(externalAppInstalls.providerAuthorityId, input.providerAuthorityId)))
      .orderBy(externalAppInstalls.id).for("update", { of: externalAppInstalls });
    if (!installs.length) return null;
    if (input.verifySource && !await input.verifySource(tx)) return null;
    const bindings = await tx.select().from(externalChannelBindings).where(and(
      inArray(externalChannelBindings.installId, installs.map((install) => install.id)),
      eq(externalChannelBindings.registrationId, input.registrationId),
      eq(externalChannelBindings.providerConversationId, input.providerConversationId),
    )).orderBy(externalChannelBindings.id).for("update");
    if (!bindings.length) return null;
    const [inserted] = await tx.insert(slackChannelDeletions).values({
      registrationId: input.registrationId, environment: input.environment, providerAppId: input.providerAppId,
      providerAuthorityId: input.providerAuthorityId, providerConversationId: input.providerConversationId,
      sourceKind: "signed_event", sourceKey: `event:${input.providerEventId}`, sourceInstallId: bindings[0]!.installId,
      providerEventId: input.providerEventId, providerEventType: input.providerEventType,
      signingSecretRevision: input.signingSecretRevision, payloadSha256: input.payloadSha256, observedAt: input.now,
    }).onConflictDoNothing().returning({ id: slackChannelDeletions.id });
    let paused = false;
    for (const binding of bindings) {
      if (binding.state === "revoked") continue;
      paused = true;
      if (binding.state === "paused" && binding.stateReason === "provider_channel_deleted") continue;
      await tx.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_deleted",
        bindingEpoch: binding.bindingEpoch + 1, updatedAt: input.now,
      }).where(eq(externalChannelBindings.id, binding.id));
    }
    return { duplicate: !inserted, paused };
  });
}

/** Reserve a provider verification before I/O so replicas cannot repeatedly read one pair. */
export async function reserveSlackLifecycleVerification(input: SlackLifecycleCoordinates & {
  db: Database; now: Date; immediate: boolean;
}) {
  return input.db.transaction(async tx => {
    const scope = await lockSlackLifecycleScope(tx, input);
    if (!scope?.registrationCurrent || !scope.install.botUserId
      || (scope.install.slackLifecycleRetryNotBefore?.getTime() ?? 0) > input.now.getTime()) return null;
    const paused = scope.binding.state === "paused"
      && (scope.binding.stateReason === "provider_channel_archived" || scope.binding.stateReason === "provider_bot_removed");
    if (!paused && scope.binding.state !== "active") return null;
    if (!paused && !input.immediate) {
      const pair = await findSlackPairRecoveryIdentity(tx, { bindingId: scope.binding.id, bindingEpoch: scope.binding.bindingEpoch });
      const [wait] = pair ? await listSlackPairRecoveryWaits(tx, pair) : [];
      if (!wait) return null;
    }
    const observation = { ...scope.binding.slackLifecycleObservation };
    const previous = observation.recovery;
    const due = input.immediate ? Date.parse(previous?.lastCheckedAt ?? "") + 30_000 : Date.parse(previous?.nextCheckAt ?? "");
    if (Number.isFinite(due) && due > input.now.getTime()) return null;
    const attempt = Math.min(12, (previous?.attempt ?? 0) + 1);
    const delay = Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** (attempt - 1));
    observation.recovery = { attempt, lastCheckedAt: input.now.toISOString(),
      nextCheckAt: new Date(input.now.getTime() + delay).toISOString() };
    await tx.update(externalChannelBindings).set({ slackLifecycleObservation: observation, updatedAt: input.now })
      .where(eq(externalChannelBindings.id, scope.binding.id));
    // Advancing a maintenance deadline is not delivery authority. Even a
    // stale-grant pair must move behind other due pairs instead of starving
    // them; it still cannot cause provider I/O or resume.
    return scope.mayResume ? scope : null;
  });
}
