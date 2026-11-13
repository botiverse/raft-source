/**
 * ReplicaRouter: Cross-replica communication layer using Redis pub/sub.
 *
 * Each replica subscribes to its own channel (`replica:{replicaId}`) and a
 * shared broadcast channel (`replica:broadcast`). When a replica needs to send
 * a command to a machine connected on another replica, it publishes to that
 * replica's channel. The receiving replica picks it up and forwards to the
 * local WebSocket connection.
 *
 * Machine→replica mapping is stored in Redis: `machine:{machineId}:replica` → replicaId
 */
import crypto from "node:crypto";
import { MachineResponseRelay, redisMachineReplyStore } from "./machineResponseRelay";
import type Redis from "ioredis";
import { getBoundedRedis, getRedis, getRedisReplicaSub, isRedisAvailable, resetRedisReplicaSub } from "./redis";
import { notifyLocalAgentCredentialRevocation } from "./services/agentCredentialRevocationBus";
import {
  normalizeActivity,
  normalizeActivityDetailKind,
  currentTimeMs,
  setClockInterval,
  setClockTimeout,
  clearClockTimeout,
  noopTracer,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type AgentRuntimeErrorState,
  AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE,
  readAgentContextViewAvailability,
  asAgentContextViewGrantId,
  asAgentContextViewRequestId,
  asMachineId,
  type AgentContextViewAvailabilityMessage,
  type AgentContextViewGrantId,
  type AgentContextViewRequestId,
  type MachineId,
  type ServerToMachineMessage,
  type AgentMessage,
  type AgentStopReason,
  type Tracer,
} from "@botiverse/raft-shared";
import type { PersistedActivityTypedCarriers, PersistedAgentActivity } from "./services/replicaStateStore";
import { normalizeDeliveryConsumptionActivityDiagnostic } from "./services/deliveryConsumptionActivityDiagnostic";
import { normalizeSpawnFailureActivityDiagnostic } from "./services/spawnFailureActivityDiagnostic";
import { normalizeToolStuckActivityDiagnostic } from "./services/toolStuckActivityDiagnostic";
import { normalizeCredentialHoldActivityDiagnostic } from "./services/credentialHoldActivityDiagnostic";
import {
  InMemoryWakeCrashLoopStateStore,
  freshWakeCrashLoopEpisode,
  normalizeWakeCrashLoopActivityDiagnostic,
  type WakeCrashLoopEpisodeState,
  type WakeCrashLoopStateRecord,
} from "./services/wakeCrashLoopBreaker";
import {
  buildRuntimeTraceContext,
  type MachineConnectTraceContext,
} from "./tracing/migrationTraceContext";
import { addTraceEvent, errorClassOf, getCurrentTraceContext, runWithTraceSpan } from "./tracing/semanticTrace";

// Each server instance gets a unique ID
export const REPLICA_ID = crypto.randomUUID();

// Error-system boundary: replica-router failures (dropped receipt-required
// deliveries, subscriber subscribe/health failures) happen on Redis pub/sub
// and cross-replica routing paths with no request trace root, so they exit
// through process-owned root spans via this injected tracer. Never set in
// unit tests → the helper below stays a no-op there.
let _replicaRouterTracer: Tracer | null = null;

export function setReplicaRouterTracer(tracer: Tracer | null): void {
  _replicaRouterTracer = tracer;
}

function traceReplicaRouterError(input: {
  site: string;
  reason: string;
  error: unknown;
  attrs?: Record<string, unknown>;
}): void {
  const tracer = _replicaRouterTracer;
  if (!tracer) return;
  tracer.emitEvent("server.replica_router.error", {
    surface: "server",
    parent: getCurrentTraceContext(),
    attrs: {
      site: input.site,
      outcome: "error",
      reason: input.reason,
      error_class: errorClassOf(input.error),
      ...input.attrs,
    },
  });
}

/**
 * Run one background replica router task in its own root span. The work
 * reports its own failures, so the returned status only picks the span status.
 * It never throws, so callers can start it without waiting.
 */
async function runReplicaRouterRoot(
  name: "server.replica_router.health_check" | "server.replica_router.receipt_delivery",
  attrs: Record<string, string>,
  work: () => Promise<"ok" | "error">,
): Promise<void> {
  const tracer = _replicaRouterTracer ?? noopTracer;
  const span = tracer.startSpan(name, { surface: "server", kind: "internal", attrs });
  try {
    const status = await runWithTraceSpan(span, work, tracer);
    span.end(status);
  } catch (error) {
    console.warn(`[ReplicaRouter] ${name} failed:`, error instanceof Error ? error.message : error);
    span.end("error", { attrs: { error_class: errorClassOf(error) } });
  }
}

// Fly.io instance ID for fly-replay header routing
const FLY_INSTANCE = process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID || null;

type MachineCommandHandler = (machineId: string, message: ServerToMachineMessage) => void;
type InboxDeliveryHandler = (
  agentId: string,
  machineId: string | null,
  message: AgentMessage,
  options: RoutedInboxDeliveryOptions,
) => void;
export type RoutedInboxDeliveryReceipt =
  | { status: "queued"; reason: string }
  | { status: "dropped"; reason: string };
export interface RoutedInboxDeliveryOptions {
  transient?: boolean;
  adminAuthority?: boolean;
  intrinsic?: boolean;
  reconcileNonMemberMention?: boolean;
  mentionDeliveryOccurrenceId?: string;
}
type InboxDeliveryReceiptHandler = (
  agentId: string,
  machineId: string | null,
  message: AgentMessage,
  options: RoutedInboxDeliveryOptions,
) => RoutedInboxDeliveryReceipt | Promise<RoutedInboxDeliveryReceipt>;
type InboxDeliveryReceiptPublisher = (
  replyReplicaId: string,
  requestId: string,
  receipt: RoutedInboxDeliveryReceipt,
) => Promise<void>;
type InboxDeliveryReceiptRouteRuntime = {
  isAvailable: () => boolean;
  getTargetReplica: (machineId: string) => Promise<string | null>;
  publish: (targetReplicaId: string, raw: string) => Promise<number>;
};
type ExternalWakeSignalHandler = (agentId: string) => void;
type MachinePrincipalFenceHandler = (machineId: string, principalKind: "legacy_machine") => void | Promise<void>;

let _machineCommandHandler: MachineCommandHandler | null = null;
let _inboxDeliveryHandler: InboxDeliveryHandler | null = null;
let _inboxDeliveryReceiptHandler: InboxDeliveryReceiptHandler | null = null;
let _inboxDeliveryReceiptPublisherForTests: InboxDeliveryReceiptPublisher | null = null;
let _inboxDeliveryReceiptRouteRuntimeForTests: InboxDeliveryReceiptRouteRuntime | null = null;
let _externalWakeSignalHandler: ExternalWakeSignalHandler | null = null;
let _machinePrincipalFenceHandler: MachinePrincipalFenceHandler | null = null;
/** Agent typing line: "this agent's message landed here" (see publishAgentTypingPosted). */
export type AgentTypingPostedSignal = {
  agentId: string;
  channelId: string | null;
  parentMessageId: string | null;
  target?: string;
};
type AgentTypingPostedHandler = (signal: AgentTypingPostedSignal) => void;
let _agentTypingPostedHandler: AgentTypingPostedHandler | null = null;

/** Why a machine's live connection is being dropped on every replica. */
export const MACHINE_CONNECTION_DROP_REASONS = ["credential_rotated", "credential_revoked"] as const;
export type MachineConnectionDropReason = (typeof MACHINE_CONNECTION_DROP_REASONS)[number];
function isMachineConnectionDropReason(value: unknown): value is MachineConnectionDropReason {
  return typeof value === "string" && (MACHINE_CONNECTION_DROP_REASONS as readonly string[]).includes(value);
}
type MachineConnectionDropHandler = (machineId: string, reason: MachineConnectionDropReason) => void | Promise<void>;
let _machineConnectionDropHandler: MachineConnectionDropHandler | null = null;
let _replicaReplayEndpoint: string | null = null;

// Cross-replica wake signal for EXTERNAL agents (option C, #wg-external-agent
// 2026-06-11): the SSE wake-hint stream listens to an in-process emitter,
// so a fan-out handled by another replica was invisible to a connected
// stream until the 25s heartbeat
// durable peek (#2809). This broadcast carries agentId ONLY (content-free);
// receivers re-emit locally and the stream's flush pulls the agent's durable
// inbox, so duplicate/reordered/lost signals never affect correctness — the
// heartbeat pull remains the correctness floor.
const EXTERNAL_WAKE_CHANNEL = "slock:replica:external-wake";
const MACHINE_PRINCIPAL_FENCE_CHANNEL = "slock:replica:machine-principal-fence";
// Content-free "re-validate this agent's sk_agent_* credentials" broadcast
// (credential revoked / agent deleted). Carries agentId only; receivers make
// their open wake-hint streams re-check the database. See
// services/agentCredentialRevocationBus.ts.
const AGENT_CREDENTIAL_REVOCATION_CHANNEL = "slock:replica:agent-credential-revocation";
// Agent typing line: an agent's message landed in a conversation. The typing
// registry lives on the replica holding the agent's machine socket, which is
// usually not the one that served the send. Ids (and the target as written)
// only; a lost signal just leaves the line to its own end / expiry.
const AGENT_TYPING_POSTED_CHANNEL = "slock:replica:agent-typing-posted";
const MACHINE_CONNECTION_DROP_CHANNEL = "slock:replica:machine-connection-drop";

const MACHINE_REPLICA_TTL = 300; // 5 minutes, refreshed on heartbeat
const STALE_OWNER_CLEANUP_MIN_AGE_MS = 60_000;
const REPLICA_SUBSCRIPTION_HEALTH_INTERVAL_MS = 10_000;
const INBOX_DELIVERY_RECEIPT_TIMEOUT_MS = 3_000;
const CHANNEL_PREFIX = "slock:replica:";
const replicaChannel = (replicaId: string) => `${CHANNEL_PREFIX}${replicaId}`;
export const machineResponseRelay = new MachineResponseRelay(
  REPLICA_ID,
  redisMachineReplyStore(getRedis),
  async (target, requestId) => {
    await getRedis().publish(replicaChannel(target), JSON.stringify({ type: "machine:response:ready", requestId }));
  },
  250,
  isRedisAvailable,
);

const machineReplicaKey = (machineId: string) => `slock:machine:${machineId}:replica`;
const machineFlyKey = (machineId: string) => `slock:machine:${machineId}:fly`;
const machineCohortKey = (machineId: string) => `slock:machine:${machineId}:cohort`;
const machineRequestHostClassKey = (machineId: string) => `slock:machine:${machineId}:request_host_class`;
const machineRequestHostPresentKey = (machineId: string) => `slock:machine:${machineId}:request_host_present`;
const machineReplicaUpdatedAtKey = (machineId: string) => `slock:machine:${machineId}:replica_updated_at`;
const machineReplicaGenerationKey = (machineId: string) => `slock:machine:${machineId}:replica_generation`;
const replicaReplayEndpointKey = (replicaId: string) => `slock:replica:${replicaId}:http`;
const machineStatusVersionKey = (machineId: string) => `slock:machine:${machineId}:status_version`;
const CONDITIONAL_UNREGISTER_MACHINE_LUA = `
  local currentReplica = redis.call("GET", KEYS[1])
  if currentReplica ~= ARGV[1] then
    return 0
  end
  if ARGV[2] ~= "" and redis.call("GET", KEYS[7]) ~= ARGV[2] then
    return 0
  end

  redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7])
  return 1
`;
const CONDITIONAL_CLEAR_MACHINE_OWNER_LUA = `
  local currentReplica = redis.call("GET", KEYS[1])
  if not currentReplica then
    return 2
  end
  if currentReplica ~= ARGV[1] then
    return 0
  end
  local currentUpdatedAt = redis.call("GET", KEYS[6])
  if not currentUpdatedAt then
    return 0
  end
  local currentGeneration = redis.call("GET", KEYS[7]) or ""
  if currentGeneration ~= ARGV[2] then
    return 0
  end
  if currentUpdatedAt ~= ARGV[3] then
    return 0
  end
  if ARGV[4] ~= "" and redis.call("GET", KEYS[8]) ~= ARGV[4] then
    return 0
  end

  redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7])
  return 1
`;
const READ_MACHINE_REPLAY_TARGET_LUA = `
  local ownerReplica = redis.call("GET", KEYS[1])
  if not ownerReplica then
    return {}
  end

  local ownerUpdatedAt = redis.call("GET", KEYS[3])
  if not ownerUpdatedAt then
    return {}
  end
  local ownerGeneration = redis.call("GET", KEYS[2]) or ""

  local endpoint = redis.call("GET", ARGV[2] .. ownerReplica .. ARGV[3])
  return {ownerReplica, endpoint or "", ownerGeneration, ownerUpdatedAt}
`;
const REFRESH_MACHINE_OWNER_LUA = `
  local currentReplica = redis.call("GET", KEYS[1])
  local currentGeneration = redis.call("GET", KEYS[2])
  if currentReplica and (currentReplica ~= ARGV[1] or currentGeneration ~= ARGV[2]) then
    return 0
  end
  if not currentReplica and currentGeneration then
    return 2
  end

  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[8])
  redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[8])
  redis.call("SET", KEYS[3], ARGV[3], "EX", ARGV[8])
  redis.call("SET", KEYS[4], ARGV[4], "EX", ARGV[8])
  redis.call("SET", KEYS[5], ARGV[5], "EX", ARGV[8])
  redis.call("SET", KEYS[6], ARGV[6], "EX", ARGV[8])
  if ARGV[7] ~= "" then
    redis.call("SET", KEYS[7], ARGV[7], "EX", ARGV[8])
  end
  if ARGV[9] ~= "" then
    redis.call("SET", KEYS[8], ARGV[9], "EX", ARGV[8])
  end
  redis.call("EXPIRE", KEYS[9], ARGV[8])
  return 1
`;

type ReceiptRequiredInboxDeliveryMessage = {
  type: "inbox:deliver:receipt" | "inbox:deliver:reconcile-receipt";
  machineId?: string;
  agentId: string;
  requestId: string;
  replyReplicaId: string;
  deliveryOptions?: unknown;
  payload: unknown;
};

