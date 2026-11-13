// Managed MCP on the OAR host (#oar-raft:#8): the launch's managed MCP proxy
// endpoint (managedMcpRuntimeProxy.ts) as one `SessionOptions.mcpServers`
// entry, which each OAR runtime hands to its runtime through its own channel.
//
// The entry is streamable HTTP to the loopback proxy, `<base>/mcp`, with the
// launch's proxy token as `Authorization: Bearer`. It is never in the URL,
// argv, the system prompt or the runtime's environment. `McpServer` has no env
// reference form (codex's `bearer_token_env_var`), so the header is the only
// way to give it. Where each runtime puts it:
//
// - codex: `config.mcp_servers.<name>.http_headers` on `thread/start` and
//   `thread/resume`, over the app-server's stdin; OAR passes every error codex
//   reports for the session through a redactor that strips the value
//   (pinned by oarCodexLaunch.test.ts against OAR's own `codexThreadOpen`).
// - grok: ACP `mcpServers[].headers` on `session/new` / `session/resume`
//   (stdin). Grok declares `mcpCapabilities.http`.
// - qwen (at or above QWEN_MIN_HTTP_MCP_VERSION): the stream-json
//   `initialize` control request's `mcpServers` (stdin).
//
// The transport is verified (stdin, never argv or env). What a runtime then
// writes to its own disk is verified only for some: OAR found agy storing
// entries (below), and OAR's post-exit scan of an isolated HOME after qwen
// 0.26.1 found no MCP credential. Codex's and grok's stores have not been
// audited for it, and Raft has not checked any runtime's disk itself. The
// bound if one does keep it: the
// token is per launch, accepted only on the loopback proxy, revoked when the
// launch is cleaned up, and reaches only this agent's own managed MCP tools
// (the Server checks each call against the agent's assignment). It never
// carries the connector's own credential.
//
// Not attached through `mcpServers`:
//
// - qoder: OAR writes `mcpServers` to a 0600 `--mcp-config` file in a private
//   temporary directory for the process's lifetime. The agent runs as the same
//   OS user, so it could read the token there. Qoder had no managed MCP
//   before, and Raft does not put the token in a file the agent can read for a
//   runtime that never had one. Qoder stays without managed MCP.
// - antigravity: OAR refuses an entry carrying `headers` or `env`
//   (`refusedSessionOptions.mcpServerCredentials`): `agy` writes session MCP
//   entries in plain text to its conversation database, which outlives the
//   session. Raft's only entry always carries the launch token, so
//   Antigravity keeps the workspace `.agents/mcp_config.json`
//   (oarAntigravityLaunch.ts). Moving the token into the URL would get past
//   OAR's check, but the token would end up in that database anyway.

import type { McpServer } from "@botiverse/oar";
import type { SpawnContext } from "../drivers/types";
import { prepareManagedMcpRuntimeProxy, type ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";

/** The launch's proxy endpoint as a session MCP server: HTTP, token in a bearer header. */
export function managedMcpSessionServer(endpoint: Pick<ManagedMcpRuntimeEndpoint, "name" | "endpointUrl" | "token">): McpServer {
  return {
    name: endpoint.name,
    type: "http",
    url: endpoint.endpointUrl,
    headers: { Authorization: `Bearer ${endpoint.token}` },
  };
}

/** `SessionOptions.mcpServers` for a launch: the managed server, or nothing to add. */
export function managedMcpSessionOptions(
  endpoint: Pick<ManagedMcpRuntimeEndpoint, "name" | "endpointUrl" | "token"> | null | undefined,
): { mcpServers?: McpServer[] } {
  return endpoint ? { mcpServers: [managedMcpSessionServer(endpoint)] } : {};
}

/**
 * The launch's managed MCP proxy for a runtime that has had no managed MCP
 * before (grok, qwen), registered only when the agent has managed MCP tools
 * and `admit` (a runtime's own condition) agrees. Otherwise nothing is
 * registered and no token is minted: the agent launches as before, without
 * an empty extra server. Registered under the launch, so the host's launch
 * cleanup (`cleanupLaunchProxiesForLaunch`) revokes it, including after a
 * failed open.
 */
export async function prepareOarManagedMcp(
  ctx: SpawnContext,
  admit: () => boolean | Promise<boolean> = () => true,
): Promise<ManagedMcpRuntimeEndpoint | null> {
  return prepareManagedMcpRuntimeProxy({
    agentId: ctx.agentId,
    launchId: ctx.launchId,
    processInstanceId: ctx.processInstanceId,
    readTurnOrigin: ctx.readTurnOrigin,
    serverUrl: ctx.config.serverUrl,
    agentCredentialKey: ctx.config.agentCredentialKey,
    admit: async (snapshot) => snapshot.tools.length > 0 && await admit(),
  });
}
