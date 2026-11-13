import type { Machine } from "../../store/machineStore";
import { getComputerCommands } from "../../utils/computerSetupCommand";
import { getServerUrl } from "../../utils/server";

/**
 * The command the Computer page's recovery card gives for an offline Computer
 * (`raft-computer restart /<server>`: it also starts a stopped service),
 * derived as MachineDetailPanel derives it. Null without a server slug.
 */
export function agentComputerRestartCommand(machine: Machine, serverSlug: string | undefined): string | null {
  const windowsMachine = machine.os?.toLowerCase().startsWith("win") ?? false;
  const commands = getComputerCommands(serverSlug, import.meta.env?.VITE_DEPLOYMENT_ENV, getServerUrl(), {
    machineId: machine.isComputer ? null : machine.id,
    platform: windowsMachine ? "windows" : undefined,
  });
  return commands?.restart ?? null;
}
