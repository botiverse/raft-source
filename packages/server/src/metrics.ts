import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import express from "express";
import type { TraceDeploymentIdentity } from "./tracing/traceDeploymentIdentity";
import { readBuildIdentityStatus, SERVER_VERSION, type BuildIdentityStatus } from "./version";

// Dedicated registry (avoids polluting the global default)
export const register = new Registry();

// `service_version` is the server semver (package.json, bumped with every
// release), the same value traces carry as `service.version`. It lets every
// application metric be split by release, so a deploy can compare the old and
// the new version side by side. One value per process, so it adds no series:
// each task already has its own `service_instance_id`.
const BASE_DEFAULT_LABELS = { app: "slock-server", service_version: SERVER_VERSION };
register.setDefaultLabels(BASE_DEFAULT_LABELS);

export function configureMetricsDeploymentIdentity(identity: TraceDeploymentIdentity) {
  register.setDefaultLabels({
    ...BASE_DEFAULT_LABELS,
    service_instance_id: identity.serviceInstanceId,
    deployment_instance_source: identity.deploymentInstanceSource,
    deployment_identity_state: identity.deploymentIdentityState,
    ...(identity.ecsTaskId ? { ecs_task_id: identity.ecsTaskId } : {}),
  });
}

// Collect default Node.js metrics (event loop lag, heap, GC, active handles)
collectDefaultMetrics({ register, prefix: "slock_" });

/**
 * `git_sha` label value: the release commit from RAFT_RELEASE_SHA, or
 * "unknown" when the build identity is missing or invalid (dev, self-hosted).
 * One value per process, so one series per task.
 */
export function releaseShaLabel(status: BuildIdentityStatus): string {
  return status.ok ? status.identity.sha : "unknown";
}

/**
 * Presence marker for the private application metrics endpoint. `git_sha`
 * lets alert rules count the release commits serving at once
 * (#proj-sre:6e643496: more than two for 15 minutes opens a ticket).
 */
export const appMetricsInfo = new Gauge({
  name: "slock_app_metrics_info",
  help: "Constant 1 when the slock-server private application metrics endpoint is exporting metrics",
  labelNames: ["git_sha"] as const,
  registers: [register],
});
appMetricsInfo.set({ git_sha: releaseShaLabel(readBuildIdentityStatus()) }, 1);

// Labels never include caller-supplied service names or Agent/token identifiers.
// First-party apps' operations (platform/tracing countAppOperation): `app`
// is the app's id, `operation` and `outcome` fixed strings in its code, so
// the series stay bounded.
export const appOperationsTotal = new Counter({
  name: "slock_app_operations_total",
  help: "First-party app operations by app, operation and outcome",
  labelNames: ["app", "operation", "outcome"] as const,
  registers: [register],
});

// Object files (services/objectFiles.ts): each deleted row's bytes, deleted
// (`deleted`) or left for the hourly sweep to try again (`failed`), by who
// tried (`after_commit`: the app's delete, `sweep`).
export const objectFileByteDeletesTotal = new Counter({
  name: "slock_object_file_byte_deletes_total",
  help: "Object file byte deletes by outcome and caller",
  labelNames: ["outcome", "caller"] as const,
  registers: [register],
});

// A Server the platform reviewed for "Require SSO" verified a domain for the first time
// (services/sso/ssoDomains.ts): an operator re-checks it. No labels, so it exists at 0 from start
// and the first increase is visible; which Server and domain is in the audit log.
export const ssoReviewedDomainVerifiedTotal = new Counter({
  name: "slock_sso_reviewed_domain_verified_total",
  help: "Domains verified for the first time by Servers whose Require SSO the platform reviewed",
  registers: [register],
});

export const agentJwtIssuanceCounter = new Counter({
  name: "slock_agent_jwt_issuance_total",
  help: "Agent audience JWT issuance outcomes by registered App and finite reason",
  labelNames: ["client_id", "outcome", "reason"] as const,
  registers: [register],
});

// Which verifier accepted or rejected an `sk_agent_*` key: `hmac` (fast
// path), `argon2` (legacy rows / secret unset / wrong key), or
// `argon2_rehmac` (the stored HMAC was from an older secret; argon2 accepted
// the key and the HMAC was rewritten). Tracks HMAC backfill coverage
// before the argon2 hash can be dropped.
export const agentCredentialVerifyTotal = new Counter({
  name: "slock_agent_credential_verify_total",
  help: "sk_agent_* key verifications by verifier path and outcome",
  labelNames: ["path", "outcome"] as const,
  registers: [register],
});

