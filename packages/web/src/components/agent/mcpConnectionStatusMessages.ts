import type { MessageId } from "../../i18n/messages";
import type { McpConnectionStatus } from "../settings/mcpApps/mcpAppApi";

// Its own module so the Connect card's candidates (McpConnectionCandidates, in
// a message row) don't pull the whole connection drawer into the first download.

/** A Connection's status, worded as the App's Connections section words it. */
export const CONNECTION_STATUS_MESSAGE_ID: Record<McpConnectionStatus, MessageId> = {
  ready: "settings.mcpApp.connections.status.ready",
  pending: "settings.mcpApp.connections.status.pending",
  needs_auth: "settings.mcpApp.connections.status.needsAuth",
  expired: "settings.mcpApp.connections.status.expired",
  error: "settings.mcpApp.connections.status.error",
};
