import {
  slotArtifactPath,
  type Slot,
} from "@botiverse/k-carrier";
import { join } from "node:path";

import { computerDir } from "./paths.js";

/** K-owned state root: `<slockHome>/computer/k/`. */
export function kStateDir(slockHome: string): string {
  return join(computerDir(slockHome), "k");
}

/** K-owned slot artifact; Computer never invents or mirrors this layout. */
export function kSlotBinaryPath(slockHome: string, slot: Slot): string {
  return slotArtifactPath(kStateDir(slockHome), slot);
}

/** Durable exact managed set that quiesce() committed before handoff. */
export function kParkedSnapshotPath(slockHome: string): string {
  return join(kStateDir(slockHome), "host-parked-set.json");
}

/** HostAdapter-owned runner barrier; this is host state, never transaction state. */
export function kRunnerHoldPath(slockHome: string): string {
  return join(kStateDir(slockHome), "host-runner-hold.json");
}
