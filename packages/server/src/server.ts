import { jointDepartureRegistry, configureJointDepartureEffects } from "./services/jointMembershipDeparture";
import { jointMembershipDepartureEffects } from "./services/jointMembershipDepartureEffects";
import { configureJointHostSideArchiveEffects, jointHostSideArchiveRegistry } from "./services/jointHostSideArchive";
import { serverAdminNoticeRegistry } from "./services/serverAdminNoticeService";
import { getServerPlan } from "./services/planService";
import { setAppSumoPlanChangeSink } from "./services/appSumoLifecycleService";
import { startAppSumoReconciliationWorker } from "./services/appSumoReconciliationWorker";
import { startRaftbenchWorker } from "./raftbench/worker";
import { runChangeLogMaintenance } from "./services/changeLogMaintenance";
import { sweepRecoveryRequests } from "./services/secondFactor/recovery";
import { runAccountDeletionCleanup } from "./services/accountDeletion/cleanup";
import { runClosedServerPurge } from "./services/closedServerPurge";
import { getChannelConversionAudienceCutover, applyChannelConversionAudienceRealtimeCutover } from "./services/channelConversionService";
import { startChannelConversionWorker } from "./services/channelConversionWorker";
import { publishExternalConnection } from "./services/externalInviteConnectService";
import { emitChannelConversionCompletion, emitChannelConversionState, emitJointLimitStateChange } from "./routes/channels";
import "dotenv/config";

// Safety net: log unhandled rejections instead of crashing the process
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
});

import { createServer } from "node:http";
import { initDatabase, prewarmPrimaryPool, setDbTracer, startPoolMetricsReporting } from "./db/index";
import { startMachineLivenessMetrics } from "./services/machineLivenessMetrics";
import { getDbLivenessTracker } from "./dbLiveness";
import { installAuditedGlobalFetch } from "./db/ambientTransaction";
import { createApp } from "./app";
import { countSocketClients, setupSocket } from "./socket/index";
import { setupMachineWebSocket } from "./routes/daemon";
import { AgentOrchestrator } from "./services/agentOrchestrator";
import { startOnboardingBriefingOnActivation } from "./services/onboardingBriefingOnActivation";
import { registerHostedCindyTriggers, startHostedCindyRecapWorker } from "./services/hostedCindyService";
import { startHostedRuntimeDailySpendWorker } from "./services/hostedRuntimeDailySpend";
import { startMachineFirstConnectRecorder, startOnboardingFunnelWorker } from "./services/onboardingFunnel";
import { triggerOwnerOnboardingOnAgentActivation } from "./services/onboardingService";
import { setIO as setBillingIO, cleanupWebhookEvents } from "./services/billingService";
import { setActivityRealtimeIO } from "./services/activityRealtime";
import { setListChangedRealtimeIO } from "./services/listChangedRealtime";
import { setProductFeedbackUnreadRealtimeIO } from "./services/productFeedbackUnreadRealtime";
import { startProductFeedbackUnreadReconcileWorker } from "./services/productFeedbackUnreadReconcile";
import {
  marketplaceReviewSideEffectSinks,
  pruneDeliveredMarketplaceReviewOutbox,
  startMarketplaceReviewOutboxWorker,
} from "./services/marketplaceReviewOutbox";
import { setJointHumanReadRealtimeIO } from "./services/jointHumanReadRealtime";
import { onConversationsRead } from "./services/notifications/retraction";
import { cleanupExpiredSessions } from "./services/sessionService";
import { firstPartyAppMaintenanceJobs, startFirstPartyAppIntervalJobs } from "./services/firstPartyAppJobs";
import { pruneObjectEvents } from "./services/objectEventRetention";
import { pruneMessageCardRevisions } from "./services/messageCardService";
import { sweepObjectFiles } from "./services/objectFiles";
import { pruneExpiredAgentApiIdempotencyKeys } from "./services/agentApiIdempotencyService";
import { pruneRevokedRunnerAgentCredentials } from "./services/agentCredentialRetention";
import { pruneCompletedJointMembershipRemovals } from "./services/jointMembershipRemovalRetention";
import { pruneAgentUsage } from "./services/agentUsageService";
import { pruneExpiredAgentAppEvents } from "./services/agentAppEventsService";
import { serializeErrorForLog } from "./tracing/safeErrorLog";
import { recheckServerSsoDomains } from "./services/sso/ssoDomains";
import { sweepExpiredSsoTransactions } from "./services/sso/ssoTransactions";
import { sweepExpiredSamlAssertions } from "./services/sso/ssoSaml";
import { assertRequiredSystemAppDeliveryGuards } from "./services/systemAppDeliveryGuards";
import { logProductFeedbackTriageNoticeConfig, setProductFeedbackTriageNoticeDeliverer } from "./services/productFeedbackTriageNotice";
import { getCdnStorage, getStorage, setStorageTracer } from "./services/storageService";
import { reportOpsCpuProfileStartup } from "./routes/opsCpuProfile";
import {
  createDurableAttachmentUploadSessionService,
  startAttachmentUploadSessionCleanup,
} from "./services/attachmentUploadSessionService";
import { startAttachmentLifecycleSweep } from "./services/attachmentLifecycleService";
import { startReminderArmWatchdog } from "./services/reminderArmWatchdog";
import { startReminderAppMigrationWorker } from "./services/reminderAppMigrationWorker";
import { startNotificationDispatcher } from "./services/notifications/dispatcher";
import { warmNotificationTransports } from "./services/notifications/transports/warmup";
import {
  DIRECT_UPLOAD_THUMBNAIL_CONCURRENCY,
  startDirectUploadThumbnailWorker,
} from "./services/attachmentDirectUploadThumbnailService";
import { emitAttachmentPreviewMessageUpdate } from "./routes/messages";
import { startAssistantDoorbellWorker } from "./services/assistantService";
import { startWeChatBridgeWorker } from "./services/wechatBridgeWorker";
import { startSeatRequestExpiryWorker } from "./services/seatRequestService";
import { startQuestionCardExpiryWorker } from "./services/actionCardsService";
import { startReadMutationWorker } from "./services/readMutationSequencer";
import { startAppNotificationDeliveryWorker } from "./services/appNotificationDeliveryService";
import { startAppLinkPreviewRecheckWorker } from "./services/appLinkPreviewRecheckWorker";
import { startLinkCardSweepWorker } from "./services/linkCardSweeps";
import { socketIoFeaturesChangedTransport, startFeatureFlagChangeNotifier } from "./services/featureFlagChangeNotifier";
import { postAgentActionRequiredNotice } from "./services/agentActionRequiredNoticeService";
import { startAgentInboxPushWorker } from "./services/agentInboxPushService";
import { startThirdPartyEventRedeliveryWorker } from "./services/thirdPartyAgentEventRedelivery";
import { startComputerOutageNotificationWorker } from "./services/computerOutageNotificationService";
import { startAgentMigrationReceiptOutboxWorker } from "./services/agentMigrationReceiptService";
import { startAgentMigrationRemediationWorker } from "./services/agentMigrationRemediationWorker";
import { startHostedAgentMigrationImporterWorker } from "./services/hostedAgentMigrationImporter";
import { startDurableTaskRecovery } from "./services/durableTasks";
import { getProductEventSink, getPublicVisitorSink } from "./services/productEventIngest";
import { setExternalConnectWorkerProductEventSink } from "./services/externalConnectProductEvents";
import { setActionCardScopeDbSink } from "./services/productEventsService";
import { durableTaskRegistry } from "./services/durableTaskRegistry";
import { startChannelMembershipRoleOutboxWorker } from "./services/channelMembershipRoleOutbox";
import { startAgentRuntimeProvisionWorker } from "./services/agentRuntimeProvisionService";
import { startAgentRuntimeApprovalWorker } from "./services/agentRuntimeApprovalService";
import { enforceDowngradeLimits } from "./services/downgradeEnforcement";
import { sweepLapsedPrepaidServers } from "./services/prepaidProSweep";
import { sendPrepaidProReminders } from "./services/prepaidProReminders";
import { onJointLimitStateChanged, sweepJointOverLimit } from "./services/jointChannelLimitService";
import { sweepExternalChannelFreezes } from "./services/externalChannelFreezeService";
import { scrubDeviceAuthorizationRequesterDetails } from "./services/deviceAuthService";
import { revokeKeysOfRevokedDeviceSessions } from "./services/deviceSessionKeys";
import { runSecurityRevokeCascade } from "./services/securityRevokeCascade";
import { initRedis, shutdownRedis } from "./redis";
import { configureMetricsDeploymentIdentity, startMetricsServer } from "./metrics";
import { createServerTracerFromEnv } from "./tracing/serverTracer";
import { initPrivacyModeFromEnv } from "./config/privacyMode";
import { flushProductEventsBeforeExit, startProductEventIngestSummary } from "./services/productEventIngestSummary";
import { productScopeDbStore } from "./services/productEventScopeDbWriter";
import { cpuProfileSaturationUtilization, cpuProfileSummaryEnabled, startCpuProfileSummarySampler } from "./tracing/cpuProfileSummary";
import { startEventLoopDelaySampler } from "./tracing/eventLoopDelay";
import { startProcessMemorySampler } from "./tracing/processMemory";
import { startEventLoopStallDetector, trackHttpServer } from "./tracing/eventLoopStall";
import { startDbLatencyProbe } from "./db/latencyProbe";
import { startReplicationSlotMonitor } from "./db/replicationSlotMonitor";
import { warmupServerWorkerPool } from "./services/workerPool/serverWorkerPool";
import { setReplicaRouterTracer } from "./replicaRouter";
import { resolveTraceDeploymentIdentity } from "./tracing/traceDeploymentIdentity";
import { errorClassOf, recordTraceEvent, setDefaultTraceTracer, startDroppedTraceEventReporter, withTraceRoot } from "./tracing/semanticTrace";
import { getFramedByOrigins, getWebCorsOriginOption } from "./config/appUrl";
import { readWebauthnRelyingParty } from "./services/secondFactor/webauthn";
import { createSlackBridgeServerRuntimeFromEnv } from "./services/slackBridgeServerRuntime";
import {
  deliverExternalInboundCommittedMessageToAgents,
  emitExternalProjectionMessageToFrontend,
  emitExternalLinkedMessageUpdateToFrontend,
  runExternalInboundCommitSideEffects,
} from "./services/messageService";
import { shutdownServerRuntime } from "./serverShutdown";
import { startDrainCoordinator, type DrainSignalSourceName } from "./services/drainCoordinator";
import { DEFAULT_DRAIN_CLOSE_SPREAD_MS, spreadClosesForDrain } from "./services/machineDrain";
import { sharedSseStreamRegistry } from "./services/sseStreamRegistry";
import { isRisingWaveConfigured } from "./db/risingwave";
import { warmContractSchemas } from "@botiverse/raft-shared";


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

