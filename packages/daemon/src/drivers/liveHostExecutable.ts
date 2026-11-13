import { existsSync, readlinkSync, statSync } from "node:fs";
import { resolveLiveExecutablePath } from "@botiverse/raft-shared";

/** `dev:ino` of a file, or null when the platform cannot report one. */
export function executableFileIdentity(path: string): string | null {
  try {
    const stat = statSync(path);
    return stat.ino > 0 ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

let readProcSelfExeForHost: () => string | null = () => {
  try {
    return readlinkSync("/proc/self/exe");
  } catch {
    return null;
  }
};

/** Test seam: a test that fakes process.execPath cannot fake /proc/self/exe. */
export function setProcSelfExeReaderForTests(reader: (() => string | null) | null): void {
  readProcSelfExeForHost = reader ?? (() => {
    try {
      return readlinkSync("/proc/self/exe");
    } catch {
      return null;
    }
  });
}

// Captured at module load, i.e. before any later K promotion or staging can
// rename or replace the file behind process.execPath.
const STARTUP_EXECUTABLE_IDENTITY = executableFileIdentity(process.execPath);

/**
 * The running binary's re-execable path for a SEA / unrecognised host. A K
 * upgrade promotes the experiment slot to stable by renaming it under the
 * running process, so the startup `process.execPath` can name a path that no
 * longer exists; see liveExecutablePath in shared.
 */
export function liveHostExecutablePath(execPath: string = process.execPath): string {
  return resolveLiveExecutablePath({
    execPath,
    platform: process.platform,
    exists: existsSync,
    readProcSelfExe: readProcSelfExeForHost,
    identityOf: executableFileIdentity,
    startupIdentity: STARTUP_EXECUTABLE_IDENTITY,
  });
}
