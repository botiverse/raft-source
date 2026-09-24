import "dotenv/config";

// Safety net: log unhandled rejections instead of crashing the process
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
});

import { createServer } from "node:http";
import { initDatabase, setDbTracer, startPoolMetricsReporting } from "./db/index.js";
import { createApp } from "./app.js";
import { setupSocket } from "./socket/index.js";
import { setupMachineWebSocket } from "./routes/daemon.js";
import { AgentOrchestrator } from "./services/agentOrchestrator.js";
import { startOnboardingBriefingOnActivation } from "./services/onboardingBriefingOnActivation.js";
import { setIO as setBillingIO, cleanupWebhookEvents } from "./services/billingService.js";
import { cleanupExpiredSessions } from "./services/sessionService.js";
import { serializeErrorForLog } from "./tracing/safeErrorLog.js";
import { setStorageTracer } from "./services/storageService.js";
import {
  createDurableAttachmentUploadSessionService,
  startAttachmentUploadSessionCleanup,
} from "./services/attachmentUploadSessionService.js";
import { startAttachmentLifecycleSweep } from "./services/attachmentLifecycleService.js";
import { startReminderArmWatchdog } from "./services/reminderArmWatchdog.js";
import { startMobilePushOutboxWorker } from "./services/pushService.js";
import { startReadMutationWorker } from "./services/readMutationSequencer.js";
import { startAppNotificationDeliveryWorker } from "./services/appNotificationDeliveryService.js";
import { startComputerOutageNotificationWorker } from "./services/computerOutageNotificationService.js";
import { startAgentMigrationReceiptOutboxWorker } from "./services/agentMigrationReceiptService.js";
import { startAgentMigrationRemediationWorker } from "./services/agentMigrationRemediationWorker.js";
import { startChannelMembershipRoleOutboxWorker } from "./services/channelMembershipRoleOutbox.js";
import { enforceDowngradeLimits } from "./services/downgradeEnforcement.js";
import { initRedis, shutdownRedis } from "./redis.js";
import { configureMetricsDeploymentIdentity, startMetricsServer } from "./metrics.js";
import { createServerTracerFromEnv } from "./tracing/serverTracer.js";
import { resolveTraceDeploymentIdentity } from "./tracing/traceDeploymentIdentity.js";
import { getWebCorsOriginOption } from "./config/appUrl.js";
import { createSlackBridgeServerRuntimeFromEnv } from "./services/slackBridgeServerRuntime.js";
import {
  emitExternalProjectionMessageToFrontend,
  emitExternalReactionMessageUpdateToFrontend,
} from "./services/messageService.js";
import { shutdownServerRuntime } from "./serverShutdown.js";
import { initializeTranslationProviderConfig } from "./services/messageTranslationService.js";


const PORT = Number(process.env.PORT) || 3001;
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_URL_READ_REPLICA = process.env.DATABASE_URL_READ_REPLICA;

const CORS_ORIGIN = getWebCorsOriginOption();

if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET environment variable is required");
  process.exit(1);
}

