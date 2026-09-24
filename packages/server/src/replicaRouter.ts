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
import { MachineResponseRelay, redisMachineReplyStore } from "./machineResponseRelay.js";
import type Redis from "ioredis";
import { getRedis, getRedisReplicaSub, isRedisAvailable, resetRedisReplicaSub } from "./redis.js";
import {
  normalizeActivity,
  normalizeActivityDetailKind,
  currentTimeMs,
  setClockInterval,
  setClockTimeout,
  clearClockTimeout,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type AgentRuntimeErrorState,
  type ServerToMachineMessage,
  type AgentMessage,
} from "@botiverse/raft-shared";
import {
  buildRuntimeTraceContext,
  type MachineConnectTraceContext,
} from "./tracing/migrationTraceContext.js";

// Each server instance gets a unique ID
export const REPLICA_ID = crypto.randomUUID();

// Fly.io instance ID for fly-replay header routing
const FLY_INSTANCE = process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID || null;

type MachineCommandHandler = (machineId: string, message: ServerToMachineMessage) => void;
type InboxDeliveryHandler = (agentId: string, machineId: string | null, message: AgentMessage) => void;
export type RoutedInboxDeliveryReceipt =
  | { status: "queued"; reason: string }
  | { status: "dropped"; reason: string };
export interface RoutedInboxDeliveryOptions {
  transient?: boolean;
  adminAuthority?: boolean;
  intrinsic?: boolean;
  migrationProtocol?: boolean;
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
let _replicaReplayEndpoint: string | null = null;

// Cross-replica wake signal for EXTERNAL agents (option C, #wg-external-agent
// 2026-06-11): external deliveries buffer process-locally and the SSE
// wake-hint stream listens to an in-process emitter, so a fan-out handled by
// another replica was invisible to a connected stream until the 25s heartbeat
// durable peek (#2809). This broadcast carries agentId ONLY (content-free);
// receivers re-emit locally and the stream's flush re-audits durable truth,
// so duplicate/reordered/lost signals never affect correctness — the
// heartbeat peek remains the correctness floor.
const EXTERNAL_WAKE_CHANNEL = "slock:replica:external-wake";
const MACHINE_PRINCIPAL_FENCE_CHANNEL = "slock:replica:machine-principal-fence";

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
    return 0
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

type ReplicaMessage =
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
    ...(typeof candidate.migrationProtocol === "boolean" ? { migrationProtocol: candidate.migrationProtocol } : {}),
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
    await sub.subscribe(replicaChannel(REPLICA_ID), EXTERNAL_WAKE_CHANNEL, MACHINE_PRINCIPAL_FENCE_CHANNEL);
  } catch (err) {
    console.warn(
      `[ReplicaRouter] Subscribe failed (${reason}); resetting replica subscriber:`,
      err instanceof Error ? err.message : err,
    );
    sub = resetRedisReplicaSub();
    bindReplicaSubscriber(sub);
    await sub.subscribe(replicaChannel(REPLICA_ID), EXTERNAL_WAKE_CHANNEL, MACHINE_PRINCIPAL_FENCE_CHANNEL);
  }

  const subscriberCount = await getReplicaSubscriberCount();
  if (subscriberCount > 0) return subscriberCount;

  if (reason !== "reset_after_unhealthy") {
    console.warn(`[ReplicaRouter] Replica ${REPLICA_ID.slice(0, 8)} subscriber missing after ${reason}; resetting`);
    sub = resetRedisReplicaSub();
    bindReplicaSubscriber(sub);
    await sub.subscribe(replicaChannel(REPLICA_ID), EXTERNAL_WAKE_CHANNEL, MACHINE_PRINCIPAL_FENCE_CHANNEL);
    return getReplicaSubscriberCount();
  }
  return subscriberCount;
}

function startReplicaSubscriptionHealthCheck() {
  if (_replicaSubscriptionHealthTimer || !isRedisAvailable()) return;
  _replicaSubscriptionHealthTimer = setClockInterval(() => {
    void (async () => {
      try {
        if (!isRedisAvailable()) return;
        const subscriberCount = await getReplicaSubscriberCount();
        if (subscriberCount > 0) return;
        const recoveredCount = await subscribeReplicaRouter("health_check");
        if (recoveredCount <= 0) {
          console.error(`[ReplicaRouter] Replica ${REPLICA_ID.slice(0, 8)} subscriber remains missing after reset`);
        }
      } catch (err) {
        console.warn(
          "[ReplicaRouter] Replica subscriber health check failed:",
          err instanceof Error ? err.message : err,
        );
      }
    })();
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
) {
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
    if (msg.type === "machine:response:ready" && typeof msg.requestId === "string") {
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
      void handleReceiptRequiredInboxDelivery(msg);
    } else if (msg.type === "inbox:deliver" && msg.agentId && _inboxDeliveryHandler) {
      _inboxDeliveryHandler(msg.agentId, msg.machineId ?? null, msg.payload as AgentMessage);
    }
  } catch (err) {
    console.error("[ReplicaRouter] Failed to parse message:", err);
  }
}

async function handleReceiptRequiredInboxDelivery(
  msg: ReceiptRequiredInboxDeliveryMessage,
): Promise<void> {
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
    receipt = { status: "dropped", reason: "cross_replica_receipt_unavailable" };
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
  }
}

