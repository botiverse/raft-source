import { SERVER_FEATURES_CHANGED_SOCKET_EVENT, currentRandomUnit } from "@botiverse/raft-shared";
import type { ServerFeaturesChangedEvent } from "@botiverse/raft-shared";

import {
  scheduleAllServerFeatureFlagsReReadOnReconnect,
  scheduleServerFeatureFlagsReReadOnChange,
} from "./serverFeatureFlags";

export type FeatureFlagRealtimeSocket = {
  on: (event: string, handler: (...args: unknown[]) => void) => unknown;
  off: (event: string, handler: (...args: unknown[]) => void) => unknown;
  connected?: boolean;
};

/**
 * Open tabs follow server feature-flag changes (#proj-workspace:#33): the
 * Server's `server:features-changed` notice re-reads that server's flags, and
 * a reconnect re-reads every server this tab evaluated, because notices sent
 * while the socket was down are not replayed (shared/featuresChanged.ts). The
 * first connect reads nothing extra: flags are evaluated on first ask. A
 * socket already connected when this registers has had its first connect.
 */
export function registerFeatureFlagRealtimeHandlers(
  socket: FeatureFlagRealtimeSocket,
  random: () => number = currentRandomUnit,
): () => void {
  let connectedBefore = socket.connected === true;
  const handleFeaturesChanged = (data: unknown) => {
    const serverId = (data as Partial<ServerFeaturesChangedEvent> | null)?.serverId;
    if (typeof serverId === "string") scheduleServerFeatureFlagsReReadOnChange(serverId, random);
  };
  const handleConnect = () => {
    if (connectedBefore) scheduleAllServerFeatureFlagsReReadOnReconnect(random);
    connectedBefore = true;
  };

  socket.on(SERVER_FEATURES_CHANGED_SOCKET_EVENT, handleFeaturesChanged);
  socket.on("connect", handleConnect);
  return () => {
    socket.off(SERVER_FEATURES_CHANGED_SOCKET_EVENT, handleFeaturesChanged);
    socket.off("connect", handleConnect);
  };
}
