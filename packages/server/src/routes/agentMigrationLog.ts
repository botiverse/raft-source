import { Router, type Router as RouterType } from "express";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { listAgentMigrationLog } from "../services/agentMigrationLogService";
import { sendMigrationError } from "./agents";

/** Mounted at /api/agent-migrations (requireAuth, requireVerified, requireServer). */
export const agentMigrationLogRouter: RouterType = Router();

agentMigrationLogRouter.get("/log", async (req, res) => {
  try {
    // It lists every agent's moves, so only owners and admins read it: members
    // must not see where other people's agents went.
    const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (role !== "owner" && role !== "admin") {
      sendMigrationError(res, 403, "not_supported", "Only server owners and admins can read the agent migration log");
      return;
    }
    res.json(await listAgentMigrationLog(req.serverId!));
  } catch (err) {
    console.error("[agent-migrations] log error:", err);
    sendMigrationError(res, 500, "MIGRATION_STATUS_FAILED", "Failed to read the agent migration log");
  }
});