/**
 * An operation on an agent, routed to the replica that owns the agent's
 * machine socket so that replica performs it with its own state. The owner is
 * the replica that later checks the daemon's frames (launch guard, session,
 * reset window), so state it did not write itself goes stale: a start prepared
 * elsewhere mints a launchId the owner never saw and the owner drops the new
 * launch's frames as stale_launch_guard; a stop or reset performed elsewhere
 * clears guards and trackers only on the requester.
 */
export interface StartIntentOptions {
  /**
   * An owner on an older build reads an unknown cause as an automatic,
   * non-human start. `internal`: the task #365 spawn-error retry sweep (never
   * routed; see AgentOrchestrator.startAgentForRetry).
   */
  startCause?: "app_inbox_wake" | "start_failure_retry" | "internal";
  resumePrompt?: string;
  wakeMessage?: AgentMessage;
  wakeMessageTransient?: boolean;
  requireQueueReceipt?: boolean;
  /** RFC 071 §5: an explicit human start. An owner on an older build ignores it. */
  control?: "human_start";
}
export type OwnerIntent =
  | { kind: "start"; options: StartIntentOptions }
  /**
   * `daemonReason`: the `agent:stop` reason the owner sends its daemon. An
   * owner on an older build ignores it and sends no reason.
   */
  | { kind: "stop"; reason: "manual" | "internal"; daemonReason?: AgentStopReason }
  /**
   * Reconciler step 11b: push the agent's current config to its daemon. Only
   * the kind crosses Redis: the owner reads the database, builds the config
   * (env vars may hold secrets) and sends it on its own socket. An owner on an
   * older build answers it with no result (START_INTENT_UNANSWERED).
   */
  | { kind: "config" }
  | {
      kind: "reset";
      mode: "restart" | "session" | "full";
      options: {
        restartEvenIfInactive?: boolean;
        restartIfStopped?: boolean;
        /** RFC 071 §5: a human E3 reset or a real runtime-config change. */
        terminalControl?: "human_reset" | "runtime_config_changed";
      };
    };
export interface StartIntentRequest {
  requestId: string;
  machineId: string;
  agentId: string;
  intent: OwnerIntent;
}
export type StartIntentResult =
  | { outcome: "dispatched" }
  | {
    outcome: "skipped";
    reason:
      | "manual_stop"
      | "wake_lock_held"
      | "computer_version_unsupported"
      | "computer_access_revoked"
      | "wake_crash_loop_blocked"
      | "terminal_failure_paused"
      | "terminal_failure_probe_in_flight"
      | "terminal_failure_needs_manual";
  }
  | { outcome: "done" }
  /** A `config` intent: whether the owner sent `agent:config`. */
  | { outcome: "config"; pushed: boolean };
/**
 * The owner answered with neither a result nor a failure: an owner on an
 * older build that does not know the intent's kind (its switch falls through)
 * and therefore ran nothing.
 */
export const START_INTENT_UNANSWERED = "StartIntentUnansweredError";
/** An owner-side failure, carried back so the requester can rethrow it with its original class. */
export interface StartIntentFailure { name: string; message: string; subkind?: string }
export class StartIntentRemoteError extends Error {
  constructor(readonly failure: StartIntentFailure) {
    super(failure.message);
    this.name = failure.name;
  }
}
/** The owner did not answer in time; it may still have run the operation. */
export class StartIntentTimeoutError extends Error {
  constructor() {
    super("Outcome unknown: the machine's replica did not answer in time");
    this.name = "StartIntentTimeoutError";
  }
}
/**
 * The intent could not be sent: Redis is unavailable, or the publish failed.
 * Almost certainly nothing ran, but a publish that fails after the command
 * was written cannot prove that; the owner's wake lock covers that case.
 */
export class StartIntentTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartIntentTransportError";
  }
}
/**
 * Thrown by the receiving replica before it runs anything, when it no longer
 * holds the machine's socket. Crosses the wire by `name`, so the requester can
 * safely look the owner up again.
 */
export const START_INTENT_OWNER_MOVED = "StartIntentOwnerMovedError";
export class StartIntentOwnerMovedError extends Error {
  constructor() {
    super("Intent reached a replica that no longer owns the machine");
    this.name = START_INTENT_OWNER_MOVED;
  }
}
type StartIntentHandler = (request: StartIntentRequest) => Promise<StartIntentResult>;
let _startIntentHandler: StartIntentHandler | null = null;

/**
 * Each replica that can answer routed intents advertises it, so a requester
 * never sends one to a replica still running an older build during a rolling
 * deploy (that replica would ignore it and the requester would time out).
 */
