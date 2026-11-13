import { and, count, eq, gt, inArray, min } from "drizzle-orm";

import type { DatabaseExecutor } from "../db/index";
import { externalAppInstalls, externalChannelBindings, externalInboundEvents, slackVerifiedIngressEvents } from "../db/schema";
import {
  slackBridgeLifecycleHealthObservationsTotal,
  slackBridgeInboundWorkerResultsTotal,
  slackBridgeOutboundWorkerResultsTotal,
  slackBridgeInboundFailedEvents24h,
  slackBridgeInboundHeldEvents,
  slackBridgeInboundOldestHeldAgeSeconds,
  slackBridgeInboundOldestPendingAgeSeconds,
  slackBridgeInboundPendingEvents,
  slackBridgeOutboundOldestPendingAgeSeconds,
  slackBridgeOutboundPairOldestPendingAgeSeconds,
  slackBridgeOutboundPairPendingMessages,
  slackBridgeOutboundPairs,
  slackBridgeOutboundPendingMessages,
} from "../metrics";
import { isSlackControlWaitReason, type ExternalDeliveryWorkerResult } from "./externalDeliveryWorkerService";
import type { ExternalInboundAttachmentWorkerResult } from "./externalInboundAttachmentWorkerService";
import type { ExternalInboundWorkerResult } from "./externalInboundWorkerService";
import type { SlackBridgeLifecycleExecutionReceipt } from "./slackBridgeWorkerLifecycle";
import {
  classifySlackPairQueue, listSlackPairHeadsForHealth, SLACK_PAIR_HEAD_BATCH_SIZE, type SlackPairQueueStatus,
} from "./slackBridgePairQueue";

// Queue state for operators: how much Raft work waits for Slack per pair and
// how old it is, and how many Slack events wait for Raft. Every process samples
// once a minute (a few index reads), and the lifecycle pass reuses the latest
// sample as its backlog instead of reading the queues again.

const SAMPLE_INTERVAL_MS = 60_000;
const SLOW_PAIR_AGE_MS = 5 * 60_000;
const MAX_EXPORTED_PAIRS = 50;
const PAIR_STATUSES: readonly SlackPairQueueStatus[] = ["idle", "flowing", "waiting", "stalled", "paused"];
const INBOUND_PENDING_STATUSES = ["queued", "processing"] as const;
const INBOUND_FAILED_STATUSES = ["dead", "revoked", "quarantined"] as const;
const DAY_MS = 24 * 60 * 60_000;

export interface SlackPairQueueSample {
  bindingId: string;
  status: SlackPairQueueStatus;
  pendingMessages: number;
  oldestPendingAgeMs: number;
}

export interface SlackBridgeQueueSample {
  pairs: SlackPairQueueSample[];
  inboundPending: { status: (typeof INBOUND_PENDING_STATUSES)[number]; events: number; oldestAgeMs: number }[];
  inboundFailed24h: { status: (typeof INBOUND_FAILED_STATUSES)[number]; events: number }[];
  inboundHeld: { events: number; oldestAgeMs: number };
}

