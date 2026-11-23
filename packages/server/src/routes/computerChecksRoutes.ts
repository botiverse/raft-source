import type { Response, Router } from "express";
import {
  asMachineId,
  COMPUTER_CHECKS_FRESH_MS,
  currentTimeMs,
  type ComputerChecksReadResponse,
} from "@botiverse/raft-shared";

import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { refuse, type RefusalInput } from "../lib/refusal";
import { addTraceEvent } from "../tracing/semanticTrace";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { computerChecksCacheService } from "../services/computerChecksCacheService";
import { canSeeComputerRuntimeAccounts } from "../services/computerControlAuthorization";
import * as machineService from "../services/machineService";

// "On this computer" checks (docs/contracts/computer-checks.md):
//   GET  /api/servers/:id/machines/:machineId/computer-checks          the last report, for those who may see it
//   POST /api/servers/:id/machines/:machineId/computer-checks/refresh  ask the Computer for a round (30 s per Computer)
// A person session only (`/api/servers` never takes an agent credential).
// Who: whoever may see the Computer's runtime accounts (the person it is
// attached by, or `editMachines`: canSeeComputerRuntimeAccounts). Anyone
// else gets `not_visible` and no data, and opening the page asks nothing of
// the Computer. Behind `computer_checks_v0` (server-scoped, default off).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVER_NOT_FOUND: RefusalInput = { code: "server_not_found", error: "You are not a member of this server." };
const COMPUTER_NOT_FOUND: RefusalInput = { code: "machine_not_found", error: "That Computer is not in this server." };
const CHECKS_DISABLED: RefusalInput = { code: "computer_checks_disabled", error: "Computer checks are not available on this server." };
const REFRESH_FORBIDDEN: RefusalInput = {
  code: "computer_checks_not_visible",
  error: "Only the person who connected this Computer, or someone who can edit Computers, can refresh what is on it.",
};

function orchestratorOf(req: { app: { get(name: string): unknown } }): AgentOrchestrator {
  return req.app.get("agentOrchestrator") as AgentOrchestrator;
}

/** The machine of this server for a member with the flag on, or a refusal already sent. */
async function resolve(serverId: string, machineIdParam: string, userId: string, res: Response, orchestrator: AgentOrchestrator): Promise<{ machineId: string } | null> {
  if (!await getActorServerRoleInServer(serverId, "user", userId)) {
    refuse(res, 404, SERVER_NOT_FOUND);
    return null;
  }
  const machine = UUID_RE.test(machineIdParam) ? await machineService.getMachine(asMachineId(machineIdParam)) : null;
  if (!machine || machine.serverId !== serverId) {
    refuse(res, 404, COMPUTER_NOT_FOUND);
    return null;
  }
  if (!await orchestrator.computerChecksEnabledFor(serverId)) {
    refuse(res, 404, CHECKS_DISABLED);
    return null;
  }
  return { machineId: machine.id };
}

/**
 * The read for a viewer. `refresh`: `always` (the refresh route) or
 * `when_stale` (the read: no report, or one older than 10 minutes); either
 * way at most one refresh per Computer in 30 s, across replicas.
 */
async function answer(
  orchestrator: AgentOrchestrator,
  serverId: string,
  machineId: string,
  refresh: "always" | "when_stale",
): Promise<{ body: ComputerChecksReadResponse; outcome: string }> {
  const availability = await orchestrator.computerChecksAvailability(machineId);
  if (availability === "unsupported") return { body: { status: "unsupported" }, outcome: "unsupported" };
  const stored = await computerChecksCacheService.read(machineId);
  const now = currentTimeMs();
  const fresh = stored !== null && now - Date.parse(stored.receivedAt) < COMPUTER_CHECKS_FRESH_MS;
  let outcome = availability === "computer_offline" ? "computer_offline" : "cached";
  if (availability === "ok" && (refresh === "always" || !fresh)) {
    if (await computerChecksCacheService.tryClaimRefresh(machineId, now)) {
      if (await orchestrator.requestComputerChecksRefresh(machineId, serverId)) {
        outcome = "refresh_sent";
      } else {
        // Nothing reached the Computer: the next visit may ask again at once.
        outcome = "refresh_not_sent";
        await computerChecksCacheService.releaseRefresh(machineId, now);
      }
    } else {
      outcome = "rate_limited";
    }
  }
  const requestedAtMs = availability === "ok" ? await computerChecksCacheService.refreshRequestedAtMs(machineId) : null;
  const refreshing = outcome !== "refresh_not_sent" && requestedAtMs !== null && (stored === null || Date.parse(stored.receivedAt) < requestedAtMs);
  return {
    body: stored
      ? { status: "known", report: stored.report, receivedAt: stored.receivedAt, fresh, refreshing }
      : { status: "unknown", refreshing },
    outcome,
  };
}

export function mountComputerChecksRoutes(serverRouter: Router): void {
  serverRouter.get("/:id/machines/:machineId/computer-checks", async (req, res) => {
    try {
      const orchestrator = orchestratorOf(req);
      const found = await resolve(req.params.id, req.params.machineId, req.userId!, res, orchestrator);
      if (!found) return;
      res.setHeader("Cache-Control", "private, no-store");
      if (!await canSeeComputerRuntimeAccounts(req.params.id, found.machineId, req.userId!)) {
        res.json({ status: "not_visible" } satisfies ComputerChecksReadResponse);
        return;
      }
      const { body, outcome } = await answer(orchestrator, req.params.id, found.machineId, "when_stale");
      addTraceEvent("machine.computer_checks.read", { server_id: req.params.id, machine_id: found.machineId, status: body.status, outcome });
      res.json(body);
    } catch {
      res.status(500).json({ error: "Failed to load what is on this Computer" });
    }
  });

  serverRouter.post("/:id/machines/:machineId/computer-checks/refresh", async (req, res) => {
    try {
      const orchestrator = orchestratorOf(req);
      const found = await resolve(req.params.id, req.params.machineId, req.userId!, res, orchestrator);
      if (!found) return;
      if (!await canSeeComputerRuntimeAccounts(req.params.id, found.machineId, req.userId!)) {
        refuse(res, 403, REFRESH_FORBIDDEN);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      const { body, outcome } = await answer(orchestrator, req.params.id, found.machineId, "always");
      addTraceEvent("machine.computer_checks.refresh", { server_id: req.params.id, machine_id: found.machineId, status: body.status, outcome });
      res.json(body);
    } catch {
      res.status(500).json({ error: "Failed to refresh what is on this Computer" });
    }
  });
}
