/**
 * View Context grants (#wg-ax:#15; shared agentContextViewGrant.ts), mounted
 * at /api/servers/:id/agent-context-view-grants behind requireServerMatchesParam
 * (which refuses a non-member before this router runs). A human session only:
 * an agent credential never reaches these routes (requireAuth answers it, and
 * no assistant owner-action entry names them).
 *
 * While `agent_context_view_v0` is off for the server every route answers the
 * same 404. Listing and granting need an owner or admin; revoking needs the
 * grant's granter (whatever their role now) or an owner or admin. Anyone else
 * revoking gets the unknown-id 404, so a refusal never confirms a grant id.
 */
import { Router, type Request, type Response, type Router as RouterType } from "express";
import {
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  isAdminOrOwner,
  type AgentContextViewGrantCreated,
  type AgentContextViewGrantList,
  type AgentContextViewGrantRevoked,
  type ServerRole,
} from "@botiverse/raft-shared";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { refuse } from "../lib/refusal";
import { UUID_RE } from "../lib/messageId";
import {
  createAgentContextViewGrant,
  listActiveAgentContextViewGrants,
  revokeAgentContextViewGrant,
} from "../services/agentContextViewGrantService";
import { evaluateFeatureFlag } from "../services/featureFlagService";
import { sendJsonServerError } from "./errorResponse";

export const agentContextViewGrantRouter: RouterType = Router({ mergeParams: true });

function routeParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return typeof value === "string" ? value : "";
}

function refuseUnavailable(res: Response): void {
  refuse(res, 404, { code: "context_view_grants_unavailable", error: "View Context grants aren't available on this server." });
}

/** The caller's server and role, or null after answering: 404 while the flag is off (or for no role at all). */
async function caller(req: Request, res: Response): Promise<{ serverId: string; role: ServerRole } | null> {
  const serverId = routeParam(req, "id");
  const flag = serverId
    ? await evaluateFeatureFlag({ key: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, serverId, userId: req.userId! }).catch(() => ({ enabled: false }))
    : { enabled: false };
  const role = flag.enabled ? await getActorServerRoleInServer(serverId, "user", req.userId!) : null;
  if (!role) {
    refuseUnavailable(res);
    return null;
  }
  return { serverId, role };
}

function refuseNotOwnerOrAdmin(res: Response, action: "view" | "grant"): void {
  refuse(res, 403, {
    code: "context_view_grant_forbidden",
    error: action === "grant"
      ? "Only server owners and admins can grant View Context to an agent."
      : "Only server owners and admins can see View Context grants.",
  });
}

agentContextViewGrantRouter.get("/", async (req, res) => {
  try {
    const who = await caller(req, res);
    if (!who) return;
    if (!isAdminOrOwner(who.role)) return refuseNotOwnerOrAdmin(res, "view");
    res.setHeader("Cache-Control", "no-store");
    res.json({ grants: await listActiveAgentContextViewGrants(who.serverId) } satisfies AgentContextViewGrantList);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list the View Context grants", logPrefix: "[agent-context-view-grants] list error:", err });
  }
});

agentContextViewGrantRouter.post("/", async (req, res) => {
  try {
    const who = await caller(req, res);
    if (!who) return;
    if (!isAdminOrOwner(who.role)) return refuseNotOwnerOrAdmin(res, "grant");
    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !UUID_RE.test(agentId)) {
      refuse(res, 400, { code: "invalid_agent_id", error: "The agentId field must be the id of an agent on this server." });
      return;
    }
    const result = await createAgentContextViewGrant({ serverId: who.serverId, granterUserId: req.userId!, granterRole: who.role, agentId });
    if (result.kind === "agent_not_grantable") {
      refuse(res, 404, {
        code: "context_view_grant_agent_not_found",
        error: "No ordinary agent on this server has that id: only ordinary agents, not personal assistants or App Bots, can hold a View Context grant.",
      });
      return;
    }
    res.status(result.kind === "created" ? 201 : 200).json({ grant: result.grant, created: result.kind === "created" } satisfies AgentContextViewGrantCreated);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to grant View Context", logPrefix: "[agent-context-view-grants] grant error:", err });
  }
});

agentContextViewGrantRouter.delete("/:grantId", async (req, res) => {
  try {
    const who = await caller(req, res);
    if (!who) return;
    const result = await revokeAgentContextViewGrant({ serverId: who.serverId, grantId: routeParam(req, "grantId"), userId: req.userId!, role: who.role });
    if (result.kind === "not_found" || result.kind === "forbidden") {
      refuse(res, 404, { code: "context_view_grant_not_found", error: "No View Context grant on this server has that id." });
      return;
    }
    res.json({ ok: true, revoked: result.kind === "revoked" } satisfies AgentContextViewGrantRevoked);
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to revoke the View Context grant", logPrefix: "[agent-context-view-grants] revoke error:", err });
  }
});
