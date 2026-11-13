/**
 * `GET /api/servers/:id/agent-usage?from=YYYY-MM-DD&to=YYYY-MM-DD&agents=a,b`
 * (#proj-o11y:42f2af5c): agent token usage per UTC day, agent and model, for
 * the agent panel's Usage tab and the Members › Agents usage view.
 *
 * Only the agents whose private surfaces (Activity) the caller may inspect
 * (roleCanInspectAgentPrivateSurfaces) are read, so totals over the answer are
 * "the agents you can see". 404 when the caller is not a member or
 * agent_usage_v0 is off for the server. Without `from`/`to` it answers the
 * last 7 UTC days ending today.
 */
import type { Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { AGENT_USAGE_FEATURE_FLAG_KEY, AGENT_USAGE_MAX_RANGE_DAYS, asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents } from "../db/schema";
import { getActorServerRoleInServer, roleCanInspectAgentPrivateSurfaces } from "../lib/actorPermissions";
import { appEnabled } from "../platform/flags";
import { refuse } from "../lib/refusal";
import { readAgentUsage, utcDay } from "../services/agentUsageService";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && utcDay(time) === value ? value : null;
}

export async function getAgentUsageRoute(req: Request, res: Response): Promise<void> {
  try {
    const serverId = req.params.id as string;
    const callerRole = await getActorServerRoleInServer(serverId, "user", req.userId!);
    if (!callerRole || !await appEnabled(asServerId(serverId), AGENT_USAGE_FEATURE_FLAG_KEY)) {
      refuse(res, 404, { code: "agent_usage_not_found", error: "This server has no agent usage to read, or you are not a member of it." });
      return;
    }
    const now = new Date();
    const to = parseDay(req.query.to);
    const from = parseDay(req.query.from);
    if (to === null || from === null) {
      refuse(res, 400, { code: "agent_usage_bad_range", error: "Give from and to as UTC dates in the form YYYY-MM-DD." });
      return;
    }
    const toDay = to ?? utcDay(now.getTime());
    const fromDay = from ?? utcDay(Date.parse(`${toDay}T00:00:00Z`) - 6 * DAY_MS);
    const span = (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS + 1;
    if (span < 1 || span > AGENT_USAGE_MAX_RANGE_DAYS) {
      refuse(res, 400, { code: "agent_usage_bad_range", error: `Ask for a range where from is not after to and that spans at most ${AGENT_USAGE_MAX_RANGE_DAYS} days.` });
      return;
    }
    const requested = typeof req.query.agents === "string" && req.query.agents.trim()
      ? new Set(req.query.agents.split(",").map((id) => id.trim()).filter(Boolean))
      : null;

    const serverAgents = await getDb().select({
      id: agents.id,
      creatorType: agents.creatorType,
      creatorId: agents.creatorId,
      assistantOwnerUserId: agents.assistantOwnerUserId,
    })
      .from(agents)
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
    const visible = serverAgents.filter((agent) => roleCanInspectAgentPrivateSurfaces(callerRole, req.userId!, agent));
    const selected = requested ? visible.filter((agent) => requested.has(agent.id)) : visible;

    const usage = await readAgentUsage({ serverId, agentIds: selected.map((agent) => agent.id), from: fromDay, to: toDay, now });
    res.json({ ...usage, visible_agents: visible.length });
  } catch (err) {
    console.error("[agent-usage] read failed:", err);
    res.status(500).json({ error: "Failed to read agent usage" });
  }
}
