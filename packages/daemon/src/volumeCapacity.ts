import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { ambientProcessEnv } from "./processEnvPatch";

export interface VolumeCapacity {
  availableBytes: number;
  totalBytes: number;
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string) => void,
) => void;

export interface VolumeCapacityDeps {
  platform?: NodeJS.Platform;
  statfs?: (path: string) => Promise<{ bavail: number; blocks: number; bsize: number }>;
  execFile?: ExecFile;
}

const IMPORTANT_USAGE_TIMEOUT_MS = 5_000;

// JXA (osascript ships with macOS): the volume's capacity for important
// resources, the number Finder shows as "available".
const IMPORTANT_USAGE_SCRIPT = `ObjC.import("Foundation");
function run(argv) {
  const u = $.NSURL.fileURLWithPath(argv[0]);
  const k = $.NSURLVolumeAvailableCapacityForImportantUsageKey;
  const r = u.resourceValuesForKeysError($([k]), null);
  return String(ObjC.unwrap(r.objectForKey(k)));
}`;

const defaultExecFile: ExecFile = (file, args, options, callback) => {
  // Explicit ambient env: never inherit another agent's in-flight process.env patch.
  execFile(file, args, { ...options, encoding: "utf8", env: ambientProcessEnv(), windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => callback(error, stdout));
};

/**
 * Free and total bytes of the volume holding `path`, or null if statfs fails.
 * statfs's bavail on APFS leaves out purgeable space (iCloud cache, local
 * snapshots) that macOS frees for important writes, so a Mac Finder shows
 * with 120 GB available reads as 20 GB free. On darwin the available figure
 * is therefore the volume's important-usage capacity when osascript returns a
 * plausible one; any failure keeps statfs's. Never throws.
 */
export async function readVolumeCapacity(path: string, deps: VolumeCapacityDeps = {}): Promise<VolumeCapacity | null> {
  const info = await (deps.statfs ?? statfs)(path).catch(() => null);
  if (!info) return null;
  const capacity = { availableBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
  if ((deps.platform ?? process.platform) !== "darwin") return capacity;
  const important = await readImportantUsageCapacity(path, deps.execFile ?? defaultExecFile);
  // Purgeable space only adds to what statfs sees: a volume type without the
  // key can answer 0, which must not read as a full disk. Capped at total.
  if (important !== null && important <= capacity.totalBytes) {
    capacity.availableBytes = Math.max(capacity.availableBytes, important);
  }
  return capacity;
}

function readImportantUsageCapacity(path: string, run: ExecFile): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      run(
        "osascript",
        ["-l", "JavaScript", "-e", IMPORTANT_USAGE_SCRIPT, "--", path],
        { timeout: IMPORTANT_USAGE_TIMEOUT_MS },
        (error, stdout) => {
          const text = error ? "" : String(stdout).trim();
          const bytes = /^\d+$/.test(text) ? Number(text) : Number.NaN;
          resolve(Number.isSafeInteger(bytes) ? bytes : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}
