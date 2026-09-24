/**
 * `GET /api/agents/manageable` — list every agent the current user has
 * credential-management authority on, across all servers they're a member of.
 *
 * Sister to `POST /api/agents/:id/credentials`: both are CLI
 * resource-explicit surfaces (see `agentCredentials.ts` and
 * `#proj-runtime:3d515727`). The CLI caller has only a user session at
 * this point — no `X-Server-Id` context — so this route does NOT use
 * `requireServer`. It mounts in `app.ts` BEFORE the agentRouter.
 *
 * Why cross-server: the `slock agent login --agent <bad>` recovery path
 * is `slock agent list`; the user could plausibly want to manage agents
 * across multiple servers and the list endpoint should reflect that. Each
 * row carries its own `serverId` / `serverName` so the calling agent can
 * group + render appropriately when asking the human "which agent?".
 *
 * Response (machine-readable, per @xxchan #wg-self-hosted-agent
 * msg=4acca4ce + @Hao msg=be775d71/msg=27f60c48): server returns stable
 * `reason` enum + structured counts, NEVER CLI-specific copy. The
 * client (CLI / web / SDK) generates next-action guidance in its own
 * context. Previously this route returned `suggested_next_action` with
 * literal `slock agent login --server ...` text; that hardcoded CLI flag
 * forms into the API contract and would break for any non-CLI client.
 *
 * ```json
 * {
 *   "ok": true,
 *   "data": {
 *     "agents": [
 *       { "id": "...", "name": "...", "displayName": "...",
 *         "description": "...", "serverId": "...", "serverName": "..." },
 *       ...
 *     ],
 *     "reason": "ok" | "no_manageable_server" | "no_agents_on_manageable_servers",
 *     "manageable_server_count": <number>
 *   }
 * }
 * ```
 *
 * `reason` semantics (only present on 2xx success — HTTP error codes
 * have their own `{error}` shape):
 *   - `ok`                                  — agents non-empty, normal success.
 *   - `no_manageable_server`                — user has neither `issueAgentCredentials` nor creator authority anywhere.
 *   - `no_agents_on_manageable_servers`     — has `issueAgentCredentials` on ≥1 server, but those servers have zero agents.
 */

import type { Request, Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { agents, serverMembers, servers } from "../db/schema.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";
import { actorRoleHasServerCapability } from "../lib/actorPermissions.js";

export async function listManageableAgentsHandler(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const memberships = await db
      .select({
        serverId: servers.id,
        serverName: servers.name,
        role: serverMembers.role,
      })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(and(
        eq(serverMembers.userId, req.userId!),
        isNull(servers.deletedAt),
      ));

    const manageableServers = memberships
      .filter((m) => actorRoleHasServerCapability(m.role, "issueAgentCredentials"))
      .map(({ serverId, serverName }) => ({ serverId, serverName }));
    if (memberships.length === 0) {
      res.json({
        ok: true,
        data: {
          agents: [],
          reason: "no_manageable_server",
          manageable_server_count: 0,
        },
      });
      return;
    }
    const memberServerIds = memberships.map((membership) => membership.serverId);
    const capableServerIds = new Set(manageableServers.map((server) => server.serverId));
    const serverNameById = new Map(memberships.map((membership) => [membership.serverId, membership.serverName] as const));

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        description: agents.description,
        serverId: agents.serverId,
        creatorType: agents.creatorType,
        creatorId: agents.creatorId,
      })
      .from(agents)
      .where(and(
        isNull(agents.deletedAt),
        inArray(agents.serverId, memberServerIds),
      ));

    const authorizedRows = rows.filter((agent) => capableServerIds.has(agent.serverId)
      || (agent.creatorType === "user" && agent.creatorId === req.userId));
    const manageableServerCount = new Set([
      ...capableServerIds,
      ...authorizedRows.map((agent) => agent.serverId),
    ]).size;

    addTraceEvent("agents.manageable.list.started", {
      manageable_server_count: manageableServerCount,
    });

    if (manageableServerCount === 0) {
      res.json({
        ok: true,
        data: {
          agents: [],
          reason: "no_manageable_server",
          manageable_server_count: 0,
        },
      });
      return;
    }

    const filtered = authorizedRows.map((a) => ({
      id: a.id,
      name: a.name,
      displayName: a.displayName,
      description: a.description,
      serverId: a.serverId,
      serverName: serverNameById.get(a.serverId) ?? null,
    }));

    addTraceEvent("agents.manageable.list.ready", {
      agent_count: filtered.length,
    });

    res.json({
      ok: true,
      data: {
        agents: filtered,
        reason: filtered.length > 0 ? "ok" : "no_agents_on_manageable_servers",
          manageable_server_count: manageableServerCount,
      },
    });
  } catch (err) {
    console.error("agents.manageable.list error:", err);
    res.status(500).json({ error: "Failed to list manageable agents" });
  }
}
