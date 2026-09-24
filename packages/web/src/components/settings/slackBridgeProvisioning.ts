import { SLACK_BRIDGE_PREFLIGHT_CHECK_IDS } from "@botiverse/raft-shared";
import type {
  SlackBridgeChannelPair,
  SlackBridgePreflight,
  SlackBridgePreflightCheckId,
  SlackBridgeRawHealth,
  SlackBridgeSetupSnapshot,
} from "@botiverse/raft-shared";

export type {
  SlackBridgeChannelPair,
  SlackBridgePreflight,
  SlackBridgePreflightCheckId,
  SlackBridgeRawHealth,
  SlackBridgeSetupSnapshot,
  SlackBridgeSetupStage,
} from "@botiverse/raft-shared";

export type SlackBridgeHealthState = "connected" | "degraded" | "unverified" | "disconnected";
export type SlackBridgeHealthReason =
  | "healthy"
  | "install_missing"
  | "oauth_pending"
  | "reauth_required"
  | "install_disconnected"
  | "install_revoked"
  | "install_quarantined"
  | "credential_missing"
  | "credential_persist_unknown"
  | "credential_revoked"
  | "binding_required"
  | "binding_paused"
  | "binding_revoked"
  | "binding_quarantined"
  | "audience_mismatch"
  | "audience_unavailable"
  | "connection_failed"
  | "scope_mismatch"
  | "verification_required";
export type SlackBridgeHealthAction =
  | "none"
  | "connect"
  | "finish_oauth"
  | "reauthorize"
  | "reconnect"
  | "resolve_quarantine"
  | "verify_credential"
  | "configure_binding"
  | "resume_binding"
  | "repair_binding"
  | "repair_audience"
  | "retry_verification";

export interface SlackBridgeHealthProjection {
  state: SlackBridgeHealthState;
  reason: SlackBridgeHealthReason;
  action: SlackBridgeHealthAction;
  lastVerifiedAt: string | null;
  failingSurface: SlackBridgeRawHealth["failingSurface"];
}

function projected(
  raw: SlackBridgeRawHealth,
  state: SlackBridgeHealthState,
  reason: SlackBridgeHealthReason,
  action: SlackBridgeHealthAction,
): SlackBridgeHealthProjection {
  return {
    state,
    reason,
    action,
    lastVerifiedAt: raw.lastVerifiedAt,
    failingSurface: raw.failingSurface,
  };
}

/**
 * Product health is deliberately a projection over the persistence states,
 * never a replacement for them. Keep each raw failure distinguishable so the
 * UI can offer the correct recovery action.
 */
export function projectSlackBridgeHealth(raw: SlackBridgeRawHealth): SlackBridgeHealthProjection {
  if (!raw.install) return projected(raw, "disconnected", "install_missing", "connect");

  switch (raw.install.state) {
    case "pending":
      return projected(raw, "unverified", "oauth_pending", "finish_oauth");
    case "reauth_required":
      return projected(raw, "degraded", "reauth_required", "reauthorize");
    case "disconnected":
      return projected(raw, "disconnected", "install_disconnected", "reconnect");
    case "revoked":
      return projected(raw, "disconnected", "install_revoked", "reconnect");
    case "quarantined":
      return projected(raw, "degraded", "install_quarantined", "resolve_quarantine");
    case "active":
      break;
  }

  if (!raw.credential) return projected(raw, "unverified", "credential_missing", "verify_credential");
  if (raw.credential.state === "revoked") {
    return projected(raw, "disconnected", "credential_revoked", "reauthorize");
  }
  if (raw.credential.state === "persist_unknown") {
    return projected(raw, "unverified", "credential_persist_unknown", "verify_credential");
  }

  if (raw.bindings.length === 0) return projected(raw, "unverified", "binding_required", "configure_binding");
  // Binding rows have no contractually stable order. Preserve the most
  // restrictive actionable state with an explicit, order-independent
  // precedence: operator quarantine, then revoked authority, then pause.
  if (raw.bindings.some((binding) => binding.state === "quarantined")) {
    return projected(raw, "degraded", "binding_quarantined", "resolve_quarantine");
  }
  if (raw.bindings.some((binding) => binding.state === "revoked")) {
    return projected(raw, "degraded", "binding_revoked", "repair_binding");
  }
  if (raw.bindings.some((binding) => binding.state === "paused")) {
    return projected(raw, "degraded", "binding_paused", "resume_binding");
  }

  const bindingIds = new Set(raw.bindings.map((binding) => binding.id));
  if (raw.audiences.some((audience) => bindingIds.has(audience.bindingId) && audience.status === "mismatch")) {
    return projected(raw, "degraded", "audience_mismatch", "repair_audience");
  }
  if (raw.bindings.some((binding) => {
    const audience = raw.audiences.find((candidate) => candidate.bindingId === binding.id);
    return !audience || audience.status === "unavailable";
  })) {
    return projected(raw, "unverified", "audience_unavailable", "retry_verification");
  }
  if (raw.failingSurface === "connection") {
    return projected(raw, "degraded", "connection_failed", "reconnect");
  }
  if (raw.failingSurface === "scope") {
    return projected(raw, "degraded", "scope_mismatch", "reauthorize");
  }
  if (raw.failingSurface) {
    return projected(raw, "unverified", "verification_required", "retry_verification");
  }
  if (!raw.lastVerifiedAt) return projected(raw, "unverified", "verification_required", "retry_verification");

  return projected(raw, "connected", "healthy", "none");
}

