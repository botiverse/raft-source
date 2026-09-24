import { clearClockInterval, currentTimeMs, setClockInterval } from "@botiverse/raft-shared";

export type SlackBridgeBindingMode = "active" | "paused" | "disconnected";
export type SlackBridgeWorkerState = "not_running" | "starting" | "running" | "stopping" | "failed";
export type SlackBridgeHealthState = "Connected" | "Degraded" | "Unverified" | "Disconnected";
export type SlackBridgeProbeSurface = "slack" | "raft";
export type SlackBridgeProbeTrigger = "periodic" | "event";
export type SlackBridgeAppInstallState =
  | "pending"
  | "active"
  | "reauth_required"
  | "disconnected"
  | "revoked"
  | "quarantined";
export type SlackBridgeChannelBindingState = "active" | "paused" | "revoked" | "quarantined";
export type SlackBridgeCredentialState = "active" | "persist_unknown" | "revoked";
export type SlackBridgeAudienceStatus = "matched" | "mismatch" | "unavailable";

export type SlackBridgeFailureReason =
  | "app_install_pending"
  | "app_reauth_required"
  | "app_disconnected"
  | "app_revoked"
  | "app_quarantined"
  | "channel_binding_paused"
  | "channel_binding_revoked"
  | "channel_binding_quarantined"
  | "credential_persist_unknown"
  | "credential_revoked"
  | "audience_mismatch"
  | "audience_unavailable"
  | "binding_paused"
  | "binding_disconnected"
  | "worker_not_running"
  | "worker_failed"
  | "lease_held_by_peer"
  | "probe_missing"
  | "probe_stale"
  | "slack_probe_failed"
  | "raft_probe_failed"
  | "backlog_backpressure";

export type SlackBridgeWorkerCommandType = "start" | "stop" | "restart";
export type SlackBridgeWorkerCommandReason =
  | "active_binding_without_worker"
  | "worker_failed"
  | "stale_worker_epoch"
  | "inactive_binding";

export interface SlackBridgeProbeObservation {
  surface: SlackBridgeProbeSurface;
  ok: boolean;
  observedAtMs: number;
  trigger: SlackBridgeProbeTrigger;
  failureReason?: string | null;
}

export interface SlackBridgeWorkerSnapshot {
  state: SlackBridgeWorkerState;
  epoch: number;
  leaseId: string | null;
  leaseOwnerId: string | null;
  leaseExpiresAtMs: number | null;
}

export interface SlackBridgeBacklogSnapshot {
  pendingEvents: number;
  oldestPendingEventAgeMs: number;
}

export interface SlackBridgeAuthoritySnapshot {
  appInstallState: SlackBridgeAppInstallState;
  channelBindingState: SlackBridgeChannelBindingState;
  credentialState: SlackBridgeCredentialState;
  audienceStatus: SlackBridgeAudienceStatus;
}

export interface SlackBridgeBindingRuntime {
  bindingId: string;
  mode: SlackBridgeBindingMode;
  desiredEpoch: number;
  authority?: SlackBridgeAuthoritySnapshot;
  worker: SlackBridgeWorkerSnapshot;
  backlog: SlackBridgeBacklogSnapshot;
  probes: Partial<Record<SlackBridgeProbeSurface, SlackBridgeProbeObservation>>;
}

export interface SlackBridgeLifecyclePolicy {
  orchestratorId: string;
  nowMs: number;
  probeFreshnessMs: number;
  maxPendingEvents: number;
  maxOldestPendingEventAgeMs: number;
  trigger: SlackBridgeProbeTrigger;
}

export interface SlackBridgeWorkerCommand {
  type: SlackBridgeWorkerCommandType;
  bindingId: string;
  nextEpoch: number;
  reason: SlackBridgeWorkerCommandReason;
}

export interface SlackBridgeProbeRequest {
  bindingId: string;
  surface: SlackBridgeProbeSurface;
  trigger: SlackBridgeProbeTrigger;
}