async function bootstrap() {
  // Translation configuration is loaded before the HTTP server starts. In
  // deployed SSM mode a missing/invalid parameter set must fail closed rather
  // than leaving a server that advertises translation but cannot safely run it.
  await initializeTranslationProviderConfig();

  // Initialize PostgreSQL database
  await initDatabase(DATABASE_URL!, DATABASE_URL_READ_REPLICA);
  console.log("[Slock] Database connected");

  // Initialize Redis (optional — enables multi-replica support)
  const REDIS_URL = process.env.REDIS_URL;
  if (REDIS_URL) {
    initRedis(REDIS_URL);
    console.log("[Slock] Redis initialized");
  }

  // Storage must be resolved only after its tracer is installed; otherwise
  // the startup-owned direct-upload service would permanently cache an
  // untraced S3 backend.
  const traceDeploymentIdentity = await resolveTraceDeploymentIdentity();
  configureMetricsDeploymentIdentity(traceDeploymentIdentity);
  const serverTracer = createServerTracerFromEnv(process.env, traceDeploymentIdentity);
  setDbTracer(serverTracer.tracer);
  setStorageTracer(serverTracer.tracer);
  startPoolMetricsReporting(serverTracer.tracer);

  // Resolve direct-upload capability once at server startup. Clients consume
  // the resulting server-owned threshold/limit projection; they never copy
  // storage or plan constants locally.
  const attachmentUploadSessionService = createDurableAttachmentUploadSessionService();
  let slackBridgeSocket: ReturnType<typeof setupSocket> | null = null;
  const slackBridge = await createSlackBridgeServerRuntimeFromEnv(process.env, {
    onInboundMessageCommitted: async ({ messageId }) => {
      if (!slackBridgeSocket) throw new Error("Slack Bridge Socket.IO runtime is unavailable");
      await emitExternalProjectionMessageToFrontend(slackBridgeSocket, messageId);
    },
    onInboundReactionCommitted: async ({ messageId }) => {
      if (!slackBridgeSocket) throw new Error("Slack Bridge Socket.IO runtime is unavailable");
      await emitExternalReactionMessageUpdateToFrontend(slackBridgeSocket, messageId);
    },
  });
  const app = createApp({
    attachmentUploadSessionService: attachmentUploadSessionService ?? undefined,
    slackBridge,
  });

  // Create HTTP server
  const server = createServer(app);

  app.set("serverTracer", serverTracer.tracer);

  // Setup Agent Orchestrator
  const agentOrchestrator = new AgentOrchestrator(undefined, undefined, serverTracer.tracer);
  app.set("agentOrchestrator", agentOrchestrator);

  // Initialize cross-replica routing (Redis pub/sub) if Redis is available
  const { initReplicaRouter } = await import("./replicaRouter.js");
  const replicaReplayEndpoint = await resolveReplicaReplayEndpoint(PORT);
  await initReplicaRouter(
    (machineId, message) => {
      agentOrchestrator.handleRoutedMachineCommand(machineId, message).catch((err) => {
        console.error(`[ReplicaRouter] Failed to handle routed machine command for ${machineId}:`, err);
      });
    },
    (agentId, machineId, message) => {
      agentOrchestrator.handleRoutedInboxDelivery(agentId, machineId, message).catch((err) => {
        console.error(`[ReplicaRouter] Failed to handle routed inbox delivery for ${agentId}:`, err);
      });
    },
    (agentId) => {
      agentOrchestrator.handleRoutedExternalWakeSignal(agentId);
    },
    replicaReplayEndpoint,
    async (machineId, principalKind) => {
      try {
        await agentOrchestrator.fenceMachinePrincipalConnections(machineId, principalKind);
      } catch (err) {
        console.error(`[ReplicaRouter] Failed to fence ${principalKind} connection for ${machineId}:`, err);
      }
    },
    (agentId, machineId, message, deliveryOptions) => (
      agentOrchestrator.handleRoutedInboxDeliveryWithReceipt(agentId, machineId, message, deliveryOptions)
    ),
  );

  // Setup Machine WebSocket BEFORE Socket.io (since Socket.io intercepts all upgrade events)
  setupMachineWebSocket(server, agentOrchestrator, serverTracer.tracer);

  // Setup Socket.io with auth (must be after machine WS to avoid intercepting /daemon/connect)
  const io = setupSocket(server, CORS_ORIGIN);
  slackBridgeSocket = io;
  app.set("io", io);
  agentOrchestrator.setIO(io);
  setBillingIO(io);

  // Brief Cindy whenever she actually comes up — not only when a user happens to press a
  // button that starts her. A computer switched on the next morning wakes her through the
  // daemon, which touches no HTTP route, and that was the one path the briefing retry did
  // not cover.
  startOnboardingBriefingOnActivation({ io, orchestrator: agentOrchestrator });

  // Hourly maintenance — downgrade enforcement + webhook event cleanup
  const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const runMaintenance = () => {
    enforceDowngradeLimits(agentOrchestrator).catch((err) =>
      console.error("[Slock] Enforcement check failed:", err));
    cleanupWebhookEvents().catch((err) =>
      console.error("[Slock] Webhook event cleanup failed:", err));
    // Expired sessions, replay receipts and refresh-token lineage rows
    // (`session_token_predecessors`) are only bounded by this sweep.
    cleanupExpiredSessions().catch((err) =>
      console.error("[Slock] Session cleanup failed:", serializeErrorForLog(err)));
  };
  setTimeout(runMaintenance, 10_000); // Run once 10s after startup
  setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);

  const stopAttachmentUploadSessionCleanup = attachmentUploadSessionService
    ? startAttachmentUploadSessionCleanup(attachmentUploadSessionService)
    : () => {};
  // Disabled by default until artifact inventory/parity and the rollout
  // capability authorize physical lifecycle work.
  const stopAttachmentLifecycleSweep = startAttachmentLifecycleSweep({ tracer: serverTracer.tracer });

  // Reminder arm watchdog: resyncs missing Computer armed(revision) receipts.
  // It never fires/wakes; due-time authority is Computer-local.
  const reminderArmWatchdog = startReminderArmWatchdog({ orchestrator: agentOrchestrator });
  const mobilePushOutboxWorker = startMobilePushOutboxWorker({ tracer: serverTracer.tracer });
  const readMutationWorker = startReadMutationWorker();
  const appNotificationDeliveryWorker = startAppNotificationDeliveryWorker();
  const computerOutageNotificationWorker = startComputerOutageNotificationWorker();
  const agentMigrationReceiptOutboxWorker = startAgentMigrationReceiptOutboxWorker({
    io,
    orchestrator: agentOrchestrator,
  });
  const agentMigrationRemediationWorker = startAgentMigrationRemediationWorker({
    io,
    orchestrator: agentOrchestrator,
  });
  const channelMembershipRoleOutboxWorker = startChannelMembershipRoleOutboxWorker({ io });

  // Start Prometheus metrics endpoint
  startMetricsServer();

  // Start server
  server.listen(PORT, () => {
    slackBridge?.start();
    console.log(`[Slock] Server listening on http://localhost:${PORT}`);
  });

  // Graceful shutdown — close WebSocket connections before exiting
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[Slock] Shutting down...");
    stopAttachmentUploadSessionCleanup();
    stopAttachmentLifecycleSweep();
    reminderArmWatchdog.stop();
    mobilePushOutboxWorker.stop();
    readMutationWorker.stop();
    appNotificationDeliveryWorker.stop();
    computerOutageNotificationWorker.stop();
    agentMigrationReceiptOutboxWorker.stop();
    agentMigrationRemediationWorker.stop();
    channelMembershipRoleOutboxWorker.stop();
    shutdownServerRuntime({
      stopAcceptingHttp: () => new Promise<void>((resolve) => {
        server.close((error) => {
          if (error) console.warn("[Slock] Failed to drain HTTP server:", error);
          resolve();
        });
      }),
      releaseMachineOwnership: async () => {
        const [orchestratorResult, slackBridgeResult] = await Promise.allSettled([
          agentOrchestrator.shutdown(),
          slackBridge?.stop() ?? Promise.resolve(),
        ]);
        if (orchestratorResult.status === "rejected") {
          console.warn("[Slock] Failed to shutdown agent orchestrator:", orchestratorResult.reason);
        }
        if (slackBridgeResult.status === "rejected") {
          console.warn("[Slock] Failed to stop Slack Bridge:", slackBridgeResult.reason);
        }
      },
      flushTraces: () => serverTracer.shutdown(),
      shutdownSharedState: shutdownRedis,
      warn: (message, reason) => console.warn(`[Slock] ${message}:`, reason),
    }).then(() => {
      process.exit(0);
    }).catch((err) => {
      console.warn("[Slock] Failed to complete server shutdown:", err);
      process.exit(0);
    });
    // Force exit after 5s if server.close() hangs
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

