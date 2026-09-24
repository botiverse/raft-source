import api from "../api/client";
import { registerServerReset } from "./serverResetRegistry";
import { useMessageStore } from "./messageStore";
import {
  reactionReadModelStore,
} from "./reactionReadModels";
import type {
  VersionedReactionViewerSnapshot,
  VersionedReactionViewerSnapshotOutcome,
} from "./reactionReadModels";
import { useServerStore } from "./serverStore";

const pendingHydrates = new Map<string, Promise<VersionedReactionViewerSnapshotOutcome>>();

function hydrateKey(
  principalId: string,
  serverId: string,
  messageId: string,
): string {
  return JSON.stringify([principalId, serverId, messageId]);
}

export function applyReactionViewerSnapshotForCurrentPrincipal(
  snapshot: VersionedReactionViewerSnapshot,
  principalId = useMessageStore.getState().currentUserId,
): VersionedReactionViewerSnapshotOutcome {
  if (
    !principalId
    || useServerStore.getState().current?.id !== snapshot.serverId
    || useMessageStore.getState().currentUserId !== principalId
  ) {
    return { kind: "conflict", reason: "principal-mismatch" };
  }
  const outcome = reactionReadModelStore
    .getState()
    .applyVersionedViewerOverlaySnapshot(principalId, snapshot);
  if (outcome.kind === "conflict") {
    console.error("[MessageV2] reaction viewer snapshot fail-stop", {
      messageId: snapshot.messageId,
      viewerVersion: snapshot.viewerVersion,
      reason: outcome.reason,
    });
  }
  return outcome;
}

export function hydrateReactionViewerSnapshot(input: {
  principalId: string;
  serverId: string;
  messageId: string;
}): Promise<VersionedReactionViewerSnapshotOutcome> {
  const key = hydrateKey(input.principalId, input.serverId, input.messageId);
  const existing = pendingHydrates.get(key);
  if (existing) return existing;

  const request = api
    .get<VersionedReactionViewerSnapshot>(`/messages/${input.messageId}/reactions/viewer`)
    .then(({ data }) => applyReactionViewerSnapshotForCurrentPrincipal(data, input.principalId))
    .finally(() => {
      if (pendingHydrates.get(key) === request) pendingHydrates.delete(key);
    });
  pendingHydrates.set(key, request);
  return request;
}

export function resetReactionViewerHydratesForTests(): void {
  pendingHydrates.clear();
}

registerServerReset(resetReactionViewerHydratesForTests);
