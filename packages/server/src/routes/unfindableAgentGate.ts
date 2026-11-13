import type { NextFunction, Request, Response, Router } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { isAgentFindableBy } from "../services/agentMemberListPolicy";

/**
 * The id every by-id agent route sees in place of an agent the caller may not
 * find (agentFindableBy: another person's personal assistant, for every role,
 * server owners and admins included; Tenny, #proj-assistant 5cc12a51). No
 * agent has it (the nil UUID), so the handler answers exactly as it does for
 * an id that names no agent: the same status, body and order of checks, and
 * nothing acts on the assistant.
 */
export const UNFINDABLE_AGENT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Whether the human caller may find the agent with this id. An unknown id, or
 * one that is no UUID, passes: its handler answers as it always does.
 */
async function isAgentIdFindableByUser(userId: string | undefined, agentId: string): Promise<boolean> {
  if (!UUID_RE.test(agentId)) return true;
  const [agent] = await getDb()
    .select({ id: agents.id, assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return !agent || isAgentFindableBy({ userId }, agent);
}

/** An agent id from a body or query, as the caller may find it: UNFINDABLE_AGENT_ID in place of one they may not. */
export async function agentIdAsFoundBy(userId: string | undefined, agentId: string): Promise<string> {
  return await isAgentIdFindableByUser(userId, agentId) ? agentId : UNFINDABLE_AGENT_ID;
}

function decodedSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * For a router mounted at `/api/agents` whose by-id routes are `/:id...`:
 * every request whose first path segment is an agent the caller may not find
 * is re-routed to UNFINDABLE_AGENT_ID before any later middleware or route
 * runs (a URL rewrite, so the routes match and read it as usual). Register it
 * before every middleware or route that reads the agent.
 */
export function hideUnfindableAgentsInPath(router: Router): void {
  router.use(async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const [, raw] = req.url.match(/^\/([^/?#]+)/) ?? [];
      // Routes match and read params on the decoded path, so the gate decides
      // on the decoded segment too: `%2D` in place of `-` names the same agent.
      // An id that can't be decoded is left alone; Express refuses it.
      const id = raw === undefined ? undefined : decodedSegment(raw);
      if (raw !== undefined && id !== undefined) {
        const rest = req.url.slice(raw.length + 1);
        if (!await isAgentIdFindableByUser(req.userId, id)) {
          req.url = `/${UNFINDABLE_AGENT_ID}${rest}`;
        } else if (id !== raw && UUID_RE.test(id)) {
          // Later middleware that reads the raw path sees the id it names.
          req.url = `/${id}${rest}`;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  });
}

/**
 * The same for a router whose by-id agent routes name the agent by the path
 * parameter `name` (e.g. `/agents/:agentId`). A parameter that is sometimes a
 * user's id (a member id) is fine: no agent has a user's id, so it passes.
 */
export function hideUnfindableAgentsByParam(router: Router, name: string): void {
  router.param(name, async (req: Request, _res: Response, next: NextFunction, value: unknown) => {
    try {
      if (typeof value === "string" && !await isAgentIdFindableByUser(req.userId, value)) {
        req.params[name] = UNFINDABLE_AGENT_ID;
      }
      next();
    } catch (err) {
      next(err);
    }
  });
}