// Same paths as above for `sk_computer_*` keys on /daemon/connect and
// /internal/computer/*, counted per candidate row verified.
export const computerCredentialVerifyTotal = new Counter({
  name: "slock_computer_credential_verify_total",
  help: "sk_computer_* key verifications by verifier path and outcome",
  labelNames: ["path", "outcome"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Socket.io metrics
// ---------------------------------------------------------------------------

/** Currently connected Socket.io clients */
export const socketConnectedClients = new Gauge({
  name: "slock_socketio_connected_clients",
  help: "Number of currently connected Socket.io clients",
  labelNames: ["transport"] as const,
  registers: [register],
});

/** Total Socket.io disconnections by reason */
export const socketDisconnects = new Counter({
  name: "slock_socketio_disconnects_total",
  help: "Total Socket.io disconnections",
  labelNames: ["reason"] as const,
  registers: [register],
});

/**
 * Notification retractions sent (a conversation was read): `transport` socket
 * (one per conversation, to every client socket of the reader), apns or fcm
 * (background push to a phone it alerted on), with the push `outcome`.
 */
export const notificationRetractsTotal = new Counter({
  name: "slock_notification_retracts_total",
  help: "Notification retractions sent, by transport and outcome",
  labelNames: ["transport", "outcome"] as const,
  registers: [register],
});

/** Total sync:resume attempts and their outcomes */
export const syncResumeTotal = new Counter({
  name: "slock_socketio_sync_resume_total",
  help: "Total sync:resume requests",
  labelNames: ["outcome"] as const, // ok, error, has_more
  registers: [register],
});

// ---------------------------------------------------------------------------
// Redis metrics
// ---------------------------------------------------------------------------

/** Duration of syncMaxSeqFromRedis calls (hottest server→Redis path) */
export const redisSyncDuration = new Histogram({
  name: "slock_redis_sync_duration_seconds",
  help: "Latency of syncMaxSeqFromRedis calls",
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [register],
});

/** Total Redis client errors by client name */
export const redisErrors = new Counter({
  name: "slock_redis_errors_total",
  help: "Total Redis client errors",
  labelNames: ["client"] as const, // redis, redis_pub, redis_sub, redis_replica_sub
  registers: [register],
});

/** Redis connection status per client (1=connected, 0=disconnected) */
export const redisConnected = new Gauge({
  name: "slock_redis_connected",
  help: "Redis connection status (1=connected, 0=disconnected)",
  labelNames: ["client"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// HTTP request metrics
// ---------------------------------------------------------------------------

/**
 * Total HTTP requests observed by the main Express app.
 * Labels intentionally stay low-cardinality so this can be safely expanded on.
 */
export const httpRequestsTotal = new Counter({
  name: "slock_http_requests_total",
  help: "Total HTTP requests handled by the main app",
  labelNames: ["route_pattern", "method", "status_bucket"] as const,
  registers: [register],
});

/**
 * Responses that failed because RisingWave was unavailable: rw_overloaded,
 * rw_unconfigured, rw_read_failed (task #162). They stay 5xx in
 * slock_http_requests_total, so SLO v1 SLI 1 still counts them as unavailable;
 * this counter lets server-bug 5xx alerts subtract them and gives the
 * RisingWave-availability category its own alert. No user or server labels.
 */
export const risingWaveUnavailableResponsesTotal = new Counter({
  name: "slock_risingwave_unavailable_responses_total",
  help: "HTTP responses that failed because RisingWave was unavailable",
  labelNames: ["route_pattern", "code", "retryable"] as const,
  registers: [register],
});

/**
 * Responses served from the last good result because RisingWave was
 * overloaded (routes/rwStaleRead.ts), per surface.
 */
export const risingWaveStaleResponsesTotal = new Counter({
  name: "slock_risingwave_stale_responses_total",
  help: "Responses served from the last good result while RisingWave was overloaded",
  labelNames: ["surface"] as const,
  registers: [register],
});

/** Bodies not remembered by routes/rwStaleRead.ts because they exceeded RW_STALE_MAX_VALUE_BYTES. */
export const risingWaveStaleCacheSkippedTotal = new Counter({
  name: "slock_rw_stale_cache_skipped_total",
  help: "Response bodies too large to remember for the RisingWave stale fallback",
  labelNames: ["surface"] as const,
  registers: [register],
});

/** Size of each body remembered by routes/rwStaleRead.ts, per surface. */
export const risingWaveStaleCacheWriteBytes = new Histogram({
  name: "slock_rw_stale_cache_write_bytes",
  help: "Bytes of each response body remembered for the RisingWave stale fallback",
  labelNames: ["surface"] as const,
  buckets: [512, 2_048, 8_192, 32_768, 131_072, 524_288],
  registers: [register],
});

/**
 * End-to-end request duration for the main Express app.
 * Uses the same low-cardinality labels as request totals.
 * The 2 s bucket is the SLO v1 latency threshold (task #431): "share of /api
 * requests done within 2 s" reads le="2" directly.
 */
export const httpRequestDuration = new Histogram({
  name: "slock_http_request_duration_seconds",
  help: "End-to-end HTTP request duration for the main app",
  labelNames: ["route_pattern", "method", "status_bucket"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10],
  registers: [register],
});

/**
 * SLO v1 SLI 4 (task #431): a message reaches the daemon within 60 s.
 * Counted per pending ack record (one per agent:deliver until it settles), not
 * per send, so 5 s ack retries do not inflate the denominator.
 * online_at_first_attempt: the target machine's socket was open on the
 * tracking replica when the record was created. SLI 4 uses "true" only; a
 * record created after a failed first send ("false") is an offline delivery.
 * Records live in replica memory: one that vanishes in a drain has no outcome,
 * so read SLI 4 as acked-within-60s / tracked, never acked / settled.
 * delivery_kind: "mention" for a tracked @mention (the daemon acks it only once
 * the agent has been told, which can wait for the current turn to end),
 * "plain" otherwise (acked on receipt). Split so the two ack semantics can be
 * read apart (task #432).
 */
export const agentDeliveryTrackedTotal = new Counter({
  name: "slock_agent_delivery_tracked_total",
  help: "Agent deliveries that started waiting for a daemon ack",
  labelNames: ["online_at_first_attempt", "delivery_kind", "daemon_version"] as const,
  registers: [register],
});

/**
 * First send to arrival at the daemon, measured from the record's first
 * attempt. Arrival is the daemon ack, or for a tracked mention the earlier
 * `daemon_pending` transition (the daemon has it and waits for the agent to be
 * told; its ack can wait for the end of the current turn). Observed once per
 * record (task #432).
 */
export const agentDeliveryAckSeconds = new Histogram({
  name: "slock_agent_delivery_ack_seconds",
  help: "Time from first agent:deliver attempt to the daemon ack",
  labelNames: ["online_at_first_attempt", "delivery_kind", "daemon_version"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

/**
 * How each pending ack record ended: acked, gave_up (ack retries exhausted),
 * dropped (retry gate), routed (handed to the owning replica, which tracks it
 * again), terminal (mention terminal error or identity drift), agent_stopped,
 * converted_to_wake (daemon rejected delivery, server started the agent),
 * replica_shutdown, parked_expired (machine stayed offline past the parked
 * max age, 30 min), held_expired (a mention that reached the daemon was not
 * settled within 30 min; its arrival already counted), acked_after_gave_up
 * (the ack arrived within 10 min after this replica gave up: the daemon did
 * get it, so real non-delivery is gave_up minus acked_after_gave_up; an extra
 * event on an already-ended record, so leave it out of sums over outcomes).
 * conn_age (gave_up and dropped only, "n/a" otherwise): age of this replica's
 * connection to the machine when the record failed: "<1h", "1-6h", ">6h",
 * "none" if the machine is not connected here, or "unknown" for a connection
 * without a recorded connect time (hand-built test connections only).
 */
export const agentDeliveryOutcomesTotal = new Counter({
  name: "slock_agent_delivery_outcomes_total",
  help: "Outcomes of agent deliveries waiting for a daemon ack",
  labelNames: ["outcome", "online_at_first_attempt", "delivery_kind", "conn_age", "daemon_version"] as const,
  registers: [register],
});

type AgentDeliveryPendingCounts = Array<{ parked: boolean; daemonVersion: string; count: number }>;
let agentDeliveryPendingProvider: (() => AgentDeliveryPendingCounts) | null = null;

/** The orchestrator registers its pending-ack map here. */
export function provideAgentDeliveryPending(provider: () => AgentDeliveryPendingCounts): void {
  agentDeliveryPendingProvider = provider;
}

/** Detach on shutdown, only if this provider is still the registered one. */
export function releaseAgentDeliveryPending(provider: () => AgentDeliveryPendingCounts): void {
  if (agentDeliveryPendingProvider === provider) agentDeliveryPendingProvider = null;
}

/**
 * Delivery records currently waiting for a daemon ack on this replica, read at
 * scrape time. parked="true" counts records whose machine went offline; they
 * wait for that machine to re-register here and have no timer of their own.
 * Healthy in-flight is a handful; growth with uptime means records without an
 * outcome (their replica_shutdown count is never scraped).
 */
export const agentDeliveryPending = new Gauge({
  name: "slock_agent_delivery_pending",
  help: "Agent deliveries currently waiting for a daemon ack on this replica",
  labelNames: ["parked", "daemon_version"] as const,
  registers: [register],
  collect() {
    // Reset first: a version with no pending records left must not keep its
    // last value; and with no orchestrator attached (released at shutdown)
    // nothing is exported.
    this.reset();
    const counts = agentDeliveryPendingProvider?.();
    if (!counts) return;
    for (const entry of counts) {
      this.set({ parked: String(entry.parked), daemon_version: entry.daemonVersion }, entry.count);
    }
  },
});

/**
 * `daemon_version` label value: the version the daemon reported, "unknown"
 * when none is known yet, "other" when it is not a plain semver-like string
 * (keeps cardinality to real versions). zhiqiang-zhou (#monitoring-alerts:
 * 1ad4e118): daemon-related metrics carry the real version so SLO rules can
 * exclude old daemons and readbacks can group by version.
 */
export function daemonVersionLabel(version: string | null | undefined): string {
  if (!version) return "unknown";
  return /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/.test(version) ? version : "other";
}

/**
 * Machine websocket connections refused by this replica. A refusal never
 * becomes an HTTP request, so it is invisible to the request metrics above.
 * reason="draining": a connection that arrived after the drain started
 * (task #268). Post-deploy readouts report it beside SLO v1 SLI 3.
 */
/**
 * task #365 (RFC 071 terminal-failure breaker, dormant until it is enabled):
 * transitions of the spawn-error pause. `kind`: `spawn_error_counted` (a
 * proven never-created start paused automatic wakes), `retry_dispatched` /
 * `retry_refused` / `retry_error` (the retry sweep re-served a refused wake).
 * How many agents are paused right now is not measured (coverage gap).
 */
export const agentWakePauseTransitionsTotal = new Counter({
  name: "slock_agent_wake_pause_transitions_total",
  help: "Spawn-error wake pause transitions by kind",
  labelNames: ["kind"] as const,
  registers: [register],
});

/**
 * Task #440: cross-replica command routing and the owner lease that backs it.
 * Every label is a closed set (message_type is the protocol's message union).
 */
export const machineCommandRouteTotal = new Counter({
  name: "slock_machine_command_route_total",
  help: "Cross-replica machine command routing attempts by outcome, reason and message type",
  labelNames: ["outcome", "reason", "message_type"] as const,
  registers: [register],
});

export const machineOwnerRefreshTotal = new Counter({
  name: "slock_machine_owner_refresh_total",
  help: "Machine owner lease refreshes by the replica holding the socket, by trigger and result",
  labelNames: ["trigger", "result"] as const,
  registers: [register],
});

/**
 * Task #374: a live machine socket on this replica whose owner-lease refresh is
 * refused while another replica keeps renewing the lease, i.e. the same machine
 * key is connected twice. Counted once per connection. Observation only: no
 * connection is closed because of it yet.
 */
export const machineDuplicateConnectionsTotal = new Counter({
  name: "slock_machine_duplicate_connections_total",
  help: "Machine sockets that keep losing the owner lease to another replica that keeps renewing it, by daemon version",
  labelNames: ["daemon_version"] as const,
  registers: [register],
});

/**
 * Task #374 enforcement (behind SLOCK_MACHINE_DUPLICATE_CONNECTION_ENFORCEMENT):
 * `closed_older` when the refused older socket is closed,
 * `refused_held_handshake` when a new connection is refused with 409 before the
 * upgrade because the winner still holds the key, and `refused_held` when one
 * slips past the handshake and is closed after opening. A refused
 * connection has not sent `ready`, so `daemon_version` on `refused_held` is the
 * version of the connection that was closed as the duplicate (nearly always
 * the one reconnecting).
 */
export const machineDuplicateConnectionActionsTotal = new Counter({
  name: "slock_machine_duplicate_connection_actions_total",
  help: "Duplicate machine connection enforcement: older sockets closed and reconnects refused while the winner holds the key",
  labelNames: ["action", "daemon_version"] as const,
  registers: [register],
});

export const machineConnectionsRefusedTotal = new Counter({
  name: "slock_machine_connections_refused_total",
  help: "Machine websocket connections refused by this replica",
  labelNames: ["reason", "daemon_version"] as const,
  registers: [register],
});

/**
 * Machine websocket connections that ended on this replica, once per
 * connection: the stale or duplicate disconnect that follows for the same
 * socket (e.g. heartbeat_timeout, then socket_close) is not counted. Answers
 * "why does this machine reconnect so often" from AMP; until now the close
 * code was only in a log line that is not kept in full (#440,
 * #proj-o11y:d32a682c). daemon_version is "unknown" when the connection
 * closed before the daemon's `ready` was processed.
 */
export const machineDisconnectsTotal = new Counter({
  name: "slock_machine_disconnects_total",
  help: "Machine websocket connections that ended on this replica, by cause, close code, shutdown reason, daemon version and connection age",
  labelNames: ["cause", "close_code", "shutdown_reason", "daemon_version", "conn_age"] as const,
  registers: [register],
});

/** Websocket close code as a closed label set: the standard 1000–1015, our own 4000–4099, "none" when the socket sent no close, anything else "other". */
export function machineCloseCodeLabel(code: number | undefined): string {
  if (code === undefined) return "none";
  if (Number.isInteger(code) && ((code >= 1000 && code <= 1015) || (code >= 4000 && code <= 4099))) return String(code);
  return "other";
}

/**
 * How long a machine connection lived when it ended. Fine under 10 minutes,
 * where reconnect loops are: a proxy's fixed idle or maximum-connection
 * timeout shows as one bucket standing out (NotZZ saw 30 s, 90 s, 140 s).
 */
export function machineConnectionLifetimeLabel(
  lifetimeMs: number | undefined,
): "unknown" | "<30s" | "30-60s" | "1-2m" | "2-5m" | "5-10m" | "10-60m" | "1-6h" | ">6h" {
  if (lifetimeMs === undefined || !Number.isFinite(lifetimeMs)) return "unknown";
  if (lifetimeMs < 30_000) return "<30s";
  if (lifetimeMs < 60_000) return "30-60s";
  if (lifetimeMs < 120_000) return "1-2m";
  if (lifetimeMs < 300_000) return "2-5m";
  if (lifetimeMs < 600_000) return "5-10m";
  if (lifetimeMs < 3_600_000) return "10-60m";
  if (lifetimeMs < 6 * 3_600_000) return "1-6h";
  return ">6h";
}

/**
 * Raw Slack Events API requests are registered before express.json() so their
 * signature-sensitive body stays byte-for-byte intact. That also puts them
 * before the general request-observability middleware. Keep a dedicated,
 * low-cardinality counter here so an operator can distinguish provider
 * non-delivery from a request rejected before durable ingress without logging
 * the body, signature, token, provider event ID, or internal row IDs.
 *
 * Each request records one `arrival` observation and one terminal observation.
 * `delivery` records only whether Slack retry headers were present; their
 * values are intentionally never labels.
 */
export const slackBridgeIngressObservationsTotal = new Counter({
  name: "slock_slack_bridge_ingress_observations_total",
  help: "Slack Events API ingress observations by closed stage, outcome, and retry-header presence",
  labelNames: ["stage", "outcome", "delivery"] as const,
  registers: [register],
});

// Slack Bridge queues (services/slackBridgeQueueMetrics.ts). Every process
// samples the database once a minute, so read them with max() across
// instances. A pair is one Raft channel and Slack channel, summed over its
// binding generations. Pair status: idle | flowing | waiting (pair-level
// block, e.g. app not in the channel) | stalled (head needs a retry or skip)
// | paused (binding or installation not active, or master switch off).
export const slackBridgeOutboundPairs = new Gauge({
  name: "slock_slack_bridge_outbound_pairs",
  help: "Slack Bridge channel pairs by outbound queue status",
  labelNames: ["status"] as const,
  registers: [register],
});

export const slackBridgeOutboundPendingMessages = new Gauge({
  name: "slock_slack_bridge_outbound_pending_messages",
  help: "Raft messages queued for Slack and not yet sent or skipped, by pair status",
  labelNames: ["status"] as const,
  registers: [register],
});

export const slackBridgeOutboundOldestPendingAgeSeconds = new Gauge({
  name: "slock_slack_bridge_outbound_oldest_pending_age_seconds",
  help: "Age of the oldest Raft message queued for Slack, by pair status",
  labelNames: ["status"] as const,
  registers: [register],
});

// Per pair only for pairs that are waiting, stalled or paused with work, or
// flowing with a head older than five minutes; at most 50 pairs (oldest first).
export const slackBridgeOutboundPairPendingMessages = new Gauge({
  name: "slock_slack_bridge_outbound_pair_pending_messages",
  help: "Raft messages queued for Slack on one unhealthy or slow pair",
  labelNames: ["binding_id", "status"] as const,
  registers: [register],
});

export const slackBridgeOutboundPairOldestPendingAgeSeconds = new Gauge({
  name: "slock_slack_bridge_outbound_pair_oldest_pending_age_seconds",
  help: "Age of the oldest Raft message queued for Slack on one unhealthy or slow pair",
  labelNames: ["binding_id", "status"] as const,
  registers: [register],
});

// Inbound events not yet committed (status: queued | processing), and events
// received in the last 24 hours that ended without a Raft message
// (status: dead | revoked | quarantined).
export const slackBridgeInboundPendingEvents = new Gauge({
  name: "slock_slack_bridge_inbound_pending_events",
  help: "Slack events stored for Raft and not yet committed, by status",
  labelNames: ["status"] as const,
  registers: [register],
});

export const slackBridgeInboundOldestPendingAgeSeconds = new Gauge({
  name: "slock_slack_bridge_inbound_oldest_pending_age_seconds",
  help: "Age of the oldest Slack event stored for Raft and not yet committed, by status",
  labelNames: ["status"] as const,
  registers: [register],
});

// Parser-held raw receipts retain encrypted bodies for replay, but do not
// block subsequent messages in the same conversation.
export const slackBridgeInboundHeldEvents = new Gauge({
  name: "slock_slack_bridge_inbound_held_events",
  help: "Slack ingress events held for a future parser replay",
  registers: [register],
});
export const slackBridgeInboundOldestHeldAgeSeconds = new Gauge({
  name: "slock_slack_bridge_inbound_oldest_held_age_seconds",
  help: "Age since the first parse failure of the oldest held Slack event",
  registers: [register],
});

export const slackBridgeInboundFailedEvents24h = new Gauge({
  name: "slock_slack_bridge_inbound_failed_events_24h",
  help: "Slack events received in the last 24 hours that ended without a Raft message, by status",
  labelNames: ["status"] as const,
  registers: [register],
});

// Worker outcomes per processed head/event. Outbound result: attempted |
// skipped | cursor_recovered | authority_blocked | blocked | lease_reclaimed;
// state is the delivery state after an attempt, the recovered state, the
// authority severity ("control_wait" for an intentional pause or master
// switch), or "none". A drop is result="skipped" or
// result="cursor_recovered",state="skipped". Inbound worker: event |
// attachment; result is the worker's closed result kind.
export const slackBridgeOutboundWorkerResultsTotal = new Counter({
  name: "slock_slack_bridge_outbound_worker_results_total",
  help: "Slack Bridge outbound worker results by closed result and state",
  labelNames: ["result", "state"] as const,
  registers: [register],
});

export const slackBridgeInboundWorkerResultsTotal = new Counter({
  name: "slock_slack_bridge_inbound_worker_results_total",
  help: "Slack Bridge inbound worker results by worker and closed result",
  labelNames: ["worker", "result"] as const,
  registers: [register],
});

// One observation per binding per lifecycle pass: the projected health state
// and closed reason (e.g. backlog_backpressure), "none" when connected.
export const slackBridgeLifecycleHealthObservationsTotal = new Counter({
  name: "slock_slack_bridge_lifecycle_health_observations_total",
  help: "Slack Bridge lifecycle health projections by state and closed reason",
  labelNames: ["state", "reason"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Database pool metrics
// ---------------------------------------------------------------------------

export const dbPoolConnections = new Gauge({
  name: "slock_db_pool_connections",
  help: "PostgreSQL pool connections by pool and state",
  labelNames: ["pool", "state"] as const, // total, idle
  registers: [register],
});

export const dbPoolWaitingRequests = new Gauge({
  name: "slock_db_pool_waiting_requests",
  help: "Requests waiting for a PostgreSQL pool connection",
  labelNames: ["pool"] as const,
  registers: [register],
});

// Time a new connection waited for a connect permit before its handshake
// started (db/connectGate.ts). Most observations are 0; a non-zero tail means
// the per-pool cap on concurrent handshakes delayed requests.
export const dbPoolConnectPermitWait = new Histogram({
  name: "slock_db_pool_connect_permit_wait_seconds",
  help: "Time a new PostgreSQL connection waited for a connect permit",
  labelNames: ["pool"] as const,
  buckets: [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// Background `SELECT 1` once per second per endpoint (db/latencyProbe.ts).
// Buckets are fine below 2 s to match the ~1.4 s Neon pauses and the ~1.6 s
// ceiling on slow queries (task #442). Timeouts and errors are counted
// separately and never observed into the histogram.
export const dbProbeDuration = new Histogram({
  name: "slock_db_probe_duration_seconds",
  help: "Round trip of the background SELECT 1 probe on the primary, by endpoint",
  labelNames: ["endpoint"] as const, // pooled, direct
  buckets: [0.1, 0.25, 0.5, 1, 1.5, 2, 5],
  registers: [register],
});

export const dbProbeTimeoutsTotal = new Counter({
  name: "slock_db_probe_timeouts_total",
  help: "Background SELECT 1 probes that hit the 5 s timeout, by endpoint",
  labelNames: ["endpoint"] as const,
  registers: [register],
});

// Probes that had to open a new connection first (after a failure, or the
// first probe). Their round trip includes TCP + TLS, so they are counted here
// instead of being observed into slock_db_probe_duration_seconds.
export const dbProbeReconnectsTotal = new Counter({
  name: "slock_db_probe_reconnects_total",
  help: "Background SELECT 1 probes that opened a new connection (not observed into the duration histogram), by endpoint",
  labelNames: ["endpoint"] as const,
  registers: [register],
});

export const dbProbeErrorsTotal = new Counter({
  name: "slock_db_probe_errors_total",
  help: "Background SELECT 1 probes that failed other than by timeout, by endpoint",
  labelNames: ["endpoint"] as const,
  registers: [register],
});

// Replication slots on the primary (db/replicationSlotMonitor.ts), read once
// a minute. Every task reports the same slots, so rules use max by (slot_name).
// slot_name is set by operators (RisingWave CDC sources), so it stays bounded.
export const dbReplicationSlotRetainedWalBytes = new Gauge({
  name: "slock_db_replication_slot_retained_wal_bytes",
  help: "WAL the primary keeps for a replication slot (current WAL LSN minus the slot's restart_lsn), in bytes",
  labelNames: ["slot_name", "slot_type"] as const,
  registers: [register],
});

export const dbReplicationSlotActive = new Gauge({
  name: "slock_db_replication_slot_active",
  help: "1 if a consumer is attached to the replication slot, 0 if not",
  labelNames: ["slot_name", "slot_type"] as const,
  registers: [register],
});

// State set: one series per slot with value 1 for its current wal_status
// (reserved, extended, unreserved, lost, or unknown when NULL).
export const dbReplicationSlotWalStatus = new Gauge({
  name: "slock_db_replication_slot_wal_status",
  help: "Current wal_status of the replication slot (value 1 on the series whose wal_status label applies)",
  labelNames: ["slot_name", "slot_type", "wal_status"] as const,
  registers: [register],
});

export const dbReplicationSlotCheckErrorsTotal = new Counter({
  name: "slock_db_replication_slot_check_errors_total",
  help: "Replication slot checks that failed; the slot gauges keep their last values meanwhile",
  registers: [register],
});

export const pgPoolReadOnlyClientRecycledTotal = new Counter({
  name: "slock_pg_pool_read_only_client_recycled_total",
  help: "Postgres pool clients destroyed after SQLSTATE 25006/read-only transaction errors",
  labelNames: ["pool"] as const,
  registers: [register],
});

// Labels stay bounded on purpose: `statement` is the leading SQL keyword class
// (select/insert/update/delete/transaction/unknown), never SQL text or a hash.
// Per-query detail lives in the server.db.connection trace span.
export const dbQueryDuration = new Histogram({
  name: "slock_db_query_duration_seconds",
  help: "PostgreSQL statement round trip by pool and statement kind",
  labelNames: ["pool", "statement"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
  registers: [register],
});

export const dbQueryErrorsTotal = new Counter({
  name: "slock_db_query_errors_total",
  help: "PostgreSQL statement failures by pool and bounded SQLSTATE (57014 = statement timeout or cancel)",
  labelNames: ["pool", "sqlstate"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Read-mutation worker metrics
// ---------------------------------------------------------------------------

/** Fair-worker drain cycles, including otherwise invisible empty polls. */
export const readMutationWorkerDrainsTotal = new Counter({
  name: "slock_read_mutation_worker_drains_total",
  help: "Read-mutation fair-worker drain cycles by closed outcome",
  labelNames: ["outcome"] as const, // empty, processed, failed, error
  registers: [register],
});

/** End-to-end duration of each fair-worker drain cycle. */
export const readMutationWorkerDrainDuration = new Histogram({
  name: "slock_read_mutation_worker_drain_duration_seconds",
  help: "End-to-end duration of read-mutation fair-worker drain cycles",
  labelNames: ["outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

/**
 * Requests from pre-frontier clients for which Done snapshots the current
 * canonical content frontier at admission. This is the retirement signal for
 * the temporary backwards-compatibility branch.
 */
export const legacyDoneFrontierFallbacksTotal = new Counter({
  name: "slock_legacy_done_frontier_fallbacks_total",
  help: "Done admissions that defaulted an omitted frontier to the current canonical latest",
  labelNames: ["target_kind"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Attachment lifecycle / GC metrics
// ---------------------------------------------------------------------------

export const attachmentLifecycleSweepsTotal = new Counter({
  name: "slock_attachment_lifecycle_sweeps_total",
  help: "Attachment lifecycle sweep attempts by closed outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const attachmentLifecycleGcOutcomesTotal = new Counter({
  name: "slock_attachment_lifecycle_gc_outcomes_total",
  help: "Attachment object GC lease outcomes",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const attachmentLifecycleGcJobs = new Gauge({
  name: "slock_attachment_lifecycle_gc_jobs",
  help: "Current attachment object GC jobs by durable state",
  labelNames: ["state"] as const,
  registers: [register],
});

export const attachmentLifecycleGcOldestPendingSeconds = new Gauge({
  name: "slock_attachment_lifecycle_gc_oldest_pending_seconds",
  help: "Age in seconds of the oldest non-completed attachment object GC job",
  registers: [register],
});

// ---------------------------------------------------------------------------
// ScopeDB typed trace-event sink metrics
// ---------------------------------------------------------------------------

/** Whether the direct ScopeDB trace-event sink is enabled for this process. */
export const scopeDbTraceSinkEnabled = new Gauge({
  name: "slock_scopedb_trace_sink_enabled",
  help: "Whether the direct ScopeDB trace-event sink is enabled (1) or disabled (0)",
  registers: [register],
});

/** Number of typed trace rows currently waiting in the direct ScopeDB sink. */
export const scopeDbTraceSinkQueueRows = new Gauge({
  name: "slock_scopedb_trace_sink_queue_rows",
  help: "Typed trace rows currently queued for the direct ScopeDB sink",
  registers: [register],
});

/** Direct ScopeDB sink flush attempts by closed outcome. */
export const scopeDbTraceSinkFlushesTotal = new Counter({
  name: "slock_scopedb_trace_sink_flushes_total",
  help: "Direct ScopeDB trace-event sink flush attempts",
  labelNames: ["outcome"] as const, // success, error
  registers: [register],
});

/** Typed rows accepted by ScopeDB after a successful direct-sink flush. */
export const scopeDbTraceSinkRowsExportedTotal = new Counter({
  name: "slock_scopedb_trace_sink_rows_exported_total",
  help: "Typed trace rows exported successfully by the direct ScopeDB sink",
  registers: [register],
});

/** Typed rows dropped by the direct ScopeDB sink, grouped by a closed reason. */
export const scopeDbTraceSinkRowsDroppedTotal = new Counter({
  name: "slock_scopedb_trace_sink_rows_dropped_total",
  help: "Typed trace rows dropped by the direct ScopeDB sink",
  labelNames: ["reason"] as const, // queue_full, export_error, encode_error, shutdown
  registers: [register],
});

/**
 * Live schema checks the direct ScopeDB sink skipped because the catalog
 * could not be read (unauthorized: 401/403, e.g. a write-only key;
 * catalog_error: timeout/5xx/network). Rows are still written; Append rejects
 * a real mismatch. Counted once per skip window, not per batch.
 */
export const scopeDbTraceSinkSchemaCheckSkippedTotal = new Counter({
  name: "slock_scopedb_trace_sink_schema_check_skipped_total",
  help: "Live schema checks skipped by the direct ScopeDB sink because the catalog could not be read",
  labelNames: ["reason"] as const, // unauthorized, catalog_error
  registers: [register],
});

/** Unix timestamp of the most recent successful direct-sink flush. */
export const scopeDbTraceSinkLastSuccessTimestamp = new Gauge({
  name: "slock_scopedb_trace_sink_last_success_timestamp_seconds",
  help: "Unix timestamp of the most recent successful direct ScopeDB sink flush",
  registers: [register],
});

/** Unix timestamp of the most recent failed direct-sink flush. */
export const scopeDbTraceSinkLastErrorTimestamp = new Gauge({
  name: "slock_scopedb_trace_sink_last_error_timestamp_seconds",
  help: "Unix timestamp of the most recent failed direct ScopeDB sink flush",
  registers: [register],
});

// ---------------------------------------------------------------------------
// S3/R2 storage metrics
// ---------------------------------------------------------------------------

export const s3PutRequestsTotal = new Counter({
  name: "slock_s3_put_requests_total",
  help: "Total S3-compatible storage PutObject attempts",
  labelNames: ["bucket", "endpoint_host", "outcome"] as const,
  registers: [register],
});

export const s3PutDuration = new Histogram({
  name: "slock_s3_put_duration_seconds",
  help: "Latency of S3-compatible storage PutObject calls",
  labelNames: ["bucket", "endpoint_host", "outcome"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// Seconds since each machine of the configured server last heartbeated
// (services/machineLivenessMetrics.ts). Scoped to one server, so about 40
// series per task.
export const machineHeartbeatAgeSeconds = new Gauge({
  name: "slock_machine_heartbeat_age_seconds",
  help: "Seconds since the machine last heartbeated, for machines of MACHINE_LIVENESS_METRICS_SERVER_ID",
  labelNames: ["machine_id"] as const,
  registers: [register],
});

// marketplace_review_outbox (services/marketplaceReviewOutbox.ts): what a
// marketplace review decision still has to tell clients. Every task reads the
// same table every 5 s, so take max() across tasks. The age keeps growing
// from the last oldest row read while reads fail, so a stuck worker or a
// failing read both show as a growing age (alert: docs/raft-app/README.md).
export const marketplaceReviewOutboxOldestUndeliveredAgeSeconds = new Gauge({
  name: "slock_marketplace_review_outbox_oldest_undelivered_age_seconds",
  help: "Age in seconds of the oldest marketplace review side effect not delivered yet (0 when none)",
  registers: [register],
});

export const marketplaceReviewOutboxUndeliveredRows = new Gauge({
  name: "slock_marketplace_review_outbox_undelivered_rows",
  help: "Marketplace review side effects not delivered yet, at the last successful read",
  registers: [register],
});

export const s3SocketPoolSocketsInUse = new Gauge({
  name: "slock_s3_socket_pool_sockets_in_use",
  help: "Busy sockets in the S3-compatible storage HTTP agent",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

export const s3SocketPoolQueueLength = new Gauge({
  name: "slock_s3_socket_pool_queue_length",
  help: "Queued requests waiting for a socket in the S3-compatible storage HTTP agent",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

/**
 * Counts how many times the AWS SDK's @smithy/node-http-handler emitted its own
 * "socket usage at capacity" saturation warning for our S3 client. The SDK
 * fires this once-per-15s when sockets-in-use >= maxSockets AND queued
 * requests >= 2*maxSockets — i.e. the canonical "we are about to start
 * stalling" threshold the SDK author considered alert-worthy. This counter
 * is the dedicated alert signal: spikes mean we are racing the request rate
 * against the pool, regardless of whether each individual PutObject still
 * eventually completes.
 *
 * Per-put gauges (`s3_socket_pool_sockets_in_use` / `_queue_length`) describe
 * point-in-time state; this counter describes incident-threshold crossings.
 *
 * stdrc 2026-05-08 #engineering:dfe362e7 ("把tracing也加上") — observability
 * follow-up to PR #1457's hotfix.
 */
export const s3SocketPoolSaturationTotal = new Counter({
  name: "slock_s3_socket_pool_saturation_total",
  help: "Times the SDK socket pool saturation warning has fired for the S3-compatible storage client",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Metrics HTTP server
// ---------------------------------------------------------------------------

const METRICS_PORT = Number(process.env.METRICS_PORT) || 9091;

export function startMetricsServer() {
  const app = express();

  app.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });

  app.listen(METRICS_PORT, "0.0.0.0", () => {
    console.log(`[Metrics] Prometheus endpoint on :${METRICS_PORT}/metrics`);
  });
}

/**
 * RFC-067 client product events by outcome: written | gated (user or workspace
 * controls) | unconfigured (no product store) | lost (store accepted fewer) |
 * rejected_<reason> (registry, timestamp, malformed body). decision_support:
 * counts are lower bounds.
 */
export const productEventIngestTotal = new Counter({
  name: "slock_product_event_ingest_total",
  help: "RFC-067 client product events by ingest outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});

/** RFC 073 durable tasks: lifecycle events per kind (created, succeeded, retry, needs_attention, fenced). */
export const durableTasksTotal = new Counter({
  name: "slock_durable_tasks_total",
  help: "Durable task lifecycle events by kind and closed outcome",
  labelNames: ["kind", "outcome"] as const,
  registers: [register],
});

/** Open durable tasks per kind, and how many of them are overdue (lease expired, not yet recovered). */
export const durableTasksOpenGauge = new Gauge({
  name: "slock_durable_tasks_open",
  help: "Open durable tasks per kind by lease status",
  labelNames: ["kind", "lease"] as const, // lease: active | overdue
  registers: [register],
});

// Interactive link cards (RFC 076 §5.2): an installation's open operations
// (sent, accepted, unknown, needs_reconciliation), set at admission once it
// passes half its cap of 1,000 and removed again below that, so monitoring
// catches a broken App before it is locked out (AndyLok owns the alert rule).
// Only installations past 500 ever get a series.
export const linkCardOpenOperations = new Gauge({
  name: "slock_link_card_open_operations",
  help: "Open interactive link card operations of an installation past half its cap (link_card.open_operations)",
  labelNames: ["installation_key"] as const,
  registers: [register],
});

// Object Activity (S6; services/objectInboxStates.ts, services/objectActivity.ts).
// The per-(person, object) rows live in Postgres, written with each object
// event and read by one index range per person. Move them into RisingWave
// (an object arm of the inbox chain) when either outgrows Postgres: P99
// fan-out above 1,000 rows per event, or P99 rows per person above 2,000.
// Fan-out is the event's people among its recipients: those it mentions and
// those who follow the object (explicit follows, or by publishing or
// commenting), never everyone who can see it.

/** Activity rows written per object event: its people recipients (agents get none). */
export const objectActivityFanout = new Histogram({
  name: "slock_object_activity_fanout_rows",
  help: "Object Activity rows created or moved per recorded object event (people among its recipients)",
  labelNames: ["object_kind"] as const,
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
  registers: [register],
});

/** One person's Activity rows that a read went over (the list: the server's; the badge: every server asked). */
export const objectActivityRowsPerUser = new Histogram({
  name: "slock_object_activity_rows_per_user",
  help: "Object Activity rows of one person read by the Activity list or the unread badge",
  labelNames: ["surface"] as const, // surface: list | badge
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000],
  registers: [register],
});