export interface SlackBridgeHealthProjection {
  state: SlackBridgeHealthState;
  reason: SlackBridgeFailureReason | null;
  failingSurface: SlackBridgeProbeSurface | "app_install" | "credential" | "audience" | "worker" | "backlog" | "binding" | null;
  lastVerifiedAtMs: number | null;
}

export interface SlackBridgeLifecyclePlan {
  bindingId: string;
  command: SlackBridgeWorkerCommand | null;
  probeRequests: SlackBridgeProbeRequest[];
  health: SlackBridgeHealthProjection;
}

export interface SlackBridgeWorkerEvent {
  bindingId: string;
  epoch: number;
  leaseId: string | null;
  state: SlackBridgeWorkerState;
  leaseOwnerId: string | null;
  leaseExpiresAtMs: number | null;
}

export interface SlackBridgeWorkerEventResult {
  accepted: boolean;
  reason: "accepted" | "binding_mismatch" | "stale_epoch" | "lease_mismatch";
  worker: SlackBridgeWorkerSnapshot;
}

export interface SlackBridgeLifecycleCommandContext {
  orchestratorId: string;
  nowMs: number;
}

export interface SlackBridgeLifecycleProbeContext {
  orchestratorId: string;
  nowMs: number;
}

export interface SlackBridgeLifecycleLoadContext {
  orchestratorId: string;
  nowMs: number;
  trigger: SlackBridgeProbeTrigger;
}

export interface SlackBridgeLifecyclePersistContext {
  orchestratorId: string;
  nowMs: number;
  trigger: SlackBridgeProbeTrigger;
}

export type SlackBridgeAudienceRefreshReason =
  | "authority_quarantined"
  | "credential_unavailable"
  | "identity_mapping_unavailable"
  | "provider_rate_limited"
  | "provider_unavailable";

export interface SlackBridgeAudienceRefreshReceipt {
  bindingId: string;
  audienceStatus: SlackBridgeAudienceStatus;
  observedAtMs: number;
  reason?: SlackBridgeAudienceRefreshReason;
  revision?: number;
}

export interface SlackBridgeLifecycleExecutionReceipt {
  bindingId: string;
  audienceRefresh: SlackBridgeAudienceRefreshReceipt;
  plan: SlackBridgeLifecyclePlan;
  commandExecuted: boolean;
  probeObservations: SlackBridgeProbeObservation[];
}

export interface SlackBridgePersistentWorkerDependencies {
  loadBindings(context: SlackBridgeLifecycleLoadContext): Promise<readonly SlackBridgeBindingRuntime[]>;
  refreshAudience(
    binding: SlackBridgeBindingRuntime,
    context: SlackBridgeLifecycleLoadContext,
  ): Promise<SlackBridgeAudienceRefreshReceipt>;
  executeCommand(command: SlackBridgeWorkerCommand, context: SlackBridgeLifecycleCommandContext): Promise<void>;
  runProbe(request: SlackBridgeProbeRequest, context: SlackBridgeLifecycleProbeContext): Promise<SlackBridgeProbeObservation>;
  persistReceipt(receipt: SlackBridgeLifecycleExecutionReceipt, context: SlackBridgeLifecyclePersistContext): Promise<void>;
  onError?(error: unknown): void;
}

