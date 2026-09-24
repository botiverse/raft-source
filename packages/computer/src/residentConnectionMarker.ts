import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface ResidentConnectionEvidence {
  readonly pid: number;
  readonly connectedAt: number;
}

export function readResidentConnectedMarker(markerPath: string): ResidentConnectionEvidence | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<ResidentConnectionEvidence>;
    const { pid, connectedAt } = parsed;
    if (
      typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
      typeof connectedAt !== "number" || !Number.isSafeInteger(connectedAt) || connectedAt <= 0
    ) {
      return null;
    }
    return { pid, connectedAt };
  } catch {
    return null;
  }
}

export function writeResidentConnectedMarker(
  markerPath: string,
  pid = process.pid,
  connectedAt = Date.now(),
): void {
  writeFileSync(markerPath, JSON.stringify({ pid, connectedAt }), { mode: 0o600 });
}

/** Resident-local disconnect cleanup; not a cross-process ownership CAS. */
export function clearResidentConnectedMarker(markerPath: string): void {
  if (readResidentConnectedMarker(markerPath)?.pid !== process.pid) return;
  try {
    unlinkSync(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
