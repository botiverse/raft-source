import {
  AGENT_MIGRATION_FEATURE_FLAG_KEY,
  CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY,
  CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY,
  COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
  SERVER_LABS_UI_FEATURE_FLAG_KEY,
  RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY,
  THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  SERVER_GUEST_FEATURE_FLAG_KEY,
  TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
  WIKI_FEATURE_FLAG_KEY,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { useCallback, useSyncExternalStore } from "react";

import api from "../api/client";
import { isServerLabEffectivelyEnabled } from "../utils/serverLabsSettings";
import type { ServerLabSettingsReadback } from "../utils/serverLabsSettings";
import { useServerStore } from "./serverStore";

export const SYNC_CORE_MESSAGES_FLAG_KEY = "sync_core_messages_v0";
export const SYNC_CORE_NOTIFICATION_PREFS_FLAG_KEY = "sync_core_notification_prefs_v0";
export const ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY = "attachment_comments_v0";
export const READ_RECEIPTS_FEATURE_FLAG_KEY = "read_receipts_v0";
export const ACTIVITY_SIDEBAR_INBOX_FLAG_KEY = "activity_sidebar_inbox_v0";

const SERVER_FEATURE_FLAG_REGISTRY = {
  activitySidebarInbox: ACTIVITY_SIDEBAR_INBOX_FLAG_KEY,
  agentMigration: AGENT_MIGRATION_FEATURE_FLAG_KEY,
  attachmentComments: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  chatGridLayout: CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY,
  channelManagerRoleActions: CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY,
  composerResourceReferences: COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY,
  readReceipts: READ_RECEIPTS_FEATURE_FLAG_KEY,
  providerConnections: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  publicServer: PUBLIC_SERVER_FEATURE_FLAG_KEY,
  runtimeAccountUsage: RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY,
  threadAgentFollowerManagement: THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY,
  serverLabsUi: SERVER_LABS_UI_FEATURE_FLAG_KEY,
  slackBridge: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
  serverGuest: SERVER_GUEST_FEATURE_FLAG_KEY,
  syncCoreMessages: SYNC_CORE_MESSAGES_FLAG_KEY,
  syncCoreNotificationPrefs: SYNC_CORE_NOTIFICATION_PREFS_FLAG_KEY,
  topbarOverflow: TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
  wiki: WIKI_FEATURE_FLAG_KEY,
} as const;

export const REGISTERED_SERVER_FEATURE_FLAG_KEYS = Object.freeze(
  Object.values(SERVER_FEATURE_FLAG_REGISTRY).sort(),
);

export type RegisteredServerFeatureFlagKey =
  (typeof REGISTERED_SERVER_FEATURE_FLAG_KEYS)[number];

type FeatureFlagEvaluateResponse = {
  evaluations: Array<{ key: string; enabled: boolean }>;
};

export type ServerFeatureFlagSnapshot = Readonly<{
  serverId: string | null;
  resolved: boolean;
  values: Readonly<Record<string, boolean>>;
}>;

const noServerSnapshot: ServerFeatureFlagSnapshot = Object.freeze({
  serverId: null,
  resolved: false,
  values: Object.freeze({}),
});

const snapshots = new Map<string, ServerFeatureFlagSnapshot>();
const pending = new Map<string, Promise<ServerFeatureFlagSnapshot>>();
const serverGenerations = new Map<string, number>();
const labDerivedValues = new Map<string, Readonly<Record<string, boolean>>>();
const listeners = new Set<() => void>();
let generation = 0;
let retryBackoffMs = 250;

function disabledValues(): Readonly<Record<string, boolean>> {
  return Object.freeze(Object.fromEntries(
    REGISTERED_SERVER_FEATURE_FLAG_KEYS.map((key) => [key, false]),
  ));
}

function unresolvedSnapshot(serverId: string): ServerFeatureFlagSnapshot {
  const existing = snapshots.get(serverId);
  if (existing) return existing;
  const created = Object.freeze({
    serverId,
    resolved: false,
    values: disabledValues(),
  });
  snapshots.set(serverId, created);
  return created;
}

function publish(snapshot: ServerFeatureFlagSnapshot): void {
  if (!snapshot.serverId) return;
  snapshots.set(snapshot.serverId, applyLabDerivedValues(snapshot));
  for (const listener of listeners) listener();
}

function applyLabDerivedValues(snapshot: ServerFeatureFlagSnapshot): ServerFeatureFlagSnapshot {
  if (!snapshot.serverId) return snapshot;
  const derived = labDerivedValues.get(snapshot.serverId);
  if (!derived) return snapshot;
  return Object.freeze({
    serverId: snapshot.serverId,
    resolved: snapshot.resolved,
    values: Object.freeze({
      ...snapshot.values,
      ...derived,
    }),
  });
}

function getServerGeneration(serverId: string): number {
  return serverGenerations.get(serverId) ?? 0;
}

function bumpServerGeneration(serverId: string): number {
  const next = getServerGeneration(serverId) + 1;
  serverGenerations.set(serverId, next);
  return next;
}

function waitForRetryBackoff(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setClockTimeout(resolve, ms);
  });
}

async function evaluateRegisteredServerFeatureFlags(
  serverId: string,
): Promise<ServerFeatureFlagSnapshot> {
  const response = await api.post<FeatureFlagEvaluateResponse>("/feature-flags/evaluate", {
    serverId,
    platform: "web",
    keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
  });
  const values = Object.fromEntries(
    REGISTERED_SERVER_FEATURE_FLAG_KEYS.map((key) => [key, false]),
  );
  for (const evaluation of response.data.evaluations) {
    if (Object.hasOwn(values, evaluation.key)) {
      values[evaluation.key] = evaluation.enabled === true;
    }
  }
  return Object.freeze({
    serverId,
    resolved: true,
    values: Object.freeze(values),
  });
}

