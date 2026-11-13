import type { SlackLifecycleMemberProfile } from "./slackChannelLifecycleObservation";
import { deferSlackLifecycleInstall, recoverSlackLifecyclePauses } from "./slackChannelLifecycleRecovery";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";

import { currentDate, type Tracer } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { evaluateFeatureFlag } from "./featureFlagService";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb, type Database } from "../db/index";
import { getRedis, isRedisAvailable } from "../redis";
import {
  claimSlackMentionReconcile,
  redisSlackMentionReconcileClaimStore,
  type SlackMentionReconcileClaim,
} from "./slackMentionReconcileClaim";
import {
  externalAppCredentials,
  externalAppRegistrations,
  externalAppInstalls,
  externalAppInstallServerGrants,
  externalChannelBindings,
} from "../db/schema";

import { loadSlackBridgeLifecycleBindingRows } from "./slackBridgeLifecycleBindingRows";
import { mapSlackBridgeLifecycleBatches, SLACK_BRIDGE_LIFECYCLE_BATCH_SIZE } from "./slackBridgeLifecycleBatch";

import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { refreshSlackBindingPrivacy } from "./slackBindingPrivacyFreshnessService";
import {
  listSlackBridgeMentionCandidates,
  slackBridgeMentionSyncState,
  refreshSlackConversationAuthority,
} from "./slackBridgeProvisioningControlPlane";
import type { SlackBridgeAvatarMaterializer } from "./slackBridgeProvisioningControlPlane";
import { refreshSlackBridgeInstallGrantReceipts } from "./slackBridgeInstallGrantService";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";
import { SLACK_BRIDGE_AGENT_MENTION_BOT_SCOPES } from "./slackBridgeProductionAppContract";
import {
  startSlackBridgePersistentWorker,
  type SlackBridgeAudienceRefreshReceipt,
  type SlackBridgeBindingRuntime,
  type SlackBridgeLifecycleExecutionReceipt,
  type SlackBridgeBacklogSnapshot,
  type SlackBridgePersistentWorker,
  type SlackBridgePersistentWorkerClock,
  type SlackBridgePersistentWorkerRunResult,
  type SlackBridgeProbeObservation,
  type SlackBridgeProbeRequest,
} from "./slackBridgeWorkerLifecycle";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PROBE_FRESHNESS_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING_EVENTS = 1_000;
const DEFAULT_MAX_OLDEST_EVENT_AGE_MS = 15 * 60_000;
const AGENT_MENTION_RECONCILE_CLAIM_MS = 30_000;
const AGENT_MENTION_RECONCILE_RENEW_MS = 10_000;

export interface SlackBridgeProductionLifecycle {
  start(): void;
  requestEventReconcile(): Promise<SlackBridgePersistentWorkerRunResult>;
  requestConversationReconcile(bindingId: string): Promise<void>;
  readMemberProfile(bindingId: string, userId: string): Promise<SlackLifecycleMemberProfile | null>;
  stop(): void;
}

export interface SlackBridgeProductionLifecycleDependencies {
  db?: Database;
  provider: SlackBridgeProviderRuntime;
  avatarMaterializer?: SlackBridgeAvatarMaterializer;
  now?: () => Date;
  orchestratorId?: string;
  intervalMs?: number;
  probeFreshnessMs?: number;
  maxPendingEvents?: number;
  maxOldestPendingEventAgeMs?: number;
  /** Raft messages waiting for Slack on this binding's pair (latest queue sample); null when unknown. */
  pairBacklog?(bindingId: string): SlackBridgeBacklogSnapshot | null;
  clock?: SlackBridgePersistentWorkerClock;
  /** Claims the whole maintenance pass across replicas, before provider reads. */
  claimRun?(): Promise<SlackMentionReconcileClaim | null>;
  /**
   * Claims one install's mention-usergroup reconcile across replicas. Every
   * replica runs the lifecycle, so without a claim each one sends the same
   * Slack usergroup writes at the same moment and trips Slack's rate limit.
   */
  claimAgentMentionReconcile?(
    serverId: string,
    installId: string,
  ): Promise<SlackMentionReconcileClaim | null>;
  onReceipt?(receipt: SlackBridgeLifecycleExecutionReceipt): void;
  onError?(error: unknown): void;
  tracer?: Tracer;
}

const UNCONTENDED_CLAIM: SlackMentionReconcileClaim = { held: async () => true, end: () => {} };