export interface SlackBridgePersistentWorkerClock {
  scheduleEvery(fn: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}

export interface SlackBridgePersistentWorkerOptions {
  orchestratorId: string;
  intervalMs: number;
  probeFreshnessMs: number;
  maxPendingEvents: number;
  maxOldestPendingEventAgeMs: number;
  nowMs?: () => number;
  clock?: SlackBridgePersistentWorkerClock;
}

export type SlackBridgePersistentWorkerRunResult =
  | { kind: "stopped" }
  | { kind: "queued" }
  | { kind: "completed"; trigger: SlackBridgeProbeTrigger; bindingCount: number };

export interface SlackBridgePersistentWorker {
  requestReconcile(trigger?: SlackBridgeProbeTrigger): Promise<SlackBridgePersistentWorkerRunResult>;
  stop(): void;
}

const PROBE_SURFACES: readonly SlackBridgeProbeSurface[] = ["slack", "raft"];

const defaultPersistentWorkerClock: SlackBridgePersistentWorkerClock = {
  scheduleEvery: setClockInterval,
  clear: clearClockInterval,
};

function hasLivePeerLease(binding: SlackBridgeBindingRuntime, policy: SlackBridgeLifecyclePolicy): boolean {
  const { leaseOwnerId, leaseExpiresAtMs } = binding.worker;
  return Boolean(
    leaseOwnerId
      && leaseOwnerId !== policy.orchestratorId
      && leaseExpiresAtMs !== null
      && leaseExpiresAtMs > policy.nowMs,
  );
}

function isCurrentWorkerLease(binding: SlackBridgeBindingRuntime, policy: SlackBridgeLifecyclePolicy): boolean {
  const { leaseOwnerId, leaseExpiresAtMs } = binding.worker;
  return leaseOwnerId === policy.orchestratorId
    && leaseExpiresAtMs !== null
    && leaseExpiresAtMs > policy.nowMs;
}

function isProbeFresh(probe: SlackBridgeProbeObservation | undefined, policy: SlackBridgeLifecyclePolicy): boolean {
  return Boolean(probe && policy.nowMs - probe.observedAtMs <= policy.probeFreshnessMs);
}

function verifiedAt(probes: Partial<Record<SlackBridgeProbeSurface, SlackBridgeProbeObservation>>): number | null {
  const slack = probes.slack;
  const raft = probes.raft;
  if (!slack?.ok || !raft?.ok) return null;
  return Math.min(slack.observedAtMs, raft.observedAtMs);
}

function planCommand(binding: SlackBridgeBindingRuntime, policy: SlackBridgeLifecyclePolicy): SlackBridgeWorkerCommand | null {
  if (binding.mode !== "active") {
    if (binding.worker.state === "not_running") return null;
    return {
      type: "stop",
      bindingId: binding.bindingId,
      nextEpoch: binding.worker.epoch,
      reason: "inactive_binding",
    };
  }

  if (hasLivePeerLease(binding, policy)) return null;

  if (binding.worker.state === "failed") {
    return {
      type: "restart",
      bindingId: binding.bindingId,
      nextEpoch: Math.max(binding.desiredEpoch, binding.worker.epoch + 1),
      reason: "worker_failed",
    };
  }

  if (binding.worker.epoch < binding.desiredEpoch && isCurrentWorkerLease(binding, policy)) {
    return {
      type: "restart",
      bindingId: binding.bindingId,
      nextEpoch: binding.desiredEpoch,
      reason: "stale_worker_epoch",
    };
  }

  if (binding.worker.state !== "running" && binding.worker.state !== "starting") {
    return {
      type: "start",
      bindingId: binding.bindingId,
      nextEpoch: Math.max(binding.desiredEpoch, binding.worker.epoch + 1),
      reason: "active_binding_without_worker",
    };
  }

  return null;
}

function projectAuthorityHealth(authority: SlackBridgeAuthoritySnapshot | undefined): SlackBridgeHealthProjection | null {
  if (!authority) return null;

  switch (authority.appInstallState) {
    case "active":
      break;
    case "pending":
      return { state: "Unverified", reason: "app_install_pending", failingSurface: "app_install", lastVerifiedAtMs: null };
    case "reauth_required":
      return { state: "Degraded", reason: "app_reauth_required", failingSurface: "app_install", lastVerifiedAtMs: null };
    case "disconnected":
      return { state: "Disconnected", reason: "app_disconnected", failingSurface: "app_install", lastVerifiedAtMs: null };
    case "revoked":
      return { state: "Disconnected", reason: "app_revoked", failingSurface: "app_install", lastVerifiedAtMs: null };
    case "quarantined":
      return { state: "Degraded", reason: "app_quarantined", failingSurface: "app_install", lastVerifiedAtMs: null };
  }

  switch (authority.channelBindingState) {
    case "active":
      break;
    case "paused":
      return { state: "Disconnected", reason: "channel_binding_paused", failingSurface: "binding", lastVerifiedAtMs: null };
    case "revoked":
      return { state: "Disconnected", reason: "channel_binding_revoked", failingSurface: "binding", lastVerifiedAtMs: null };
    case "quarantined":
      return { state: "Degraded", reason: "channel_binding_quarantined", failingSurface: "binding", lastVerifiedAtMs: null };
  }

  switch (authority.credentialState) {
    case "active":
      break;
    case "persist_unknown":
      return { state: "Unverified", reason: "credential_persist_unknown", failingSurface: "credential", lastVerifiedAtMs: null };
    case "revoked":
      return { state: "Disconnected", reason: "credential_revoked", failingSurface: "credential", lastVerifiedAtMs: null };
  }

  switch (authority.audienceStatus) {
    case "matched":
      return null;
    case "mismatch":
      return { state: "Degraded", reason: "audience_mismatch", failingSurface: "audience", lastVerifiedAtMs: null };
    case "unavailable":
      return { state: "Unverified", reason: "audience_unavailable", failingSurface: "audience", lastVerifiedAtMs: null };
  }
}

function planProbeRequests(
  binding: SlackBridgeBindingRuntime,
  policy: SlackBridgeLifecyclePolicy,
): SlackBridgeProbeRequest[] {
  if (binding.mode !== "active") return [];
  if (hasLivePeerLease(binding, policy)) return [];
  if (binding.worker.state !== "running") return [];

  if (policy.trigger === "event") {
    return PROBE_SURFACES.map((surface) => ({ bindingId: binding.bindingId, surface, trigger: "event" }));
  }

  return PROBE_SURFACES
    .filter((surface) => !isProbeFresh(binding.probes[surface], policy))
    .map((surface) => ({ bindingId: binding.bindingId, surface, trigger: "periodic" }));
}

function projectHealth(binding: SlackBridgeBindingRuntime, policy: SlackBridgeLifecyclePolicy): SlackBridgeHealthProjection {
  const authorityHealth = projectAuthorityHealth(binding.authority);
  if (authorityHealth) return authorityHealth;

  if (binding.mode === "paused") {
    return { state: "Disconnected", reason: "binding_paused", failingSurface: "binding", lastVerifiedAtMs: null };
  }
  if (binding.mode === "disconnected") {
    return { state: "Disconnected", reason: "binding_disconnected", failingSurface: "binding", lastVerifiedAtMs: null };
  }
  if (hasLivePeerLease(binding, policy)) {
    return { state: "Unverified", reason: "lease_held_by_peer", failingSurface: "worker", lastVerifiedAtMs: null };
  }
  if (binding.worker.state === "failed") {
    return { state: "Degraded", reason: "worker_failed", failingSurface: "worker", lastVerifiedAtMs: null };
  }
  if (binding.worker.state !== "running") {
    return { state: "Unverified", reason: "worker_not_running", failingSurface: "worker", lastVerifiedAtMs: null };
  }
  if (binding.backlog.pendingEvents > policy.maxPendingEvents
    || binding.backlog.oldestPendingEventAgeMs > policy.maxOldestPendingEventAgeMs) {
    return { state: "Degraded", reason: "backlog_backpressure", failingSurface: "backlog", lastVerifiedAtMs: null };
  }

  for (const surface of PROBE_SURFACES) {
    const probe = binding.probes[surface];
    if (!probe) {
      return { state: "Unverified", reason: "probe_missing", failingSurface: surface, lastVerifiedAtMs: null };
    }
    if (!isProbeFresh(probe, policy)) {
      return { state: "Unverified", reason: "probe_stale", failingSurface: surface, lastVerifiedAtMs: null };
    }
    if (!probe.ok) {
      return {
        state: "Degraded",
        reason: surface === "slack" ? "slack_probe_failed" : "raft_probe_failed",
        failingSurface: surface,
        lastVerifiedAtMs: null,
      };
    }
  }

  return {
    state: "Connected",
    reason: null,
    failingSurface: null,
    lastVerifiedAtMs: verifiedAt(binding.probes),
  };
}

export function planSlackBridgeWorkerLifecycle(
  bindings: readonly SlackBridgeBindingRuntime[],
  policy: SlackBridgeLifecyclePolicy,
): SlackBridgeLifecyclePlan[] {
  return bindings.map((binding) => ({
    bindingId: binding.bindingId,
    command: planCommand(binding, policy),
    probeRequests: planProbeRequests(binding, policy),
    health: projectHealth(binding, policy),
  }));
}

export function applySlackBridgeWorkerEvent(
  current: SlackBridgeBindingRuntime,
  event: SlackBridgeWorkerEvent,
): SlackBridgeWorkerEventResult {
  if (event.bindingId !== current.bindingId) {
    return { accepted: false, reason: "binding_mismatch", worker: current.worker };
  }
  if (event.epoch < current.worker.epoch) {
    return { accepted: false, reason: "stale_epoch", worker: current.worker };
  }
  if (event.epoch === current.worker.epoch
    && current.worker.leaseId
    && event.leaseId !== current.worker.leaseId) {
    return { accepted: false, reason: "lease_mismatch", worker: current.worker };
  }
  return {
    accepted: true,
    reason: "accepted",
    worker: {
      state: event.state,
      epoch: event.epoch,
      leaseId: event.leaseId,
      leaseOwnerId: event.leaseOwnerId,
      leaseExpiresAtMs: event.leaseExpiresAtMs,
    },
  };
}

function mergePendingTrigger(
  current: SlackBridgeProbeTrigger | null,
  next: SlackBridgeProbeTrigger,
): SlackBridgeProbeTrigger {
  return current === "event" || next === "event" ? "event" : "periodic";
}

const AUDIENCE_REFRESH_REASONS: ReadonlySet<SlackBridgeAudienceRefreshReason> = new Set([
  "authority_quarantined",
  "credential_unavailable",
  "identity_mapping_unavailable",
  "provider_rate_limited",
  "provider_unavailable",
]);

function validateAudienceRefreshReceipt(
  binding: SlackBridgeBindingRuntime,
  receipt: SlackBridgeAudienceRefreshReceipt,
): void {
  if (
    receipt.bindingId !== binding.bindingId
    || !["matched", "mismatch", "unavailable"].includes(receipt.audienceStatus)
    || !Number.isFinite(receipt.observedAtMs)
    || (receipt.revision !== undefined
      && (!Number.isSafeInteger(receipt.revision) || receipt.revision <= 0))
    || (receipt.reason !== undefined && !AUDIENCE_REFRESH_REASONS.has(receipt.reason))
    || (receipt.audienceStatus !== "unavailable" && receipt.reason !== undefined)
  ) {
    throw new Error("Slack Bridge persistent worker audience refresh returned an invalid receipt");
  }
}

export function startSlackBridgePersistentWorker(
  dependencies: SlackBridgePersistentWorkerDependencies,
  options: SlackBridgePersistentWorkerOptions,
): SlackBridgePersistentWorker {
  if (!options.orchestratorId) {
    throw new Error("Slack Bridge persistent worker requires an orchestratorId");
  }
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("Slack Bridge persistent worker interval must be positive");
  }