export async function sampleSlackBridgeQueues(
  executor: DatabaseExecutor,
  input: { registrationId: string; now: Date },
): Promise<SlackBridgeQueueSample> {
  const nowMs = input.now.getTime();
  const bindings = await executor.select({
    id: externalChannelBindings.id,
    bindingEpoch: externalChannelBindings.bindingEpoch,
    state: externalChannelBindings.state,
    installState: externalAppInstalls.state,
  }).from(externalChannelBindings)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
    .where(and(
      eq(externalChannelBindings.registrationId, input.registrationId),
      inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
    ));
  const heads: Awaited<ReturnType<typeof listSlackPairHeadsForHealth>> = [];
  for (let offset = 0; offset < bindings.length; offset += SLACK_PAIR_HEAD_BATCH_SIZE) {
    heads.push(...await listSlackPairHeadsForHealth(executor, bindings.slice(offset, offset + SLACK_PAIR_HEAD_BATCH_SIZE)
      .map((binding) => ({ bindingId: binding.id, bindingEpoch: binding.bindingEpoch }))));
  }
  const headByBinding = new Map(heads.map((head) => [head.currentBindingId, head]));
  const pairs = bindings.map((binding): SlackPairQueueSample => {
    const head = headByBinding.get(binding.id);
    return {
      bindingId: binding.id,
      status: classifySlackPairQueue({
        bindingState: binding.state, installState: binding.installState, head, now: input.now,
        pairControlled: isSlackControlWaitReason(head?.authorityBlockedReason ?? null),
      }),
      pendingMessages: head ? Number(head.pairPendingMessages) : 0,
      oldestPendingAgeMs: head ? Math.max(0, nowMs - head.createdAt.getTime()) : 0,
    };
  });

  const inboundPending = await executor.select({
    status: externalInboundEvents.status,
    events: count(),
    oldestReceivedAt: min(externalInboundEvents.receivedAt),
  }).from(externalInboundEvents).where(and(
    inArray(externalInboundEvents.status, [...INBOUND_PENDING_STATUSES]),
    eq(externalInboundEvents.appRegistrationId, input.registrationId),
  )).groupBy(externalInboundEvents.status);
  // Raw heads still waiting for normalization have no normalized row yet.
  // Exclude materialized receipts so their normalized row is counted once.
  const rawPending = await executor.select({
    status: slackVerifiedIngressEvents.state,
    events: count(),
    oldestReceivedAt: min(slackVerifiedIngressEvents.receivedAt),
  }).from(slackVerifiedIngressEvents).where(and(
    inArray(slackVerifiedIngressEvents.state, [...INBOUND_PENDING_STATUSES]),
    eq(slackVerifiedIngressEvents.appRegistrationId, input.registrationId),
  )).groupBy(slackVerifiedIngressEvents.state);
  const inboundFailed = await executor.select({
    status: externalInboundEvents.status,
    events: count(),
  }).from(externalInboundEvents).where(and(
    inArray(externalInboundEvents.status, [...INBOUND_FAILED_STATUSES]),
    gt(externalInboundEvents.receivedAt, new Date(nowMs - DAY_MS)),
    eq(externalInboundEvents.appRegistrationId, input.registrationId),
  )).groupBy(externalInboundEvents.status);

  // A materialized raw head whose normalized event terminalized without a
  // message still holds its encrypted receipt and blocks that partition.
  // It is not present in the normalized pending counts above.
  const [blockedRaw] = await executor.select({
    events: count(), oldestReceivedAt: min(slackVerifiedIngressEvents.receivedAt),
  }).from(slackVerifiedIngressEvents).innerJoin(externalInboundEvents,
    eq(slackVerifiedIngressEvents.materializedInboundEventId, externalInboundEvents.id)).where(and(
    eq(slackVerifiedIngressEvents.appRegistrationId, input.registrationId),
    eq(slackVerifiedIngressEvents.state, "materialized"),
    inArray(externalInboundEvents.status, [...INBOUND_FAILED_STATUSES]),
  ));

  const [held] = await executor.select({ events: count(), oldestFailureAt: min(slackVerifiedIngressEvents.firstParseFailureAt) })
    .from(slackVerifiedIngressEvents).where(and(
      eq(slackVerifiedIngressEvents.appRegistrationId, input.registrationId),
      eq(slackVerifiedIngressEvents.state, "held"),
    ));

  return {
    pairs,
    inboundHeld: { events: held?.events ?? 0, oldestAgeMs: held?.oldestFailureAt
      ? Math.max(0, nowMs - new Date(held.oldestFailureAt).getTime()) : 0 },
    inboundPending: INBOUND_PENDING_STATUSES.map((status) => {
      const row = inboundPending.find((candidate) => candidate.status === status);
      const raw = rawPending.find((candidate) => candidate.status === status);
      const blocked = status === "queued" ? blockedRaw : null;
      const ages = [row?.oldestReceivedAt, raw?.oldestReceivedAt, blocked?.oldestReceivedAt]
        .flatMap((date) => date == null ? [] : [Math.max(0, nowMs - new Date(date).getTime())]);
      return {
        status,
        events: (row?.events ?? 0) + (raw?.events ?? 0) + (blocked?.events ?? 0),
        oldestAgeMs: Math.max(0, ...ages),
      };
    }),
    inboundFailed24h: INBOUND_FAILED_STATUSES.map((status) => ({
      status,
      events: inboundFailed.find((candidate) => candidate.status === status)?.events ?? 0,
    })),
  };
}