function defaultClaimAgentMentionReconcile(
  serverId: string,
  installId: string,
  owner: string,
  onError?: (error: unknown) => void,
): Promise<SlackMentionReconcileClaim | null> {
  // No Redis: single replica / dev — just run.
  if (!isRedisAvailable()) return Promise.resolve(UNCONTENDED_CLAIM);
  return claimSlackMentionReconcile({
    store: redisSlackMentionReconcileClaimStore(getRedis()),
    key: `slock:slack-bridge:mention-reconcile:${serverId}:${installId}`,
    token: owner,
    ttlMs: AGENT_MENTION_RECONCILE_CLAIM_MS,
    renewEveryMs: AGENT_MENTION_RECONCILE_RENEW_MS,
    onError,
  });
}

function validNow(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function audienceReceipt(
  receipt: {
    bindingId: string;
    audienceStatus: SlackBridgeAudienceRefreshReceipt["audienceStatus"];
    observedAtMs: number;
    reason?: SlackBridgeAudienceRefreshReceipt["reason"];
    revision?: number;
  },
): SlackBridgeAudienceRefreshReceipt {
  return {
    bindingId: receipt.bindingId,
    audienceStatus: receipt.audienceStatus,
    observedAtMs: receipt.observedAtMs,
    ...(receipt.reason ? { reason: receipt.reason } : {}),
    ...(receipt.revision !== undefined ? { revision: receipt.revision } : {}),
  };
}

/**
 * Production composition for the reviewed lifecycle worker. It is created at
 * process bootstrap without I/O, starts one persistent interval loop from the
 * server start hook, accepts post-ingress event triggers, and stops from the
 * server shutdown hook. Private bindings call the explicit human identity
 * resolver; public bindings refresh provider actor/addressability authority
 * through the same producer used by self-serve setup.
 */
export function createSlackBridgeProductionLifecycle(
  dependencies: SlackBridgeProductionLifecycleDependencies,
): SlackBridgeProductionLifecycle {
  const db = dependencies.db ?? getDb();
  const now = dependencies.now ?? currentDate;
  const intervalMs = dependencies.intervalMs ?? DEFAULT_INTERVAL_MS;
  const orchestratorId = dependencies.orchestratorId
    ?? `slack-bridge:${process.pid}:${randomUUID()}`;
  const claimAgentMentionReconcile = dependencies.claimAgentMentionReconcile
    ?? ((serverId: string, installId: string) => (
      defaultClaimAgentMentionReconcile(serverId, installId, orchestratorId, dependencies.onError)
    ));
  const claimRun = dependencies.claimRun ?? (async () => {
    if (!isRedisAvailable()) return UNCONTENDED_CLAIM;
    return claimSlackMentionReconcile({
      store: redisSlackMentionReconcileClaimStore(getRedis()),
      key: "slock:slack-bridge:lifecycle-refresh",
      token: `${orchestratorId}:${randomUUID()}`,
      // The completed claim lapses rather than being deleted, spacing passes
      // across replicas whose five-minute timers are independently phased.
      ttlMs: intervalMs,
      renewEveryMs: Math.min(10_000, Math.max(1, Math.floor(intervalMs / 3))),
      onError: dependencies.onError,
    });
  });
  const latestAudience = new Map<string, SlackBridgeAudienceRefreshReceipt>();
  const privacyRetryNotBeforeByInstall = new Map<string, number>();
  let worker: SlackBridgePersistentWorker | null = null;
  let stopped = false;



  const loadBindings = async (
    nowMs: number,
    isRunHeld?: () => Promise<boolean>,
  ): Promise<SlackBridgeBindingRuntime[]> => {
    const observedAt = new Date(nowMs);
    if (!validNow(observedAt)) throw new Error("Slack Bridge lifecycle clock is invalid");
    if (isRunHeld && !await isRunHeld()) return [];
    try {
      await refreshSlackBridgeInstallGrantReceipts({
        isRunHeld,
        db,
        provider: dependencies.provider.provisioningProvider,
        now: observedAt,
        onError: dependencies.onError,
      });
    } catch (error) {
      // A provider or database failure never extends an old receipt. The
      // existing receipt expires on schedule and admission then fails closed.
      dependencies.onError?.(error);
    }
    if (isRunHeld && !await isRunHeld()) return [];
    // Privacy is independent from audience membership freshness. Refresh it
    // before any worker consumes the stored classification; provider failure
    // never extends the old deadline and the shared authority resolver then
    // fails closed once that deadline expires.
    const activeBindingIds = await db.select({
      bindingId: externalChannelBindings.id,
      installId: externalChannelBindings.installId,
      serverId: externalChannelBindings.serverId,
      registrationId: externalChannelBindings.registrationId,
    })
      .from(externalChannelBindings)
      .where(eq(externalChannelBindings.state, "active"))
      .orderBy(externalChannelBindings.installId, externalChannelBindings.id);
    const activeInstallIds = new Set<string>();
    const groups = new Map<string, (typeof activeBindingIds)[number]>();
    for (const [index, row] of activeBindingIds.entries()) {
      if (index > 0 && index % SLACK_BRIDGE_LIFECYCLE_BATCH_SIZE === 0) await setImmediate();
      activeInstallIds.add(row.installId);
      groups.set(`${row.serverId}:${row.installId}`, row);
    }
    if (dependencies.provider.provisioningProvider.reconcileAgentMentionHandles) {
      const scopes = new Set<string>(SLACK_BRIDGE_AGENT_MENTION_BOT_SCOPES);
      for (const group of groups.values()) {
        if (isRunHeld && !await isRunHeld()) return [];
        try {
          const [install] = await db.select().from(externalAppInstalls).where(and(
            eq(externalAppInstalls.id, group.installId),
            eq(externalAppInstalls.registrationId, group.registrationId),
            eq(externalAppInstalls.state, "active"),
          )).limit(2);
          if (
            !install?.botUserId
            || [...scopes].some((scope) => !install.installedScopes.includes(scope))
          ) continue;
          const grant = await resolveExternalInstallServerGrantAuthority(db, {
            installId: group.installId,
            serverId: group.serverId,
            registrationId: group.registrationId,
          });
          if (!grant.current || !grant.association) continue;
          const bindings = await db.select().from(externalChannelBindings).where(and(
            eq(externalChannelBindings.serverId, group.serverId),
            eq(externalChannelBindings.installId, group.installId),
            eq(externalChannelBindings.state, "active"),
          ));
          const { candidates, humanCandidates, workspaceHumanCandidates } = await listSlackBridgeMentionCandidates(
            db,
            group.serverId,
            bindings,
          );
          if (isRunHeld && !await isRunHeld()) return [];
          const claim = await claimAgentMentionReconcile(group.serverId, install.id);
          if (!claim) continue;
          let reconciled: Awaited<ReturnType<NonNullable<
            typeof dependencies.provider.provisioningProvider.reconcileAgentMentionHandles
          >>>;
          try {
            reconciled = await dependencies.provider.provisioningProvider
              .reconcileAgentMentionHandles({
                installId: install.id,
                providerAppId: install.providerAppId,
                providerAuthorityId: install.providerAuthorityId,
                botUserId: install.botUserId,
                connectionEpoch: install.connectionEpoch,
                credentialRevision: install.credentialRevision,
                now: observedAt,
                isRunHeld,
              }, {
                serverId: group.serverId,
                candidates,
                humanCandidates: workspaceHumanCandidates,
                isClaimHeld: async () => await claim.held() && (!isRunHeld || await isRunHeld()),
              });
          } finally {
            claim.end();
          }
          // Agent-mention usergroup sync is additive: a deterministic Slack
          // rejection (workspace restricts usergroup management to admins,
          // free plan, handle collisions) must never crash the lifecycle —
          // bindings and message sync keep working, the persisted state just
          // surfaces the recovery hint in settings until the next reconcile
          // succeeds. Transport-level "unverified" does not rewrite state.
          // Agents and humans count together; a principal that exhausted every
          // handle candidate reports `name_taken` through `failures`.
          const syncState = slackBridgeMentionSyncState({
            reconciled,
            candidates,
            humanCandidates,
            observedAt,
          });
          const prev = grant.association.agentMentionSync;
          const changed = syncState !== null && (
            !prev
            || prev.state !== syncState.state
            || prev.slackError !== syncState.slackError
            || prev.expected !== syncState.expected
            || prev.actual !== syncState.actual
          );
          if (changed) {
            await db.update(externalAppInstallServerGrants)
              .set({ agentMentionSync: syncState })
              .where(and(
                eq(externalAppInstallServerGrants.installId, install.id),
                eq(externalAppInstallServerGrants.serverId, group.serverId),
                eq(externalAppInstallServerGrants.grantEpoch, grant.association.grantEpoch),
                eq(externalAppInstallServerGrants.state, "active"),
              ));
          }
          if (syncState?.state === "degraded") {
            console.warn("[SlackBridge] Agent mention reconciliation degraded", {
              serverId: group.serverId,
              installId: install.id,
              slackError: syncState.slackError,
              expected: syncState.expected,
              actual: syncState.actual,
              failures: reconciled.kind === "fact" ? reconciled.fact.failures : undefined,
            });
          }
        } catch (error) {
          dependencies.onError?.(error);
        }
      }
    }
    for (const installId of privacyRetryNotBeforeByInstall.keys()) {
      if (!activeInstallIds.has(installId)) privacyRetryNotBeforeByInstall.delete(installId);
    }
    for (const { bindingId, installId } of activeBindingIds) {
      if (isRunHeld && !await isRunHeld()) return [];
      if ((privacyRetryNotBeforeByInstall.get(installId) ?? 0) > nowMs) continue;
      try {
        const receipt = await refreshSlackBindingPrivacy({
          isRunHeld,
          bindingId,
          provider: dependencies.provider,
          db,
          now: observedAt,
        });
        if (receipt.kind === "unavailable" && receipt.retryAfterMs !== undefined) {
          privacyRetryNotBeforeByInstall.set(installId, nowMs + receipt.retryAfterMs);
        } else {
          privacyRetryNotBeforeByInstall.delete(installId);
        }
      } catch (error) {
        dependencies.onError?.(error);
      }
    }
    if (isRunHeld && !await isRunHeld()) return [];
    const rows = await loadSlackBridgeLifecycleBindingRows(db);
    return mapSlackBridgeLifecycleBatches(rows, (row) => {
      return {
        bindingId: row.bindingId,
        mode: row.bindingState === "active"
          ? "active" as const
          : row.bindingState === "paused"
            ? "paused" as const
            : "disconnected" as const,
        desiredEpoch: row.bindingEpoch,
        authority: {
          appInstallState: row.installState,
          channelBindingState: row.bindingState,
          credentialState: row.credentialState ?? "persist_unknown",
          audienceStatus: row.audienceStatus ?? "unavailable",
        },
        // This snapshot describes the process-owned lifecycle loop itself. The
        // loop is already running when loadBindings executes, so no synthetic
        // per-binding start command is emitted.
        worker: {
          state: "running" as const,
          epoch: row.bindingEpoch,
          leaseId: orchestratorId,
          leaseOwnerId: orchestratorId,
          leaseExpiresAtMs: nowMs + Math.max(intervalMs * 2, 60_000),
        },
        backlog: dependencies.pairBacklog?.(row.bindingId) ?? { pendingEvents: 0, oldestPendingEventAgeMs: 0 },
        probes: {},
      };
    });
  };

  const runProbe = async (
    request: SlackBridgeProbeRequest,
    observedAtMs: number,
  ): Promise<SlackBridgeProbeObservation> => {
    let ok = false;
    let failureReason: string | null = null;
    if (request.surface === "slack") {
      const refresh = latestAudience.get(request.bindingId);
      ok = refresh?.audienceStatus !== "unavailable";
      failureReason = ok ? null : refresh?.reason ?? "audience_unavailable";
    } else {
      const rows = await db.select({ id: externalChannelBindings.id })
        .from(externalChannelBindings)
        .innerJoin(externalAppInstalls, and(
          eq(externalAppInstalls.id, externalChannelBindings.installId),
          eq(externalAppInstalls.state, "active"),
        ))
        .innerJoin(externalAppCredentials, and(
          eq(externalAppCredentials.installId, externalAppInstalls.id),
          eq(externalAppCredentials.state, "active"),
        ))
        .where(and(
          eq(externalChannelBindings.id, request.bindingId),
          eq(externalChannelBindings.state, "active"),
        )).limit(2);
      ok = rows.length === 1;
      failureReason = ok ? null : "runtime_authority_unavailable";
    }
    return {
      surface: request.surface,
      ok,
      observedAtMs,
      trigger: request.trigger,
      failureReason,
    };
  };

  const startWorker = (): SlackBridgePersistentWorker => startSlackBridgePersistentWorker({
    claimRun,
    loadBindings: ({ nowMs, isRunHeld }) => loadBindings(nowMs, isRunHeld),
    async refreshAudience(binding, context) {
      // One refresh producer for both privacy classes: observe provider members
      // and refresh actor/addressability projections and avatars the same way
      // the setup path does.
      const refreshed = await refreshSlackConversationAuthority({
        db,
        provider: dependencies.provider.provisioningProvider,
        avatarMaterializer: dependencies.avatarMaterializer,
        bindingId: binding.bindingId,
        now: new Date(context.nowMs),
        reuseFresh: context.trigger === "periodic",
        isRunHeld: context.isRunHeld,
      });
      const receipt = audienceReceipt(refreshed);
      latestAudience.set(binding.bindingId, receipt);
      return receipt;
    },
    async executeCommand() {
      throw new Error("Slack Bridge production lifecycle emitted an unexpected binding command");
    },
    runProbe: (request, context) => runProbe(request, context.nowMs),
    async afterRefresh(context) {
      await recoverSlackLifecyclePauses({ db, provider: dependencies.provider.provisioningProvider,
        now: new Date(context.nowMs), clock: now, isRunHeld: context.isRunHeld, onError: dependencies.onError });
    },
    async persistReceipt(receipt) {
      dependencies.onReceipt?.(receipt);
    },
    onError: dependencies.onError,
    tracer: dependencies.tracer,
  }, {
    orchestratorId,
    intervalMs,
    probeFreshnessMs: dependencies.probeFreshnessMs ?? DEFAULT_PROBE_FRESHNESS_MS,
    maxPendingEvents: dependencies.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS,
    maxOldestPendingEventAgeMs: dependencies.maxOldestPendingEventAgeMs
      ?? DEFAULT_MAX_OLDEST_EVENT_AGE_MS,
    nowMs: () => now().getTime(),
    clock: dependencies.clock,
  });

  const readMemberProfile = async (bindingId: string, userId: string): Promise<SlackLifecycleMemberProfile | null> => {
    if (stopped || !dependencies.provider.provisioningProvider.readUserProfile) return null;
    try {
      const [scope] = await db.select({ binding: externalChannelBindings, install: externalAppInstalls }).from(externalChannelBindings)
        .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
        .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalChannelBindings.registrationId))
        .where(and(eq(externalChannelBindings.id, bindingId), eq(externalChannelBindings.state, "active"),
          eq(externalAppInstalls.state, "active"), eq(externalAppRegistrations.state, "active"),
          eq(externalAppRegistrations.provider, "slack"), eq(externalAppRegistrations.providerAppId, externalAppInstalls.providerAppId))).limit(1);
      const checkedAt = now();
      if (!scope?.install.botUserId || (scope.install.slackLifecycleRetryNotBefore?.getTime() ?? 0) > checkedAt.getTime()
        || !(await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: scope.binding.serverId }, db)).enabled) return null;
      const grant = await resolveExternalInstallServerGrantAuthority(db, { installId: scope.install.id,
        serverId: scope.binding.serverId, registrationId: scope.binding.registrationId });
      if (!grant.current || grant.grant.grantEpoch !== scope.binding.grantEpoch) return null;
      const result = await dependencies.provider.provisioningProvider.readUserProfile({ installId: scope.install.id,
        providerAppId: scope.install.providerAppId, providerAuthorityId: scope.install.providerAuthorityId,
        botUserId: scope.install.botUserId, connectionEpoch: scope.install.connectionEpoch,
        credentialRevision: scope.install.credentialRevision, providerUserId: userId, now: checkedAt, isRunHeld: async () => !stopped });
      if (result.kind === "unverified" && result.retryAfterMs !== undefined) {
        await deferSlackLifecycleInstall(db, scope.install.id, result.retryAfterMs, now());
      }
      return result.kind === "fact" && result.fact.id === userId ? { displayName: result.fact.displayName,
        handle: result.fact.handle, actorKind: result.fact.actorKind } : null;
    } catch (error) { dependencies.onError?.(error); return null; }
  };

  const pendingConversations = new Map<string, Promise<void>>();
  const requestConversationReconcile = (bindingId: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    const existing = pendingConversations.get(bindingId);
    if (existing) return existing;
    const pending = (async () => {
      const claim = isRedisAvailable() ? await claimSlackMentionReconcile({
        store: redisSlackMentionReconcileClaimStore(getRedis()),
        key: `slock:slack-bridge:lifecycle-conversation:${bindingId}`, token: randomUUID(),
        ttlMs: AGENT_MENTION_RECONCILE_CLAIM_MS,
        renewEveryMs: AGENT_MENTION_RECONCILE_RENEW_MS,
      }) : UNCONTENDED_CLAIM;
      if (!claim) return;
      try { await recoverSlackLifecyclePauses({ db, provider: dependencies.provider.provisioningProvider,
        bindingId, now: now(), clock: now, onError: dependencies.onError,
        isRunHeld: async () => !stopped && await claim.held() }); }
      finally { claim.end(); }
    })().finally(() => { pendingConversations.delete(bindingId); });
    pendingConversations.set(bindingId, pending);
    return pending;
  };
  return {
    start() {
      if (worker || stopped) return;
      worker = startWorker();
      void worker.requestReconcile("event").catch((error) => dependencies.onError?.(error));
    },
    requestConversationReconcile,
    readMemberProfile,
    requestEventReconcile() {
      if (!worker || stopped) return Promise.resolve({ kind: "stopped" });
      return worker.requestReconcile("event");
    },
    stop() {
      if (stopped) return;
      stopped = true;
      worker?.stop();
      worker = null;
    },
  };
}
