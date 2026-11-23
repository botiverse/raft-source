import { createContext } from "react";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";

/**
 * Where an agent form's runtime runs (its server, Computer and Raft runtime
 * id), for an Upgrade offered inside the form (the model-source status line's
 * `runtime_outdated`). Null: no Computer chosen, so nothing to upgrade.
 */
export interface RuntimeUpgradeTarget {
  serverId: string;
  machineId: string;
  runtimeId: string;
  /** Test seam; the app's runtime-auth client when absent. */
  client?: RuntimeAuthClient;
}

export const RuntimeUpgradeTargetContext = createContext<RuntimeUpgradeTarget | null>(null);
