import type { Request, Response } from "express";
import { isBuiltInRuntimeCustomModelPresetProviderId } from "@botiverse/raft-shared";

import { handleMachineLocalProbeRouting } from "../machineLocalReplay";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { createBoundedRuntimeFormProbe } from "./boundedRuntimeFormProbe";
import { computerProbeCacheFor } from "./computerProbeCacheService";
import type * as machineService from "./machineService";
import { clientRendersDependentCustomWithOptions, runtimeFormV2Entry } from "./runtimeFormV2Registry";

/**
 * task #10: the Built-in preset providers (OpenRouter) a v2 client may type a
 * model id for and see the limit fields of. Both must hold:
 * - the client advertises `dependent_select.custom_value_with_options`
 *   (a shipped app that does not would show a blank text box instead of the
 *   list with its default);
 * - the target Computer runs a typed id for that provider: read from the
 *   Built-in model source exactly as the option-source route resolves it
 *   (bounded probe, shared cache, machine-local routing).
 * Anything else (no capability, no Computer, offline, legacy catalog, an
 * error) is none. "handled": the request was routed to the replica that owns
 * the machine, which already answered it.
 */
export async function builtInTypedModelProvidersFor(input: {
  req: Request;
  res: Response;
  serverId: string;
  machine: NonNullable<Awaited<ReturnType<typeof machineService.getMachine>>> | null;
  clientCapabilities: readonly string[];
}): Promise<string[] | "handled"> {
  const { req, res, machine } = input;
  if (!machine || !clientRendersDependentCustomWithOptions(input.clientCapabilities)) return [];
  const entry = runtimeFormV2Entry("builtin");
  if (!entry) return [];
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
    const resolution = await entry.resolveOptionSource({
      sourceId: "model",
      machineId: machine.id,
      machine,
      serverId: input.serverId,
      formRevision: undefined,
      connectionsVisible: false,
      refresh: false,
      sourceStatus: true,
      clientCapabilities: input.clientCapabilities,
      agentOrchestrator: computerProbe.probe,
      routeToComputer: computerProbe.routeToComputer,
    });
    if (resolution.kind === "handled") return "handled";
    if (resolution.kind !== "source" || !resolution.source) return [];
    const source = resolution.source as { kind?: string; status?: string; customValueAllowedByValue?: Record<string, boolean> };
    if (source.kind !== "dependent_select" || (source.status !== undefined && source.status !== "live")) return [];
    return Object.entries(source.customValueAllowedByValue ?? {})
      .filter(([providerId, allowed]) => allowed && isBuiltInRuntimeCustomModelPresetProviderId(providerId))
      .map(([providerId]) => providerId);
  } catch {
    return [];
  }
}