/** Replaces every Slack Bridge queue gauge with one sample. */
export function exportSlackBridgeQueueSample(sample: SlackBridgeQueueSample | null): void {
  for (const gauge of [
    slackBridgeOutboundPairs, slackBridgeOutboundPendingMessages, slackBridgeOutboundOldestPendingAgeSeconds,
    slackBridgeOutboundPairPendingMessages, slackBridgeOutboundPairOldestPendingAgeSeconds,
    slackBridgeInboundPendingEvents, slackBridgeInboundOldestPendingAgeSeconds, slackBridgeInboundFailedEvents24h,
    slackBridgeInboundHeldEvents, slackBridgeInboundOldestHeldAgeSeconds,
  ]) gauge.reset();
  // A failed read leaves the gauges empty: a frozen age would hide a stall.
  if (!sample) return;
  for (const status of PAIR_STATUSES) {
    const pairs = sample.pairs.filter((pair) => pair.status === status);
    slackBridgeOutboundPairs.set({ status }, pairs.length);
    slackBridgeOutboundPendingMessages.set({ status }, pairs.reduce((sum, pair) => sum + pair.pendingMessages, 0));
    slackBridgeOutboundOldestPendingAgeSeconds.set({ status },
      Math.round(Math.max(0, ...pairs.map((pair) => pair.oldestPendingAgeMs)) / 1000));
  }
  const exported = sample.pairs
    .filter((pair) => pair.status === "waiting" || pair.status === "stalled"
      || (pair.status === "paused" && pair.pendingMessages > 0)
      || (pair.status === "flowing" && pair.oldestPendingAgeMs >= SLOW_PAIR_AGE_MS))
    .sort((left, right) => right.oldestPendingAgeMs - left.oldestPendingAgeMs)
    .slice(0, MAX_EXPORTED_PAIRS);
  for (const pair of exported) {
    const labels = { binding_id: pair.bindingId, status: pair.status };
    slackBridgeOutboundPairPendingMessages.set(labels, pair.pendingMessages);
    slackBridgeOutboundPairOldestPendingAgeSeconds.set(labels, Math.round(pair.oldestPendingAgeMs / 1000));
  }
  slackBridgeInboundHeldEvents.set(sample.inboundHeld.events);
  slackBridgeInboundOldestHeldAgeSeconds.set(Math.round(sample.inboundHeld.oldestAgeMs / 1000));
  for (const row of sample.inboundPending) {
    slackBridgeInboundPendingEvents.set({ status: row.status }, row.events);
    slackBridgeInboundOldestPendingAgeSeconds.set({ status: row.status }, Math.round(row.oldestAgeMs / 1000));
  }
  for (const row of sample.inboundFailed24h) {
    slackBridgeInboundFailedEvents24h.set({ status: row.status }, row.events);
  }
}

export interface SlackBridgeQueueMetricsSampler {
  start(): void;
  stop(): Promise<void>;
  /** The latest pair backlog, or null before the first sample or after a failed one. */
  pairBacklog(bindingId: string): { pendingEvents: number; oldestPendingEventAgeMs: number } | null;
  sampleNow(): Promise<void>;
}

export function createSlackBridgeQueueMetricsSampler(input: {
  db: DatabaseExecutor;
  registrationId: string;
  now?: () => Date;
  intervalMs?: number;
  onError?(error: unknown): void;
}): SlackBridgeQueueMetricsSampler {
  const intervalMs = input.intervalMs ?? SAMPLE_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let latest = new Map<string, SlackPairQueueSample>();
  const sampleNow = () => {
    running ??= (async () => {
      try {
        const sample = await sampleSlackBridgeQueues(input.db, {
          registrationId: input.registrationId,
          now: input.now?.() ?? new Date(),
        });
        latest = new Map(sample.pairs.map((pair) => [pair.bindingId, pair]));
        exportSlackBridgeQueueSample(sample);
      } catch (error) {
        latest = new Map();
        exportSlackBridgeQueueSample(null);
        input.onError?.(error);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return {
    start() {
      if (timer) return;
      void sampleNow();
      timer = setInterval(() => void sampleNow(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
    pairBacklog(bindingId) {
      const pair = latest.get(bindingId);
      return pair ? { pendingEvents: pair.pendingMessages, oldestPendingEventAgeMs: pair.oldestPendingAgeMs } : null;
    },
    sampleNow,
  };
}

/** Counts one outbound worker result; idle ticks are not counted. */
export function observeSlackOutboundWorkerResult(result: ExternalDeliveryWorkerResult): void {
  if (result.kind === "disabled" || result.kind === "empty") return;
  // An intentional control (master switch, pause) is not an authority fault,
  // even after it outlasts the overdue threshold.
  const state = result.kind === "attempted" ? result.deliveryState
    : result.kind === "cursor_recovered" ? result.state
      : result.kind === "authority_blocked"
        ? isSlackControlWaitReason(result.reason) ? "control_wait" : result.severity
        : "none";
  slackBridgeOutboundWorkerResultsTotal.inc({ result: result.kind, state });
}

/** Counts one inbound event or attachment worker result; idle ticks are not counted. */
export function observeSlackInboundWorkerResult(
  worker: "event" | "attachment",
  result: ExternalInboundWorkerResult | ExternalInboundAttachmentWorkerResult,
): void {
  if (result.kind === "disabled" || result.kind === "empty") return;
  slackBridgeInboundWorkerResultsTotal.inc({ worker, result: result.kind });
}

/** Counts the health one lifecycle pass projected for one binding. */
export function observeSlackLifecycleHealth(receipt: SlackBridgeLifecycleExecutionReceipt): void {
  const { health } = receipt.plan;
  slackBridgeLifecycleHealthObservationsTotal.inc({ state: health.state, reason: health.reason ?? "none" });
}
