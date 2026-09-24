import type { OsSupervisorKind } from "./osSupervisor.js";

export const OS_SUPERVISOR_KIND_ENV_VAR = "RAFT_COMPUTER_OS_SUPERVISOR_KIND";

const OS_SUPERVISOR_KINDS = new Set<OsSupervisorKind>([
  "launchd-user",
  "systemd-user",
  "windows-task",
]);

export interface LegacyOsSupervisorInvocation {
  kind: OsSupervisorKind;
  slockHome: string;
}

export function parseLegacyOsSupervisorInvocation(
  argv: string[] = process.argv,
): LegacyOsSupervisorInvocation | null {
  const serviceIndex = argv.indexOf("__service");
  if (
    (serviceIndex !== 1 && serviceIndex !== 2) ||
    argv.lastIndexOf("__service") !== serviceIndex
  )
    return null;
  // The retired manager definitions have one exact closed grammar. Do not let
  // a pseudo marker swallow an otherwise arbitrary CLI invocation.
  if (argv.length !== serviceIndex + 5) return null;
  const markerIndex = argv.indexOf("--os-supervised", serviceIndex + 1);
  if (
    markerIndex < 0 ||
    argv.lastIndexOf("--os-supervised") !== markerIndex ||
    markerIndex + 1 >= argv.length
  )
    return null;
  const kind = argv[markerIndex + 1] as OsSupervisorKind;
  if (!OS_SUPERVISOR_KINDS.has(kind)) return null;
  const homeIndex = argv.indexOf("--slock-home", serviceIndex + 1);
  if (homeIndex < 0 || argv.lastIndexOf("--slock-home") !== homeIndex)
    return null;
  const optionSlots = new Set([serviceIndex + 1, serviceIndex + 3]);
  if (
    !optionSlots.has(markerIndex) ||
    !optionSlots.has(homeIndex) ||
    markerIndex === homeIndex
  )
    return null;
  const slockHome = homeIndex >= 0 ? argv[homeIndex + 1]?.trim() : undefined;
  if (!slockHome || slockHome.startsWith("--")) return null;
  return { kind, slockHome };
}