  const clock = options.clock ?? defaultPersistentWorkerClock;
  const nowMs = options.nowMs ?? currentTimeMs;
  let stopped = false;
  let running = false;
  let pendingTrigger: SlackBridgeProbeTrigger | null = null;

  const runOnce = async (trigger: SlackBridgeProbeTrigger): Promise<SlackBridgePersistentWorkerRunResult> => {
    const observedNowMs = nowMs();
    const policy: SlackBridgeLifecyclePolicy = {
      orchestratorId: options.orchestratorId,
      nowMs: observedNowMs,
      probeFreshnessMs: options.probeFreshnessMs,
      maxPendingEvents: options.maxPendingEvents,
      maxOldestPendingEventAgeMs: options.maxOldestPendingEventAgeMs,
      trigger,
    };
    const loadContext: SlackBridgeLifecycleLoadContext = {
      orchestratorId: options.orchestratorId,
      nowMs: observedNowMs,
      trigger,
    };
    const bindings = await dependencies.loadBindings(loadContext);
    const refreshedBindings: SlackBridgeBindingRuntime[] = [];
    const audienceRefreshes = new Map<string, SlackBridgeAudienceRefreshReceipt>();
    for (const binding of bindings) {
      const audienceRefresh = await dependencies.refreshAudience(binding, loadContext);
      validateAudienceRefreshReceipt(binding, audienceRefresh);
      if (audienceRefreshes.has(binding.bindingId)) {
        throw new Error("Slack Bridge persistent worker loaded a duplicate binding");
      }
      audienceRefreshes.set(binding.bindingId, audienceRefresh);
      refreshedBindings.push(binding.authority
        ? {
            ...binding,
            authority: {
              ...binding.authority,
              audienceStatus: audienceRefresh.audienceStatus,
            },
          }
        : binding);
    }
    const plans = planSlackBridgeWorkerLifecycle(refreshedBindings, policy);

    for (const plan of plans) {
      const audienceRefresh = audienceRefreshes.get(plan.bindingId);
      if (!audienceRefresh) {
        throw new Error("Slack Bridge persistent worker plan is missing its audience refresh receipt");
      }
      let commandExecuted = false;
      const probeObservations: SlackBridgeProbeObservation[] = [];
      if (plan.command) {
        await dependencies.executeCommand(plan.command, {
          orchestratorId: options.orchestratorId,
          nowMs: observedNowMs,
        });
        commandExecuted = true;
      }
      for (const request of plan.probeRequests) {
        const observation = await dependencies.runProbe(request, {
          orchestratorId: options.orchestratorId,
          nowMs: observedNowMs,
        });
        if (
          observation.surface !== request.surface
          || observation.trigger !== request.trigger
          || !Number.isFinite(observation.observedAtMs)
        ) {
          throw new Error("Slack Bridge persistent worker probe returned an invalid observation");
        }
        probeObservations.push(observation);
      }
      await dependencies.persistReceipt({
        bindingId: plan.bindingId,
        audienceRefresh,
        plan,
        commandExecuted,
        probeObservations,
      }, {
        orchestratorId: options.orchestratorId,
        nowMs: observedNowMs,
        trigger,
      });
    }

    return { kind: "completed", trigger, bindingCount: refreshedBindings.length };
  };

  const drain = async (trigger: SlackBridgeProbeTrigger): Promise<SlackBridgePersistentWorkerRunResult> => {
    if (stopped) return { kind: "stopped" };
    if (running) {
      pendingTrigger = mergePendingTrigger(pendingTrigger, trigger);
      return { kind: "queued" };
    }

    running = true;
    try {
      let currentTrigger: SlackBridgeProbeTrigger | null = trigger;
      let lastResult: SlackBridgePersistentWorkerRunResult = { kind: "completed", trigger, bindingCount: 0 };
      while (currentTrigger && !stopped) {
        pendingTrigger = null;
        lastResult = await runOnce(currentTrigger);
        currentTrigger = pendingTrigger;
      }
      return stopped ? { kind: "stopped" } : lastResult;
    } catch (error) {
      dependencies.onError?.(error);
      throw error;
    } finally {
      running = false;
    }
  };

  const handle = clock.scheduleEvery(() => {
    void drain("periodic").catch((error) => dependencies.onError?.(error));
  }, options.intervalMs);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") {
    handle.unref();
  }

  return {
    requestReconcile(trigger: SlackBridgeProbeTrigger = "event") {
      return drain(trigger);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clock.clear(handle);
    },
  };
}