type EcsTaskMetadata = {
  Containers?: Array<{
    Networks?: Array<{
      IPv4Addresses?: string[];
    }>;
  }>;
};

async function resolveReplicaReplayEndpoint(port: number): Promise<string | null> {
  const configured = process.env.SLOCK_REPLICA_REPLAY_BASE_URL || process.env.REPLICA_REPLAY_BASE_URL;
  if (configured) return configured;

  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadataUri) return null;

  try {
    const response = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) {
      console.warn(`[ReplicaRouter] ECS task metadata returned ${response.status}; replica replay endpoint disabled`);
      return null;
    }
    const task = await response.json() as EcsTaskMetadata;
    const privateIp = task.Containers
      ?.flatMap((container) => container.Networks ?? [])
      .flatMap((network) => network.IPv4Addresses ?? [])
      .find((ip) => Boolean(ip));
    if (!privateIp) {
      console.warn("[ReplicaRouter] ECS task metadata did not include a private IPv4 address; replica replay endpoint disabled");
      return null;
    }
    return `http://${privateIp}:${port}`;
  } catch (err) {
    console.warn("[ReplicaRouter] Failed to resolve ECS replica replay endpoint; replica replay disabled", err);
    return null;
  }
}

bootstrap().catch((err) => {
  console.error("[Slock] Fatal error:", err);
  process.exit(1);
});
