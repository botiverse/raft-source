import { formatManagedMcpPromptName, type AgentApiIntegrationMcpApp } from "@botiverse/raft-shared";
import { listAgentManagedMcpCatalog } from "./managedMcpService";

/**
 * This Server's MCP Apps as `raft integration list` shows them to an Agent, next to its Agent Login
 * services (MCP Apps and Agent Login Apps are all Raft Apps, of different types).
 *
 * Every enabled App is listed, with `grant` (does this Agent have it) and `state` (its Connection
 * state for this Agent), so an Agent that lacks an App can see it and ask for it with
 * `raft integration login`, as for an ordinary App. A disabled App is listed only when the Agent has
 * it, so the Agent can say why its tools are missing.
 *
 * Both come from the Agent's own catalogue (`listAgentManagedMcpCatalog`), whose `agentConnection` is
 * the shared admission decision (`admitFromRows`) -- the same answer the Apps tab and the call path
 * give. `toolNames` are the tools this Agent may call (or would get once granted).
 */
export async function listAgentMcpAppsForIntegrationInventory(
  serverId: string,
  agentId: string,
): Promise<AgentApiIntegrationMcpApp[]> {
  const catalog = await listAgentManagedMcpCatalog(serverId, agentId);
  return catalog.servers.flatMap((app) => {
    const view = app.agentConnection;
    if (!view) return [];
    const grant = view.grant === "revoked" || view.grant === "not_granted" ? view.grant : "granted";
    if (!app.enabled && grant !== "granted") return [];
    const allowed = app.assignment?.allowedTools ?? null;
    const toolNames = app.toolCatalog
      .map((tool) => tool.name)
      .filter((name) => allowed === null || allowed.includes(name));
    return [{
      type: "mcp" as const,
      id: app.id,
      name: app.name,
      description: app.description,
      homepageUrl: app.homepageUrl ?? null,
      state: view.status,
      access: "mcp_tools" as const,
      toolCount: toolNames.length,
      toolNames,
      grant,
    }];
  });
}

/**
 * The MCP App a `raft integration login` / `invoke` service argument names, if any: by id, or by
 * name (case-insensitive). Only the Apps this Agent has (the list above).
 */
export function findMcpAppForService(
  apps: readonly AgentApiIntegrationMcpApp[],
  rawService: string,
): AgentApiIntegrationMcpApp | null {
  const service = rawService.trim();
  if (!service) return null;
  const normalized = service.toLowerCase();
  return apps.find((app) => app.id === service) ?? apps.find((app) => app.name.toLowerCase() === normalized) ?? null;
}

/** Whether `raft integration login` has anything to ask a person for: a grant, or a Connection. */
export function mcpAppNeedsRequest(app: Pick<AgentApiIntegrationMcpApp, "state" | "grant">): boolean {
  return app.state !== "disabled" && (app.grant !== "granted" || app.state !== "ready");
}

/**
 * What `login` answers for an MCP App when it posts no card. Older CLIs print it as is (they do not
 * know MCP Apps), so it carries the whole next step.
 */
export function mcpAppLoginMessage(
  app: Pick<AgentApiIntegrationMcpApp, "id" | "name" | "state" | "grant">,
  outcome: "ready" | "disabled" | "target_required",
): string {
  // The name is quoted on one line, like every App name in model-facing text.
  const what = `${formatManagedMcpPromptName(app.name)} is an MCP App: it is used through the MCP tools it gives your runtime, not through Raft Agent Login.`;
  if (outcome === "ready") return `${what} It is already usable: call its MCP tools (if they are not in your tool list yet, use raft_app_tools / raft_app_call). No request was posted.`;
  if (outcome === "disabled") return `${what} It is switched off on this Server; a Server owner/admin can switch it on. No request was posted.`;
  const missing = app.grant !== "granted" ? "access to it" : "a connection to it";
  return `${what} You need ${missing}. Rerun with --target <channel-or-thread> to post a request card there for a person who can grant or connect it: raft integration login --service ${JSON.stringify(app.id)} --target <channel-or-thread>. No request was posted.`;
}
