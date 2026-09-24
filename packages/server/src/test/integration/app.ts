import { createServer } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../../app.js";
import { getDb } from "../../db/index.js";
import { closeTestDatabase, openTestDatabase } from "./database.js";
import { measureIntegrationPhase, ownIntegrationResource, poisonIntegrationEnvironment } from "./lifecycle.js";
import { featureFlags } from "../../db/schema.js";
import { setupSocket } from "../../socket/index.js";
import * as agentActivityLogService from "../../services/agentActivityLogService.js";
import { HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY, ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY } from "../../services/featureFlagService.js";
import type { AgentStartDispatchResult } from "../../services/agentOrchestrator.js";
import type { AttachmentUploadSessionService } from "../../routes/attachmentUploadSessions.js";
import type { SlackBridgeRouteDependencies } from "../../routes/slackBridge.js";

type StubAgentOrchestrator = {
  deliverMessage: () => Promise<void>;
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
  listRecentActivityLog: (agentId: string, limit?: number) => Promise<never[]>;
  getMachineStatus: (machineId: string) => Promise<"online" | "offline">;
  getMachineStatusVersion: (machineId: string) => Promise<number>;
  getMachineDaemonVersion: (machineId: string) => string | null;
  startAgent: (agentId: string) => Promise<AgentStartDispatchResult>;
  stopAgent: (agentId: string, reason?: string) => Promise<void>;
  resetAgent: (agentId: string, mode: "restart" | "session" | "full", options?: { restartIfStopped?: boolean }) => Promise<void>;
  evictCache: (agentId: string) => void;
  shutdown: () => void;
  setIO: () => void;
  hasMachineLocally: (machineId: string) => boolean;
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
  return {
    detectMachineRuntimeModels: async () => ({ kind: "missing_config", recovery: "kimi_login" }),
    pushAppConfigUpsert: async () => false,
    deliverMessage: async () => { },
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
    listRecentActivityLog: async () => [],
    getMachineStatus: async () => "offline",
    getMachineStatusVersion: async () => 0,
    getMachineDaemonVersion: () => null,
    startAgent: async () => ({ outcome: "dispatched" }),
    stopAgent: async () => { },
    resetAgent: async () => { },
    evictCache: () => { },
    shutdown: () => { },
    setIO: () => { },
    hasMachineLocally: () => true,
    disconnectMachineForUnlink: async () => false,
    getAgentSessionTranscript: async () => ({ transcript: "stub transcript", reachable: true }),
    collectFeedbackTranscript: async () => ({ reachable: true, traceBundleId: "stub-bundle-id" }),
  };
}

export type TestAppOptions = {
  /** Standalone harness routes only; never mounted by the production app. */
  beforeApp?: RequestHandler;
  observeHttpServer?: (server: ReturnType<typeof createServer>) => void;
  clock?: { now(): Date };
  humanActivityMuteFlagDefaultEnabled?: boolean;
  onboardingOpenerFlagDefaultEnabled?: boolean;
  attachmentUploadSessionService?: AttachmentUploadSessionService;
  slackBridge?: SlackBridgeRouteDependencies;
  slackBridgeFactory?: () => SlackBridgeRouteDependencies | Promise<SlackBridgeRouteDependencies>;
  skipAuthRateLimit?: boolean;
  enforceMessageRateLimit?: boolean;
  messageRateLimitMax?: number;
};

export async function createTestApp(port = 0, opts: TestAppOptions = {}) {
  ensureTestEnv();
  if (opts.humanActivityMuteFlagDefaultEnabled !== undefined) {
    await getDb()
      .update(featureFlags)
      .set({ defaultEnabled: opts.humanActivityMuteFlagDefaultEnabled })
      .where(eq(featureFlags.key, HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY));
  }
  if (opts.onboardingOpenerFlagDefaultEnabled !== undefined) {
    await getDb().update(featureFlags)
      .set({ defaultEnabled: opts.onboardingOpenerFlagDefaultEnabled })
      .where(eq(featureFlags.key, ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY));
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
    },
  });
  const server = createServer(opts.beforeApp ? express().use(opts.beforeApp).use(app) : app);
  const io = setupSocket(server, process.env.CORS_ORIGIN || "http://127.0.0.1:4173");
  // TODO: swap this stub for a real orchestrator in agent-flow tests.
  const agentOrchestrator = createAgentOrchestratorStub();

  app.set("io", io);
  app.set("agentOrchestrator", agentOrchestrator);
  // Clock seam: when a test pins a clock, app-level "now" reads (e.g. the
  // joint-channel billing gate via resolveNow) become deterministic instead of
  // depending on the ambient wall-clock vs TRIAL_END_DATE. Default = real clock.
  if (opts.clock) {
    app.set("clock", opts.clock);
  }

  opts.observeHttpServer?.(server);

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
