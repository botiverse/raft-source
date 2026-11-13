import { useEffect, useState } from "react";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import type { Machine } from "../store/machineStore";
import { UNREPORTED_VERSION_GRACE_MS, computerVersionTier } from "../utils/computerVersionTier";
import type { ComputerVersionTier } from "../utils/computerVersionTier";

export type ResolvedComputerVersionTier = Exclude<ComputerVersionTier, { kind: "unreported" }>;

const NONE: ResolvedComputerVersionTier = { kind: "none" };

/**
 * computerVersionTier for a card, with "online, no version" held back for
 * UNREPORTED_VERSION_GRACE_MS: a current Computer reports its version right
 * after it connects, so only a Computer still silent after that is too old to
 * report one and needs a reinstall.
 */
export function useComputerVersionTier(
  machine: Pick<Machine, "id" | "isComputer" | "status" | "computerVersion" | "versionGate">,
): ResolvedComputerVersionTier {
  const tier = computerVersionTier(machine);
  const waitingKey = tier.kind === "unreported" ? machine.id : null;
  // Which wait has run out. Reset whenever the wait ends (a version arrived or
  // the machine went offline), so the next one starts from zero.
  const [elapsed, setElapsed] = useState<{ key: string | null; done: boolean }>({ key: waitingKey, done: false });
  if (elapsed.key !== waitingKey) setElapsed({ key: waitingKey, done: false });
  useEffect(() => {
    if (waitingKey === null) return;
    const t = setClockTimeout(
      () => setElapsed((current) => (current.key === waitingKey ? { key: waitingKey, done: true } : current)),
      UNREPORTED_VERSION_GRACE_MS,
    );
    return () => clearClockTimeout(t);
  }, [waitingKey]);
  if (tier.kind !== "unreported") return tier;
  return elapsed.key === waitingKey && elapsed.done
    ? { ...tier, kind: "reinstall" }
    : NONE;
}
