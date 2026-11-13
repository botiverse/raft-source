import type { Router } from "express";
import type { Server as SocketServer } from "socket.io";

import { refuse } from "../lib/refusal";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { notifyNewComputerOwner, setComputerOwner } from "../services/computerOwnerService";

/** The machine list builder (routes/servers.ts), passed in so this module does not import its mounter. */
type BuildMachineList = (input: {
  serverId: string;
  userId: string;
  agentOrchestrator: AgentOrchestrator;
  app: { get(name: string): unknown };
  machineIds?: readonly string[];
}) => Promise<{ body: { machines: readonly unknown[] } }>;

const REFUSALS = {
  machine_not_found: { status: 404, error: "That Computer is not in this server." },
  computer_owner_forbidden: {
    status: 403,
    error: "Only the Computer's owner or a server owner or admin can change its owner; whoever connected a Public Computer can make it theirs.",
  },
  computer_owner_ineligible: { status: 400, error: "The new owner has to be a person in this server who is not a Guest." },
} as const;

/** `{ ownerUserId: string | null }`: a user id, or null for Public. Undefined when malformed. */
function parseOwnerBody(body: unknown): { ownerUserId: string | null } | undefined {
  if (!body || typeof body !== "object" || !("ownerUserId" in body)) return undefined;
  const value = (body as { ownerUserId: unknown }).ownerUserId;
  if (value === null) return { ownerUserId: null };
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return { ownerUserId: value.toLowerCase() };
  }
  return undefined;
}

/**
 * Computer owner v1 (#wg-rbac:#32, services/computerOwnerService.ts):
 * PUT /api/servers/:id/machines/:machineId/owner `{ ownerUserId: string | null }`
 * answers the Computer as GET /machines lists it. A person session only
 * (`/api/servers` never takes an agent credential).
 */
export function mountComputerOwnerRoutes(serverRouter: Router, deps: { buildMachineList: BuildMachineList }): void {
  serverRouter.put("/:id/machines/:machineId/owner", async (req, res) => {
    const parsed = parseOwnerBody(req.body);
    if (!parsed) {
      refuse(res, 400, { code: "computer_owner_invalid", error: "Send ownerUserId as a member's id, or null to make the Computer Public." });
      return;
    }
    try {
      const result = await setComputerOwner({
        serverId: req.params.id,
        machineId: req.params.machineId,
        actorUserId: req.userId!,
        ownerUserId: parsed.ownerUserId,
      });
      if (!result.ok) {
        refuse(res, REFUSALS[result.code].status, { code: result.code, error: REFUSALS[result.code].error });
        return;
      }
      if (result.changed) {
        const io = req.app.get("io") as SocketServer | undefined;
        io?.to(`server:${req.params.id}`).emit("machine:updated", { serverId: req.params.id, machineId: result.machineId });
        if (result.ownerUserId) {
          await notifyNewComputerOwner({
            serverId: req.params.id,
            machineId: result.machineId,
            machineName: result.machineName,
            ownerUserId: result.ownerUserId,
            actorUserId: req.userId!,
          });
        }
      }
      const { body } = await deps.buildMachineList({
        serverId: req.params.id,
        userId: req.userId!,
        agentOrchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
        app: req.app,
        machineIds: [result.machineId],
      });
      res.json({ machine: body.machines[0] ?? null });
    } catch (err) {
      console.error("[computer-owner] set owner failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "Failed to change the Computer's owner" });
    }
  });
}
