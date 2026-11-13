import { setActivityRealtimeIO } from "../../services/activityRealtime";
import { setListChangedRealtimeIO } from "../../services/listChangedRealtime";
import { setJointHumanReadRealtimeIO } from "../../services/jointHumanReadRealtime";
import { configureJointHostSideArchiveEffects } from "../../services/jointHostSideArchive";
import { onConversationsRead } from "../../services/notifications/retraction";
import { createServer } from "node:http";
import type { PublicSearchServiceBucketStore, PublicSearchServiceKeySource } from "../../lib/publicSearchServiceAccess";
import type { OpsCpuProfileDeps } from "../../routes/opsCpuProfile";
import express from "express";
import type { RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../../app";
import { getDb } from "../../db/index";
import { findAccessRevokedMachineIds } from "../../services/computerAgents";
import { closeTestDatabase, openTestDatabase } from "./database";
import { measureIntegrationPhase, ownIntegrationResource, poisonIntegrationEnvironment } from "./lifecycle";
import { featureFlags } from "../../db/schema";
import { TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { setupSocket } from "../../socket/index";
import * as agentActivityLogService from "../../services/agentActivityLogService";
import type { AgentOrchestrator, AgentStartDispatchResult, MachineMigrationTransportState } from "../../services/agentOrchestrator";
import type { AttachmentUploadSessionService } from "../../routes/attachmentUploadSessions";
import type { SlackBridgeRouteDependencies } from "../../routes/slackBridge";

type StubAgentOrchestrator = {
  deliverMessage: () => Promise<void>;
  deliverMessagesOnChannel: (channelId: string, deliveries: ReadonlyArray<{ agentId: string; message: unknown; options?: unknown }>) => Array<Promise<unknown>>;
  purgeAgentInboxForChannels: (agentId: string, channelIds: readonly string[], reason?: string) => Promise<{ localRemovedCount: number; machineSent: boolean }>;
  loadDeliveryGates: () => Promise<null>;
  receiveMessages: () => Promise<never[]>;
  peekPendingMessages: () => never[];
  acknowledgeDeliveredMessages: () => { removedCount: number };
  acknowledgeDeliveredMessagesForChannel: () => { removedCount: number };
  acknowledgeDeliveredMessagesForChannelUpToSeq: () => { removedCount: number };
  recordAgentRaftAction: (
    agentId: string,
    event: { title: string; text: string; producerFactId?: string; activity?: string; dedupeKey?: string },
  ) => Promise<void>;
  recordExternalAgentActivity: (
    agentId: string,
    request: { events: unknown[]; dropped?: number },
    serverId?: string,
  ) => Promise<{ acceptedCount: number; rejectedCount: number; droppedCount: number }>;
  getActivity: (agentId: string) => Promise<{ activity: string; activityDetail: string }>;
  getActivities: (rows: ReadonlyArray<{ id: string }>) => Promise<Array<{ activity: string; activityDetail: string }>>;
  listRecentActivityLog: (agentId: string, limit?: number) => Promise<never[]>;
  listTurnSummaries: (agentId: string, options?: { limit?: number; before?: { endedAt: number; id: string } }) => Promise<{ summaries: never[] }>;
  getRunningTurn: (agentId: string, afterMs: number | null) => Promise<null>;
  getLiveActivityObservedAtMs: (agentId: string) => Promise<number | null>;
  getMachineStatus: (machineId: string) => Promise<"online" | "offline">;
  getMachineStatusVersion: (machineId: string) => Promise<number>;
  getMachineDaemonVersion: (machineId: string) => string | null;
  getCurrentTimeMs: () => number;
  /** GET /api/agents projects blockedReason through it; a missing method fails the whole list. */
  isMachineAgentWorkHeld: (machineId: string) => Promise<boolean>;
  /** POST /agents/:id/start asks it first (reconciler step 15); read from the database, as the orchestrator does for a machine not connected here. */
  isMachineAccessRevoked: (machineId: string) => Promise<boolean>;
  startAgent: (agentId: string) => Promise<AgentStartDispatchResult>;
  stopAgent: (agentId: string, reason?: string) => Promise<{ delivered: boolean }>;
  resetAgent: (agentId: string, mode: "restart" | "session" | "full", options?: { restartIfStopped?: boolean }) => Promise<void>;
  evictCache: (agentId: string) => void;
  liftWakeBlockForConfigChange: (agentId: string, options?: { runtimeValuesChanged?: boolean; runtimeOrModelChanged?: boolean }) => Promise<void>;
  /** Reconciler step 11b: as for a daemon without the config push, so routes keep their fallback. */
  applyAgentConfig: (agentId: string) => Promise<"pushed" | "not_pushed">;
  shutdown: () => void;
  setIO: () => void;
  hasMachineLocally: (machineId: string) => boolean;
  /** No machine is connected to the stub; tests that need a transport replace it. */
  getMachineMigrationTransport: (machineId: string) => Promise<MachineMigrationTransportState | null>;
  disconnectMachineForUnlink: (machineId: string) => Promise<boolean>;
  getAgentSessionTranscript: (agentId: string) => Promise<{ transcript: string | null; reachable: boolean }>;
  collectFeedbackTranscript: (agentId: string, feedbackReportId: string, reportWindow?: unknown) => Promise<{ reachable: boolean; traceBundleId?: string; error?: string; fallbackReason?: string }>;
  /**
   * Task #204. Present on the stub so the config-push path executes for real in
   * tests instead of throwing into the route's catch — a missing method here
   * would make the push look "fine" while never running.
   */
  pushAppConfigUpsert: (agentId: string, config: unknown) => Promise<boolean>;
  detectMachineRuntimeModels: (machineId: string, runtime: string) => Promise<{
    kind: "missing_config";
    recovery: "kimi_login";
  }>;
};

function ensureTestEnv() {
  process.env.NODE_ENV ||= "test";
  process.env.JWT_SECRET ||= "test-jwt-secret";
  process.env.CORS_ORIGIN ||= "http://127.0.0.1:4173";
  process.env.APP_URL ||= "http://127.0.0.1:4173";
}

function createAgentOrchestratorStub(): StubAgentOrchestrator {
  const stub: StubAgentOrchestrator = {
    detectMachineRuntimeModels: async () => ({ kind: "missing_config", recovery: "kimi_login" }),
    pushAppConfigUpsert: async () => false,
    deliverMessage: async () => { },
    // Each item through the stub's deliverMessage (looked up at call time, so
    // a test replacing it still observes channel-batch deliveries).
    deliverMessagesOnChannel: (_channelId, deliveries) => deliveries.map(({ agentId, message, options }) =>
      (stub.deliverMessage as (...args: unknown[]) => Promise<unknown>)(agentId, message, options)),
    purgeAgentInboxForChannels: async () => ({ localRemovedCount: 0, machineSent: false }),
    loadDeliveryGates: async () => null,
    receiveMessages: async () => [],
    peekPendingMessages: () => [],
    acknowledgeDeliveredMessages: () => ({ removedCount: 0 }),
    acknowledgeDeliveredMessagesForChannel: () => ({ removedCount: 0 }),
    acknowledgeDeliveredMessagesForChannelUpToSeq: () => ({ removedCount: 0 }),
    recordAgentRaftAction: async (agentId, event) => {
      await agentActivityLogService.appendAgentActivityEvent(
        agentId,
        event.activity ?? "online",
        "",
        [{
          kind: "slock_action",
          title: event.title,
          text: event.text,
          ...(event.producerFactId ? { producerFactId: event.producerFactId } : {}),
        }],
        new Date(),
        event.dedupeKey,
      );
    },
    recordExternalAgentActivity: async (_agentId, request) => ({
      acceptedCount: Array.isArray(request.events) ? request.events.length : 0,
      rejectedCount: 0,
      droppedCount: typeof request.dropped === "number" && Number.isFinite(request.dropped) && request.dropped > 0
        ? Math.floor(request.dropped)
        : 0,
    }),
    getActivity: async () => ({ activity: "offline", activityDetail: "" }),
    // Per row through getActivity, so a test that replaces getActivity on the
    // stub still drives list endpoints.
    getActivities: async (rows) => Promise.all(rows.map((row) => stub.getActivity(row.id))),
    listRecentActivityLog: async () => [],
    listTurnSummaries: async () => ({ summaries: [] }),
    getRunningTurn: async () => null,
    getLiveActivityObservedAtMs: async () => null,
    getMachineStatus: async () => "offline",
    getMachineStatusVersion: async () => 0,
    getMachineDaemonVersion: () => null,
    // The machine list's upgrade policy reads the clock for a Computer row.
    getCurrentTimeMs: () => Date.now(),
    isMachineAgentWorkHeld: async () => false,
    isMachineAccessRevoked: async (machineId) => (await findAccessRevokedMachineIds(getDb(), [machineId])).has(machineId),
    startAgent: async () => ({ outcome: "dispatched" }),
    stopAgent: async () => ({ delivered: true }),
    resetAgent: async () => { },
    evictCache: () => { },
    liftWakeBlockForConfigChange: async () => { },
    applyAgentConfig: async () => "not_pushed",
    shutdown: () => { },
    setIO: () => { },
    hasMachineLocally: () => true,
    getMachineMigrationTransport: async () => null,
    disconnectMachineForUnlink: async () => false,
    getAgentSessionTranscript: async () => ({ transcript: "stub transcript", reachable: true }),
    collectFeedbackTranscript: async () => ({ reachable: true, traceBundleId: "stub-bundle-id" }),
  };
  return stub;
}

export type TestAppOptions = {
  /** Standalone harness routes only; never mounted by the production app. */
  beforeApp?: RequestHandler;
  clock?: { now(): Date };
  humanActivityMuteFlagDefaultEnabled?: boolean;
  /** task_v2_conversations_v0 default (migration seeds it off): true = every server writes task anchors. */
  taskV2ConversationsFlagDefaultEnabled?: boolean;
  attachmentUploadSessionService?: AttachmentUploadSessionService;
  slackBridge?: SlackBridgeRouteDependencies;
  slackBridgeFactory?: () => SlackBridgeRouteDependencies | Promise<SlackBridgeRouteDependencies>;
  skipAuthRateLimit?: boolean;
  enforceMessageRateLimit?: boolean;
  messageRateLimitMax?: number;
  /** First-party apps' web rate limits to enforce in the harness, by `<app id>.<limit name>`, and core's `objects.summaries` (app.ts). */
  appRateLimitMax?: Readonly<Record<string, number>>;
  enforceProductFeedbackRateLimit?: boolean;
  /** Enforce the question-card answer limit at this many an hour (skipped otherwise). */
  questionAnswerRateLimitMax?: number;
  /** Enforce the OAuth identity endpoints' limits: this many a minute per access token (skipped otherwise)... */
  oauthIdentityTokenRateLimitMax?: number;
  /** ...and this many invalid tokens per IP (default 200). */
  oauthIdentityInvalidTokenRateLimitMax?: number;
  publicSearchKeySource?: PublicSearchServiceKeySource;
  publicSearchBucketStore?: PublicSearchServiceBucketStore;
  opsCpuProfile?: Partial<OpsCpuProfileDeps>;
};

export async function createTestApp(port = 0, opts: TestAppOptions = {}) {
  ensureTestEnv();
  if (opts.humanActivityMuteFlagDefaultEnabled !== undefined) {
    await getDb()
      .update(featureFlags)
      .set({ defaultEnabled: opts.humanActivityMuteFlagDefaultEnabled })
      .where(eq(featureFlags.key, "human_activity_mute_v0"));
  }
  if (opts.taskV2ConversationsFlagDefaultEnabled !== undefined) {
    await getDb().update(featureFlags)
      .set({ defaultEnabled: opts.taskV2ConversationsFlagDefaultEnabled })
      .where(eq(featureFlags.key, TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY));
  }

  const slackBridge = opts.slackBridgeFactory
    ? await opts.slackBridgeFactory()
    : opts.slackBridge;
  const app = createApp({
    attachmentUploadSessionService: opts.attachmentUploadSessionService,
    slackBridge,
    testHarness: {
      skipAuthRateLimit: opts.skipAuthRateLimit ?? false,
      enforceMessageRateLimit: opts.enforceMessageRateLimit,
      messageRateLimitMax: opts.messageRateLimitMax,
      appRateLimitMax: opts.appRateLimitMax,
      enforceProductFeedbackRateLimit: opts.enforceProductFeedbackRateLimit,
      questionAnswerRateLimitMax: opts.questionAnswerRateLimitMax,
      oauthIdentityTokenRateLimitMax: opts.oauthIdentityTokenRateLimitMax,
      oauthIdentityInvalidTokenRateLimitMax: opts.oauthIdentityInvalidTokenRateLimitMax,
      publicSearchKeySource: opts.publicSearchKeySource,
      publicSearchBucketStore: opts.publicSearchBucketStore,
      opsCpuProfile: opts.opsCpuProfile,
    },
  });
  const server = createServer(opts.beforeApp ? express().use(opts.beforeApp).use(app) : app);
  const io = setupSocket(server, process.env.CORS_ORIGIN || "http://127.0.0.1:4173");
  // TODO: swap this stub for a real orchestrator in agent-flow tests.
  const agentOrchestrator = createAgentOrchestratorStub();

  app.set("io", io);
  setActivityRealtimeIO(io);
  setListChangedRealtimeIO(io);
  setJointHumanReadRealtimeIO(io, (userId, serverId, scopes) => onConversationsRead(io, userId, serverId, scopes));
  app.set("agentOrchestrator", agentOrchestrator);
  configureJointHostSideArchiveEffects({ io, orchestrator: agentOrchestrator as unknown as AgentOrchestrator });
  // Clock seam: when a test pins a clock, app-level "now" reads (e.g. the
  // joint-channel billing gate via resolveNow) become deterministic instead of
  // depending on the ambient wall-clock vs TRIAL_END_DATE. Default = real clock.
  if (opts.clock) {
    app.set("clock", opts.clock);
  }

  let closing: Promise<void> | null = null;
  let release = () => { };
  const close = () => closing ??= (async () => {
    try {
      await measureIntegrationPhase("appClose", async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            io.close((error) => {
              if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error);
              else resolve();
            });
          });
        } finally {
          configureJointHostSideArchiveEffects(null);
          agentOrchestrator.shutdown();
        }
      });
    } catch (error) {
      poisonIntegrationEnvironment(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      release();
    }
  })();
  release = ownIntegrationResource(close);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  return { app, io, server, baseUrl: `http://127.0.0.1:${address.port}`, close };
}

/** Explicit lifetime for loops, hooks, and the standalone Playwright server. */
export async function openTestApp(databaseUrl = "pglite://", port = 0, opts: TestAppOptions = {}) {
  ensureTestEnv();
  await openTestDatabase(databaseUrl);
  try {
    const app = await measureIntegrationPhase("app", () => createTestApp(port, opts));
    let closing: Promise<void> | null = null;
    return {
      ...app,
      close: () => closing ??= (async () => {
        try {
          await app.close();
        } finally {
          await closeTestDatabase();
        }
      })(),
    };
  } catch (error) {
    await closeTestDatabase();
    throw error;
  }
}
