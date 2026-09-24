// Process primitives used by both the service (CLI adapter) and the
// services/* layer. Neutral relocation target: services/* must NOT
// import from service.ts (a CLI adapter) — these pidfile/liveness
// primitives have no CLI concerns and belong in a sibling-neutral
// module that either layer can depend on.
//
// Package-private: NOT exposed via `@botiverse/raft-computer/lib`
// (RFC v9 §3). The `/internal/` segment is an export hard gate; the
// `exports` field in `packages/computer/package.json` MUST NOT list any
// path under `./src/internal/*`.
//
// Pure relocation from `service.ts` (RFC v9 PR-impl-1 commit 1).
// 0 behavior change — identical signatures, identical bodies; only the
// import path moves.
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Generic pidfile reader by absolute path. Returns null on missing / junk. */
export async function readPidfileAt(pidfilePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidfilePath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Liveness via signal 0. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function writePidfileAt(pidfilePath: string, pid: number): Promise<void> {
  await mkdir(dirname(pidfilePath), { recursive: true });
  await writeFile(pidfilePath, String(pid), { mode: 0o600 });
}

export async function clearPidfileAt(pidfilePath: string): Promise<void> {
  try {
    await unlink(pidfilePath);
  } catch {
    /* ignore */
  }
}