export type SlackBridgeChannelPairValidation =
  | { valid: true }
  | {
    valid: false;
    reason: "pair_required" | "incomplete_pair" | "duplicate_raft_channel" | "duplicate_slack_channel";
  };

export function validateSlackBridgeChannelPairs(
  pairs: readonly SlackBridgeChannelPair[],
): SlackBridgeChannelPairValidation {
  if (pairs.length === 0) return { valid: false, reason: "pair_required" };
  const raftIds = new Set<string>();
  const slackIds = new Set<string>();
  for (const pair of pairs) {
    if (!pair.raftChannelId || !pair.slackChannelId) return { valid: false, reason: "incomplete_pair" };
    if (raftIds.has(pair.raftChannelId)) return { valid: false, reason: "duplicate_raft_channel" };
    if (slackIds.has(pair.slackChannelId)) return { valid: false, reason: "duplicate_slack_channel" };
    raftIds.add(pair.raftChannelId);
    slackIds.add(pair.slackChannelId);
  }
  return { valid: true };
}

export const SLACK_BRIDGE_REQUIRED_PREFLIGHT_CHECKS = SLACK_BRIDGE_PREFLIGHT_CHECK_IDS;

/**
 * The aggregate state is an upstream summary, not authority by itself. Enable
 * fails closed unless the required check set is closed, unique, and entirely
 * passed. This also rejects unexpected runtime values crossing a typed seam.
 */
export function isSlackBridgePreflightPassed(preflight: SlackBridgePreflight | null): boolean {
  if (!preflight || preflight.state !== "passed") return false;
  if (preflight.checks.length !== SLACK_BRIDGE_REQUIRED_PREFLIGHT_CHECKS.length) return false;

  const checks = new Map<SlackBridgePreflightCheckId, SlackBridgePreflight["checks"][number]["state"]>();
  for (const check of preflight.checks) {
    if (!SLACK_BRIDGE_REQUIRED_PREFLIGHT_CHECKS.includes(check.id) || checks.has(check.id)) return false;
    checks.set(check.id, check.state);
  }

  return SLACK_BRIDGE_REQUIRED_PREFLIGHT_CHECKS.every((id) => checks.get(id) === "passed");
}

export type SlackBridgeProvisioningView = { kind: "ready"; snapshot: SlackBridgeSetupSnapshot };

export type SlackBridgeOAuthResult =
  | { kind: "redirect"; url: string }
  | { kind: "view"; view: SlackBridgeProvisioningView };

/**
 * The setup surface depends only on this contract. The production adapter must
 * bind to a reviewed control-plane exact; tests use in-memory doubles and do
 * not imply a live provider is available.
 */
export interface SlackBridgeProvisioningProvider {
  load(): Promise<SlackBridgeProvisioningView>;
  connect(): Promise<SlackBridgeProvisioningView>;
  beginOAuth(): Promise<SlackBridgeOAuthResult>;
  saveChannelPairs(pairs: readonly SlackBridgeChannelPair[]): Promise<SlackBridgeProvisioningView>;
  removeChannelPair?(pair: SlackBridgeChannelPair & { expectedBindingEpoch: number }): Promise<SlackBridgeProvisioningView>;
  disconnect?(expectedConnectionEpoch: number): Promise<SlackBridgeProvisioningView>;
  runPreflight(): Promise<SlackBridgeProvisioningView>;
  enable(): Promise<SlackBridgeProvisioningView>;
}

/**
 * Runs the mechanical verification step and enables delivery only when the
 * server returns the complete passed check set. A failed preflight remains a
 * renderable view so the person setting up the bridge sees the exact recovery
 * surface instead of a generic operation error.
 */
export async function verifyAndEnableSlackBridge(
  provider: SlackBridgeProvisioningProvider,
): Promise<SlackBridgeProvisioningView> {
  const preflight = await provider.runPreflight();
  if (!isSlackBridgePreflightPassed(preflight.snapshot.preflight)) return preflight;
  return provider.enable();
}

