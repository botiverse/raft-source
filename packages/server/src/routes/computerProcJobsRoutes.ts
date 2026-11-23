import type { Response, Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  asMachineId,
  isValidProcName,
  isValidProcStoppedBy,
  type ProcJobsReadResponse,
  type ServerRole,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { actorRoleHasServerCapability, getActorServerRoleInServer } from "../lib/actorPermissions";
import { refuse, type RefusalInput } from "../lib/refusal";
import { addTraceEvent } from "../tracing/semanticTrace";
import { RouteFailureError } from "../tracing/routeFailure";
import { agentFindableBy } from "../services/agentMemberListPolicy";
import type { AgentOrchestrator, ProcJobStopRequestResult } from "../services/agentOrchestrator";
import { canManageComputer } from "../services/computerControlAuthorization";
import { recordIntegrationAuditEventBestEffort, serverAuditContextMetadata } from "../services/integrationAuditService";
import * as machineService from "../services/machineService";
import { procJobsCacheService } from "../services/procJobsCacheService";

// `raft proc` jobs on the Computer page (docs/contracts/proc-jobs.md):
//   GET  /api/servers/:id/machines/:machineId/proc-jobs       the last snapshot, as this person may see it
//   POST /api/servers/:id/machines/:machineId/proc-jobs/stop  { agentId, name }: stop one job
// A person session only (`/api/servers` never takes an agent credential).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVER_NOT_FOUND: RefusalInput = { code: "server_not_found", error: "You are not a member of this server." };
const READ_FORBIDDEN: RefusalInput = {
  code: "insufficient_role",
  error: "You need permission to see this server's Computers to see their jobs.",
};
const COMPUTER_NOT_FOUND: RefusalInput = { code: "machine_not_found", error: "That Computer is not in this server." };
const JOB_NOT_FOUND: RefusalInput = { code: "proc_job_not_found", error: "That job is not on this Computer." };
const STOP_FORBIDDEN: RefusalInput = {
  code: "insufficient_role",
  error: "Only the person who connected this Computer, or a server owner or admin, can stop its jobs.",
};
const STOP_INVALID: RefusalInput = { code: "proc_job_invalid", error: "Send the job's agentId and name." };
const COMPUTER_OFFLINE: RefusalInput = { code: "computer_offline", error: "This Computer is offline." };
const COMPUTER_UPGRADE_REQUIRED: RefusalInput = {
  code: "computer_upgrade_required",
  error: "This Computer needs an upgrade before a job can be stopped from here.",
};

/** The request's `{ agentId, name }`, or undefined when malformed. Nothing else in the body is read. */
export function parseProcJobStopBody(body: unknown): { agentId: string; name: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { agentId, name } = body as { agentId?: unknown; name?: unknown };
  if (typeof agentId !== "string" || !UUID_RE.test(agentId)) return undefined;
  if (!isValidProcName(name)) return undefined;
  return { agentId: agentId.toLowerCase(), name };
}

/** The member's role and the machine of this server, or a refusal already sent. */
async function memberAndMachine(
  serverId: string,
  machineId: string,
  userId: string,
  res: Response,
): Promise<{ role: ServerRole; machine: { id: string; name: string } } | null> {
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  if (!role) {
    refuse(res, 404, SERVER_NOT_FOUND);
    return null;
  }
  const machine = UUID_RE.test(machineId) ? await machineService.getMachine(asMachineId(machineId)) : null;
  if (!machine || machine.serverId !== serverId) {
    refuse(res, 404, COMPUTER_NOT_FOUND);
    return null;
  }
  return { role, machine: { id: machine.id, name: machine.name } };
}

/** Of these agent ids, the ones of this server this person may find (agentFindableBy: a personal assistant only by its owner). */
async function findableAgentIds(serverId: string, userId: string, agentIds: readonly string[], onMachineId?: string): Promise<Set<string>> {
  const ids = [...new Set(agentIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      inArray(agents.id, ids),
      eq(agents.serverId, serverId),
      ...(onMachineId ? [eq(agents.machineId, onMachineId)] : []),
      isNull(agents.deletedAt),
      sql`${agentFindableBy({ userId })}`,
    ));
  return new Set(rows.map((row) => row.id));
}

/** The person's handle as a job's stopper: the signed-in person's own name, never the request's word; null when it is not a handle. */
async function stopperHandle(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return row && isValidProcStoppedBy(row.name) ? row.name : null;
}

type StopEnd = ProcJobStopRequestResult["outcome"] | "computer_timeout" | "request_failed";

async function recordStop(input: {
  serverId: string;
  userId: string;
  role: ServerRole;
  machine: { id: string; name: string };
  agentId: string;
  name: string;
  result: StopEnd;
}): Promise<void> {
  await recordIntegrationAuditEventBestEffort({
    serverId: input.serverId,
    eventType: "computer.proc_job_stopped",
    outcome: input.result === "stopped" || input.result === "already_exited" ? "success" : "failure",
    source: "web",
    actor: { type: "human", id: input.userId },
    target: { type: "machine", id: input.machine.id },
    metadata: {
      machineId: input.machine.id,
      machineName: input.machine.name,
      agentId: input.agentId,
      jobName: input.name,
      result: input.result,
      ...serverAuditContextMetadata({ actorRole: input.role }),
    },
  });
}

export function mountComputerProcJobsRoutes(serverRouter: Router): void {
  serverRouter.get("/:id/machines/:machineId/proc-jobs", async (req, res) => {
    try {
      const found = await memberAndMachine(req.params.id, req.params.machineId, req.userId!, res);
      if (!found) return;
      // Whoever may see the Computers list (GET /machines).
      if (!actorRoleHasServerCapability(found.role, "viewMachines")) {
        refuse(res, 403, READ_FORBIDDEN);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      const snapshot = await procJobsCacheService.read(found.machine.id);
      if (!snapshot) {
        res.json({ status: "unknown" } satisfies ProcJobsReadResponse);
        return;
      }
      const visible = await findableAgentIds(req.params.id, req.userId!, snapshot.jobs.map((job) => job.agentId));
      res.json({
        status: "known",
        reportedAt: snapshot.reportedAt,
        jobs: snapshot.jobs.filter((job) => visible.has(job.agentId)),
      } satisfies ProcJobsReadResponse);
    } catch {
      res.status(500).json({ error: "Failed to load the Computer's jobs" });
    }
  });

  serverRouter.post("/:id/machines/:machineId/proc-jobs/stop", async (req, res) => {
    const parsed = parseProcJobStopBody(req.body);
    if (!parsed) {
      refuse(res, 400, STOP_INVALID);
      return;
    }
    const trace = (outcome: string) => addTraceEvent("machine.proc_job_stop", {
      server_id: req.params.id,
      machine_id: req.params.machineId,
      agent_id: parsed.agentId,
      outcome,
    });
    let found: Awaited<ReturnType<typeof memberAndMachine>> = null;
    // Set once the checks passed: from there every attempt is recorded, whatever its end.
    let authorized = false;
    try {
      found = await memberAndMachine(req.params.id, req.params.machineId, req.userId!, res);
      if (!found) {
        trace("not_found");
        return;
      }
      if (!await canManageComputer(getDb(), { userId: req.userId!, role: found.role }, req.params.id, found.machine, "control")) {
        trace("forbidden");
        refuse(res, 403, STOP_FORBIDDEN);
        return;
      }
      // An agent this person may not find is not there for them, control or not;
      // nor is one not on this Computer (its jobs are never listed here either).
      if (!(await findableAgentIds(req.params.id, req.userId!, [parsed.agentId], found.machine.id)).has(parsed.agentId)) {
        trace("agent_not_found");
        refuse(res, 404, JOB_NOT_FOUND);
        return;
      }
      authorized = true;
      const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
      const stoppedBy = await stopperHandle(req.userId!);
      const result = await orchestrator.stopProcJob(found.machine.id, parsed.agentId, parsed.name, stoppedBy);
      trace(result.outcome);
      await recordStop({ serverId: req.params.id, userId: req.userId!, role: found.role, machine: found.machine, agentId: parsed.agentId, name: parsed.name, result: result.outcome });
      if (result.outcome === "computer_offline") {
        refuse(res, 409, COMPUTER_OFFLINE);
        return;
      }
      if (result.outcome === "computer_upgrade_required") {
        refuse(res, 409, COMPUTER_UPGRADE_REQUIRED);
        return;
      }
      res.json({ outcome: result.outcome });
    } catch (error) {
      const timeout = error instanceof RouteFailureError && error.subkind === "daemon_timeout";
      const offline = error instanceof RouteFailureError && error.subkind === "daemon_offline";
      trace(timeout ? "computer_timeout" : offline ? "computer_offline" : "error");
      if (found && authorized) {
        await recordStop({
          serverId: req.params.id,
          userId: req.userId!,
          role: found.role,
          machine: found.machine,
          agentId: parsed.agentId,
          name: parsed.name,
          result: timeout ? "computer_timeout" : offline ? "computer_offline" : "request_failed",
        });
      }
      if (timeout) {
        res.status(504).json({ error: "The Computer did not answer in time. Try again.", code: "computer_timeout" });
        return;
      }
      if (offline) {
        refuse(res, 409, COMPUTER_OFFLINE);
        return;
      }
      res.status(500).json({ error: "Failed to stop the job" });
    }
  });
}