export function __setInboxDeliveryReceiptRuntimeForTests(
  handler: InboxDeliveryReceiptHandler | null,
  publisher: InboxDeliveryReceiptPublisher | null,
): void {
  _inboxDeliveryReceiptHandler = handler;
  _inboxDeliveryReceiptPublisherForTests = publisher;
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

/**
 * Refresh the machine→replica mapping TTL. Called on each heartbeat pong.
 */
export async function refreshMachineReplica(
  machineId: string,
  traceContext: MachineConnectTraceContext = buildRuntimeTraceContext(),
  expectedGeneration?: string,
): Promise<void> {
  if (!isRedisAvailable() || !expectedGeneration) return;
  await getRedis().eval(
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

export async function getMachineReplicaOwner(machineId: string): Promise<string | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedis();
  return await redis.get(machineReplicaKey(machineId));
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
): Promise<boolean> {
  if (!isRedisAvailable() || !machineId) return false;
  if (localMachineIds.has(machineId)) return false;

  const redis = getRedis();
  const targetReplica = await redis.get(machineReplicaKey(machineId));
  if (!targetReplica || targetReplica === REPLICA_ID) return false;

  const msg: ReplicaMessage = {
    type: "inbox:deliver",
    machineId,
    agentId,
    payload: message,
  };
  await redis.publish(replicaChannel(targetReplica), JSON.stringify(msg));
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
  const runtime = _inboxDeliveryReceiptRouteRuntimeForTests ?? {
    isAvailable: isRedisAvailable,
    getTargetReplica: async (targetMachineId: string) => (
      getRedis().get(machineReplicaKey(targetMachineId))
    ),
    publish: async (targetReplicaId: string, raw: string) => (
      getRedis().publish(replicaChannel(targetReplicaId), raw)
    ),
  };
  if (!runtime.isAvailable() || !machineId) return { routed: false };
  if (localMachineIds.has(machineId)) return { routed: false };

  let targetReplica: string | null;
  try {
    targetReplica = await runtime.getTargetReplica(machineId);
  } catch (error) {
    console.error(`[ReplicaRouter] Failed to resolve receipt delivery owner for ${agentId}:`, error);
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
export async function setAgentActivity(
  agentId: string,
  activity: AgentActivityKind,
  detail: string,
  detailKind: AgentActivityDetailKind,
  observedAtMs?: number,
) {
  if (!isRedisAvailable()) return;
  const redis = getRedis();
  const key = `slock:agent:${agentId}:activity`;
  const pipeline = redis.pipeline();
  pipeline.hset(key, "activity", activity, "detail", detail, "detailKind", detailKind, "updatedAt", String(Date.now()));
  if (observedAtMs !== undefined) {
    pipeline.hset(key, "observedAtMs", String(observedAtMs));
  } else {
    pipeline.hdel(key, "observedAtMs");
  }
  pipeline.expire(key, 600); // 10 min TTL
  await pipeline.exec();
}

export function projectAgentActivityFromRedisHash(data: Record<string, string>): {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  observedAtMs?: number;
  updatedAt: number;
} | null {
  if (!data.activity) return null;
  const observedAtMs = Number(data.observedAtMs);
  return {
    activity: normalizeActivity(data.activity),
    detail: data.detail || "",
    detailKind: normalizeActivityDetailKind(data.detailKind),
    ...(Number.isFinite(observedAtMs) ? { observedAtMs } : {}),
    updatedAt: Number(data.updatedAt) || 0,
  };
}

/**
 * Get agent activity from Redis.
 */
export async function getAgentActivity(
  agentId: string,
): Promise<{ activity: AgentActivityKind; detail: string; detailKind: AgentActivityDetailKind; observedAtMs?: number; updatedAt: number } | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedis();
  const data = await redis.hgetall(`slock:agent:${agentId}:activity`);
  return projectAgentActivityFromRedisHash(data);
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

export async function getAgentRuntimeError(agentId: string): Promise<AgentRuntimeErrorMirror | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedis();
  return projectAgentRuntimeErrorFromRedisHash(await redis.hgetall(agentRuntimeErrorKey(agentId)));
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
