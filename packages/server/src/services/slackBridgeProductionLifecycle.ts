import { randomUUID } from "node:crypto";

import { currentDate } from "@botiverse/raft-shared";
import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb, type Database } from "../db/index.js";
import {
  externalAppCredentials,
  externalAppInstalls,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
} from "../db/schema.js";
import {
  createSlackPrivateAudienceRefresher,
  type SlackAudienceIdentityAuthority,
} from "./slackAudienceRefreshService.js";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime.js";
import { refreshSlackPublicConversationAuthority } from "./slackBridgeProvisioningControlPlane.js";
import type { SlackBridgeAvatarMaterializer } from "./slackBridgeProvisioningControlPlane.js";
import { refreshSlackBridgeInstallGrantReceipts } from "./slackBridgeInstallGrantService.js";
import {
  startSlackBridgePersistentWorker,
  type SlackBridgeAudienceRefreshReceipt,
  type SlackBridgeBindingRuntime,
  type SlackBridgeLifecycleExecutionReceipt,
  type SlackBridgePersistentWorker,
  type SlackBridgePersistentWorkerClock,
  type SlackBridgePersistentWorkerRunResult,
  type SlackBridgeProbeObservation,
  type SlackBridgeProbeRequest,
} from "./slackBridgeWorkerLifecycle.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PROBE_FRESHNESS_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING_EVENTS = 1_000;
const DEFAULT_MAX_OLDEST_EVENT_AGE_MS = 15 * 60_000;

export interface SlackBridgeProductionLifecycle {
  start(): void;
  requestEventReconcile(): Promise<SlackBridgePersistentWorkerRunResult>;
  stop(): void;
}

export interface SlackBridgeProductionLifecycleDependencies {
  db?: Database;
  provider: SlackBridgeProviderRuntime;
  identityAuthority: SlackAudienceIdentityAuthority;
  avatarMaterializer?: SlackBridgeAvatarMaterializer;
  now?: () => Date;
  orchestratorId?: string;
  intervalMs?: number;
  probeFreshnessMs?: number;
  maxPendingEvents?: number;
  maxOldestPendingEventAgeMs?: number;
  clock?: SlackBridgePersistentWorkerClock;
  onReceipt?(receipt: SlackBridgeLifecycleExecutionReceipt): void;
  onError?(error: unknown): void;
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
  const latestAudience = new Map<string, SlackBridgeAudienceRefreshReceipt>();
  const bindingPrivacy = new Map<string, "public" | "private">();
  let worker: SlackBridgePersistentWorker | null = null;
  let stopped = false;

  const refreshAudience = createSlackPrivateAudienceRefresher({
    transport: dependencies.provider.transport,
    quarantineSink: dependencies.provider.quarantineSink,
    credentialResolver: dependencies.provider.credentialResolver,
    identityAuthority: dependencies.identityAuthority,
    withReadSnapshot: (fn) => db.transaction(async (tx) => fn(tx), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    }),
    now,
  });

  const loadBindings = async (nowMs: number): Promise<SlackBridgeBindingRuntime[]> => {
    const observedAt = new Date(nowMs);
    if (!validNow(observedAt)) throw new Error("Slack Bridge lifecycle clock is invalid");
    try {
      await refreshSlackBridgeInstallGrantReceipts({
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
    const rows = await db.select({
      bindingId: externalChannelBindings.id,
      bindingState: externalChannelBindings.state,
      bindingEpoch: externalChannelBindings.bindingEpoch,
      audienceRevision: externalChannelBindings.audienceRevision,
      privacyClass: externalChannelBindings.privacyClass,
      installState: externalAppInstalls.state,
      credentialState: externalAppCredentials.state,
    }).from(externalChannelBindings)
      .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
      .leftJoin(externalAppCredentials, eq(externalAppCredentials.installId, externalAppInstalls.id))
      // Inactive bindings are already durably projected by the ingress
      // lifecycle transition. They must not keep producing audience revisions
      // or synthetic per-binding worker commands after pause/revoke/quarantine.
      .where(eq(externalChannelBindings.state, "active"));
    const bindingIds = rows.map(({ bindingId }) => bindingId);
    const snapshots = bindingIds.length === 0
      ? []
      : await db.select({
          bindingId: externalBindingAudienceSnapshots.bindingId,
          audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
          status: externalBindingAudienceSnapshots.status,
        }).from(externalBindingAudienceSnapshots)
          .where(inArray(externalBindingAudienceSnapshots.bindingId, bindingIds))
          .orderBy(desc(externalBindingAudienceSnapshots.audienceRevision));
    const latestSnapshotByBinding = new Map<string, (typeof snapshots)[number]>();
    const snapshotByBindingRevision = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (!latestSnapshotByBinding.has(snapshot.bindingId)) {
        latestSnapshotByBinding.set(snapshot.bindingId, snapshot);
      }
      snapshotByBindingRevision.set(
        `${snapshot.bindingId}:${snapshot.audienceRevision}`,
        snapshot,
      );
    }

    bindingPrivacy.clear();
    return rows.map((row) => {
      bindingPrivacy.set(row.bindingId, row.privacyClass);
      const snapshot = row.privacyClass === "private" && row.audienceRevision
        ? snapshotByBindingRevision.get(`${row.bindingId}:${row.audienceRevision}`)
        : latestSnapshotByBinding.get(row.bindingId);
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
          audienceStatus: snapshot?.status ?? "unavailable",
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
        backlog: { pendingEvents: 0, oldestPendingEventAgeMs: 0 },
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
    loadBindings: ({ nowMs }) => loadBindings(nowMs),
    async refreshAudience(binding, context) {
      const refreshed = bindingPrivacy.get(binding.bindingId) === "public"
        ? await refreshSlackPublicConversationAuthority({
          db,
          provider: dependencies.provider.provisioningProvider,
          avatarMaterializer: dependencies.avatarMaterializer,
          bindingId: binding.bindingId,
          now: new Date(context.nowMs),
        })
        : await refreshAudience({ bindingId: binding.bindingId });
      const receipt = audienceReceipt(refreshed);
      latestAudience.set(binding.bindingId, receipt);
      return receipt;
    },
    async executeCommand() {
      throw new Error("Slack Bridge production lifecycle emitted an unexpected binding command");
    },
    runProbe: (request, context) => runProbe(request, context.nowMs),
    async persistReceipt(receipt) {
      dependencies.onReceipt?.(receipt);
    },
    onError: dependencies.onError,
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

  return {
    start() {
      if (worker || stopped) return;
      worker = startWorker();
      void worker.requestReconcile("event").catch((error) => dependencies.onError?.(error));
    },
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
