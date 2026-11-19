import type { Request, Response } from "express";
import { isBuiltInRuntimeCustomModelPresetProviderId } from "@botiverse/raft-shared";

import { handleMachineLocalProbeRouting } from "../machineLocalReplay";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { createBoundedRuntimeFormProbe } from "./boundedRuntimeFormProbe";
import { computerProbeCacheFor } from "./computerProbeCacheService";
import type * as machineService from "./machineService";
import {
  clientRendersDependentCustomWithOptions,
  runtimeFormV2Entry,
  type BuiltInTypedModelProviders,
} from "./runtimeFormV2Registry";

/**
 * task #10: the Built-in preset providers (OpenRouter, Qwen Token Plan, ...) a v2 client may type a
 * model id for and see the limit fields of. Both must hold:
 * - the client advertises `dependent_select.custom_value_with_options`
 *   (a shipped app that does not would show a blank text box instead of the
 *   list with its default);
 * - the target Computer runs a typed id for that provider: read from the
 *   Built-in model source exactly as the option-source route resolves it
 *   (bounded probe, shared cache, machine-local routing).
 * Anything else (no capability, no Computer, offline, legacy catalog, an
 * error) is none. `connections`: those of them the Computer also runs through
 * a saved connection (its catalog's customModelConnectionProviderIds; none on
 * a Computer released before that). "handled": the request was routed to the
 * replica that owns the machine, which already answered it.
 */
export async function builtInTypedModelProvidersFor(input: {
  req: Request;
  res: Response;
  serverId: string;
  machine: NonNullable<Awaited<ReturnType<typeof machineService.getMachine>>> | null;
  clientCapabilities: readonly string[];
}): Promise<BuiltInTypedModelProviders | "handled"> {
  const none: BuiltInTypedModelProviders = { presets: [], connections: [] };
  const { req, res, machine } = input;
  if (!machine || !clientRendersDependentCustomWithOptions(input.clientCapabilities)) return none;
  const entry = runtimeFormV2Entry("builtin");
  if (!entry) return none;
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
  // The catalog the model source was filtered by, for the connection set.
  let catalog: unknown;
  const probe: typeof computerProbe.probe = {
    ...computerProbe.probe,
    async detectMachineRuntimeModelsWithAuthority(...args) {
      const detection = await computerProbe.probe.detectMachineRuntimeModelsWithAuthority(...args);
      catalog = detection.outcome.kind === "live" ? detection.outcome.value.catalog : undefined;
      return detection;
    },
  };
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
      agentOrchestrator: probe,
      routeToComputer: computerProbe.routeToComputer,
    });
    if (resolution.kind === "handled") return "handled";
    if (resolution.kind !== "source" || !resolution.source) return none;
    const source = resolution.source as { kind?: string; status?: string; customValueAllowedByValue?: Record<string, boolean> };
    if (source.kind !== "dependent_select" || (source.status !== undefined && source.status !== "live")) return none;
    const presets = Object.entries(source.customValueAllowedByValue ?? {})
      .filter(([providerId, allowed]) => allowed && isBuiltInRuntimeCustomModelPresetProviderId(providerId))
      .map(([providerId]) => providerId);
    const throughConnection = (catalog as { customModelConnectionProviderIds?: unknown } | undefined)?.customModelConnectionProviderIds;
    return {
      presets,
      connections: Array.isArray(throughConnection) ? presets.filter((providerId) => throughConnection.includes(providerId)) : [],
    };
  } catch {
    return none;
  }
}