const INTENT_CAPABILITY_TTL_SECONDS = 24 * 60 * 60;
const intentCapabilityKey = (replicaId: string) => `replica-cap:owner-intent:v1:${replicaId}`;
async function advertiseIntentCapability(): Promise<void> {
  if (!_startIntentHandler || !isRedisAvailable()) return;
  try {
    await getRedis().set(intentCapabilityKey(REPLICA_ID), "1", "EX", INTENT_CAPABILITY_TTL_SECONDS);
  } catch (error) {
    console.warn("[ReplicaRouter] Failed to advertise intent capability:", error instanceof Error ? error.message : error);
  }
}
/** Whether `replicaId` has advertised that it answers routed intents. Any error reads as no. */
export async function replicaSupportsOwnerIntents(replicaId: string): Promise<boolean> {
  if (!isRedisAvailable()) return false;
  try {
    return (await getRedis().exists(intentCapabilityKey(replicaId))) === 1;
  } catch {
    return false;
  }
}
const START_INTENT_TIMEOUT_MS = 30_000;
const pendingStartIntents = new Map<string, {
  resolve: (result: StartIntentResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Ask `ownerReplicaId` to run the start. A timeout means the outcome is
 * unknown (the owner may still dispatch), so it is reported as such and never
 * retried here.
 */
export async function routeStartIntent(ownerReplicaId: string, request: StartIntentRequest): Promise<StartIntentResult> {
  if (!isRedisAvailable()) throw new StartIntentTransportError("Start intent transport unavailable");
  return new Promise<StartIntentResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStartIntents.delete(request.requestId);
      reject(new StartIntentTimeoutError());
    }, START_INTENT_TIMEOUT_MS);
    timer.unref?.();
    pendingStartIntents.set(request.requestId, { resolve, reject, timer });
    void getRedis().publish(replicaChannel(ownerReplicaId), JSON.stringify({
      type: "agent:start:intent", request, replyReplicaId: REPLICA_ID,
    })).catch((error) => {
      const pending = pendingStartIntents.get(request.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingStartIntents.delete(request.requestId);
      pending.reject(new StartIntentTransportError(
        `Start intent publish failed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  });
}

async function handleStartIntent(request: StartIntentRequest, replyReplicaId: string): Promise<void> {
  let reply: { result: StartIntentResult } | { failure: StartIntentFailure };
  try {
    if (!_startIntentHandler) throw new Error("Start intent handler unavailable");
    reply = { result: await _startIntentHandler(request) };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const subkind = (err as { subkind?: unknown }).subkind;
    reply = { failure: { name: err.name, message: err.message, ...(typeof subkind === "string" ? { subkind } : {}) } };
  }
  await getRedis().publish(replicaChannel(replyReplicaId), JSON.stringify({
    type: "agent:start:intent:result", requestId: request.requestId, ...reply,
  })).catch((error) => console.error("[ReplicaRouter] Failed to publish start intent result:", error));
}

function settleStartIntent(requestId: string, result?: StartIntentResult, failure?: StartIntentFailure): void {
  const pending = pendingStartIntents.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingStartIntents.delete(requestId);
  const settled = startIntentReply(result, failure);
  if (settled instanceof StartIntentRemoteError) pending.reject(settled);
  else pending.resolve(settled);
}

/** What a requester makes of an owner's reply. Exported for tests. */
export function startIntentReply(result?: StartIntentResult, failure?: StartIntentFailure): StartIntentResult | StartIntentRemoteError {
  if (result && (result.outcome === "dispatched" || result.outcome === "skipped" || result.outcome === "done" || result.outcome === "config")) return result;
  if (failure) return new StartIntentRemoteError(failure);
  return new StartIntentRemoteError(result
    ? { name: "Error", message: "Invalid start intent result" }
    : { name: START_INTENT_UNANSWERED, message: "The owner did not answer this intent (an older build)" });
}

type ReplicaMessage =
  | ({ type: "agent:typing:posted" } & Partial<AgentTypingPostedSignal>)
  | { type: "agent:start:intent"; request: StartIntentRequest; replyReplicaId: string }
  | { type: "agent:start:intent:result"; requestId: string; result?: StartIntentResult; failure?: StartIntentFailure }
  | { type: "machine:response:ready"; requestId: string }
  | {
      type: "machine:command";
      machineId: string;
      payload: unknown;
    }
  | {
      type: "inbox:deliver";
      machineId?: string;
      agentId: string;
      payload: unknown;
      // Added field: older replicas ignore it and keep visibility-checking.
      deliveryOptions?: unknown;
    }
  | ReceiptRequiredInboxDeliveryMessage
  | {
      type: "inbox:receipt";
      requestId: string;
      payload: unknown;
    };

type PendingInboxDeliveryReceipt = {
  resolve: (receipt: RoutedInboxDeliveryReceipt) => void;
  timer: unknown;
};

const pendingInboxDeliveryReceipts = new Map<string, PendingInboxDeliveryReceipt>();

function normalizeInboxDeliveryReceipt(value: unknown): RoutedInboxDeliveryReceipt {
  const candidate = value as { status?: unknown; reason?: unknown } | null;
  if (
    (candidate?.status === "queued" || candidate?.status === "dropped")
    && typeof candidate.reason === "string"
    && candidate.reason.length > 0
  ) {
    return { status: candidate.status, reason: candidate.reason };
  }
  return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
}

function normalizeRoutedInboxDeliveryOptions(value: unknown): RoutedInboxDeliveryOptions {
  const candidate = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    ...(typeof candidate.transient === "boolean" ? { transient: candidate.transient } : {}),
    ...(typeof candidate.adminAuthority === "boolean" ? { adminAuthority: candidate.adminAuthority } : {}),
    ...(typeof candidate.intrinsic === "boolean" ? { intrinsic: candidate.intrinsic } : {}),
    ...(typeof candidate.reconcileNonMemberMention === "boolean"
      ? { reconcileNonMemberMention: candidate.reconcileNonMemberMention }
      : {}),
    ...(typeof candidate.mentionDeliveryOccurrenceId === "string"
      ? { mentionDeliveryOccurrenceId: candidate.mentionDeliveryOccurrenceId }
      : {}),
  };
}

function settlePendingInboxDeliveryReceipt(requestId: string, receipt: RoutedInboxDeliveryReceipt): void {
  const pending = pendingInboxDeliveryReceipts.get(requestId);
  if (!pending) return;
  pendingInboxDeliveryReceipts.delete(requestId);
  clearClockTimeout(pending.timer);
  pending.resolve(receipt);
}

export type MachineCommandRouteReason =
  | "redis_unavailable"
  | "local_owner"
  | "owner_missing"
  | "self_owner"
  | "published"
  | "publish_no_receivers";

export interface MachineCommandRouteResult {
  routed: boolean;
  reason: MachineCommandRouteReason;
  ownerReplicaId?: string;
  ownerReplicaPresent?: boolean;
  ownerReplicaCurrent?: boolean;
  ownerReplicaTtlSeconds?: number;
  ownerReplicaAgeMs?: number;
  ownerCohort?: MachineConnectTraceContext["cohort"];
  ownerRequestHostClass?: MachineConnectTraceContext["requestHostClass"];
  ownerRequestHostPresent?: boolean;
  receiverPresent?: boolean;
  receiverKind?: "local_ws" | "pubsub_subscriber" | "none";
  receiverReplicaCurrent?: boolean;
  publishReceivers?: number;
  staleOwnerCleanupResult?: "deleted" | "mismatch" | "missing" | "not_attempted";
  staleOwnerCleanupReason?: "publish_no_receivers";
}

let _replicaSubscriber: Redis | null = null;
let _replicaSubscriptionHealthTimer: unknown | null = null;

function bindReplicaSubscriber(sub: Redis) {
  if (_replicaSubscriber === sub) return;
  _replicaSubscriber?.off("message", handleReplicaMessage);
  sub.off("message", handleReplicaMessage);
  sub.on("message", handleReplicaMessage);
  _replicaSubscriber = sub;
}

async function getReplicaSubscriberCount(replicaId = REPLICA_ID): Promise<number> {
  const counts = await getRedis().pubsub("NUMSUB", replicaChannel(replicaId));
  const raw = Array.isArray(counts) ? counts[1] : undefined;
  return typeof raw === "number" ? raw : Number(raw) || 0;
}

async function subscribeReplicaRouter(reason: "startup" | "health_check" | "reset_after_unhealthy"): Promise<number> {
  let sub = getRedisReplicaSub();
  bindReplicaSubscriber(sub);
  try {
    await sub.subscribe(replicaChannel(REPLICA_ID), EXTERNAL_WAKE_CHANNEL, MACHINE_PRINCIPAL_FENCE_CHANNEL, AGENT_CREDENTIAL_REVOCATION_CHANNEL, AGENT_TYPING_POSTED_CHANNEL, MACHINE_CONNECTION_DROP_CHANNEL);
  } catch (err) {
    console.warn(
      `[ReplicaRouter] Subscribe failed (${reason}); resetting replica subscriber:`,
      err instanceof Error ? err.message : err,
    );
    traceReplicaRouterError({ site: "subscriber_subscribe", reason: "subscribe_threw", error: err });
    sub = resetRedisReplicaSub();
    bindReplicaSubscriber(sub);
    await sub.subscribe(replicaChannel(REPLICA_ID), EXTERNAL_WAKE_CHANNEL, MACHINE_PRINCIPAL_FENCE_CHANNEL, AGENT_CREDENTIAL_REVOCATION_CHANNEL, AGENT_TYPING_POSTED_CHANNEL, MACHINE_CONNECTION_DROP_CHANNEL);
  }

  const subscriberCount = await getReplicaSubscriberCount();
  if (subscriberCount > 0) return subscriberCount;

  if (reason !== "reset_after_unhealthy") {
    console.warn(`[ReplicaRouter] Replica ${REPLICA_ID.slice(0, 8)} subscriber missing after ${reason}; resetting`);
    sub = resetRedisReplicaSub();
    bindReplicaSubscriber(sub);
    await sub.subscribe(replicaChannel(REPLICA_ID), EXTERNAL_WAKE_CHANNEL, MACHINE_PRINCIPAL_FENCE_CHANNEL, AGENT_CREDENTIAL_REVOCATION_CHANNEL, AGENT_TYPING_POSTED_CHANNEL, MACHINE_CONNECTION_DROP_CHANNEL);
    return getReplicaSubscriberCount();
  }
  return subscriberCount;
}

function startReplicaSubscriptionHealthCheck() {
  if (_replicaSubscriptionHealthTimer || !isRedisAvailable()) return;
  _replicaSubscriptionHealthTimer = setClockInterval(() => {
    if (!isRedisAvailable()) return;
    void runReplicaRouterRoot("server.replica_router.health_check", {}, async () => {
      try {
        await advertiseIntentCapability();
        const subscriberCount = await getReplicaSubscriberCount();
        if (subscriberCount > 0) return "ok";
        const recoveredCount = await subscribeReplicaRouter("health_check");
        if (recoveredCount <= 0) {
          console.error(`[ReplicaRouter] Replica ${REPLICA_ID.slice(0, 8)} subscriber remains missing after reset`);
          return "error";
        }
        return "ok";
      } catch (err) {
        console.warn(
          "[ReplicaRouter] Replica subscriber health check failed:",
          err instanceof Error ? err.message : err,
        );
        traceReplicaRouterError({ site: "subscriber_health_check", reason: "health_check_threw", error: err });
        return "error";
      }
    });
  }, REPLICA_SUBSCRIPTION_HEALTH_INTERVAL_MS);
  if (
    _replicaSubscriptionHealthTimer
    && typeof _replicaSubscriptionHealthTimer === "object"
    && "unref" in _replicaSubscriptionHealthTimer
    && typeof _replicaSubscriptionHealthTimer.unref === "function"
  ) {
    _replicaSubscriptionHealthTimer.unref();
  }
}

/**
 * Initialize the replica router. Call after Redis is initialized.
 * Sets up subscription on this replica's channel for incoming cross-replica commands.
 */
export async function initReplicaRouter(
  onMachineCommand: MachineCommandHandler,
  onInboxDelivery: InboxDeliveryHandler,
  onExternalWakeSignal?: ExternalWakeSignalHandler,
  replicaReplayEndpoint?: string | null,
  onMachinePrincipalFence?: MachinePrincipalFenceHandler,
  onInboxDeliveryReceipt?: InboxDeliveryReceiptHandler,
  onStartIntent?: StartIntentHandler,
) {
  _startIntentHandler = onStartIntent ?? null;
  _machineCommandHandler = onMachineCommand;
  _inboxDeliveryHandler = onInboxDelivery;
  _inboxDeliveryReceiptHandler = onInboxDeliveryReceipt ?? null;
  _externalWakeSignalHandler = onExternalWakeSignal ?? null;
  _machinePrincipalFenceHandler = onMachinePrincipalFence ?? null;
  _replicaReplayEndpoint = normalizeReplicaReplayEndpoint(replicaReplayEndpoint);

  if (!isRedisAvailable()) return;

  // Use the dedicated replica subscriber connection (tracked by redis.ts for shutdown).
  const subscriberCount = await subscribeReplicaRouter("startup");

  if (_replicaReplayEndpoint) {
    await registerReplicaReplayEndpoint(_replicaReplayEndpoint);
  }
  await advertiseIntentCapability();
  startReplicaSubscriptionHealthCheck();

  console.log(`[ReplicaRouter] Replica ${REPLICA_ID.slice(0, 8)} listening (subscribers=${subscriberCount})`);
}

/**
 * Dispatch one raw pub/sub frame. Exported for unit tests (the wire handler
 * is otherwise only reachable through a live Redis subscription).
 */
export function handleReplicaMessage(channel: string, raw: string): void {
  try {
    if (channel === EXTERNAL_WAKE_CHANNEL) {
      const signal = JSON.parse(raw) as { agentId?: string; from?: string };
      // Self-published signals are skipped: the local emit already ran.
      if (signal.agentId && signal.from !== REPLICA_ID && _externalWakeSignalHandler) {
        _externalWakeSignalHandler(signal.agentId);
      }
      return;
    }
    if (channel === AGENT_CREDENTIAL_REVOCATION_CHANNEL) {
      const signal = JSON.parse(raw) as { agentId?: string; from?: string };
      // Self-published signals are skipped: the local notify already ran.
      if (typeof signal.agentId === "string" && signal.agentId && signal.from !== REPLICA_ID) {
        notifyLocalAgentCredentialRevocation(signal.agentId);
      }
      return;
    }
    if (channel === AGENT_TYPING_POSTED_CHANNEL) {
      // The broadcast form, still published by replicas from before targeted
      // routing (rolling deploys). New replicas send to the owner only.
      const signal = JSON.parse(raw) as Partial<AgentTypingPostedSignal> & { from?: string };
      // Self-published signals are skipped: the local end already ran.
      if (signal.from === REPLICA_ID) return;
      handleAgentTypingPostedSignal(signal);
      return;
    }
    if (channel === MACHINE_CONNECTION_DROP_CHANNEL) {
      const signal = JSON.parse(raw) as { machineId?: string; reason?: string; from?: string };
      if (
        typeof signal.machineId === "string"
        && isMachineConnectionDropReason(signal.reason)
        && signal.from !== REPLICA_ID
        && _machineConnectionDropHandler
      ) {
        void _machineConnectionDropHandler(signal.machineId, signal.reason);
      }
      return;
    }
    if (channel === MACHINE_PRINCIPAL_FENCE_CHANNEL) {
      const signal = JSON.parse(raw) as {
        machineId?: string;
        principalKind?: string;
        from?: string;
      };
      if (
        signal.machineId
        && signal.principalKind === "legacy_machine"
        && signal.from !== REPLICA_ID
        && _machinePrincipalFenceHandler
      ) {
        void _machinePrincipalFenceHandler(signal.machineId, signal.principalKind);
      }
      return;
    }
    const msg: ReplicaMessage = JSON.parse(raw);
    if (msg.type === "agent:typing:posted") {
      handleAgentTypingPostedSignal(msg);
    } else if (msg.type === "agent:start:intent" && msg.request && typeof msg.replyReplicaId === "string") {
      void handleStartIntent(msg.request, msg.replyReplicaId);
    } else if (msg.type === "agent:start:intent:result" && typeof msg.requestId === "string") {
      settleStartIntent(msg.requestId, msg.result, msg.failure);
    } else if (msg.type === "machine:response:ready" && typeof msg.requestId === "string") {
      void machineResponseRelay.consume(msg.requestId);
    } else if (msg.type === "machine:command" && msg.machineId && _machineCommandHandler) {
      _machineCommandHandler(msg.machineId, msg.payload as ServerToMachineMessage);
    } else if (msg.type === "inbox:receipt" && typeof msg.requestId === "string") {
      settlePendingInboxDeliveryReceipt(msg.requestId, normalizeInboxDeliveryReceipt(msg.payload));
    } else if (
      (msg.type === "inbox:deliver:receipt" || msg.type === "inbox:deliver:reconcile-receipt")
      && typeof msg.agentId === "string"
      && typeof msg.requestId === "string"
      && typeof msg.replyReplicaId === "string"
    ) {
      void runReplicaRouterRoot(
        "server.replica_router.receipt_delivery",
        { message_type: msg.type, agent_id: msg.agentId },
        () => handleReceiptRequiredInboxDelivery(msg),
      );
    } else if (msg.type === "inbox:deliver" && msg.agentId && _inboxDeliveryHandler) {
      _inboxDeliveryHandler(
        msg.agentId,
        msg.machineId ?? null,
        msg.payload as AgentMessage,
        normalizeRoutedInboxDeliveryOptions(msg.deliveryOptions),
      );
    }
  } catch (err) {
    console.error("[ReplicaRouter] Failed to parse message:", err);
  }
}

async function handleReceiptRequiredInboxDelivery(
  msg: ReceiptRequiredInboxDeliveryMessage,
): Promise<"ok" | "error"> {
  let status: "ok" | "error" = "ok";
  let receipt: RoutedInboxDeliveryReceipt;
  try {
    receipt = _inboxDeliveryReceiptHandler
      ? normalizeInboxDeliveryReceipt(await _inboxDeliveryReceiptHandler(
          msg.agentId,
          msg.machineId ?? null,
          msg.payload as AgentMessage,
          {
            ...normalizeRoutedInboxDeliveryOptions(msg.deliveryOptions),
            ...(msg.type === "inbox:deliver:reconcile-receipt"
              ? { reconcileNonMemberMention: true }
              : {}),
          },
        ))
      : { status: "dropped", reason: "cross_replica_receipt_unavailable" };
  } catch (error) {
    console.error(`[ReplicaRouter] Receipt-required inbox delivery failed for ${msg.agentId}:`, error);
    traceReplicaRouterError({
      site: "receipt_required_delivery",
      reason: "delivery_threw",
      error,
      attrs: { agent_id: msg.agentId },
    });
    receipt = { status: "dropped", reason: "cross_replica_receipt_unavailable" };
    status = "error";
  }

  try {
    if (_inboxDeliveryReceiptPublisherForTests) {
      await _inboxDeliveryReceiptPublisherForTests(msg.replyReplicaId, msg.requestId, receipt);
    } else {
      const response: ReplicaMessage = {
        type: "inbox:receipt",
        requestId: msg.requestId,
        payload: receipt,
      };
      await getRedis().publish(replicaChannel(msg.replyReplicaId), JSON.stringify(response));
    }
  } catch (error) {
    console.error(`[ReplicaRouter] Failed to publish inbox receipt for ${msg.agentId}:`, error);
    traceReplicaRouterError({
      site: "receipt_publish",
      reason: "publish_threw",
      error,
      attrs: { agent_id: msg.agentId },
    });
    status = "error";
  }
  return status;
}

export function __setInboxDeliveryReceiptRuntimeForTests(
  handler: InboxDeliveryReceiptHandler | null,
  publisher: InboxDeliveryReceiptPublisher | null,
): void {
  _inboxDeliveryReceiptHandler = handler;
  _inboxDeliveryReceiptPublisherForTests = publisher;
}

function inboxRouteRuntime(): InboxDeliveryReceiptRouteRuntime {
  return _inboxDeliveryReceiptRouteRuntimeForTests ?? {
    isAvailable: isRedisAvailable,
    getTargetReplica: async (targetMachineId: string) => (
      getRedis().get(machineReplicaKey(targetMachineId))
    ),
    publish: async (targetReplicaId: string, raw: string) => (
      getRedis().publish(replicaChannel(targetReplicaId), raw)
    ),
  };
}

export function __setInboxDeliveryHandlerForTests(handler: InboxDeliveryHandler | null): void {
  _inboxDeliveryHandler = handler;
}

export function __setInboxDeliveryReceiptRouteRuntimeForTests(
  runtime: InboxDeliveryReceiptRouteRuntime | null,
): void {
  _inboxDeliveryReceiptRouteRuntimeForTests = runtime;
}

export function __setExternalWakeSignalHandlerForTests(handler: ((agentId: string) => void) | null): void {
  _externalWakeSignalHandler = handler;
}

export function __setMachinePrincipalFenceHandlerForTests(handler: MachinePrincipalFenceHandler | null): void {
  _machinePrincipalFenceHandler = handler;
}

/**
 * Permanently fence already-authenticated legacy sockets after the adoption
 * CAS. Local delivery closes the same-replica socket synchronously; the
 * content-free broadcast closes matching sockets on every other replica.
 * Computer-principal sockets are never targeted.
 */
export async function fenceMachinePrincipalConnections(
  machineId: string,
  principalKind: "legacy_machine",
): Promise<void> {
  await _machinePrincipalFenceHandler?.(machineId, principalKind);
  if (!isRedisAvailable()) return;
  await getRedis().publish(
    MACHINE_PRINCIPAL_FENCE_CHANNEL,
    JSON.stringify({ machineId, principalKind, from: REPLICA_ID }),
  );
}

export function __setReplicaReplayEndpointForTests(endpoint: string | null): void {
  _replicaReplayEndpoint = normalizeReplicaReplayEndpoint(endpoint);
}

/**
 * Tell every replica (this one synchronously, the others via Redis) that the
 * `sk_agent_*` credentials of `agentId` may have become invalid — a
 * credential was revoked or the agent was deleted. Call AFTER the write has
 * committed: receivers re-validate against the database. Best-effort: if the
 * publish fails, open streams still close at their next heartbeat
 * re-validation.
 */
export async function broadcastAgentCredentialRevocation(agentId: string): Promise<void> {
  notifyLocalAgentCredentialRevocation(agentId);
  if (!isRedisAvailable()) return;
  try {
    await getRedis().publish(AGENT_CREDENTIAL_REVOCATION_CHANNEL, JSON.stringify({ agentId, from: REPLICA_ID }));
  } catch (err) {
    console.error("[ReplicaRouter] Failed to publish agent credential revocation:", err);
  }
}

export function setAgentTypingPostedHandler(handler: AgentTypingPostedHandler | null): void {
  _agentTypingPostedHandler = handler;
}

function handleAgentTypingPostedSignal(signal: Partial<AgentTypingPostedSignal>): void {
  if (!_agentTypingPostedHandler) return;
  if (typeof signal.agentId !== "string" || !signal.agentId) return;
  const channelId = typeof signal.channelId === "string" ? signal.channelId : null;
  const parentMessageId = typeof signal.parentMessageId === "string" ? signal.parentMessageId : null;
  if (!channelId && !parentMessageId) return;
  _agentTypingPostedHandler({
    agentId: signal.agentId,
    channelId,
    parentMessageId,
    ...(typeof signal.target === "string" ? { target: signal.target } : {}),
  });
}

/**
 * Agent typing line: tell the replica holding the agent's machine socket that
 * the agent's message landed, so it closes the agent's lines there and ignores
 * the refreshes that follow. Only that replica holds typing state for the
 * agent, so the signal goes to it alone (fan-out doesn't grow with replicas);
 * nothing is sent when this replica owns the machine (the caller already ended
 * the lines locally) or no replica does (no machine, no live line).
 * Fire-and-forget.
 */
export async function publishAgentTypingPosted(signal: AgentTypingPostedSignal, machineId: string | null): Promise<void> {
  if (!isRedisAvailable() || !machineId) return;
  try {
    const owner = await getMachineReplicaOwner(machineId);
    if (!owner || owner === REPLICA_ID) return;
    const message: ReplicaMessage = { type: "agent:typing:posted", ...signal };
    await getRedis().publish(replicaChannel(owner), JSON.stringify(message));
  } catch (err) {
    console.error("[ReplicaRouter] Failed to send agent typing posted signal:", err);
  }
}

/**
 * Broadcast a content-free external-agent wake signal to all replicas.
 * Fire-and-forget: Redis unavailability or publish failure degrades to the
 * pre-existing behavior (local emit + 25s heartbeat durable peek).
 */
export async function publishExternalWakeSignal(agentId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await getRedis().publish(EXTERNAL_WAKE_CHANNEL, JSON.stringify({ agentId, from: REPLICA_ID }));
  } catch (err) {
    console.error("[ReplicaRouter] Failed to publish external wake signal:", err);
  }
}

/**
 * Register that a machine is connected to THIS replica.
 * Called when a daemon WebSocket connects.
 */
export async function registerMachineReplica(
  machineId: string,
  traceContext: MachineConnectTraceContext = buildRuntimeTraceContext(),
): Promise<string> {
  const generation = crypto.randomUUID();
  await commitMachineReplicaGeneration(machineId, generation, traceContext);
  return generation;
}

/**
 * Reassert a still-live local connection's existing generation after an older
 * in-flight registration overwrote it. Keeping the exact generation lets the
 * orchestrator fence this repair against a concurrent socket replacement.
 */
export async function restoreMachineReplicaGeneration(
  machineId: string,
  generation: string,
  traceContext: MachineConnectTraceContext = buildRuntimeTraceContext(),
): Promise<void> {
  if (!generation) throw new Error("Machine replica generation is required");
  await commitMachineReplicaGeneration(machineId, generation, traceContext);
}

async function commitMachineReplicaGeneration(
  machineId: string,
  generation: string,
  traceContext: MachineConnectTraceContext,
): Promise<void> {
  if (!isRedisAvailable()) {
    throw new Error("Machine replica owner store is unavailable");
  }
  const redis = getRedis();
  const transaction = redis.multi();
  transaction.set(machineReplicaKey(machineId), REPLICA_ID, "EX", MACHINE_REPLICA_TTL);
  transaction.set(machineReplicaGenerationKey(machineId), generation, "EX", MACHINE_REPLICA_TTL);
  transaction.set(machineReplicaUpdatedAtKey(machineId), String(currentTimeMs()), "EX", MACHINE_REPLICA_TTL);
  transaction.set(machineCohortKey(machineId), traceContext.cohort, "EX", MACHINE_REPLICA_TTL);
  transaction.set(machineRequestHostClassKey(machineId), traceContext.requestHostClass, "EX", MACHINE_REPLICA_TTL);
  transaction.set(machineRequestHostPresentKey(machineId), traceContext.requestHostPresent ? "1" : "0", "EX", MACHINE_REPLICA_TTL);
  if (_replicaReplayEndpoint) {
    transaction.set(replicaReplayEndpointKey(REPLICA_ID), _replicaReplayEndpoint, "EX", MACHINE_REPLICA_TTL);
  }
  if (FLY_INSTANCE) {
    transaction.set(machineFlyKey(machineId), FLY_INSTANCE, "EX", MACHINE_REPLICA_TTL);
  }
  assertRedisTransactionSucceeded(await transaction.exec(), "machine owner registration");
}

export type MachineReplicaRefreshResult =
  | "refreshed"
  | "rejected_other_lease"
  | "rejected_residual_generation"
  | "skipped_no_generation"
  | "redis_unavailable";

/**
 * Refresh the machine→replica mapping TTL. Called on each heartbeat pong.
 */
export async function refreshMachineReplica(
  machineId: string,
  traceContext: MachineConnectTraceContext = buildRuntimeTraceContext(),
  expectedGeneration?: string,
): Promise<MachineReplicaRefreshResult> {
  if (!isRedisAvailable()) return "redis_unavailable";
  if (!expectedGeneration) return "skipped_no_generation";
  const result = await getRedis().eval(
    REFRESH_MACHINE_OWNER_LUA,
    9,
    machineReplicaKey(machineId),
    machineReplicaGenerationKey(machineId),
    machineReplicaUpdatedAtKey(machineId),
    machineCohortKey(machineId),
    machineRequestHostClassKey(machineId),
    machineRequestHostPresentKey(machineId),
    replicaReplayEndpointKey(REPLICA_ID),
    machineFlyKey(machineId),
    machineStatusVersionKey(machineId),
    REPLICA_ID,
    expectedGeneration,
    String(currentTimeMs()),
    traceContext.cohort,
    traceContext.requestHostClass,
    traceContext.requestHostPresent ? "1" : "0",
    _replicaReplayEndpoint ?? "",
    String(MACHINE_REPLICA_TTL),
    FLY_INSTANCE ?? "",
  );
  return result === 1 ? "refreshed" : result === 2 ? "rejected_residual_generation" : "rejected_other_lease";
}

function assertRedisTransactionSucceeded(
  result: Array<[Error | null, unknown]> | null,
  operation: string,
): void {
  if (!result) throw new Error(`Redis ${operation} returned no transaction result`);
  const failed = result.find(([error]) => error);
  if (failed?.[0]) throw failed[0];
}

export async function hasMachineReplica(machineId: string): Promise<boolean> {
  if (!isRedisAvailable()) return false;
  const redis = getRedis();
  return !!(await redis.get(machineReplicaKey(machineId)));
}

/** getMachineReplicaOwner for many machines in one round trip (MGET). */
export async function getMachineReplicaOwners(machineIds: readonly string[]): Promise<Map<string, string | null>> {
  const owners = new Map<string, string | null>();
  if (!isRedisAvailable() || machineIds.length === 0) return owners;
  const ids = [...new Set(machineIds)];
  const values = await getRedis().mget(...ids.map(machineReplicaKey));
  ids.forEach((id, index) => owners.set(id, values[index] ?? null));
  return owners;
}

export async function getMachineReplicaOwner(machineId: string): Promise<string | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedis();
  return await redis.get(machineReplicaKey(machineId));
}

/**
 * The daemon behind the current lease, written by the lease holder after a
 * successful refresh (task #374 observation). Only returned when it belongs to
 * the lease's current generation.
 */
export type MachineReplicaInstance = {
  generation: string;
  daemonInstanceId: string | null;
  daemonVersion: string | null;
  /** Short hash of the hostname the daemon reported; a clue, not host identity. */
  reportedHostnameHash?: string | null;
};

export type MachineReplicaLease = {
  replicaId: string | null;
  generation: string | null;
  updatedAtMs: number | null;
  instance?: MachineReplicaInstance | null;
};

const machineReplicaInstanceKey = (machineId: string) => `slock:machine:${machineId}:replica_instance`;

export async function setMachineReplicaInstance(
  machineId: string,
  instance: MachineReplicaInstance,
  ttlSeconds: number = MACHINE_REPLICA_TTL,
): Promise<void> {
  if (!isRedisAvailable()) return;
  await getRedis().set(machineReplicaInstanceKey(machineId), JSON.stringify(instance), "EX", ttlSeconds);
}

function parseMachineReplicaInstance(raw: string | null | undefined, generation: string | null): MachineReplicaInstance | null {
  if (!raw || !generation) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MachineReplicaInstance>;
    if (parsed.generation !== generation) return null;
    return {
      generation,
      daemonInstanceId: typeof parsed.daemonInstanceId === "string" ? parsed.daemonInstanceId : null,
      daemonVersion: typeof parsed.daemonVersion === "string" ? parsed.daemonVersion : null,
      reportedHostnameHash: typeof parsed.reportedHostnameHash === "string" ? parsed.reportedHostnameHash : null,
    };
  } catch {
    return null;
  }
}

/**
 * Who holds the machine's owner lease and when it was last renewed, in one
 * round trip. Task #374: a refresh refused as `rejected_other_lease` is only
 * evidence of a second live connection if this keeps advancing.
 */
export async function getMachineReplicaLease(machineId: string): Promise<MachineReplicaLease | null> {
  if (!isRedisAvailable()) return null;
  const [replicaId, generation, updatedAt, instance] = await getRedis().mget(
    machineReplicaKey(machineId),
    machineReplicaGenerationKey(machineId),
    machineReplicaUpdatedAtKey(machineId),
    machineReplicaInstanceKey(machineId),
  );
  const updatedAtMs = updatedAt === null || updatedAt === undefined ? null : Number(updatedAt);
  return {
    replicaId: replicaId ?? null,
    generation: generation ?? null,
    updatedAtMs: updatedAtMs !== null && Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    instance: parseMachineReplicaInstance(instance, generation ?? null),
  };
}

const machineDuplicateHoldKey = (machineId: string) => `slock:machine:${machineId}:duplicate_hold`;

/** The connection that won a duplicate-connection decision (task #374). */
export type MachineDuplicateHold = {
  replicaId: string;
  generation: string;
  /** Daemon version of the connection closed as the duplicate; labels later refusals. */
  closedDaemonVersion: string | null;
};

/**
 * Task #374: after the older of two live connections for one machine key is
 * closed, the winner is recorded here for every replica. While it still holds
 * the owner lease, a new connection for the machine is refused instead of
 * taking the lease back, so two daemons on one key cannot keep kicking each
 * other off (old daemons do not understand the close code and reconnect).
 */
export async function setMachineDuplicateHold(machineId: string, hold: MachineDuplicateHold, ttlSeconds: number): Promise<void> {
  if (!isRedisAvailable()) return;
  await getRedis().set(machineDuplicateHoldKey(machineId), JSON.stringify(hold), "EX", ttlSeconds);
}

export async function getMachineDuplicateHold(machineId: string): Promise<MachineDuplicateHold | null> {
  if (!isRedisAvailable()) return null;
  const raw = await getRedis().get(machineDuplicateHoldKey(machineId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MachineDuplicateHold>;
    return typeof parsed.replicaId === "string" && typeof parsed.generation === "string"
      ? {
        replicaId: parsed.replicaId,
        generation: parsed.generation,
        closedDaemonVersion: typeof parsed.closedDaemonVersion === "string" ? parsed.closedDaemonVersion : null,
      }
      : null;
  } catch {
    return null;
  }
}

export async function touchMachineDuplicateHold(machineId: string, ttlSeconds: number): Promise<void> {
  if (!isRedisAvailable()) return;
  await getRedis().expire(machineDuplicateHoldKey(machineId), ttlSeconds);
}

export async function getMachineReplicaTraceContext(machineId: string): Promise<Partial<MachineConnectTraceContext> | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedis();
  const [cohort, requestHostClass, requestHostPresent] = await Promise.all([
    redis.get(machineCohortKey(machineId)),
    redis.get(machineRequestHostClassKey(machineId)),
    redis.get(machineRequestHostPresentKey(machineId)),
  ]);
  if (!cohort && !requestHostClass && requestHostPresent === null) return null;
  return {
    cohort: normalizeCohort(cohort),
    requestHostClass: normalizeRequestHostClass(requestHostClass),
    requestHostPresent: requestHostPresent === "1",
  };
}

async function getMachineRouteOwnerDiagnostics(machineId: string): Promise<{
  ownerReplicaId: string | null;
  ownerGeneration?: string;
  ownerVersion?: string;
  ownerReplicaTtlSeconds?: number;
  ownerReplicaAgeMs?: number;
  ownerContext: Partial<MachineConnectTraceContext> | null;
}> {
  if (!isRedisAvailable()) {
    return { ownerReplicaId: null, ownerContext: null };
  }
  const redis = getRedis();
  const [ownerReplicaId, ttlSeconds, updatedAtRaw, generationRaw, ownerContext] = await Promise.all([
    redis.get(machineReplicaKey(machineId)),
    redis.ttl(machineReplicaKey(machineId)),
    redis.get(machineReplicaUpdatedAtKey(machineId)),
    redis.get(machineReplicaGenerationKey(machineId)),
    getMachineReplicaTraceContext(machineId),
  ]);
  const updatedAtMs = updatedAtRaw ? Number(updatedAtRaw) : NaN;
  const ownerReplicaAgeMs = Number.isFinite(updatedAtMs)
    ? Math.max(0, currentTimeMs() - updatedAtMs)
    : undefined;
  return {
    ownerReplicaId,
    ownerGeneration: updatedAtRaw === null ? undefined : generationRaw ?? "",
    ownerVersion: updatedAtRaw ?? undefined,
    ownerReplicaTtlSeconds: ttlSeconds >= 0 ? ttlSeconds : undefined,
    ownerReplicaAgeMs,
    ownerContext,
  };
}

function projectRouteOwnerContext(
  context: Partial<MachineConnectTraceContext> | null | undefined,
): Pick<MachineCommandRouteResult, "ownerCohort" | "ownerRequestHostClass" | "ownerRequestHostPresent"> {
  return {
    ownerCohort: context?.cohort ?? "unknown",
    ownerRequestHostClass: context?.requestHostClass ?? "unknown",
    ownerRequestHostPresent: context?.requestHostPresent ?? false,
  };
}

function normalizeCohort(value: string | null): MachineConnectTraceContext["cohort"] {
  return value === "aws" || value === "fly" || value === "unknown" ? value : "unknown";
}

function normalizeRequestHostClass(value: string | null): MachineConnectTraceContext["requestHostClass"] {
  return value === "api_raft_build" ||
    value === "api_slock_ai" ||
    value === "custom" ||
    value === "direct" ||
    value === "unknown"
    ? value
    : "unknown";
}

export function normalizeReplicaReplayEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function registerReplicaReplayEndpoint(endpoint: string): Promise<void> {
  if (!isRedisAvailable()) return;
  const normalized = normalizeReplicaReplayEndpoint(endpoint);
  if (!normalized) return;
  await getRedis().set(replicaReplayEndpointKey(REPLICA_ID), normalized, "EX", MACHINE_REPLICA_TTL);
}

export async function getReplicaReplayEndpointForMachine(machineId: string): Promise<{ replicaId: string; endpoint: string } | null> {
  const target = await getMachineReplicaReplayTarget(machineId);
  return target?.endpoint && !target.currentReplica
    ? { replicaId: target.replicaId, endpoint: target.endpoint }
    : null;
}

export interface MachineReplicaReplayTarget {
  replicaId: string;
  endpoint: string | null;
  generation: string;
  version: string;
  currentReplica: boolean;
}

/**
 * Read owner and its replay endpoint in one Redis script. A two-command read
 * can otherwise pair the previous owner's id with the next owner's endpoint
 * during a rollout handoff.
 */
export async function getMachineReplicaReplayTarget(machineId: string): Promise<MachineReplicaReplayTarget | null> {
  if (!isRedisAvailable()) return null;
  const result = await getRedis().eval(
    READ_MACHINE_REPLAY_TARGET_LUA,
    3,
    machineReplicaKey(machineId),
    machineReplicaGenerationKey(machineId),
    machineReplicaUpdatedAtKey(machineId),
    REPLICA_ID,
    CHANNEL_PREFIX,
    ":http",
  );
  if (!Array.isArray(result) || typeof result[0] !== "string") return null;
  const replicaId = result[0];
  const endpoint = typeof result[1] === "string" && result[1].length > 0 ? result[1] : null;
  const generation = typeof result[2] === "string" ? result[2] : null;
  const version = typeof result[3] === "string" ? result[3] : null;
  if (generation === null || !version) return null;
  return {
    replicaId,
    endpoint,
    generation,
    version,
    currentReplica: replicaId === REPLICA_ID,
  };
}

export async function bumpMachineStatusVersion(machineId: string): Promise<number> {
  if (!isRedisAvailable()) return 0;
  const redis = getRedis();
  const key = machineStatusVersionKey(machineId);
  const version = await redis.incr(key);
  await redis.expire(key, MACHINE_REPLICA_TTL);
  return version;
}

export async function getMachineStatusVersion(machineId: string): Promise<number> {
  if (!isRedisAvailable()) return 0;
  const redis = getRedis();
  const raw = await redis.get(machineStatusVersionKey(machineId));
  return raw ? Number(raw) || 0 : 0;
}

/**
 * Unregister machine→replica mapping. Called on disconnect.
 */
export async function unregisterMachineReplica(machineId: string, expectedGeneration?: string) {
  if (!isRedisAvailable()) return;
  const redis = getRedis();
  await redis.eval(
    CONDITIONAL_UNREGISTER_MACHINE_LUA,
    7,
    machineReplicaKey(machineId),
    machineFlyKey(machineId),
    machineCohortKey(machineId),
    machineRequestHostClassKey(machineId),
    machineRequestHostPresentKey(machineId),
    machineReplicaUpdatedAtKey(machineId),
    machineReplicaGenerationKey(machineId),
    REPLICA_ID,
    expectedGeneration ?? "",
  );
}

export async function clearMachineReplicaOwnerIfMatches(
  machineId: string,
  expectedReplicaId: string,
  expectedGeneration: string,
  expectedVersion: string,
  expectedEndpoint?: string,
): Promise<"deleted" | "mismatch" | "missing"> {
  if (!isRedisAvailable()) return "missing";
  const result = await getRedis().eval(
    CONDITIONAL_CLEAR_MACHINE_OWNER_LUA,
    8,
    machineReplicaKey(machineId),
    machineFlyKey(machineId),
    machineCohortKey(machineId),
    machineRequestHostClassKey(machineId),
    machineRequestHostPresentKey(machineId),
    machineReplicaUpdatedAtKey(machineId),
    machineReplicaGenerationKey(machineId),
    replicaReplayEndpointKey(expectedReplicaId),
    expectedReplicaId,
    expectedGeneration,
    expectedVersion,
    expectedEndpoint ?? "",
  );
  return result === 1 ? "deleted" : result === 2 ? "missing" : "mismatch";
}

async function maybeCleanupStaleMachineOwner(
  machineId: string,
  targetReplica: string,
  ownerGeneration: string | undefined,
  ownerVersion: string | undefined,
  ownerReplicaAgeMs: number | undefined,
): Promise<MachineCommandRouteResult["staleOwnerCleanupResult"]> {
  if (ownerGeneration === undefined || !ownerVersion || !shouldCleanupStaleMachineOwner(ownerReplicaAgeMs)) {
    return "not_attempted";
  }
  try {
    return await clearMachineReplicaOwnerIfMatches(
      machineId,
      targetReplica,
      ownerGeneration,
      ownerVersion,
    );
  } catch (err) {
    console.warn(
      `[ReplicaRouter] Failed to cleanup stale owner for machine ${machineId}:`,
      err instanceof Error ? err.message : err,
    );
    return "not_attempted";
  }
}

export function shouldCleanupStaleMachineOwner(ownerReplicaAgeMs: number | undefined): boolean {
  return ownerReplicaAgeMs !== undefined && ownerReplicaAgeMs >= STALE_OWNER_CLEANUP_MIN_AGE_MS;
}

/**
 * Send a command to a machine. If the machine is on this replica, returns false
 * (caller should send directly). If on another replica, publishes via Redis and returns true.
 * If machine location is unknown, returns false.
 */
export async function routeMachineCommand(
  machineId: string,
  message: ServerToMachineMessage,
  localMachineIds: Set<string>,
): Promise<boolean> {
  return (await routeMachineCommandWithResult(machineId, message, localMachineIds)).routed;
}

export async function routeMachineCommandWithResult(
  machineId: string,
  message: ServerToMachineMessage,
  localMachineIds: Set<string>,
): Promise<MachineCommandRouteResult> {
  if (!isRedisAvailable()) {
    return {
      routed: false,
      reason: "redis_unavailable",
      ownerReplicaPresent: false,
      ownerReplicaCurrent: false,
      receiverPresent: false,
      receiverKind: "none",
      receiverReplicaCurrent: false,
    };
  }
  if (localMachineIds.has(machineId)) {
    return {
      routed: false,
      reason: "local_owner",
      ownerReplicaId: REPLICA_ID,
      ownerReplicaPresent: true,
      ownerReplicaCurrent: true,
      receiverPresent: true,
      receiverKind: "local_ws",
      receiverReplicaCurrent: true,
      ...projectRouteOwnerContext(buildRuntimeTraceContext()),
    };
  }

  const redis = getRedis();
  const {
    ownerReplicaId: targetReplica,
    ownerGeneration,
    ownerVersion,
    ownerReplicaTtlSeconds,
    ownerReplicaAgeMs,
    ownerContext,
  } = await getMachineRouteOwnerDiagnostics(machineId);
  const ownerReplicaTraceAttrs = {
    ownerReplicaPresent: Boolean(targetReplica),
    ownerReplicaCurrent: targetReplica === REPLICA_ID,
    ...(ownerReplicaTtlSeconds !== undefined ? { ownerReplicaTtlSeconds } : {}),
    ...(ownerReplicaAgeMs !== undefined ? { ownerReplicaAgeMs } : {}),
  };
  if (!targetReplica) {
    return {
      routed: false,
      reason: "owner_missing",
      ...ownerReplicaTraceAttrs,
      receiverPresent: false,
      receiverKind: "none",
      receiverReplicaCurrent: false,
      ...projectRouteOwnerContext(ownerContext),
    };
  }
  if (targetReplica === REPLICA_ID) {
    return {
      routed: false,
      reason: "self_owner",
      ownerReplicaId: targetReplica,
      ...ownerReplicaTraceAttrs,
      receiverPresent: false,
      receiverKind: "none",
      receiverReplicaCurrent: true,
      ...projectRouteOwnerContext(ownerContext ?? buildRuntimeTraceContext()),
    };
  }

  const msg: ReplicaMessage = {
    type: "machine:command",
    machineId,
    payload: message,
  };
  const receivers = await redis.publish(replicaChannel(targetReplica), JSON.stringify(msg));
  const staleOwnerCleanupResult = receivers > 0
    ? undefined
    : await maybeCleanupStaleMachineOwner(
        machineId,
        targetReplica,
        ownerGeneration,
        ownerVersion,
        ownerReplicaAgeMs,
      );
  return {
    routed: receivers > 0,
    reason: receivers > 0 ? "published" : "publish_no_receivers",
    ownerReplicaId: targetReplica,
    ...ownerReplicaTraceAttrs,
    receiverPresent: receivers > 0,
    receiverKind: receivers > 0 ? "pubsub_subscriber" : "none",
    receiverReplicaCurrent: false,
    publishReceivers: receivers,
    ...(staleOwnerCleanupResult !== undefined
      ? {
          staleOwnerCleanupResult,
          staleOwnerCleanupReason: "publish_no_receivers" as const,
        }
      : {}),
    ...projectRouteOwnerContext(ownerContext),
  };
}

/**
 * Route a message to an agent's inbox on the correct replica.
 * Returns true if routed cross-replica, false if should be handled locally.
 */
export async function routeInboxDelivery(
  agentId: string,
  machineId: string | null,
  message: AgentMessage,
  localMachineIds: Set<string>,
  deliveryOptions: RoutedInboxDeliveryOptions = {},
): Promise<boolean> {
  const runtime = inboxRouteRuntime();
  if (!runtime.isAvailable() || !machineId) return false;
  if (localMachineIds.has(machineId)) return false;

  const targetReplica = await runtime.getTargetReplica(machineId);
  if (!targetReplica || targetReplica === REPLICA_ID) return false;

  const msg: ReplicaMessage = {
    type: "inbox:deliver",
    machineId,
    agentId,
    payload: message,
    // Only `intrinsic` changes the owner's gate on this route (it skips the
    // visibility check the sender already skipped).
    ...(deliveryOptions.intrinsic === true ? { deliveryOptions: { intrinsic: true } } : {}),
  };
  await runtime.publish(targetReplica, JSON.stringify(msg));
  return true;
}

export type RoutedInboxDeliveryReceiptResult =
  | { routed: false }
  | { routed: true; receipt: RoutedInboxDeliveryReceipt };

/**
 * Route a strict inbox handoff and wait for the owning replica to report the
 * result of its local delivery path. A Redis publish count is deliberately not
 * treated as acceptance: `queued` is returned only after the target replica
 * has run the delivery gate and accepted the replayable inbox or local wake.
 */
export async function routeInboxDeliveryWithReceipt(
  agentId: string,
  machineId: string | null,
  message: AgentMessage,
  localMachineIds: Set<string>,
  deliveryOptions: RoutedInboxDeliveryOptions = {},
): Promise<RoutedInboxDeliveryReceiptResult> {
  const runtime = inboxRouteRuntime();
  if (!runtime.isAvailable() || !machineId) return { routed: false };
  if (localMachineIds.has(machineId)) return { routed: false };

  let targetReplica: string | null;
  try {
    targetReplica = await runtime.getTargetReplica(machineId);
  } catch (error) {
    console.error(`[ReplicaRouter] Failed to resolve receipt delivery owner for ${agentId}:`, error);
    traceReplicaRouterError({
      site: "receipt_owner_resolve",
      reason: "owner_resolve_threw",
      error,
      attrs: { agent_id: agentId },
    });
    return {
      routed: true,
      receipt: { status: "dropped", reason: "cross_replica_receipt_unavailable" },
    };
  }
  if (!targetReplica || targetReplica === REPLICA_ID) return { routed: false };

  const requestId = crypto.randomUUID();
  const receiptPromise = new Promise<RoutedInboxDeliveryReceipt>((resolve) => {
    const timer = setClockTimeout(() => {
      pendingInboxDeliveryReceipts.delete(requestId);
      resolve({ status: "dropped", reason: "cross_replica_receipt_unavailable" });
    }, INBOX_DELIVERY_RECEIPT_TIMEOUT_MS);
    (timer as ReturnType<typeof setTimeout>).unref?.();
    pendingInboxDeliveryReceipts.set(requestId, { resolve, timer });
  });
  const msg: ReplicaMessage = {
    // Capability reconciliation gets its own wire discriminator. An older
    // target already understands the ordinary receipt request but would drop
    // the new option and false-ack same-seq dedupe as queued. The new type is
    // intentionally unknown to that target, so the source times out/drop
    // instead of claiming an upgrade that never happened.
    type: deliveryOptions.reconcileNonMemberMention === true
      ? "inbox:deliver:reconcile-receipt"
      : "inbox:deliver:receipt",
    machineId,
    agentId,
    requestId,
    replyReplicaId: REPLICA_ID,
    deliveryOptions: normalizeRoutedInboxDeliveryOptions(deliveryOptions),
    payload: message,
  };

  try {
    const receivers = await runtime.publish(targetReplica, JSON.stringify(msg));
    if (receivers <= 0) {
      settlePendingInboxDeliveryReceipt(requestId, {
        status: "dropped",
        reason: "cross_replica_receipt_unavailable",
      });
    }
  } catch (error) {
    console.error(`[ReplicaRouter] Failed to publish receipt-required inbox delivery for ${agentId}:`, error);
    traceReplicaRouterError({
      site: "receipt_route_publish",
      reason: "publish_threw",
      error,
      attrs: { agent_id: agentId },
    });
    settlePendingInboxDeliveryReceipt(requestId, {
      status: "dropped",
      reason: "cross_replica_receipt_unavailable",
    });
  }

  return { routed: true, receipt: await receiptPromise };
}

// --- Distributed lock for agent waking ---

/**
 * Try to acquire a distributed lock for waking an agent.
 * Returns true if lock acquired, false if another replica already holds it.
 * Lock auto-expires after 30 seconds.
 */
export async function acquireWakeLock(agentId: string): Promise<boolean> {
  if (!isRedisAvailable()) return true; // No Redis = single replica, always succeed
  const redis = getRedis();
  const result = await redis.set(`slock:agent:${agentId}:waking`, REPLICA_ID, "EX", 30, "NX");
  return result === "OK";
}

/**
 * Release the wake lock for an agent.
 */
export async function releaseWakeLock(agentId: string) {
  if (!isRedisAvailable()) return;
  const redis = getRedis();
  await redis.del(`slock:agent:${agentId}:waking`);
}

// --- Agent activity & maxSeq in Redis ---

/**
 * Store agent activity in Redis for cross-replica consistency.
 */
/**
 * task #1116: the snapshot is one HSET so a concurrent reader never observes a
 * new detail beside an old carrier (or vice versa). Absent optional fields are
 * written as "" (cleared) in the same command; decode treats "" as absent.
 */
export function buildAgentActivityHashFields(input: {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  observedAtMs?: number;
  carriers?: PersistedActivityTypedCarriers;
  updatedAtMs: number;
}): Record<string, string> {
  return {
    activity: input.activity,
    detail: input.detail,
    detailKind: input.detailKind,
    updatedAt: String(input.updatedAtMs),
    observedAtMs: input.observedAtMs !== undefined ? String(input.observedAtMs) : "",
    carriers: encodeActivityTypedCarriers(input.carriers) ?? "",
  };
}

export async function setAgentActivity(
  agentId: string,
  activity: AgentActivityKind,
  detail: string,
  detailKind: AgentActivityDetailKind,
  observedAtMs?: number,
  carriers?: PersistedActivityTypedCarriers,
) {
  if (!isRedisAvailable()) return;
  const redis = getRedis();
  const key = `slock:agent:${agentId}:activity`;
  const fields = buildAgentActivityHashFields({ activity, detail, detailKind, observedAtMs, carriers, updatedAtMs: Date.now() });
  const pipeline = redis.pipeline();
  pipeline.hset(key, fields);
  pipeline.expire(key, 600); // 10 min TTL
  await pipeline.exec();
}

function encodeActivityTypedCarriers(carriers: PersistedActivityTypedCarriers | undefined): string | null {
  if (!carriers) return null;
  const encoded: PersistedActivityTypedCarriers = {
    ...(carriers.deliveryConsumption ? { deliveryConsumption: carriers.deliveryConsumption } : {}),
    ...(carriers.wakeCrashLoop ? { wakeCrashLoop: carriers.wakeCrashLoop } : {}),
    ...(carriers.spawnFailure ? { spawnFailure: carriers.spawnFailure } : {}),
    ...(carriers.toolStuck ? { toolStuck: carriers.toolStuck } : {}),
    ...(carriers.credentialHold ? { credentialHold: carriers.credentialHold } : {}),
  };
  return Object.keys(encoded).length > 0 ? JSON.stringify(encoded) : null;
}

/**
 * Decode the mirrored carrier field. Each known carrier is run through its
 * normalizer; anything that does not validate is dropped rather than propagated.
 */
export function decodeActivityTypedCarriers(raw: string | undefined): PersistedActivityTypedCarriers | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const carriers: PersistedActivityTypedCarriers = {};
  const deliveryConsumption = normalizeDeliveryConsumptionActivityDiagnostic(
    record.deliveryConsumption as Record<string, unknown> | null | undefined,
  );
  if (deliveryConsumption) carriers.deliveryConsumption = deliveryConsumption;
  const wakeCrashLoop = normalizeWakeCrashLoopActivityDiagnostic(record.wakeCrashLoop);
  if (wakeCrashLoop) carriers.wakeCrashLoop = wakeCrashLoop;
  const spawnFailure = normalizeSpawnFailureActivityDiagnostic(
    record.spawnFailure as Record<string, unknown> | null | undefined,
    { source: "server" },
  );
  if (spawnFailure) carriers.spawnFailure = spawnFailure;
  const toolStuck = normalizeToolStuckActivityDiagnostic(record.toolStuck as Record<string, unknown> | null | undefined);
  if (toolStuck) carriers.toolStuck = toolStuck;
  const credentialHold = normalizeCredentialHoldActivityDiagnostic(record.credentialHold as Record<string, unknown> | null | undefined);
  if (credentialHold) carriers.credentialHold = credentialHold;
  return Object.keys(carriers).length > 0 ? carriers : undefined;
}

export function projectAgentActivityFromRedisHash(data: Record<string, string>): PersistedAgentActivity | null {
  if (!data.activity) return null;
  const observedAtMs = data.observedAtMs ? Number(data.observedAtMs) : NaN;
  const carriers = decodeActivityTypedCarriers(data.carriers);
  return {
    activity: normalizeActivity(data.activity),
    detail: data.detail || "",
    detailKind: normalizeActivityDetailKind(data.detailKind),
    ...(Number.isFinite(observedAtMs) ? { observedAtMs } : {}),
    updatedAt: Number(data.updatedAt) || 0,
    ...(carriers ? { carriers } : {}),
  };
}

/**
 * Get agent activity from Redis.
 */
/** getAgentActivity for many agents in one round trip (pipelined HGETALL). */
export async function getAgentActivities(
  agentIds: readonly string[],
): Promise<Map<string, PersistedAgentActivity | null>> {
  const activities = new Map<string, PersistedAgentActivity | null>();
  if (!isRedisAvailable() || agentIds.length === 0) return activities;
  const ids = [...new Set(agentIds)];
  const pipeline = getRedis().pipeline();
  for (const id of ids) pipeline.hgetall(`slock:agent:${id}:activity`);
  const results = await pipeline.exec();
  ids.forEach((id, index) => {
    const [error, data] = results?.[index] ?? [null, null];
    if (error) throw error;
    activities.set(id, projectAgentActivityFromRedisHash((data ?? {}) as Record<string, string>));
  });
  return activities;
}

export async function getAgentActivity(
  agentId: string,
): Promise<PersistedAgentActivity | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedis();
  const data = await redis.hgetall(`slock:agent:${agentId}:activity`);
  return projectAgentActivityFromRedisHash(data);
}

// --- Wake crash-loop breaker state in Redis (task #1119) ---

export const wakeCrashLoopKey = (agentId: string) => `slock:agent:${agentId}:wake_crash_loop`;
/**
 * A blocked episode must survive until a human start/resume clears it, so a
 * blocked record has no TTL. An unblocked streak is only meaningful while the
 * agent keeps being restarted; it expires after 7 days of no writes.
 */
export const WAKE_CRASH_LOOP_UNBLOCKED_TTL_SEC = 7 * 86_400;

/**
 * KEYS[1] = hash {version, state}; ARGV[1] = expected version ("0" when absent);
 * ARGV[2] = state JSON; ARGV[3] = ttl seconds ("0" = persist).
 * Writes only when the stored version equals the expected one; returns 1/0.
 */
export const CAS_WAKE_CRASH_LOOP_LUA = `
local current = redis.call('HGET', KEYS[1], 'version')
if current == false then current = '0' end
if current ~= ARGV[1] then return 0 end
local next = tonumber(current) + 1
redis.call('HSET', KEYS[1], 'version', tostring(next), 'state', ARGV[2])
if tonumber(ARGV[3]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
else
  redis.call('PERSIST', KEYS[1])
end
return 1
`;

/** No-Redis fallback: a single replica keeps the state in-process (still CAS-shaped). */
export const localWakeCrashLoopStateStore = new InMemoryWakeCrashLoopStateStore();

const WAKE_CRASH_LOOP_EXIT_KINDS_PERSISTED: ReadonlySet<string> = new Set(["machine_disconnected", "agent_process_exited"]);

export interface DecodedWakeCrashLoopState {
  /**
   * `Required`: the decoder must produce every field the state type declares,
   * optional ones included, so a field added to the type without a decode step
   * is a type error here instead of a value that silently vanishes on the
   * Redis read (RFC 071 F1: the task #1221 fields were written but not read).
   */
  state: Required<WakeCrashLoopEpisodeState>;
  /** Fields the stored record did not carry in a valid shape; empty when the record was whole. */
  repaired: string[];
}

function finiteOrNull(record: Record<string, unknown>, key: string, repaired: string[]): number | null {
  const value = record[key];
  if (value === null || value === undefined) { if (value === undefined) repaired.push(key); return null; }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  repaired.push(key);
  return null;
}

function stringOrNull(record: Record<string, unknown>, key: string, repaired: string[]): string | null {
  const value = record[key];
  if (value === null || value === undefined) { if (value === undefined) repaired.push(key); return null; }
  if (typeof value === "string" && value.length <= 128) return value;
  repaired.push(key);
  return null;
}

/** Optional field (added after the first records were written): absent is legal and means null. */
function optionalStringOrNull(record: Record<string, unknown>, key: string, repaired: string[]): string | null {
  return record[key] === undefined ? null : stringOrNull(record, key, repaired);
}

/** Optional count: absent is legal and means 0; anything but a non-negative integer is repaired to 0. */
function optionalNonNegativeInt(record: Record<string, unknown>, key: string, repaired: string[]): number {
  const value = record[key];
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  repaired.push(key);
  return 0;
}

/** Optional flag: absent is legal and means false; a non-boolean is repaired to false. */
function optionalBoolean(record: Record<string, unknown>, key: string, repaired: string[]): boolean {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  repaired.push(key);
  return false;
}

/** The Redis write form of an episode; `decodeWakeCrashLoopState` is its inverse. */
export function encodeWakeCrashLoopState(state: WakeCrashLoopEpisodeState): string {
  return JSON.stringify(state);
}

/**
 * Decode a persisted crash-loop episode. Every field is checked against the
 * shape `WakeCrashLoopEpisodeState` declares; the breaker does arithmetic on
 * the times and branches on the booleans, so an unchecked field would flow
 * into a time comparison as a string or a truthy "false" (task audit,
 * skyzh 2026-09-15). A field that is missing or has the wrong type is
 * replaced by its neutral value (null / false) and named in `repaired`, so
 * the record stays readable and the CAS version is preserved. Legal nulls are
 * legal. The three core fields decide whether the record is a state at all:
 * `blocked === true` is always honoured — a damaged blocked record is never
 * turned into an unblocked one by decoding — and an unreadable core yields
 * null, which the reader reports rather than silently treating as fresh.
 */
export function decodeWakeCrashLoopState(raw: unknown): DecodedWakeCrashLoopState | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.blocked !== "boolean") return null;
  const repaired: string[] = [];
  const episode = typeof record.episode === "number" && Number.isInteger(record.episode) && record.episode >= 1 ? record.episode : null;
  const earlyExitCount = typeof record.earlyExitCount === "number" && Number.isInteger(record.earlyExitCount) && record.earlyExitCount >= 0
    ? record.earlyExitCount
    : null;
  if (episode === null || earlyExitCount === null) {
    // The counters are unreadable. Only a blocked record is worth keeping:
    // the block must survive until a human start clears it. An unblocked
    // record with broken counters carries nothing the breaker can use.
    if (!record.blocked) return null;
    if (episode === null) repaired.push("episode");
    if (earlyExitCount === null) repaired.push("earlyExitCount");
  }
  const lastStartCounted = typeof record.lastStartCounted === "boolean" ? record.lastStartCounted : (repaired.push("lastStartCounted"), false);
  const lastExitKindRaw = record.lastExitKind;
  let lastExitKind: WakeCrashLoopEpisodeState["lastExitKind"] = null;
  if (lastExitKindRaw === undefined || (lastExitKindRaw !== null && !(typeof lastExitKindRaw === "string" && WAKE_CRASH_LOOP_EXIT_KINDS_PERSISTED.has(lastExitKindRaw)))) {
    repaired.push("lastExitKind");
  } else {
    lastExitKind = lastExitKindRaw as WakeCrashLoopEpisodeState["lastExitKind"];
  }
  const state: Required<WakeCrashLoopEpisodeState> = {
    episode: episode ?? 1,
    earlyExitCount: earlyExitCount ?? 0,
    blocked: record.blocked,
    blockedAtMs: finiteOrNull(record, "blockedAtMs", repaired),
    lastStartAtMs: finiteOrNull(record, "lastStartAtMs", repaired),
    lastStartLaunchId: stringOrNull(record, "lastStartLaunchId", repaired),
    lastStartCounted,
    firstExitAtMs: finiteOrNull(record, "firstExitAtMs", repaired),
    lastExitAtMs: finiteOrNull(record, "lastExitAtMs", repaired),
    lastExitKind,
    lastSignal: stringOrNull(record, "lastSignal", repaired),
    lastLaunchId: stringOrNull(record, "lastLaunchId", repaired),
    // task #1221 fields. Records written before them lack them; absent is not a repair.
    needsActionReason: optionalStringOrNull(record, "needsActionReason", repaired),
    catchupOwed: optionalBoolean(record, "catchupOwed", repaired),
    catchupCarriedLaunchId: optionalStringOrNull(record, "catchupCarriedLaunchId", repaired),
    // Start-failure streak fields; absent on older records, which is not a repair.
    startFailureCount: optionalNonNegativeInt(record, "startFailureCount", repaired),
    lastStartFailureReason: optionalStringOrNull(record, "lastStartFailureReason", repaired),
    lastStartFailureLaunchId: optionalStringOrNull(record, "lastStartFailureLaunchId", repaired),
    retryAfterMs: record.retryAfterMs === undefined ? null : finiteOrNull(record, "retryAfterMs", repaired),
    // task #365 fields; absent on older records, which is not a repair.
    startFailureOwnedLaunchId: optionalStringOrNull(record, "startFailureOwnedLaunchId", repaired),
    blockedByLaunchId: optionalStringOrNull(record, "blockedByLaunchId", repaired),
    // Needs-action notice dedupe; absent on older records, which is not a repair.
    actionRequiredNotifiedFingerprint: optionalStringOrNull(record, "actionRequiredNotifiedFingerprint", repaired),
    // Self-retrying pause; absent on older records, which is not a repair.
    pauseRetryAtMs: record.pauseRetryAtMs === undefined ? null : finiteOrNull(record, "pauseRetryAtMs", repaired),
    pauseRetryCooldownMs: record.pauseRetryCooldownMs === undefined ? null : finiteOrNull(record, "pauseRetryCooldownMs", repaired),
    pauseRetryLaunchId: optionalStringOrNull(record, "pauseRetryLaunchId", repaired),
    // Reconciler step 12: the ready try of a self-retrying pause; absent on older records, which is not a repair.
    pauseRetryReadyLaunchId: optionalStringOrNull(record, "pauseRetryReadyLaunchId", repaired),
    pauseRetryReadyCooldownMs: record.pauseRetryReadyCooldownMs === undefined ? null : finiteOrNull(record, "pauseRetryReadyCooldownMs", repaired),
    // Reconciler step 12 follow-up: the owner was told the tries reached the cap; absent on older records (= not told), which is not a repair.
    pauseRetryCapNotified: optionalBoolean(record, "pauseRetryCapNotified", repaired),
  };
  return { state, repaired };
}

export async function getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null> {
  if (!isRedisAvailable()) return localWakeCrashLoopStateStore.getWakeCrashLoopState(agentId);
  const data = await getRedis().hgetall(wakeCrashLoopKey(agentId));
  if (data.state === undefined && data.version === undefined) return null;
  const version = Number(data.version);
  const decoded = decodeWakeCrashLoopState(data.state);
  if (!Number.isInteger(version) || version <= 0 || !decoded) {
    // A record exists but cannot be read as an episode. Say so; the breaker
    // then starts from a fresh episode at this version instead of looping on
    // a compare-and-set against version 0.
    console.warn(`[ReplicaRouter] wake crash-loop state for agent ${agentId} is unreadable (version=${String(data.version)}); treating as fresh`);
    return Number.isInteger(version) && version > 0 ? { state: freshWakeCrashLoopEpisode(1), version } : null;
  }
  if (decoded.repaired.length > 0) {
    console.warn(`[ReplicaRouter] wake crash-loop state for agent ${agentId} repaired on read: ${decoded.repaired.join(", ")}${decoded.state.blocked ? " (blocked preserved)" : ""}`);
  }
  return { state: decoded.state, version };
}

export async function compareAndSetWakeCrashLoopState(
  agentId: string,
  expectedVersion: number,
  state: WakeCrashLoopEpisodeState,
): Promise<boolean> {
  if (!isRedisAvailable()) return localWakeCrashLoopStateStore.compareAndSetWakeCrashLoopState(agentId, expectedVersion, state);
  const result = await getRedis().eval(
    CAS_WAKE_CRASH_LOOP_LUA,
    1,
    wakeCrashLoopKey(agentId),
    String(expectedVersion),
    encodeWakeCrashLoopState(state),
    String(state.blocked ? 0 : WAKE_CRASH_LOOP_UNBLOCKED_TTL_SEC),
  );
  return result === 1;
}

// --- Agent runtime errors in Redis ---

const AGENT_RUNTIME_ERROR_TTL_SEC = 86_400;
const agentRuntimeErrorKey = (agentId: string) => `slock:agent:${agentId}:runtime_error`;

export interface AgentRuntimeErrorMirror {
  error: AgentRuntimeErrorState | null;
  fingerprint: string;
  updatedAt: number;
}

/**
 * Stable content identity for the runtime-error authority record. The tuple is
 * deliberately limited to the daemon-observed identity fields from the Phase 1
 * contract; `actionRequired` remains payload, not generation identity.
 */
export function fingerprintAgentRuntimeError(error: AgentRuntimeErrorState | null): string {
  return JSON.stringify(error
    ? [error.message, error.at, error.launchId ?? null]
    : [null, null, null]);
}

export function projectAgentRuntimeErrorFromRedisHash(
  data: Record<string, string>,
): AgentRuntimeErrorMirror | null {
  if (data.state !== "error" && data.state !== "clear") return null;

  if (data.state === "clear") {
    const fingerprint = fingerprintAgentRuntimeError(null);
    if (data.fingerprint !== fingerprint) return null;
    return {
      error: null,
      fingerprint,
      updatedAt: Number(data.updatedAt) || 0,
    };
  }

  if (!data.message || !data.at) return null;
  const error: AgentRuntimeErrorState = {
    message: data.message,
    at: data.at,
    ...(data.launchId ? { launchId: data.launchId } : {}),
    actionRequired: data.actionRequired !== "0",
  };
  const fingerprint = fingerprintAgentRuntimeError(error);
  if (data.fingerprint !== fingerprint) return null;
  return {
    error,
    fingerprint,
    updatedAt: Number(data.updatedAt) || 0,
  };
}

/**
 * Mirror the persisted runtime-error field into Redis. Clears are explicit
 * tombstones rather than key deletion, so replicas can distinguish an
 * authoritative clear from a pre-rollout/missing mirror and cannot resurrect a
 * process-local stale error.
 */
export async function setAgentRuntimeError(
  agentId: string,
  error: AgentRuntimeErrorState | null,
): Promise<void> {
  if (!isRedisAvailable()) return;
  const redis = getRedis();
  const key = agentRuntimeErrorKey(agentId);
  const fingerprint = fingerprintAgentRuntimeError(error);
  const pipeline = redis.pipeline();
  pipeline.hset(
    key,
    "state",
    error ? "error" : "clear",
    "fingerprint",
    fingerprint,
    "updatedAt",
    String(currentTimeMs()),
  );
  if (error) {
    pipeline.hset(
      key,
      "message",
      error.message,
      "at",
      error.at,
      "actionRequired",
      error.actionRequired ? "1" : "0",
    );
    if (error.launchId) {
      pipeline.hset(key, "launchId", error.launchId);
    } else {
      pipeline.hdel(key, "launchId");
    }
  } else {
    pipeline.hdel(key, "message", "at", "launchId", "actionRequired");
  }
  pipeline.expire(key, AGENT_RUNTIME_ERROR_TTL_SEC);
  await pipeline.exec();
}

/** getAgentRuntimeError for many agents in one round trip (pipelined HGETALL). */
export async function getAgentRuntimeErrors(
  agentIds: readonly string[],
): Promise<Map<string, AgentRuntimeErrorMirror | null>> {
  const mirrors = new Map<string, AgentRuntimeErrorMirror | null>();
  if (!isRedisAvailable() || agentIds.length === 0) return mirrors;
  const ids = [...new Set(agentIds)];
  const pipeline = getRedis().pipeline();
  for (const id of ids) pipeline.hgetall(agentRuntimeErrorKey(id));
  const results = await pipeline.exec();
  ids.forEach((id, index) => {
    const [error, data] = results?.[index] ?? [null, null];
    if (error) throw error;
    mirrors.set(id, projectAgentRuntimeErrorFromRedisHash((data ?? {}) as Record<string, string>));
  });
  return mirrors;
}

export async function getAgentRuntimeError(agentId: string): Promise<AgentRuntimeErrorMirror | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedis();
  return projectAgentRuntimeErrorFromRedisHash(await redis.hgetall(agentRuntimeErrorKey(agentId)));
}

// --- Agent View Context availability in Redis ---

const AGENT_CONTEXT_VIEW_AVAILABILITY_TTL_SEC = 7 * 86_400;
const agentContextViewAvailabilityKey = (agentId: string) => `slock:agent:${agentId}:context_view`;

/**
 * The latest `agent:context_view_availability` report for an agent and the
 * Computer that sent it. A reader ignores a record from a machine other than
 * the agent's current one, so a move or unbind needs no clear.
 */
export interface AgentContextViewAvailabilityRecord {
  machineId: string;
  report: Omit<AgentContextViewAvailabilityMessage, "type">;
  /** ISO 8601, when the Server received the report. */
  receivedAt: string;
}

/** Stored JSON back to a record; anything malformed (or a report the parser now refuses) reads as none. */
export function parseAgentContextViewAvailabilityRecord(raw: string | null | undefined): AgentContextViewAvailabilityRecord | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { machineId, report, receivedAt } = value as Record<string, unknown>;
  if (typeof machineId !== "string" || !machineId || typeof receivedAt !== "string" || !report || typeof report !== "object") return null;
  const parsed = readAgentContextViewAvailability({ ...report, type: AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE });
  if (!parsed) return null;
  const { type: _type, ...rest } = parsed;
  return { machineId, report: rest, receivedAt };
}

/** No-Redis fallback: a single replica keeps the records in-process, with the same TTL. */
const localAgentContextViewAvailability = new Map<string, { raw: string; expiresAtMs: number }>();

/** Store the latest report for an agent; every write refreshes the 7-day TTL. */
export async function setAgentContextViewAvailability(agentId: string, record: AgentContextViewAvailabilityRecord): Promise<void> {
  const raw = JSON.stringify(record);
  if (!isRedisAvailable()) {
    localAgentContextViewAvailability.set(agentId, { raw, expiresAtMs: currentTimeMs() + AGENT_CONTEXT_VIEW_AVAILABILITY_TTL_SEC * 1000 });
    return;
  }
  await getRedis().set(agentContextViewAvailabilityKey(agentId), raw, "EX", AGENT_CONTEXT_VIEW_AVAILABILITY_TTL_SEC);
}

export async function getAgentContextViewAvailability(agentId: string): Promise<AgentContextViewAvailabilityRecord | null> {
  if (!isRedisAvailable()) {
    const local = localAgentContextViewAvailability.get(agentId);
    if (!local) return null;
    if (local.expiresAtMs <= currentTimeMs()) {
      localAgentContextViewAvailability.delete(agentId);
      return null;
    }
    return parseAgentContextViewAvailabilityRecord(local.raw);
  }
  return parseAgentContextViewAvailabilityRecord(await getRedis().get(agentContextViewAvailabilityKey(agentId)));
}

export async function clearAgentContextViewAvailability(agentId: string): Promise<void> {
  if (!isRedisAvailable()) {
    localAgentContextViewAvailability.delete(agentId);
    return;
  }
  await getRedis().del(agentContextViewAvailabilityKey(agentId));
}

// --- Reconciler step 13 F9: the last ready owed wake per agent ---
//
// When a daemon `ready` last dispatched an owed wake for the agent (epoch ms),
// shared by every replica so a daemon that reconnects to another replica does
// not wake the agent again for the same messages. Written only for a
// dispatched start; expires after 24 h, the owed wake's own time floor.

const READY_OWED_WAKE_TTL_SEC = 24 * 60 * 60;
export const readyOwedWakeKey = (agentId: string) => `slock:agent:${agentId}:ready_owed_wake_at`;

/** No-Redis fallback: a single replica keeps the marks in-process, with the same TTL. */
const localReadyOwedWakes = new Map<string, { atMs: number; expiresAtMs: number }>();

export async function setReadyOwedWakeAt(agentId: string, atMs: number): Promise<void> {
  if (!isRedisAvailable()) {
    localReadyOwedWakes.set(agentId, { atMs, expiresAtMs: currentTimeMs() + READY_OWED_WAKE_TTL_SEC * 1000 });
    return;
  }
  await getRedis().set(readyOwedWakeKey(agentId), String(atMs), "EX", READY_OWED_WAKE_TTL_SEC);
}

/** Null when there is none (or it expired, or is malformed). Throws when Redis cannot be read. */
export async function getReadyOwedWakeAt(agentId: string): Promise<number | null> {
  if (!isRedisAvailable()) {
    const local = localReadyOwedWakes.get(agentId);
    if (!local) return null;
    if (local.expiresAtMs <= currentTimeMs()) {
      localReadyOwedWakes.delete(agentId);
      return null;
    }
    return local.atMs;
  }
  const raw = await getRedis().get(readyOwedWakeKey(agentId));
  const atMs = raw === null ? Number.NaN : Number(raw);
  return Number.isSafeInteger(atMs) && atMs > 0 ? atMs : null;
}

// --- Reconciler step 15: at most one disk-sign-in lift per Computer and runtime ---
//
// A daemon's `machine:runtime_credentials:changed` lifts sign-in pauses, and
// every lift starts a fresh wake crash-loop episode. A credential file that
// keeps changing while the account is still unusable (a refresh that keeps
// writing while the server keeps getting 401) would cycle lift → start → 401
// → block → lift and defeat the breaker, so a disk lift is claimed once per
// machine and runtime per window, shared by every replica (SET NX EX).

export const DISK_CREDENTIAL_LIFT_WINDOW_SEC = 15 * 60;
export const diskCredentialLiftKey = (machineId: string, runtime: string) => `slock:machine:${machineId}:runtime:${runtime}:disk_credential_lift`;

/** No-Redis fallback: a single replica keeps the claims in-process, with the same window. */
const localDiskCredentialLifts = new Map<string, number>();

/** True when this call claimed the window (the lift may go ahead). Throws when Redis cannot be written. */
export async function claimDiskCredentialLift(machineId: string, runtime: string): Promise<boolean> {
  const key = diskCredentialLiftKey(machineId, runtime);
  if (!isRedisAvailable()) {
    const nowMs = currentTimeMs();
    const expiresAtMs = localDiskCredentialLifts.get(key);
    if (expiresAtMs !== undefined && expiresAtMs > nowMs) return false;
    localDiskCredentialLifts.set(key, nowMs + DISK_CREDENTIAL_LIFT_WINDOW_SEC * 1000);
    return true;
  }
  return (await getRedis().set(key, String(currentTimeMs()), "EX", DISK_CREDENTIAL_LIFT_WINDOW_SEC, "NX")) === "OK";
}

// --- Agent View Context requests in Redis ---
//
// One record per open view request (`slock:context-view:<requestId>`), written
// by the replica holding the viewer's HTTP request and read by whichever
// replica the daemon's result POST lands on. The record never changes after it
// is written; the first result POST claims it with a separate SET NX key, so a
// claim is atomic without a script and a POST with another Computer's
// credential never consumes it.

/** What the result POST is checked against and where the viewer waits. */
export interface AgentContextViewRequestRecord {
  requestId: AgentContextViewRequestId;
  /** The person who views; for an agent's search or read (`viewerKind: "agent"`), the agent's id. */
  viewerUserId: string;
  /**
   * #wg-ax:#15: an agent searching or reading a context. Absent for a person's
   * view. A replica that predates the field rechecks such a record as a
   * person's and refuses it (no user has that id), so it fails closed.
   */
  viewerKind?: "agent";
  /** The answer this request takes: `query` only an agent's search or read answer, never a view. */
  mode?: "query";
  /**
   * The View Context grant an agent used to view another agent's context
   * (agentContextViewGrantService.ts); absent for a person's view and for an
   * agent viewing its own. Additive: a replica that predates it rechecks an
   * agent viewer as viewing only itself, so a record naming another agent is
   * refused (fails closed), and a replica that predates `viewerKind` refuses
   * it as a person's view.
   */
  grantId?: AgentContextViewGrantId;
  agentId: string;
  serverId: string;
  messageId: string;
  /**
   * The agent's machine when the request was sent. Both credentials a Computer
   * may present on /internal/computer (its sk_computer_* key, or the Phase 1
   * sk_machine_* alias) resolve to one machine, so the POST is checked against it.
   */
  machineId: MachineId;
  /** The replica holding the viewer's request (REPLICA_ID) and its replay endpoint, when it has one. */
  viewerReplicaId: string;
  viewerEndpoint: string | null;
  /** ISO 8601. */
  createdAt: string;
}

export type AgentContextViewRequestClaim =
  | { kind: "claimed"; record: AgentContextViewRequestRecord }
  /** No such request, or its TTL ran out. */
  | { kind: "unknown" }
  /** The caller is not the Computer the request was sent to; nothing was consumed. */
  | { kind: "wrong_computer" }
  | { kind: "already_claimed" };

const agentContextViewRequestKey = (requestId: AgentContextViewRequestId) => `slock:context-view:${requestId}`;
const agentContextViewClaimKey = (requestId: AgentContextViewRequestId) => `slock:context-view:${requestId}:claimed`;

function parseAgentContextViewRequestRecord(raw: string | null | undefined): AgentContextViewRequestRecord | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const strings = ["requestId", "viewerUserId", "agentId", "serverId", "messageId", "machineId", "viewerReplicaId", "createdAt"] as const;
  if (!strings.every((key) => typeof v[key] === "string" && v[key] !== "")) return null;
  if (v.viewerEndpoint !== null && typeof v.viewerEndpoint !== "string") return null;
  // Redis is a boundary: the id is checked again when read back.
  const requestId = asAgentContextViewRequestId(v.requestId as string);
  if (!requestId) return null;
  // An agent's search or read keeps what it is: dropped, its result would be
  // rechecked as a person's view (and refused). A value this replica doesn't
  // know makes the whole record unknown, so it fails closed.
  if (v.viewerKind !== undefined && v.viewerKind !== "agent") return null;
  if (v.mode !== undefined && v.mode !== "query") return null;
  // The relay writes both for an agent's query and neither for a person's view.
  if ((v.viewerKind === "agent") !== (v.mode === "query")) return null;
  let grantId: AgentContextViewGrantId | null = null;
  if (v.grantId !== undefined) {
    grantId = typeof v.grantId === "string" ? asAgentContextViewGrantId(v.grantId) : null;
    if (!grantId) return null;
  }
  return {
    requestId,
    viewerUserId: v.viewerUserId as string,
    ...(v.viewerKind === "agent" ? { viewerKind: "agent" as const } : {}),
    ...(v.mode === "query" ? { mode: "query" as const } : {}),
    ...(grantId ? { grantId } : {}),
    agentId: v.agentId as string,
    serverId: v.serverId as string,
    messageId: v.messageId as string,
    machineId: asMachineId(v.machineId as string),
    viewerReplicaId: v.viewerReplicaId as string,
    viewerEndpoint: v.viewerEndpoint as string | null,
    createdAt: v.createdAt as string,
  };
}

/** No-Redis fallback: a single replica keeps the records and claims in-process, with the same TTL. */
const localAgentContextViewRequests = new Map<AgentContextViewRequestId, { raw: string; claimed: boolean; expiresAtMs: number }>();

function liveLocalAgentContextViewRequest(requestId: AgentContextViewRequestId) {
  const local = localAgentContextViewRequests.get(requestId);
  if (!local) return null;
  if (local.expiresAtMs <= currentTimeMs()) {
    localAgentContextViewRequests.delete(requestId);
    return null;
  }
  return local;
}

export async function createAgentContextViewRequest(record: AgentContextViewRequestRecord, ttlMs: number): Promise<void> {
  const raw = JSON.stringify(record);
  if (!isRedisAvailable()) {
    localAgentContextViewRequests.set(record.requestId, { raw, claimed: false, expiresAtMs: currentTimeMs() + ttlMs });
    return;
  }
  await getRedis().set(agentContextViewRequestKey(record.requestId), raw, "PX", ttlMs);
}

/** The record and whether a result POST has claimed it; null when unknown or expired. */
export async function getAgentContextViewRequest(requestId: AgentContextViewRequestId): Promise<{ record: AgentContextViewRequestRecord; claimed: boolean } | null> {
  if (!isRedisAvailable()) {
    const local = liveLocalAgentContextViewRequest(requestId);
    const record = parseAgentContextViewRequestRecord(local?.raw);
    return local && record ? { record, claimed: local.claimed } : null;
  }
  const [raw, claimed] = await getRedis().mget(agentContextViewRequestKey(requestId), agentContextViewClaimKey(requestId));
  const record = parseAgentContextViewRequestRecord(raw);
  return record ? { record, claimed: claimed !== null } : null;
}

/**
 * The first result POST from the Computer the request was sent to claims it,
 * whatever its body. The record is immutable, so reading it and then SET NX
 * on the claim key is atomic for the claim; the claim key lives at most as
 * long as the request (`ttlMs`).
 */
export async function claimAgentContextViewRequest(requestId: AgentContextViewRequestId, callerMachineId: MachineId, ttlMs: number): Promise<AgentContextViewRequestClaim> {
  if (!isRedisAvailable()) {
    const local = liveLocalAgentContextViewRequest(requestId);
    const record = parseAgentContextViewRequestRecord(local?.raw);
    if (!local || !record) return { kind: "unknown" };
    if (record.machineId !== callerMachineId) return { kind: "wrong_computer" };
    if (local.claimed) return { kind: "already_claimed" };
    local.claimed = true;
    return { kind: "claimed", record };
  }
  const redis = getRedis();
  const record = parseAgentContextViewRequestRecord(await redis.get(agentContextViewRequestKey(requestId)));
  if (!record) return { kind: "unknown" };
  if (record.machineId !== callerMachineId) return { kind: "wrong_computer" };
  const won = await redis.set(agentContextViewClaimKey(requestId), "1", "PX", ttlMs, "NX");
  return won === "OK" ? { kind: "claimed", record } : { kind: "already_claimed" };
}

/** This replica's replay endpoint (null when it has none), for a record a result on another replica must reach. */
export function getLocalReplicaReplayEndpoint(): string | null {
  return _replicaReplayEndpoint;
}

// --- Machine meta in Redis ---
//
// Live machine fields that are reported by the daemon's `ready` message and
// kept in `agentOrchestrator.machineConnections` (an in-process map on the
// owner replica). REST handlers running on a non-owner replica need these
// values too — the store mirrors them through Redis so any replica's
// `/api/servers/:id/machines` returns a complete row regardless of which
// replica owns the machine connection.
//
// `computerVersion` is the field this commit unblocks (#wg-raft-computer
// task #95). Other owner-memory fields (`daemonVersion`, `hostname`, `os`,
// future capabilities/runtimes) intentionally share the same hash so this
// stays a single seam — see `MachineMeta` below — instead of growing into a
// per-field patch sprawl. ApplePI's cross-replica status/activity coherence
// contract follow-up can collapse status+activity through the same key
// without inventing yet another store.

/**
 * Owner-memory live fields mirrored cross-replica. Only fields that come
 * from the daemon `ready` message and need to round-trip through REST on
 * non-owner replicas live here. Adding a field is additive: callers
 * already pass partial objects.
 */
export interface MachineMeta {
  computerVersion?: string | null;
  // Freshness of the live Computer-version fact. The owner rewrites this on
  // ready and every pong while the same connection/session remains live.
  computerVersionObservedAt?: string | null;
  daemonVersion?: string | null;
  /** JSON-encoded Record<runtimeId, version>; Redis hash values are strings. */
  runtimeVersions?: string | null;
  hostname?: string | null;
  os?: string | null;
  migrationTransportProvisioned?: string | null;
  migrationTransportEndpoint?: string | null;
  migrationTransportLeaseSource?: string | null;
  migrationTransportObservedAt?: string | null;
  migrationTransportCapturedAt?: string | null;
  migrationTransportProtocol?: string | null;
  migrationTransportCapabilities?: string | null;
  /** Probe carrier fact (F1): JSON string[] of ready-handshake capabilities. */
  probeCapabilities?: string | null;
  /** task #1268: JSON of the owner's last fanned-out runtime detection state, or null for synchronous daemons. */
  probeRuntimeDetection?: string | null;
  probeConnectionEpochId?: string | null;
  probeReplicaGeneration?: string | null;
  /** ISO timestamp of the owner replica's latest observation of this fact. */
  probeObservedAt?: string | null;
  /** JSON-encoded Record<runtimeId, version> observed by the owner replica. */
  probeRuntimeVersions?: string | null;
  /** Latest `machine:disk_status`, decimal strings. */
  diskAvailableBytes?: string | null;
  diskTotalBytes?: string | null;
  /** Latest `machine:memory_status`, decimal strings. */
  memoryAvailableBytes?: string | null;
  memoryTotalBytes?: string | null;
  /** #proj-raft-computer task #34: JSON of `ready.installerRepairHint` / its later change; null when there is nothing to hint. */
  installerRepairHint?: string | null;
}

// 1h TTL: long enough that brief Redis hiccups don't drop live metadata,
// short enough that a crashed-and-never-reconnected machine eventually
// stops serving its old `computerVersion` to non-owner replicas. The
// owner upserts live fields every heartbeat via `setMachineMeta` (which
// rewrites the hash AND resets the deadline), so during normal operation
// the entry never expires; TTL is only the crash/forgotten-disconnect
// fuse.
const MACHINE_META_TTL_SEC = 3600;

/**
 * Store machine live meta in Redis. `null` values are written as empty
 * strings so a present-but-null reply (e.g. a Computer that has no
 * `computerVersion` to report) is distinguishable from "no entry yet" —
 * `getMachineMeta` returns the entry shape `{ field: null | string }`.
 *
 * Best-effort: silently no-ops when Redis is unavailable. Callers must
 * fall back to in-memory `machineConnections` (owner replica) — this
 * mirror exists to cover non-owner replica REST reads, not to replace
 * the source of truth.
 */
export async function setMachineMeta(machineId: string, meta: MachineMeta): Promise<void> {
  if (!isRedisAvailable()) return;
  const redis = getRedis();
  const key = `slock:machine:${machineId}:meta`;
  const fields: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    fields.push(k, v === null || v === undefined ? "" : v);
  }
  if (fields.length === 0) return;
  const pipeline = redis.pipeline();
  pipeline.hset(key, ...fields);
  pipeline.expire(key, MACHINE_META_TTL_SEC);
  await pipeline.exec();
}

/**
 * Get machine live meta from Redis. Empty-string field values map back to
 * `null` (the convention `setMachineMeta` writes for absent values), so
 * callers can read a `present-but-null` field the same way the in-memory
 * map exposes one.
 */
export async function getMachineMeta(machineId: string): Promise<MachineMeta | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedis();
  const data = await redis.hgetall(`slock:machine:${machineId}:meta`);
  const keys = Object.keys(data);
  if (keys.length === 0) return null;
  const out: MachineMeta = {};
  for (const k of keys) {
    const v = data[k];
    (out as Record<string, string | null>)[k] = v === undefined || v === "" ? null : v;
  }
  return out;
}

/**
 * Drop the machine meta entry on disconnect / unregister so non-owner
 * replicas don't return stale `computerVersion` for a machine that has
 * since reconnected with a different version (or hasn't reconnected at
 * all). The TTL eventually evicts orphans, but explicit removal is
 * cleaner during normal shutdown.
 */
export async function clearMachineMeta(machineId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  const redis = getRedis();
  await redis.del(`slock:machine:${machineId}:meta`);
}

/**
 * Update max message seq per server in Redis.
 */
export async function updateMaxSeqRedis(serverId: string, seq: number) {
  if (!isRedisAvailable()) return;
  const redis = getRedis();
  // Use Lua script for atomic compare-and-set
  const script = `
    local current = tonumber(redis.call('get', KEYS[1]) or '0')
    if tonumber(ARGV[1]) > current then
      redis.call('set', KEYS[1], ARGV[1])
    end
    return 1
  `;
  await redis.eval(script, 1, `slock:server:${serverId}:maxseq`, String(seq));
}

/**
 * Get max message seq from Redis (falls back to 0).
 */
export async function getMaxSeqRedis(serverId: string): Promise<number> {
  if (!isRedisAvailable()) return 0;
  const redis = getRedis();
  const val = await redis.get(`slock:server:${serverId}:maxseq`);
  return val ? Number(val) : 0;
}

// --- Fly.io replica affinity ---

/** Returns true if running on Fly.io (FLY_MACHINE_ID or FLY_ALLOC_ID set). */
export function isFlyEnvironment(): boolean {
  return FLY_INSTANCE !== null;
}

/**
 * Get the Fly instance ID for the replica hosting this machine.
 * Returns null if: not on Fly, machine not found, or machine is on THIS instance.
 */
export async function getFlyInstanceForMachine(machineId: string): Promise<string | null> {
  if (!isRedisAvailable() || !FLY_INSTANCE) return null;
  const redis = getRedis();
  const flyId = await redis.get(`slock:machine:${machineId}:fly`);
  if (!flyId || flyId === FLY_INSTANCE) return null;
  return flyId;
}

export function setMachineConnectionDropHandler(handler: MachineConnectionDropHandler | null): void {
  _machineConnectionDropHandler = handler;
}

/**
 * Closes a machine's live connection wherever it is held, after its credential
 * changed (rotated, revoked). A rotated or revoked key is checked at the next
 * handshake; without this the open socket kept working until it dropped on its
 * own. The local replica runs first; the content-free broadcast reaches the rest.
 */
export async function dropMachineConnectionEverywhere(
  machineId: string,
  reason: MachineConnectionDropReason,
): Promise<void> {
  await _machineConnectionDropHandler?.(machineId, reason);
  // Runs after the caller committed the credential change: the broadcast must
  // neither hang the request (the shared client retries without limit while
  // Redis reconnects) nor turn a committed change into a 500. A failure leaves
  // the socket open on another replica until it reconnects, so it is recorded
  // as a named event that o11y alerts on.
  const redis = getBoundedRedis(MACHINE_CONNECTION_DROP_PUBLISH_TIMEOUT_MS);
  if (!redis) return;
  try {
    await redis.publish(MACHINE_CONNECTION_DROP_CHANNEL, JSON.stringify({ machineId, reason, from: REPLICA_ID }));
  } catch (err) {
    addTraceEvent("machine_connection.drop_broadcast_failed", { reason, error_class: errorClassOf(err) });
    console.error(`[ReplicaRouter] Failed to publish the connection drop for ${machineId}:`, err);
  }
}

const MACHINE_CONNECTION_DROP_PUBLISH_TIMEOUT_MS = 2_000;
