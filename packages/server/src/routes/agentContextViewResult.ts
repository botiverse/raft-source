// View Context result routes (agentContextViewRelay.ts). Both read the raw
// request stream, so app.ts registers them before the global JSON parser.
//
// POST /internal/computer/agent-context/:requestId (AGENT_CONTEXT_VIEW_RESULT_ROUTE):
// the daemon's one result POST, Computer auth (authFromRegistry). Its answers
// (every one final) are part of the contract: see AGENT_CONTEXT_VIEW_RESULT_ROUTE
// in packages/shared/src/agentContextView.ts.
//
// POST /internal/replica/agent-context/:requestId (AGENT_CONTEXT_VIEW_FORWARD_ROUTE):
// replica to replica, signed with the replica replay scheme.
import { and, eq, isNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { asMachineId, type MachineId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { computers } from "../db/schema";
import type { AgentContextViewRelay } from "../services/agentContextViewRelay";

/** The machine the presenting Computer credential belongs to (sk_machine_* alias, or the live computers row). */
async function callerMachineId(req: Request): Promise<MachineId | null> {
  if (req.machineId) return req.machineId;
  if (!req.computerId || !req.serverId) return null;
  const [row] = await getDb()
    .select({ machineId: computers.machineId })
    .from(computers)
    .where(and(eq(computers.id, req.computerId), eq(computers.serverId, req.serverId), isNull(computers.revokedAt)))
    .limit(1);
  return row?.machineId ? asMachineId(row.machineId) : null;
}

export function agentContextViewResultHandler(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const machineId = await callerMachineId(req);
    if (!machineId) {
      // As an unknown id: a Computer with no machine was never sent a request.
      res.status(404).json({ ok: false, code: "not_found" });
      return;
    }
    await (req.app.get("agentContextViewRelay") as AgentContextViewRelay).receiveResult(req, res, machineId);
  })().catch(next);
}

export function agentContextViewForwardHandler(req: Request, res: Response, next: NextFunction): void {
  (req.app.get("agentContextViewRelay") as AgentContextViewRelay).receiveForward(req, res).catch(next);
}