/**
 * One explicit setup action saves the chosen channel pairs, verifies the
 * bridge, and enables delivery. OAuth consent and channel choice stay human;
 * the deterministic Next/Preflight/Enable transitions do not.
 */
export async function finishSlackBridgeSetup(input: {
  provider: SlackBridgeProvisioningProvider;
  pairs: readonly SlackBridgeChannelPair[];
}): Promise<SlackBridgeProvisioningView> {
  if (!validateSlackBridgeChannelPairs(input.pairs).valid) {
    throw new Error("slack_bridge_channel_pairs_invalid");
  }
  await input.provider.saveChannelPairs(input.pairs);
  return verifyAndEnableSlackBridge(input.provider);
}

export class SlackBridgePartialUpdateError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("slack_bridge_channel_pairs_partially_updated");
    this.name = "SlackBridgePartialUpdateError";
    this.cause = cause;
  }
}

function channelPairKey(pair: SlackBridgeChannelPair): string {
  return `${pair.raftChannelId}\u0000${pair.slackChannelId}`;
}

/**
 * Applies edits made from an already-connected health snapshot. Protected
 * bindings cannot be omitted from the aggregate PUT: removals therefore use
 * their exact binding epoch first, then additions are built over each DELETE
 * response so unrelated/concurrent pairs are preserved.
 */
export async function applyManagedSlackBridgeChannelPairs(input: {
  provider: SlackBridgeProvisioningProvider;
  baseline: SlackBridgeSetupSnapshot;
  desiredPairs: readonly SlackBridgeChannelPair[];
}): Promise<SlackBridgeProvisioningView> {
  const baselineKeys = new Set(input.baseline.channelPairs.map(channelPairKey));
  const desiredKeys = new Set(input.desiredPairs.map(channelPairKey));
  const removed = input.baseline.channelPairs.filter((pair) => !desiredKeys.has(channelPairKey(pair)));
  const additions = input.desiredPairs.filter((pair) => !baselineKeys.has(channelPairKey(pair)));

  if (removed.length === 0 && additions.length === 0) {
    return { kind: "ready", snapshot: input.baseline };
  }

  const removeChannelPair = input.provider.removeChannelPair;
  if (removed.length > 0 && !removeChannelPair) {
    throw new Error("slack_bridge_binding_removal_unavailable");
  }

  // Freeze and validate every destructive coordinate before the first DELETE.
  // A later missing coordinate must not leave an avoidable partial teardown.
  const removals = removed.map((pair) => {
    if (!Number.isInteger(pair.bindingEpoch) || (pair.bindingEpoch ?? 0) <= 0) {
      throw new Error("slack_bridge_binding_coordinates_unavailable");
    }
    return { ...pair, expectedBindingEpoch: pair.bindingEpoch as number };
  });

  let current = input.baseline;
  let confirmedRemovals = 0;
  const fail = (cause: unknown): never => {
    if (confirmedRemovals > 0) throw new SlackBridgePartialUpdateError(cause);
    throw cause;
  };

  for (const removal of removals) {
    const live = current.channelPairs.find((pair) => channelPairKey(pair) === channelPairKey(removal));
    if (!live || live.bindingEpoch !== removal.expectedBindingEpoch) {
      fail(new Error("slack_bridge_binding_epoch_stale"));
    }

    const removedView = await removeChannelPair!(removal).catch((cause) => fail(cause));
    if (removedView.snapshot.channelPairs.some((pair) => channelPairKey(pair) === channelPairKey(removal))) {
      fail(new Error("slack_bridge_binding_removal_not_observed"));
    }
    current = removedView.snapshot;
    confirmedRemovals += 1;
  }

  if (additions.length === 0) {
    return { kind: "ready", snapshot: current };
  }

  const currentKeys = new Set(current.channelPairs.map(channelPairKey));
  const freshPairs = [
    ...current.channelPairs.map(({ raftChannelId, slackChannelId }) => ({ raftChannelId, slackChannelId })),
    ...input.desiredPairs
      .filter((pair) => !currentKeys.has(channelPairKey(pair)))
      .map(({ raftChannelId, slackChannelId }) => ({ raftChannelId, slackChannelId })),
  ];
  if (!validateSlackBridgeChannelPairs(freshPairs).valid) {
    fail(new Error("slack_bridge_channel_pairs_invalid_after_removal"));
  }

  try {
    await input.provider.saveChannelPairs(freshPairs);
    const finished = await verifyAndEnableSlackBridge(input.provider);
    if (!isSlackBridgePreflightPassed(finished.snapshot.preflight)) {
      throw new Error("slack_bridge_preflight_failed");
    }
    return finished;
  } catch (cause) {
    return fail(cause);
  }
}
