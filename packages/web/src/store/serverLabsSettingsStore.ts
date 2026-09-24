import { useCallback, useSyncExternalStore } from "react";

import api from "../api/client";
import {
  normalizeServerLabSettingsReadback,
} from "../utils/serverLabsSettings";
import type {
  CanonicalServerLabSettingsReadback,
  ServerLabSettingsReadback,
  ServerLabsMessageId,
} from "../utils/serverLabsSettings";
import { publishServerFeatureFlagValuesFromLabsReadback } from "./serverFeatureFlags";
import { useServerStore } from "./serverStore";

export interface ServerLabsStoreContext {
  serverId: string;
  serverEpoch: number;
  token: number;
}

export interface ServerLabsSettingsSnapshot {
  serverId: string | null;
  serverEpoch: number | null;
  readback: ServerLabSettingsReadback | null;
  loading: boolean;
  unavailable: boolean;
  errorId: ServerLabsMessageId | null;
}

const EMPTY_SERVER_LABS_SNAPSHOT: ServerLabsSettingsSnapshot = Object.freeze({
  serverId: null,
  serverEpoch: null,
  readback: null,
  loading: false,
  unavailable: false,
  errorId: null,
});

const snapshots = new Map<string, ServerLabsSettingsSnapshot>();
const latestLoadTokens = new Map<string, number>();
const latestMutationTokens = new Map<string, number>();
const listeners = new Set<() => void>();
let requestToken = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function isActiveServerLabsContext(context: ServerLabsStoreContext): boolean {
  const serverState = useServerStore.getState();
  return serverState.current?.id === context.serverId
    && serverState.serverEpoch === context.serverEpoch;
}

function currentSnapshot(context: ServerLabsStoreContext): ServerLabsSettingsSnapshot {
  return snapshots.get(context.serverId) ?? {
    ...EMPTY_SERVER_LABS_SNAPSHOT,
    serverId: context.serverId,
    serverEpoch: context.serverEpoch,
  };
}

function publishSnapshot(snapshot: ServerLabsSettingsSnapshot): void {
  if (!snapshot.serverId) return;
  snapshots.set(snapshot.serverId, Object.freeze(snapshot));
  notify();
}

function shouldPublishReadback(
  existing: ServerLabsSettingsSnapshot,
  context: ServerLabsStoreContext,
  readback: ServerLabSettingsReadback,
): boolean {
  if (readback.serverId !== context.serverId) return false;
  if (!isActiveServerLabsContext(context)) return false;
  if (existing.serverEpoch !== null && existing.serverEpoch > context.serverEpoch) return false;
  if (
    existing.serverEpoch === context.serverEpoch
    && existing.readback
    && existing.readback.serverLabVersion > readback.serverLabVersion
  ) {
    return false;
  }
  return true;
}

export function createServerLabsStoreContext(
  serverId: string,
  serverEpoch: number,
): ServerLabsStoreContext {
  requestToken += 1;
  return { serverId, serverEpoch, token: requestToken };
}

export function subscribeServerLabsSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getServerLabsSettingsSnapshot(
  serverId: string | null | undefined,
  serverEpoch: number,
): ServerLabsSettingsSnapshot {
  if (!serverId) return EMPTY_SERVER_LABS_SNAPSHOT;
  const snapshot = snapshots.get(serverId);
  if (snapshot?.serverEpoch === serverEpoch) return snapshot;
  const created = Object.freeze({
    ...EMPTY_SERVER_LABS_SNAPSHOT,
    serverId,
    serverEpoch,
  });
  snapshots.set(serverId, created);
  return created;
}

export function useServerLabsSettingsSnapshot(
  serverId: string | null | undefined,
  serverEpoch: number,
): ServerLabsSettingsSnapshot {
  const subscribe = useCallback((listener: () => void) => subscribeServerLabsSettings(listener), []);
  return useSyncExternalStore(
    subscribe,
    () => getServerLabsSettingsSnapshot(serverId, serverEpoch),
    () => EMPTY_SERVER_LABS_SNAPSHOT,
  );
}

