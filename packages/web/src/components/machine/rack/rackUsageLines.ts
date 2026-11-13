import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";

// Whether a rack usage cell last showed two lines (an account that reports a
// model's own window: "60% used" over "Fable · 40%"), per server, computer
// and provider, so while its usage is read again its placeholder is that
// tall and the card or row does not grow when the answer lands. Kept in this
// browser (localStorage, as the rack's counts), past the usage client's own 60s cache:
// `slock:rackUsageLines:{serverId}:{machineId}:{provider}` = "2" | "1".

const STORAGE_PREFIX = "slock:rackUsageLines";

type LinesStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): LinesStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function rackUsageLinesKey(serverId: string, machineId: string, provider: RuntimeAccountUsageProvider): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(serverId)}:${encodeURIComponent(machineId)}:${provider}`;
}

/** Whether the cell last showed two lines; false when never seen in this browser (or unreadable). */
export function readRackUsageTwoLines(
  serverId: string,
  machineId: string,
  provider: RuntimeAccountUsageProvider,
  storage: LinesStorage | undefined = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(rackUsageLinesKey(serverId, machineId, provider)) === "2";
  } catch {
    return false;
  }
}

export function writeRackUsageTwoLines(
  serverId: string,
  machineId: string,
  provider: RuntimeAccountUsageProvider,
  twoLines: boolean,
  storage: LinesStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  const key = rackUsageLinesKey(serverId, machineId, provider);
  const value = twoLines ? "2" : "1";
  try {
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}
