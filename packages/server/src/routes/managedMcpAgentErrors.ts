// What an agent reads when a managed MCP call fails (Computer agents through
// the daemon, hosted agents through raft-sdk: both get this string from the
// agent API, so they read the same words). Every message ends in something
// the agent can do (Sage, AX). Codes are unchanged; the admin Settings routes
// keep their own messages.

import { flattenManagedMcpPromptText, formatManagedMcpPromptName, formatManagedMcpRuntimeToolPrefix } from "@botiverse/raft-shared";

// Names come from the remote MCP server or the connector's setup: quoted on one line so they cannot break out of the sentence.
function promptName(value: string | null | undefined): string | null {
  return value && flattenManagedMcpPromptText(value) ? formatManagedMcpPromptName(value) : null;
}

const RECONNECT_CODES = new Set(["managed_mcp_oauth_required", "managed_mcp_oauth_invalid_state"]);
const CREDENTIAL_CODES = new Set(["managed_mcp_auth_invalid", "managed_mcp_endpoint_auth_rejected", "managed_mcp_credential_invalid"]);
const STALE_CODES = new Set(["managed_mcp_config_stale", "managed_mcp_assignment_stale", "managed_mcp_tool_not_allowed"]);
const UNAVAILABLE_CODES = new Set(["managed_mcp_unreachable", "managed_mcp_oauth_busy"]);
const GONE_CODES = new Set(["managed_mcp_server_not_found", "managed_mcp_server_disabled"]);

const HANDOFF = "Tell the person who asked; retrying will not help until then.";

/** The agent-facing message for `code`, or null to keep the original one. */
export function managedMcpAgentErrorMessage(code: string, context: { serverName?: string | null; toolName?: string | null; mcpServerId?: string | null }): string | null {
  const server = promptName(context.serverName) ?? "This MCP connector";
  if (RECONNECT_CODES.has(code)) {
    return `${server} is disconnected; someone who manages this server's integrations has to reconnect it in Raft. ${HANDOFF}`;
  }
  if (CREDENTIAL_CODES.has(code)) {
    return `${server} rejected the credentials Raft holds for it; someone who manages this server's integrations has to update them in Raft. ${HANDOFF}`;
  }
  if (STALE_CODES.has(code)) {
    const tool = promptName(context.toolName);
    // True whether or not the caller's tool list has refreshed yet (the daemon keeps its list for the session).
    return `${tool ? `${tool} is` : "This tool is"} no longer offered by ${promptName(context.serverName) ?? "this MCP connector"}; don't call it again. If you still need it, tell the person who asked.`;
  }
  if (GONE_CODES.has(code)) {
    // Removed or disabled by an admin mid-session; the caller's tool list may still show it.
    // Name it the way the agent sees it: the id segment in its tools' names (hosted runtimes add a mount prefix such as raft__; a deleted connector has no name left).
    const prefix = context.mcpServerId ? ` (its tools' names contain ${formatManagedMcpRuntimeToolPrefix(context.mcpServerId)})` : "";
    return `${server}${prefix} is no longer available to you; don't call its tools again. If you still need it, tell the person who asked.`;
  }
  if (code === "managed_mcp_endpoint_blocked") {
    return `${server} was blocked by the server's network security check. Ask a server administrator to check its network or proxy settings; do not retry until this is resolved.`;
  }
  if (UNAVAILABLE_CODES.has(code)) {
    return `${server} can't be reached right now; try again in a minute, and if it keeps failing, tell the person who asked.`;
  }
  return null;
}
