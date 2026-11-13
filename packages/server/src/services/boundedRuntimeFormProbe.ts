import {
  isMachineLocalReplayFailure,
  type MachineLocalReplayFailure,
  type MachineLocalRoutingResult,
} from "../machineLocalReplay";
import { RouteFailureError } from "../tracing/routeFailure";
import type { AgentOrchestrator, MachineRuntimeModelDetection } from "./agentOrchestrator";
import {
  computerProbeFreshness,
  type ComputerProbeAnswer,
  type ComputerProbeCacheService,
  type ComputerProbeFreshness,
} from "./computerProbeCacheService";
import type { RuntimeFormModelProbe } from "./runtimeFormV2Registry";

export interface BoundedRuntimeFormProbe {
  /** The resolver's routing (RuntimeFormOptionSourceContext.routeToComputer). */
  routeToComputer(): Promise<MachineLocalRoutingResult>;
  /** The resolver's model probe (RuntimeFormOptionSourceContext.agentOrchestrator). */
  probe: RuntimeFormModelProbe;
  /** How the model probe was answered; null when the resolver never asked it. */
  freshness(): ComputerProbeFreshness | null;
  /** The failed replay this request answered from the cache instead, if any. */
  replayFailure(): MachineLocalReplayFailure | null;
}

/**
 * The Computer access a runtime-form option-source resolver gets, bounded so
 * the answer fits the replay budget (computerProbeCacheService):
 *
 * - On the owner replica the model probe answers with the Computer's outcome
 *   when it arrives within the wait, otherwise with the last good outcome
 *   (stale), otherwise it throws a daemon_timeout, which every resolver
 *   already maps to `probe_timeout` / its bundled list.
 * - When the replay to the owner replica failed, routing reports the probe as
 *   answerable here and the probe reads only the shared cache: the resolver
 *   still runs, so saved-connection enrichment and revision checks are the
 *   same as for a live answer.
 */
export function createBoundedRuntimeFormProbe(input: {
  machine: { daemonVersion?: string | null; computerVersion?: string | null };
  probes: ComputerProbeCacheService;
  orchestrator: Pick<AgentOrchestrator, "detectMachineRuntimeModels" | "detectMachineRuntimeModelsWithAuthority">;
  route: () => Promise<MachineLocalRoutingResult | MachineLocalReplayFailure>;
}): BoundedRuntimeFormProbe {
  let failedReplay: MachineLocalReplayFailure | null = null;
  let freshness: ComputerProbeFreshness | null = null;

  const answerModels = (
    machineId: string,
    runtime: string,
    request: () => Promise<MachineRuntimeModelDetection["outcome"]>,
  ) => failedReplay
    ? input.probes.cachedModels(machineId, runtime)
    : input.probes.probeModels(machineId, runtime, request);

  const settle = <T>(answer: ComputerProbeAnswer<T>): T => {
    freshness = computerProbeFreshness(answer);
    if (answer.state === "unavailable") {
      throw new RouteFailureError("daemon_timeout", "The Computer did not answer the model probe in time");
    }
    return answer.value;
  };

  return {
    async routeToComputer() {
      const routing = await input.route();
      if (!isMachineLocalReplayFailure(routing)) return routing;
      failedReplay = routing;
      return "confirmed_local";
    },
    probe: {
      async detectMachineRuntimeModels(machineId, runtime, options) {
        return settle(await answerModels(machineId, runtime, () =>
          input.orchestrator.detectMachineRuntimeModels(machineId, runtime, options)));
      },
      async detectMachineRuntimeModelsWithAuthority(machineId, runtime, options) {
        const live: { detection?: MachineRuntimeModelDetection } = {};
        const outcome = settle(await answerModels(machineId, runtime, async () => {
          live.detection = await input.orchestrator.detectMachineRuntimeModelsWithAuthority(machineId, runtime, options);
          return live.detection.outcome;
        }));
        if (freshness?.state === "ok" && live.detection) return live.detection;
        // A cached outcome: the versions are the machine row's, as for an offline Computer.
        return {
          outcome,
          daemonVersion: input.machine.daemonVersion ?? null,
          computerVersion: input.machine.computerVersion ?? null,
        };
      },
    },
    freshness: () => freshness,
    replayFailure: () => failedReplay,
  };
}