// Passkeys (services/secondFactor/webauthn.ts): unset is fine (passkeys
// unavailable); set but inconsistent with itself or APP_URL refuses to start,
// since an RP ID cannot change once passkeys are registered under it.
try {
  readWebauthnRelyingParty();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// RAFT_PRIVACY_MODE (config/privacyMode.ts): read once, before the tracer and
// every other sender exists. An invalid value refuses to start rather than
// guessing which way a request should go.
try {
  if (initPrivacyModeFromEnv(process.env)) {
    console.log("[Slock] Privacy mode is on: nothing is sent to Raft's own services");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// FRAMED_BY_ORIGINS (config/appUrl.ts): a page that frames the app (Deck), added
// to the attachment previews' frame-ancestors only. A bad entry refuses to start
// rather than failing every preview.
try {
  getFramedByOrigins();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// RisingWave is a hard dependency: Activity, followed-thread stats and sidebar
// unread are served from it only, with no Postgres fallback. A production server
// without it would fail those reads on every request, so refuse to start.
if (process.env.NODE_ENV === "production" && !isRisingWaveConfigured()) {
  console.error("RISINGWAVE_DATABASE_URL environment variable is required in production (RisingWave is a hard dependency)");
  process.exit(1);
}

async function bootstrap() {
  // The shared Agent API contract schemas are built on first use (so a short
  // `raft` CLI call builds only its own route's). The server builds them all
  // here instead: a broken schema fails startup, not the first request to its
  // route, and no request pays the build.
  console.log(`[Slock] Built ${warmContractSchemas()} contract schemas`);
  // Every system app whose agent events need a delivery guard has it here
  // (first-party apps' come from their registration); none missing, or no start.
  console.log(`[Slock] System-app delivery guards: ${assertRequiredSystemAppDeliveryGuards().join(", ") || "none"}`);

  // Install the audited global fetch BEFORE any request path runs. No-op unless
  // RAFT_TX_POOL_AUDIT_FILE is set, so production fetch is untouched.
  installAuditedGlobalFetch();

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
  setReplicaRouterTracer(serverTracer.tracer);
  // Background work (pollers, workers, timers) records through the server
  // tracer by default instead of silently dropping; anything still dropped is
  // reported as `server.trace_event.dropped`.
  setDefaultTraceTracer(serverTracer.tracer);
  startDroppedTraceEventReporter(serverTracer.tracer);
  startProductEventIngestSummary(serverTracer.tracer, productScopeDbStore(process.env));
  startPoolMetricsReporting();
  startMachineLivenessMetrics();
  getDbLivenessTracker().start();

  // Resolve direct-upload capability once at server startup. Clients consume
  // the resulting server-owned threshold/limit projection; they never copy
  // storage or plan constants locally.
  // The thumbnail worker starts once sockets exist (below); completions before
  // that are picked up by its first run.
  let kickDirectUploadThumbnails = () => {};
  const attachmentUploadSessionService = createDurableAttachmentUploadSessionService({
    onThumbnailPending: () => kickDirectUploadThumbnails(),
  });
  let slackBridgeSocket: ReturnType<typeof setupSocket> | null = null;
  // Error-system boundary: background bridge errors must surface in telemetry,
  // not only the console. The bridge ticks run inside their own root spans, so
  // this event is tied to the tick that failed. The classification here is the
  // bounded identity (exception name / typeof); closed reasons live with each
  // call site inside the bridge.
  const reportSlackBridgeError = (site: string) => (error: unknown) => {
    console.error(`[SlackBridge] ${site} failed:`, error);
    recordTraceEvent("server.slack_bridge.error", {
      site,
      outcome: "error",
      reason: "bridge_worker_threw",
      error_class: errorClassOf(error),
    });
  };
  // Cross replica routed handlers and the hourly maintenance sweeps run outside
  // any request trace. Each run gets its own root span (closed site plus
  // bounded attrs). A failure ends the span with error and records the
  // `server.background.error` event inside it.
  const runBackgroundWork = (
    name: "server.background.maintenance" | "server.background.routed_handler",
    attrs: Record<string, string>,
    work: () => Promise<unknown>,
  ) => withTraceRoot(
    serverTracer.tracer,
    name,
    { surface: "server", kind: "internal", attrs },
    work,
    "server.background.error",
  );
  const slackBridge = await createSlackBridgeServerRuntimeFromEnv(process.env, {
    tracer: serverTracer.tracer,
    onLifecycleError: reportSlackBridgeError("lifecycle"),
    onOutboundError: reportSlackBridgeError("outbound"),
    onInboundError: reportSlackBridgeError("inbound"),
    onInboundAttachmentError: reportSlackBridgeError("inbound_attachment"),
    onQueueMetricsError: reportSlackBridgeError("queue_metrics"),
    onInboundMessageCommitted: async ({ messageId }) => {
      await runExternalInboundCommitSideEffects(
        async () => {
          if (!slackBridgeSocket) throw new Error("Slack Bridge Socket.IO runtime is unavailable");
          await emitExternalProjectionMessageToFrontend(slackBridgeSocket, messageId);
        },
        async () => {
          // Agents on the bound channel/thread must see the inbound message
          // too. Without this the Slack-side human thinks the agent is alive
          // but never gets an answer (Inferact report, task #221).
          const agentOrchestrator = app.get("agentOrchestrator") as AgentOrchestrator | undefined;
          if (agentOrchestrator) {
            await deliverExternalInboundCommittedMessageToAgents(agentOrchestrator, messageId);
          }
        },
      );
    },
    onInboundMessageEdited: async ({ messageId }) => {
      if (!slackBridgeSocket) throw new Error("Slack Bridge Socket.IO runtime is unavailable");
      await emitExternalLinkedMessageUpdateToFrontend(slackBridgeSocket, messageId, { updateThreadPreview: true });
    },
    onInboundReactionCommitted: async ({ messageId }) => {
      if (!slackBridgeSocket) throw new Error("Slack Bridge Socket.IO runtime is unavailable");
      await emitExternalLinkedMessageUpdateToFrontend(slackBridgeSocket, messageId);
    },
  });
  const app = createApp({
    attachmentUploadSessionService: attachmentUploadSessionService ?? undefined,
    slackBridge,
    serviceInstanceId: traceDeploymentIdentity.serviceInstanceId,
  });
  app.set("slackBridgePrivacyRevalidator", slackBridge?.revalidateChannelPrivacy);
  reportOpsCpuProfileStartup();

  // Create HTTP server
  const server = createServer(app);

  // The production ALB holds idle keep-alive connections for 300s (measured
  // 2026-09-29, slock-prod-alb idle_timeout). The server must out-idle the
  // balancer so the balancer is always the side that closes first; with the
  // Node default (5s) the server closes sockets the ALB still considers
  // reusable, and the next request on such a socket races the close and
  // fails with 502 (task #261). headersTimeout must exceed keepAliveTimeout
  // (Node requirement).
  server.keepAliveTimeout = Number(process.env.SLOCK_HTTP_KEEP_ALIVE_TIMEOUT_MS) || 310_000;
  server.headersTimeout = Number(process.env.SLOCK_HTTP_HEADERS_TIMEOUT_MS) || 320_000;

  app.set("serverTracer", serverTracer.tracer);

  // Setup Agent Orchestrator
  const agentOrchestrator = new AgentOrchestrator(undefined, undefined, serverTracer.tracer);
  app.set("agentOrchestrator", agentOrchestrator);
  setProductFeedbackTriageNoticeDeliverer(agentOrchestrator);
  logProductFeedbackTriageNoticeConfig();

  // Initialize cross-replica routing (Redis pub/sub) if Redis is available
  const { initReplicaRouter, setAgentTypingPostedHandler, setMachineConnectionDropHandler } = await import("./replicaRouter");
  const replicaReplayEndpoint = await resolveReplicaReplayEndpoint(PORT);
  await initReplicaRouter(
    (machineId, message) => {
      runBackgroundWork(
        "server.background.routed_handler",
        { site: "routed_machine_command", machine_id: machineId },
        () => agentOrchestrator.handleRoutedMachineCommand(machineId, message),
      ).catch((err) => {
        console.error(`[ReplicaRouter] Failed to handle routed machine command for ${machineId}:`, err);
      });
    },
    (agentId, machineId, message, deliveryOptions) => {
      runBackgroundWork(
        "server.background.routed_handler",
        { site: "routed_inbox_delivery", agent_id: agentId },
        () => agentOrchestrator.handleRoutedInboxDelivery(agentId, machineId, message, deliveryOptions),
      ).catch((err) => {
        console.error(`[ReplicaRouter] Failed to handle routed inbox delivery for ${agentId}:`, err);
      });
    },
    (agentId) => {
      agentOrchestrator.handleRoutedExternalWakeSignal(agentId);
    },
    replicaReplayEndpoint,
    async (machineId, principalKind) => {
      try {
        await runBackgroundWork(
          "server.background.routed_handler",
          { site: "machine_principal_fence", machine_id: machineId, principal_kind: principalKind },
          () => agentOrchestrator.fenceMachinePrincipalConnections(machineId, principalKind),
        );
      } catch (err) {
        console.error(`[ReplicaRouter] Failed to fence ${principalKind} connection for ${machineId}:`, err);
      }
    },
    (agentId, machineId, message, deliveryOptions) => (
      agentOrchestrator.handleRoutedInboxDeliveryWithReceipt(agentId, machineId, message, deliveryOptions)
    ),
    (request) => agentOrchestrator.handleStartIntent(request),
  );
  // Agent typing line: another replica served the agent's send.
  setAgentTypingPostedHandler((signal) => agentOrchestrator.handleRoutedAgentTypingPosted(signal));
  setMachineConnectionDropHandler(async (machineId, reason) => {
    try {
      await runBackgroundWork(
        "server.background.routed_handler",
        { site: "machine_connection_drop", machine_id: machineId, reason },
        () => agentOrchestrator.dropMachineConnectionForCredentialChange(machineId, reason),
      );
    } catch (err) {
      console.error(`[ReplicaRouter] Failed to drop the connection for ${machineId}:`, err);
    }
  });

  // Setup Machine WebSocket BEFORE Socket.io (since Socket.io intercepts all upgrade events)
  setupMachineWebSocket(server, agentOrchestrator, serverTracer.tracer);

  // Setup Socket.io with auth (must be after machine WS to avoid intercepting /daemon/connect)
  const io = setupSocket(server, CORS_ORIGIN);
  slackBridgeSocket = io;
  app.set("io", io);
  agentOrchestrator.setIO(io);
  setBillingIO(io, agentOrchestrator);
  setAppSumoPlanChangeSink(async serverId => {
    const plan = await getServerPlan(serverId);
    io.to(`server:${serverId}`).emit("server:plan-updated", { serverId, plan });
  });
  setActivityRealtimeIO(io);
  setListChangedRealtimeIO(io);
  setProductFeedbackUnreadRealtimeIO(io);
  // A marketplace review decision's side effects (marketplace_review_outbox), sent by the worker below.
  const marketplaceReviewSinks = marketplaceReviewSideEffectSinks({ io, agentOrchestrator });
  setJointHumanReadRealtimeIO(io, (userId, serverId, scopes) => onConversationsRead(io, userId, serverId, scopes));
  // Action card funnel rows also go to ScopeDB while readers move off Postgres.
  setActionCardScopeDbSink(getProductEventSink(app));
  // The connect worker's external_channel_connect_finished rows (it has no request to read the sink from).
  setExternalConnectWorkerProductEventSink(getProductEventSink(app));
  onJointLimitStateChanged((parentJointId) => emitJointLimitStateChange(io, parentJointId));

  // Brief Cindy whenever she actually comes up — not only when a user happens to press a
  // button that starts her. A computer switched on the next morning wakes her through the
  // daemon, which touches no HTTP route, and that was the one path the briefing retry did
  // not cover.
  startOnboardingBriefingOnActivation({ io, orchestrator: agentOrchestrator });
  // Hosted Cindy is briefed when her workspace import lands, not on machine:online.
  registerHostedCindyTriggers({ io, orchestrator: agentOrchestrator, trigger: triggerOwnerOnboardingOnAgentActivation, tracer: serverTracer.tracer });
  // A hosted Cindy has no computer to fire her Day-2 recap; the server does.
  const hostedCindyRecapWorker = startHostedCindyRecapWorker({ io, orchestrator: agentOrchestrator, tracer: serverTracer.tracer });
  // Yesterday's hosted spend, per agent and for the onboarding budget, as trace events for the daily report.
  const hostedRuntimeDailySpendWorker = startHostedRuntimeDailySpendWorker({ tracer: serverTracer.tracer });
  // New-server onboarding funnel (T3): aggregates to otel.logs every 6 hours, plus the one
  // milestone no table kept, a Computer's first connection.
  startMachineFirstConnectRecorder({ orchestrator: agentOrchestrator });
  const onboardingFunnelWorker = startOnboardingFunnelWorker({ tracer: serverTracer.tracer });

  // Hourly maintenance — downgrade enforcement + webhook event cleanup
  const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const runMaintenance = () => {
    runBackgroundWork(
      "server.background.maintenance",
      { site: "enforce_downgrade_limits" },
      () => enforceDowngradeLimits(agentOrchestrator, serverTracer.tracer),
    ).catch((err) => {
      console.error("[Slock] Enforcement check failed:", err);
    });
    // Prepaid Pro (task #19): nothing tells Raft when prepaid time runs out,
    // so drop lapsed Servers to Free here; every paid source is re-read first.
    // Clients hear it through the paid-source plan-change sink after commit;
    // the joint, external-freeze and hosted-runtime sweeps pick up the change.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prepaid_lapse_sweep" },
      () => sweepLapsedPrepaidServers(),
    ).catch((err) => {
      console.error("[Slock] Prepaid lapse sweep failed:", serializeErrorForLog(err));
    });
    // Prepaid Pro does not renew: email the owner 7 days and 1 day before it
    // ends, and when it ends (each once; prepaidProReminders.ts).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prepaid_reminders" },
      () => sendPrepaidProReminders(),
    ).catch((err) => {
      console.error("[Slock] Prepaid reminders failed:", serializeErrorForLog(err));
    });
    // Contract v0.3 §18.8: observe joints that went over their free-server
    // cap with nobody posting, so the notice appears and the grace expires on
    // time. Idempotent: only the first observation sets over_limit_since.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "joint_over_limit_sweep" },
      () => sweepJointOverLimit(),
    ).catch((err) => {
      console.error("[Slock] Joint over-limit sweep failed:", serializeErrorForLog(err));
    });
    // The free plan's external channel freeze: the backstop for changes no
    // request path reconciled (a deleted server, a plan change outside the
    // billing sync, an account deletion). Creates no freeze before the launch
    // backfill has run.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "external_channel_freeze_sweep" },
      () => sweepExternalChannelFreezes(),
    ).catch((err) => {
      console.error("[Slock] External channel freeze sweep failed:", serializeErrorForLog(err));
    });
    runBackgroundWork(
      "server.background.maintenance",
      { site: "cleanup_webhook_events" },
      () => cleanupWebhookEvents(),
    ).catch((err) => {
      console.error("[Slock] Webhook event cleanup failed:", err);
    });
    // Expired sessions, replay receipts and refresh-token lineage rows
    // (`session_token_predecessors`) are only bounded by this sweep.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "cleanup_expired_sessions" },
      () => cleanupExpiredSessions(),
    ).catch((err) => {
      console.error("[Slock] Session cleanup failed:", serializeErrorForLog(err));
    });
    // Device-login records keep who started and finished a login (IP,
    // location, user agent) for 30 days, for security only.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "scrub_device_authorization_requester_details" },
      () => scrubDeviceAuthorizationRequesterDetails(),
    ).catch((err) => {
      console.error("[Slock] Device login detail cleanup failed:", serializeErrorForLog(err));
    });
    // A device login's session takes the keys it handed out with it, however
    // it was revoked; the revoker does it after its commit, and this repairs
    // one that failed in between (deviceSessionKeys.ts).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "revoke_keys_of_revoked_device_sessions" },
      () => revokeKeysOfRevokedDeviceSessions("everyone"),
    ).catch((err) => {
      console.error("[Slock] Device session key revocation failed:", serializeErrorForLog(err));
    });
    // A security revoke of a web session (a password change or reset, the
    // account's retirement, a device login's revoke link) takes what it
    // approved through one-time grants and what it issued itself, and mails
    // the person once; this repairs one that failed after its commit. Never a
    // plain logout, never the session that changed the password
    // (securityRevokeCascade.ts).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "revoke_what_security_revoked_sessions_issued" },
      () => runSecurityRevokeCascade("security_revoked", "repair"),
    ).catch((err) => {
      console.error("[Slock] Security revoke cascade repair failed:", serializeErrorForLog(err));
    });
    // SSO domains (rfcs/083-server-sso.md §5.5): re-check each verified
    // domain daily, and hourly while its record is missing or lookups fail;
    // a confirmed absence unverifies it at once.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "recheck_server_sso_domains" },
      () => recheckServerSsoDomains(),
    ).catch((err) => {
      console.error("[Slock] SSO domain re-check failed:", serializeErrorForLog(err));
    });
    // SSO sign-in legs past their 10-minute expiry (services/sso/ssoTransactions.ts).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "sweep_expired_sso_transactions" },
      () => sweepExpiredSsoTransactions(),
    ).catch((err) => {
      console.error("[Slock] SSO transaction sweep failed:", serializeErrorForLog(err));
    });
    // SAML assertion IDs past the moment they could still be accepted (services/sso/ssoSaml.ts).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "sweep_expired_saml_assertions" },
      () => sweepExpiredSamlAssertions(),
    ).catch((err) => {
      console.error("[Slock] SAML assertion sweep failed:", serializeErrorForLog(err));
    });
    // Two-step verification recovery requests (services/secondFactor/recovery.ts):
    // expire the ones past their time (also expired lazily on read) and mail
    // "you can finish now" once per request whose 72-hour wait ended.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "sweep_second_factor_recovery_requests" },
      () => sweepRecoveryRequests(),
    ).catch((err) => {
      console.error("[Slock] Two-step verification recovery sweep failed:", serializeErrorForLog(err));
    });
    // Agent API idempotency keys are valid for 24 hours; expired ledger rows
    // are only bounded by this sweep (bounded batches per tick).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_agent_api_idempotency_keys" },
      () => pruneExpiredAgentApiIdempotencyKeys(),
    ).catch((err) => {
      console.error("[Slock] Agent API idempotency key cleanup failed:", serializeErrorForLog(err));
    });
    // A Computer's runner keys, one per launch, revoked when it ends: deleted
    // 30 days later (bounded batches per tick, one replica at a time).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_revoked_runner_agent_credentials" },
      () => pruneRevokedRunnerAgentCredentials(),
    ).catch((err) => {
      console.error("[Slock] Revoked runner credential cleanup failed:", serializeErrorForLog(err));
    });
    // Marketplace review outbox rows, once delivered, are deleted 30 days
    // later; an undelivered one never is (bounded batches per tick, one
    // replica at a time).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_delivered_marketplace_review_outbox" },
      () => pruneDeliveredMarketplaceReviewOutbox(),
    ).catch((err) => {
      console.error("[Slock] Marketplace review outbox cleanup failed:", serializeErrorForLog(err));
    });
    // Who a joint disconnect removed (joint_membership_removals) is kept 90
    // days after its cleanup completed, then deleted; an unfinished
    // departure's rows never are (bounded batches per tick, one replica at a time).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_completed_joint_membership_removals" },
      () => pruneCompletedJointMembershipRemovals(),
    ).catch((err) => {
      console.error("[Slock] Joint membership removal cleanup failed:", serializeErrorForLog(err));
    });
    // Agent token usage keeps 90 days (agentUsageService.ts; bounded batches, one replica at a time).
    runBackgroundWork("server.background.maintenance", { site: "prune_agent_usage_daily" }, () => pruneAgentUsage()).catch((err) => {
      console.error("[Slock] Agent usage cleanup failed:", serializeErrorForLog(err));
    });
    // First-party apps' maintenance (apps/firstPartyApps.ts: FirstPartyApp.jobs.maintenance; bounded work per tick).
    for (const job of firstPartyAppMaintenanceJobs()) {
      runBackgroundWork("server.background.maintenance", { site: job.site }, job.run).catch((err) => {
        console.error(`[Slock] ${job.app} ${job.site} failed:`, serializeErrorForLog(err));
      });
    }
    // Object files (services/objectFiles.ts): drafts unclaimed for an hour and a
    // soft-deleted server's files are let go, then the bytes of let-go files
    // deleted, those whose delete after the app's commit failed included
    // (bounded batches per tick; nothing without the app-content bucket).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "sweep_object_files" },
      () => sweepObjectFiles(),
    ).catch((err) => {
      console.error("[Slock] Object file sweep failed:", serializeErrorForLog(err));
    });
    // Object events (Activity, technical design §7) are kept 90 days (bounded batches per tick).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_object_events" },
      () => pruneObjectEvents(),
    ).catch((err) => {
      console.error("[Slock] Object event cleanup failed:", serializeErrorForLog(err));
    });
    // Card messages' revisions (RFC 082 §4.5) are kept 44 days after the
    // message was sent; the message keeps its current card (bounded batches per tick).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_message_card_revisions" },
      () => pruneMessageCardRevisions(),
    ).catch((err) => {
      console.error("[Slock] Card message revision cleanup failed:", serializeErrorForLog(err));
    });
    // Events apps send to agents are kept 30 days after they expire (Agent
    // panel history); only this sweep bounds the table (bounded batches per tick).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_agent_app_events" },
      () => pruneExpiredAgentAppEvents(),
    ).catch((err) => {
      console.error("[Slock] Agent app event cleanup failed:", serializeErrorForLog(err));
    });
    // change_log (incremental sync) partitions: created 14 days ahead, dropped
    // after the 7-day retention. Idempotent; one replica at a time.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "change_log_maintain" },
      () => runChangeLogMaintenance(),
    ).catch((err) => {
      console.error("[Slock] change_log maintenance failed:", serializeErrorForLog(err));
    });
    // Account deletions whose grace period is over: retire and scrub the
    // account, then delete the person's data in bounded batches, resuming
    // next run (services/accountDeletion/cleanup.ts). SKIP LOCKED and a lease
    // keep replicas off each other's requests.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "account_deletion_cleanup" },
      () => runAccountDeletionCleanup({ deps: { orchestrator: agentOrchestrator, io } }),
    ).catch((err) => {
      console.error("[Slock] Account deletion cleanup failed:", serializeErrorForLog(err));
    });
    // Closed servers past 30 days, behind the closed_server_purge flag: a
    // server with the variant `delete` is purged (on the primary, under a
    // lease, within the run's guards: services/closedServerPurgeDelete.ts);
    // one with no variant or `count` is only counted (read-only transactions
    // on the replica when configured). One run per hour across replicas, at
    // most 5 minutes, never in a quiet time (services/closedServerPurge.ts).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "closed_server_purge" },
      // auth.revoke for a closed server's Slack installs goes through the bridge runtime (it holds the cipher).
      () => runClosedServerPurge({ revokers: { slackInstallToken: slackBridge ? (installId) => slackBridge.revokeInstallToken(installId) : undefined } }),
    ).catch((err) => {
      console.error("[Slock] Closed server purge failed:", serializeErrorForLog(err));
    });
  };
  setTimeout(runMaintenance, 10_000); // Run once 10s after startup
  setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);

  const stopAttachmentUploadSessionCleanup = attachmentUploadSessionService
    ? startAttachmentUploadSessionCleanup(attachmentUploadSessionService, serverTracer.tracer)
    : () => {};
  // Thumbnails for direct uploads (task #57); concurrency bounded by the
  // peak-memory measurement (DIRECT_UPLOAD_THUMBNAIL_CONCURRENCY).
  const thumbnailSourceStorage = getStorage();
  const directUploadThumbnailWorker = attachmentUploadSessionService && thumbnailSourceStorage
    ? startDirectUploadThumbnailWorker({
      storage: thumbnailSourceStorage,
      cdnStorage: getCdnStorage(),
      notifyMessagesUpdated: async (messageIds) => {
        for (const messageId of messageIds) {
          await emitAttachmentPreviewMessageUpdate(io, messageId).catch((err) => {
            console.error("[direct-upload-thumbnail] message update broadcast failed", { messageId, err });
          });
        }
      },
    }, { concurrency: DIRECT_UPLOAD_THUMBNAIL_CONCURRENCY, tracer: serverTracer.tracer })
    : null;
  if (directUploadThumbnailWorker) kickDirectUploadThumbnails = directUploadThumbnailWorker.kick;
  // Disabled by default until artifact inventory/parity and the rollout
  // capability authorize physical lifecycle work.
  const stopAttachmentLifecycleSweep = startAttachmentLifecycleSweep({ tracer: serverTracer.tracer });

  // Reminder arm watchdog: resyncs missing Computer armed(revision) receipts.
  // It never fires/wakes; due-time authority is Computer-local.
  const reminderArmWatchdog = startReminderArmWatchdog({ orchestrator: agentOrchestrator, tracer: serverTracer.tracer });
  // Off unless REMINDER_APP_CLIENT_ID / _IMPORT_URL / _IMPORT_TOKEN are set; then dry-run on allowlisted servers by default.
  const reminderAppMigrationWorker = startReminderAppMigrationWorker({ tracer: serverTracer.tracer });
  // Unified notifications: the 15 s fallback drain of notification_outbox and its daily sweep.
  // Push provider credentials and connections, ahead of the first drain; never blocks the start.
  void warmNotificationTransports();
  const notificationDispatcher = startNotificationDispatcher({ io, tracer: serverTracer.tracer });
  const readMutationWorker = startReadMutationWorker({ tracer: serverTracer.tracer });
  const appNotificationDeliveryWorker = startAppNotificationDeliveryWorker({ tracer: serverTracer.tracer });
  // Rechecks idle and suspended App link preview domain proofs every 15 minutes.
  const appLinkPreviewRecheckWorker = startAppLinkPreviewRecheckWorker({ tracer: serverTracer.tracer });
  const appSumoReconciliationWorker = startAppSumoReconciliationWorker();
  // `product_feedback:unread` pushes (and `product_feedback:app_unread` for
  // each mobile source's app): one run a minute per app across replicas reads
  // the Hands reporter change feed and pushes a reporter's unread total when a
  // ticket of theirs got a new public reply. Off unless
  // HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED=true.
  const productFeedbackUnreadReconcileWorker = startProductFeedbackUnreadReconcileWorker({ tracer: serverTracer.tracer });
  // Interactive link cards: the first-send deadline, view, reconciliation and trim sweeps, once a minute
  // (RFC 076 §3.7, §5.2); a moved operation is hinted to its viewer (§6.8).
  const linkCardSweepWorker = startLinkCardSweepWorker({ tracer: serverTracer.tracer, io });
  // `server:features-changed`: polls the feature-flag config cursor that Feature Flag Admin bumps on
  // every write and tells this replica's sockets and Computers whose flags may have changed.
  const featureFlagChangeNotifier = startFeatureFlagChangeNotifier({
    transport: socketIoFeaturesChangedTransport(io, agentOrchestrator),
  });
  const agentInboxPushWorker = startAgentInboxPushWorker({
    agentOrchestrator,
    tracer: serverTracer.tracer,
    // A stopped registration tells the agent's owner, in their DM with the agent.
    notifyOwner: ({ agentId, cause }) => postAgentActionRequiredNotice(io, agentOrchestrator, {
      agentId,
      notice: { kind: "inbox_push_paused", cause },
    }),
  });
  // Managed agents' app events whose push was lost (computer offline): safety-net
  // sweep over this replica's connected computers. Off by default: it runs only with
  // THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED=true (and not THIRD_PARTY_EVENT_REDELIVERY_ENABLED=false).
  const thirdPartyEventRedeliveryWorker = startThirdPartyEventRedeliveryWorker({ agentOrchestrator });
  const raftbenchWorker = startRaftbenchWorker(agentOrchestrator);
  const assistantDoorbellWorker = startAssistantDoorbellWorker({ agentOrchestrator, tracer: serverTracer.tracer });
  // The personal assistant's WeChat bridge: one long poll per active binding
  // across replicas (a lease per binding), mirroring WeChat-turn replies back.
  // Idle without WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY; WECHAT_BRIDGE_WORKER_DISABLED=1 turns it off.
  const wechatBridgeWorker = startWeChatBridgeWorker({ io, orchestrator: agentOrchestrator, tracer: serverTracer.tracer });
  // First-party apps' interval jobs (apps/firstPartyApps.ts: FirstPartyApp.jobs.every),
  // their notices pushed through this orchestrator. One run per job at a time;
  // shutdown waits for the runs in flight, so their pushes don't run against
  // a closing orchestrator and database.
  const firstPartyAppJobs = startFirstPartyAppIntervalJobs(agentOrchestrator);
  // Seat requests open longer than 7 days end, and what they held is cleared (task #10).
  const seatRequestExpiryWorker = startSeatRequestExpiryWorker(io, agentOrchestrator);
  // Question cards past their expiresAt end as expired, and each agent is told (question-card spec §4.4).
  const questionCardExpiryWorker = startQuestionCardExpiryWorker(io, agentOrchestrator);
  const computerOutageNotificationWorker = startComputerOutageNotificationWorker();
  const agentMigrationReceiptOutboxWorker = startAgentMigrationReceiptOutboxWorker({
    io,
    orchestrator: agentOrchestrator,
  });
  const agentMigrationRemediationWorker = startAgentMigrationRemediationWorker({
    io,
    orchestrator: agentOrchestrator,
  });
  const hostedAgentMigrationImporterWorker = startHostedAgentMigrationImporterWorker({ io, orchestrator: agentOrchestrator });
  // RFC 073: recover durable tasks whose inline run was lost. Off unless DURABLE_TASKS_ENABLED=true.
  const durableTaskRecovery = startDurableTaskRecovery({ registry: durableTaskRegistry, tracer: serverTracer.tracer });
  configureJointDepartureEffects(jointMembershipDepartureEffects(agentOrchestrator));
  // This registered denial-cleanup kind must recover on every replica even if
  // the unrelated legacy durable-task environment switch is disabled.
  const jointDepartureRecovery = startDurableTaskRecovery({ registry: jointDepartureRegistry, tracer: serverTracer.tracer, enabled: true });
  // A joint whose host side emptied is archived for every side (same rule: always recovered).
  configureJointHostSideArchiveEffects({ io, orchestrator: agentOrchestrator });
  const jointHostSideArchiveRecovery = startDurableTaskRecovery({ registry: jointHostSideArchiveRegistry, tracer: serverTracer.tracer, enabled: true });
  // Retired server-admin notices: queued rows are drained (completed, nothing sent), always, as above.
  const serverAdminNoticeRecovery = startDurableTaskRecovery({ registry: serverAdminNoticeRegistry, tracer: serverTracer.tracer, enabled: true });
  const conversionWorker = startChannelConversionWorker(async job => {
    applyChannelConversionAudienceRealtimeCutover(io, await getChannelConversionAudienceCutover(job.id));
    if (job.status === "done" || job.status === "canceled" || job.status === "failed") await emitChannelConversionCompletion(io, job.id, job.sourceChannelId);
    else await emitChannelConversionState(io, job.sourceChannelId);
  }, sourceChannelId => emitChannelConversionState(io, sourceChannelId), slackBridge?.revalidateChannelPrivacy, serverTracer.tracer,
  connection => publishExternalConnection({ io, orchestrator: agentOrchestrator }, connection));
  const channelMembershipRoleOutboxWorker = startChannelMembershipRoleOutboxWorker({ io, tracer: serverTracer.tracer });
  // Marketplace review decisions (App Admin's): agent:deleted and the credential revocation
  // signal for removed bots, permission-updates:changed; every 5 s, oldest-age gauge alongside.
  const marketplaceReviewOutboxWorker = startMarketplaceReviewOutboxWorker({ sinks: marketplaceReviewSinks, tracer: serverTracer.tracer });
  const agentRuntimeProvisionWorker = startAgentRuntimeProvisionWorker({ tracer: serverTracer.tracer });
  // antiproton held-call approvals: the reconcile of each configured target (none: idle).
  const agentRuntimeApprovalWorker = startAgentRuntimeApprovalWorker({ io });

  // Start Prometheus metrics endpoint
  startMetricsServer();

  // Open a few primary PG connections before the load balancer can route
  // here, so a deploy's reconnect storm does not find an empty pool. Bounded
  // and never throws; see db/poolPrewarm.ts.
  await prewarmPrimaryPool();

  // Start server
  trackHttpServer(server);
  server.listen(PORT, () => {
    slackBridge?.start();
    console.log(`[Slock] Server listening on http://localhost:${PORT}`);
    serverTracer.tracer.emitEvent("slock.server.started", { surface: "server" });
    const cpuProfileSampler = cpuProfileSummaryEnabled(process.env, traceDeploymentIdentity.serviceInstanceId)
      ? startCpuProfileSummarySampler(serverTracer.tracer, {
          instanceKey: traceDeploymentIdentity.serviceInstanceId,
          saturationUtilization: cpuProfileSaturationUtilization(process.env),
        })
      : null;
    startEventLoopDelaySampler(serverTracer.tracer, undefined, () => ({
      machine_connections: agentOrchestrator.machineConnectionCount,
      ...countSocketClients(io.of("/").sockets.values()),
    }), cpuProfileSampler?.observe);
    startProcessMemorySampler(serverTracer.tracer);
    startEventLoopStallDetector(serverTracer.tracer);
    startDbLatencyProbe(serverTracer.tracer);
    startReplicationSlotMonitor();
    // Pre-warm one preview worker so the first xlsx preview request does not
    // pay the spawn+compile cost. Fire-and-forget: warmup failure must never
    // take startup down.
    try {
      warmupServerWorkerPool();
    } catch (err) {
      console.warn("[Slock] Worker pool warmup failed:", err);
    }
  });

  // Going-away phase (task #261): when ECS begins draining this task, close
  // long-lived connections deliberately — daemon WebSockets get 1001
  // (going-away) so daemons reconnect to a healthy task within their normal
  // 0–5s jitter instead of being hard-cut by the ALB at deregistration
  // expiry, and SSE streams are ended so those clients reconnect
  // immediately. Idempotent: the drain detector fires it early and SIGTERM
  // re-runs it as a fallback. Must only run once draining has started, or
  // reconnecting daemons would be routed back onto this task.
  // Bounded exit. Long-lived connections were already closed by the
  // going-away phase, so the drain above should settle in milliseconds;
  // the deadline only covers stragglers and must stay below the ECS task
  // stopTimeout (30s by default), after which SIGKILL cuts us anyway.
  const shutdownDeadlineMs = Number(process.env.SLOCK_SHUTDOWN_DEADLINE_MS) || 25_000;
  // Total budget for the going-away stagger. Daemons below computer-v1.0.38
  // have no reconnect jitter (fixed ~1s), so this stagger is the only thing
  // spreading their reconnects. Sized with the ALB deregistration delay,
  // which is the window it runs inside (task #261).
  const drainSpreadMs = Number(process.env.SLOCK_DRAIN_CLOSE_SPREAD_MS) || DEFAULT_DRAIN_CLOSE_SPREAD_MS;

  // Background workers stop at drain start, not at SIGTERM: the ECS drain
  // fires ~5.5 min before exit, and until then the draining task's loops ran
  // next to the new tasks' and doubled background DB load for the whole
  // drain (v1.21.21 cutover, #proj-o11y:45a2b4f2). Every worker here claims
  // its work from the DB (lease / SKIP LOCKED / version check) or delivers
  // through cross-replica routing, so the healthy tasks pick it up within one
  // poll interval. Idempotent: shutdown() calls it again.
  let backgroundWorkersStopped: Promise<void> | null = null;
  const stopBackgroundWorkers = (): Promise<void> => {
    if (backgroundWorkersStopped) return backgroundWorkersStopped;
    stopAttachmentUploadSessionCleanup();
    directUploadThumbnailWorker?.stop();
    stopAttachmentLifecycleSweep();
    reminderArmWatchdog.stop();
    seatRequestExpiryWorker.stop();
    questionCardExpiryWorker.stop();
    agentRuntimeApprovalWorker.stop();
    reminderAppMigrationWorker.stop();
    // Stops the timers now; shutdown waits (bounded) for a maintenance pass in flight.
    const notificationSweepStopped = notificationDispatcher.stop();
    readMutationWorker.stop();
    appNotificationDeliveryWorker.stop();
    appLinkPreviewRecheckWorker.stop();
    const appSumoStopped = appSumoReconciliationWorker.stop();
    const productFeedbackUnreadReconcileStopped = productFeedbackUnreadReconcileWorker.stop();
    setAppSumoPlanChangeSink(null);
    linkCardSweepWorker.stop();
    featureFlagChangeNotifier.stop();
    agentInboxPushWorker.stop();
    // Stops the timer now; shutdown waits (bounded) for the sweep pass in flight.
    const thirdPartyEventRedeliveryStopped = thirdPartyEventRedeliveryWorker.stop();
    raftbenchWorker.stop();
    assistantDoorbellWorker.stop();
    const firstPartyAppJobsStopped = firstPartyAppJobs.stop();
    computerOutageNotificationWorker.stop();
    agentMigrationReceiptOutboxWorker.stop();
    agentMigrationRemediationWorker.stop();
    hostedAgentMigrationImporterWorker.stop();
    durableTaskRecovery.stop();
    jointDepartureRecovery.stop();
    jointHostSideArchiveRecovery.stop();
    serverAdminNoticeRecovery.stop();
    channelMembershipRoleOutboxWorker.stop();
    marketplaceReviewOutboxWorker.stop();
    // Stops claiming now; shutdown waits (bounded) for the provider call in flight.
    backgroundWorkersStopped = Promise.all([
      notificationSweepStopped,
      agentRuntimeProvisionWorker.stop(),
      // Aborts the WeChat long polls and sends in flight, then releases the leases (bounded).
      wechatBridgeWorker.stop(),
      thirdPartyEventRedeliveryStopped,
      appSumoStopped,
      productFeedbackUnreadReconcileStopped,
      // App-event reconnect passes started by a `ready` (bounded wait).
      agentOrchestrator.awaitThirdPartyEventReconnectPasses(),
      firstPartyAppJobsStopped,
    ]).then(() => undefined);
    conversionWorker.stop();
    hostedCindyRecapWorker.stop();
    hostedRuntimeDailySpendWorker.stop();
    onboardingFunnelWorker.stop();
    return backgroundWorkersStopped;
  };

  let goingAwayStarted = false;
  const beginGoingAway = (trigger: "ecs_drain" | "signal", source: DrainSignalSourceName | "sigterm") => {
    if (goingAwayStarted) return;
    goingAwayStarted = true;
    // The SIGTERM fallback must finish its stagger before the deadline;
    // the ECS-drain trigger fires minutes early and can afford the full
    // configured spread.
    const spreadMs = trigger === "ecs_drain"
      ? drainSpreadMs
      : Math.min(drainSpreadMs, Math.max(0, shutdownDeadlineMs - 5_000));
    // `drain_trigger_source` is the acceptance signal for the drain window
    // (task #268): the drained side must read `control_plane`. `metadata`
    // means the control-plane probe never fired (IAM not applied, API
    // unreachable) and the drain ran at the ALB cut, i.e. too late.
    console.log(`[Slock] Entering drain: sending going-away to long-lived connections (trigger=${trigger}, drain_trigger_source=${source}, spreadMs=${spreadMs})`);
    serverTracer.tracer.emitEvent("slock.server.drain_started", {
      surface: "server",
      attrs: { drain_trigger: trigger, drain_trigger_source: source, drain_spread_ms: spreadMs },
    });
    // One structured event per spread, so the measured span reaches ScopeDB
    // with drain_started (the console lines only reach CloudWatch) and every
    // cutover can be checked without AWS access: span_ms should be close to
    // drain_spread_ms, and outcome "failed" should never appear.
    // It runs inside the spreads' .then/.catch, so it must never throw: a
    // throw from the .catch would be an unobserved rejection (#426).
    const emitDrainSpread = (kind: "machine" | "sse" | "browser", result: { closed: number; spanMs: number } | null, err?: unknown) => {
      try {
        serverTracer.tracer.emitEvent("slock.server.drain_spread", {
          surface: "server",
          attrs: {
            drain_trigger: trigger,
            drain_spread_kind: kind,
            drain_spread_ms: spreadMs,
            outcome: result ? "ok" : "failed",
            ...(result ? { closed: result.closed, span_ms: result.spanMs } : { error_class: err instanceof Error ? err.name : typeof err }),
          },
        });
      } catch {
        // Telemetry only; the console line above already recorded it.
      }
    };
    void agentOrchestrator.closeMachineConnectionsForDrain({ spreadMs }).then(({ closed, spanMs }) => {
      // Measured values, not configured ones: the acceptance readings for
      // task #261 compare the actual span against the configured budget.
      console.log(`[Slock] Drain going-away: closed ${closed} machine connection(s), actual span ${spanMs}ms (configured spreadMs=${spreadMs})`);
      emitDrainSpread("machine", { closed, spanMs });
    }).catch((err: unknown) => {
      console.warn("[Slock] Drain going-away: machine connection spread failed:", err);
      emitDrainSpread("machine", null, err);
    });
    // Browser tabs (Socket.IO and SSE) get the same spread as daemons. Each
    // reconnect reloads the page's data (machines, agents, messages/sync,
    // inbox), and closing them all at once on every old task put that whole
    // reload on Neon in one second (#proj-o11y:7c3aaf2e). Streams opened
    // after this point would be a new client on a draining task; the ALB
    // has stopped routing to it, so the snapshot is the whole set.
    void spreadClosesForDrain(sharedSseStreamRegistry.snapshot(), (res) => sharedSseStreamRegistry.end(res), { spreadMs }).then(({ closed, spanMs }) => {
      console.log(`[Slock] Drain going-away: ended ${closed} SSE stream(s), actual span ${spanMs}ms (configured spreadMs=${spreadMs})`);
      emitDrainSpread("sse", { closed, spanMs });
    }).catch((err: unknown) => {
      console.warn("[Slock] Drain going-away: SSE stream spread failed:", err);
      emitDrainSpread("sse", null, err);
    });
    // Close each browser socket's transport rather than disconnecting it at
    // the Socket.IO layer: a server-side disconnect ("io server disconnect")
    // is the one case socket.io-client does NOT reconnect from, so every open
    // tab stayed offline after each deploy until refocused. A transport close
    // is reconnected automatically, with the client's own jittered backoff.
    void spreadClosesForDrain(io.of("/").sockets.values(), (socket) => {
      if (!socket.connected) return false;
      socket.conn.close();
      return true;
    }, { spreadMs }).then(({ closed, spanMs }) => {
      console.log(`[Slock] Drain going-away: closed ${closed} browser socket transport(s), actual span ${spanMs}ms (configured spreadMs=${spreadMs})`);
      emitDrainSpread("browser", { closed, spanMs });
    }).catch((err: unknown) => {
      console.warn("[Slock] Drain going-away: browser socket spread failed:", err);
      emitDrainSpread("browser", null, err);
    });
    // Observed: a detached rejection would be the #426 failure shape.
    stopBackgroundWorkers().catch((err: unknown) => {
      console.warn("[Slock] Drain going-away: background worker stop failed:", err);
    });
    console.log("[Slock] Drain going-away: stopped background workers");
  };

  // The ALB severs connections to a draining target the moment the
  // deregistration delay expires, and ECS sends SIGTERM at roughly the same
  // moment, so a SIGTERM-triggered going-away can never beat the hard cut.
  // The signal has to come from the start of draining. Measured on staging
  // 2026-09-29 (task #268): the task's own metadata v4 endpoint only flips
  // DesiredStatus to STOPPED at the cut (+306..317 s, closed 0), while the
  // ECS control plane reports desiredStatus=STOPPED from drain start. So the
  // primary probe is DescribeTasks on this task (needs ecs:DescribeTasks on
  // the task role, modules/server-service), with the metadata endpoint as a
  // second path into the same latch. SLOCK_DRAIN_DETECTOR_DISABLED=1 is the
  // operational kill switch.
  const ecsMetadataUri = process.env.SLOCK_DRAIN_DETECTOR_DISABLED === "1"
    ? undefined
    : process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (ecsMetadataUri) {
    startDrainCoordinator({
      metadataUri: ecsMetadataUri,
      onDrain: (source) => beginGoingAway("ecs_drain", source),
      onControlPlaneReadiness: (ready, reason) => {
        // Startup diagnostics, not the verdict: IAM is eventually consistent,
        // so the first probes after an apply may fail and then recover. The
        // acceptance reads drain_trigger_source on the drained side.
        console.log(`[Slock] drain_control_plane_ready=${ready}${ready ? "" : ` (${reason instanceof Error ? reason.message : String(reason)})`}`);
        serverTracer.tracer.emitEvent("slock.server.drain_control_plane_ready", { surface: "server", attrs: { drain_control_plane_ready: ready } });
      },
    }).catch((err: unknown) => {
      // Backstop only: startDrainCoordinator is written not to throw. An
      // unobserved rejection here would be the #426 failure shape (a detached
      // promise taking the process down), so it is observed and logged.
      console.warn("[Slock] Drain coordinator failed to start; drain will fall back to SIGTERM:", err);
    });
  }

  // Graceful shutdown — close WebSocket connections before exiting
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[Slock] Shutting down...");
    // Fallback going-away: if the drain detector never fired (no metadata
    // endpoint, or the signal arrived without a drain window), close
    // long-lived connections now so they do not hold `server.close()` open
    // until the deadline.
    beginGoingAway("signal", "sigterm");
    // Already stopped at drain start on the ECS path; this returns the same promise.
    const provisionWorkerStopped = stopBackgroundWorkers();
    shutdownServerRuntime({
      stopAcceptingHttp: () => new Promise<void>((resolve) => {
        server.close((error) => {
          if (error) console.warn("[Slock] Failed to drain HTTP server:", error);
          resolve();
        });
      }),
      settleWorkers: () => provisionWorkerStopped,
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
      // RFC-067: write queued product events and public visitor ids before
      // exit (best effort). Both, or a join's visitor row could be lost while
      // its public_page_server_joined row is kept (Tenny, #9870). Then the
      // last window of their outcome counts goes out with the traces.
      flushTraces: () => flushProductEventsBeforeExit({
        flushRows: () => Promise.allSettled([
          getProductEventSink(app)?.flush(),
          getPublicVisitorSink(app)?.flush(),
        ]),
        shutdownTracer: () => serverTracer.shutdown(),
      }),
      shutdownSharedState: shutdownRedis,
      warn: (message, reason) => console.warn(`[Slock] ${message}:`, reason),
    }).then(() => {
      process.exit(0);
    }).catch((err) => {
      console.warn("[Slock] Failed to complete server shutdown:", err);
      process.exit(0);
    });
    // Bounded exit: long-lived connections were already closed by the
    // going-away phase, so the drain above should settle in milliseconds.
    // The deadline only covers stragglers; it must stay below the ECS task
    // stopTimeout (30s default) or SIGKILL cuts us anyway.
    setTimeout(() => process.exit(0), shutdownDeadlineMs).unref();
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