export function subscribeServerFeatureFlags(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getServerFeatureFlagSnapshot(
  serverId: string | null | undefined,
): ServerFeatureFlagSnapshot {
  return serverId ? unresolvedSnapshot(serverId) : noServerSnapshot;
}

export function prefetchServerFeatureFlags(
  serverId: string | null | undefined,
): Promise<ServerFeatureFlagSnapshot> {
  return prefetchServerFeatureFlagsInternal(serverId, false);
}

function prefetchServerFeatureFlagsInternal(
  serverId: string | null | undefined,
  forceRefresh: boolean,
): Promise<ServerFeatureFlagSnapshot> {
  if (!serverId) return Promise.resolve(noServerSnapshot);

  const cached = snapshots.get(serverId);
  if (!forceRefresh && cached?.resolved) return Promise.resolve(cached);

  const inFlight = pending.get(serverId);
  if (!forceRefresh && inFlight) return inFlight;

  const requestGeneration = generation;
  const requestServerGeneration = getServerGeneration(serverId);
  const requestRetryBackoffMs = retryBackoffMs;
  const request = evaluateRegisteredServerFeatureFlags(serverId).catch(async () => {
    await waitForRetryBackoff(requestRetryBackoffMs);
    if (generation !== requestGeneration || getServerGeneration(serverId) !== requestServerGeneration) {
      return Object.freeze({
        serverId,
        resolved: true,
        values: disabledValues(),
      });
    }
    return evaluateRegisteredServerFeatureFlags(serverId);
  }).catch(() => Object.freeze({
    serverId,
    resolved: true,
    values: disabledValues(),
  })).then((snapshot) => {
    if (generation === requestGeneration && getServerGeneration(serverId) === requestServerGeneration) publish(snapshot);
    return snapshot;
  }).finally(() => {
    if (pending.get(serverId) === request) pending.delete(serverId);
  });

  pending.set(serverId, request);
  return request;
}

export function refreshServerFeatureFlags(
  serverId: string | null | undefined,
): Promise<ServerFeatureFlagSnapshot> {
  if (!serverId) return Promise.resolve(noServerSnapshot);
  bumpServerGeneration(serverId);
  pending.delete(serverId);
  return prefetchServerFeatureFlagsInternal(serverId, true);
}

export function publishServerFeatureFlagValuesFromLabsReadback(
  readback: ServerLabSettingsReadback,
): void {
  const snapshot = getServerFeatureFlagSnapshot(readback.serverId);
  const values: Record<string, boolean> = { ...snapshot.values };
  const previous = labDerivedValues.get(readback.serverId);
  const derived: Record<string, boolean> = {};
  if (previous) {
    for (const key of Object.keys(previous)) {
      values[key] = false;
      derived[key] = false;
    }
  }
  for (const lab of readback.labs) {
    if (Object.hasOwn(values, lab.key)) {
      const enabled = isServerLabEffectivelyEnabled(readback.masterEnabled, lab);
      values[lab.key] = enabled;
      derived[lab.key] = enabled;
    }
  }
  const touched = Object.keys(derived).length > 0;
  if (touched) {
    labDerivedValues.set(readback.serverId, Object.freeze(derived));
  } else {
    labDerivedValues.delete(readback.serverId);
  }
  if (!touched && !previous) return;
  publish(Object.freeze({
    serverId: readback.serverId,
    resolved: snapshot.resolved,
    values: Object.freeze(values),
  }));
}

export function readServerFeatureFlag(
  serverId: string | null | undefined,
  key: RegisteredServerFeatureFlagKey,
): boolean {
  const snapshot = getServerFeatureFlagSnapshot(serverId);
  return snapshot.values[key] === true;
}

export function useServerFeatureFlag(
  key: RegisteredServerFeatureFlagKey,
  options: { prefetch?: boolean } = {},
): { resolved: boolean; enabled: boolean } {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = subscribeServerFeatureFlags(listener);
    if (options.prefetch !== false) void prefetchServerFeatureFlags(serverId);
    return unsubscribe;
  }, [options.prefetch, serverId]);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => getServerFeatureFlagSnapshot(serverId),
    () => noServerSnapshot,
  );

  return {
    resolved: snapshot.resolved,
    enabled: snapshot.values[key] === true,
  };
}

export function resetServerFeatureFlagsForSession(): void {
  generation += 1;
  pending.clear();
  snapshots.clear();
  serverGenerations.clear();
  labDerivedValues.clear();
  for (const listener of listeners) listener();
}

export function resetServerFeatureFlagsForTests(): void {
  retryBackoffMs = 250;
  resetServerFeatureFlagsForSession();
}

/** Seed one resolved flag for component tests without going through HTTP. */
export function setServerFeatureFlagForTests(
  serverId: string,
  key: RegisteredServerFeatureFlagKey,
  enabled: boolean,
): void {
  const snapshot = getServerFeatureFlagSnapshot(serverId);
  const values = Object.freeze({ ...snapshot.values, [key]: enabled });
  publish(Object.freeze({
    serverId,
    resolved: true,
    values,
  }));
}

export function setServerFeatureFlagRetryBackoffForTests(ms: number): void {
  retryBackoffMs = ms;
}