export function beginServerLabsMutation(context: ServerLabsStoreContext): void {
  latestMutationTokens.set(context.serverId, context.token);
}

export function publishServerLabsReadback(
  context: ServerLabsStoreContext,
  readback: ServerLabSettingsReadback,
  source: "load" | "mutation",
): boolean {
  if (source === "load" && latestLoadTokens.get(context.serverId) !== context.token) return false;
  if (source === "mutation" && latestMutationTokens.get(context.serverId) !== context.token) return false;

  const existing = currentSnapshot(context);
  if (!shouldPublishReadback(existing, context, readback)) return false;

  publishSnapshot({
    serverId: context.serverId,
    serverEpoch: context.serverEpoch,
    readback,
    loading: false,
    unavailable: false,
    errorId: null,
  });
  publishServerFeatureFlagValuesFromLabsReadback(readback);
  return true;
}

export function failServerLabsMutation(
  context: ServerLabsStoreContext,
  errorId: ServerLabsMessageId,
): boolean {
  if (latestMutationTokens.get(context.serverId) !== context.token) return false;
  if (!isActiveServerLabsContext(context)) return false;
  const existing = currentSnapshot(context);
  if (existing.serverEpoch !== null && existing.serverEpoch !== context.serverEpoch) return false;
  publishSnapshot({
    ...existing,
    serverId: context.serverId,
    serverEpoch: context.serverEpoch,
    loading: false,
    unavailable: false,
    errorId,
  });
  return true;
}

function failServerLabsLoad(
  context: ServerLabsStoreContext,
  errorId: ServerLabsMessageId,
): boolean {
  if (latestLoadTokens.get(context.serverId) !== context.token) return false;
  if (!isActiveServerLabsContext(context)) return false;
  const existing = currentSnapshot(context);
  if (existing.serverEpoch !== null && existing.serverEpoch !== context.serverEpoch) return false;
  publishSnapshot({
    ...existing,
    serverId: context.serverId,
    serverEpoch: context.serverEpoch,
    loading: false,
    unavailable: false,
    errorId,
  });
  return true;
}

export async function loadServerLabsSettings(context: ServerLabsStoreContext): Promise<void> {
  latestLoadTokens.set(context.serverId, context.token);
  publishSnapshot({
    serverId: context.serverId,
    serverEpoch: context.serverEpoch,
    readback: null,
    loading: true,
    unavailable: false,
    errorId: null,
  });
  try {
    const response = await api.get<
      ServerLabSettingsReadback
      | CanonicalServerLabSettingsReadback
      | { data: ServerLabSettingsReadback | CanonicalServerLabSettingsReadback }
    >(`/servers/${context.serverId}/labs`);
    const normalized = normalizeServerLabSettingsReadback(response.data);
    if (normalized.serverId !== context.serverId) {
      failServerLabsLoad(context, "settings.labs.failedServerMismatch");
      return;
    }
    publishServerLabsReadback(context, normalized, "load");
  } catch (err: any) {
    if (latestLoadTokens.get(context.serverId) !== context.token || !isActiveServerLabsContext(context)) return;
    if (err.response?.status === 404) {
      publishSnapshot({
        serverId: context.serverId,
        serverEpoch: context.serverEpoch,
        readback: null,
        loading: false,
        unavailable: true,
        errorId: null,
      });
      return;
    }
    publishSnapshot({
      ...currentSnapshot(context),
      serverId: context.serverId,
      serverEpoch: context.serverEpoch,
      loading: false,
      unavailable: false,
      errorId: "settings.labs.failedLoad",
    });
  }
}

export function resetServerLabsSettingsForSession(): void {
  requestToken += 1;
  snapshots.clear();
  latestLoadTokens.clear();
  latestMutationTokens.clear();
  notify();
}

export function resetServerLabsSettingsForTests(): void {
  resetServerLabsSettingsForSession();
}
