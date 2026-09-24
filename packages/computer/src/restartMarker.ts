import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PendingRestartMarker {
  readonly requestId: string;
  readonly originServerId: string;
  readonly startedAt: string;
  readonly oldServicePid?: number;
  readonly oldRunnerPids?: Record<string, number>;
  readonly acceptedManagedServerIds?: string[];
}

export function pendingRestartMarkerPath(slockHome: string): string {
  return join(slockHome, "restart-pending.json");
}

export async function writePendingRestartMarker(
  slockHome: string,
  marker: PendingRestartMarker,
): Promise<void> {
  const path = pendingRestartMarkerPath(slockHome);
  const tmp = `${path}.tmp`;
  await mkdir(slockHome, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function readPendingRestartMarker(
  slockHome: string,
): Promise<PendingRestartMarker | null> {
  try {
    const parsed = JSON.parse(
      await readFile(pendingRestartMarkerPath(slockHome), "utf8"),
    ) as Partial<PendingRestartMarker>;
    if (
      typeof parsed.requestId !== "string" ||
      typeof parsed.originServerId !== "string" ||
      typeof parsed.startedAt !== "string"
      || (parsed.oldServicePid !== undefined && typeof parsed.oldServicePid !== "number")
      || (parsed.oldRunnerPids !== undefined
        && (typeof parsed.oldRunnerPids !== "object"
          || parsed.oldRunnerPids === null
          || Object.values(parsed.oldRunnerPids).some((pid) => typeof pid !== "number")))
      || (parsed.acceptedManagedServerIds !== undefined
        && (!Array.isArray(parsed.acceptedManagedServerIds)
          || parsed.acceptedManagedServerIds.some((serverId) => typeof serverId !== "string")))
    ) {
      return null;
    }
    return parsed as PendingRestartMarker;
  } catch {
    return null;
  }
}

export async function clearPendingRestartMarker(slockHome: string): Promise<void> {
  await rm(pendingRestartMarkerPath(slockHome), { force: true });
}

export function shouldReconcilePendingRestart(
  marker: PendingRestartMarker,
  serverId: string,
): boolean {
  return marker.originServerId === serverId;
}
