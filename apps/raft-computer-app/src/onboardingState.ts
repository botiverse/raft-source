import type { ComputerStatusReport } from "@botiverse/raft-computer/lib";

export function needsOnboarding(status: ComputerStatusReport | null): boolean {
  if (!status) return true;
  if (!status.loggedIn) return true;
  if (status.servers.length === 0) return true;
  return false;
}
