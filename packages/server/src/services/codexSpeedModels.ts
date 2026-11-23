import type { Request, Response } from "express";
import type { RuntimeModelInfo } from "@botiverse/raft-shared";

import { handleMachineLocalProbeRouting } from "../machineLocalReplay";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { createBoundedRuntimeFormProbe } from "./boundedRuntimeFormProbe";
import { computerProbeCacheFor } from "./computerProbeCacheService";
import type * as machineService from "./machineService";

/**
 * #wg-runtime-form:#31: read this Computer's live Codex model list (same
 * bounded probe, shared cache, and machine-local routing as the `model` and
 * `speed` option sources loaded next) so the served Codex form puts `speed`
 * (SHOW) and `fastMode` (HIDE) on mutually exclusive model sets:
 * - models with >=2 fast tiers -> `speed` dropdown (Standard / Fast / Ultrafast)
 * - models with 1 fast tier -> `fastMode` checkbox
 * - models declaring 0 fast tiers -> neither shown
 * Anything else (no Computer, offline, probe failed) returns `[]` so `speed`
 * stays hidden and `fastMode` acts as the fallback. "handled": routed to the
 * replica that owns the machine, which already answered the request.
 */
export async function codexSpeedModelsFor(input: {
  req: Request;
  res: Response;
  machine: NonNullable<Awaited<ReturnType<typeof machineService.getMachine>>> | null;
}): Promise<readonly RuntimeModelInfo[] | "handled"> {
  const { req, res, machine } = input;
  if (!machine) return [];
  const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  const computerProbe = createBoundedRuntimeFormProbe({
    machine,
    probes: computerProbeCacheFor(req.app),
    orchestrator: agentOrchestrator,
    route: () => handleMachineLocalProbeRouting(
      req,
      res,
      machine.id,
      () => agentOrchestrator.hasMachineLocally(machine.id),
    ),
  });
  try {
    const routing = await computerProbe.routeToComputer();
    if (routing === "handled") return "handled";
    if (routing !== "confirmed_local") return [];
    const outcome = await computerProbe.probe.detectMachineRuntimeModels(machine.id, "codex", { force: false });
    return outcome.kind === "live" ? outcome.value.models : [];
  } catch {
    return [];
  }
}
