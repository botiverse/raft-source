// What the daemon reports on `ready` about how it runs (`installKind`) and
// whether a `node` is available to start child processes with (`nodeOnPath`).
// Read once per ready, synchronously, from the process itself and PATH only:
// nothing is spawned and no path leaves the machine.
import fs from "node:fs";
import path from "node:path";
import type { DaemonInstallKind } from "@botiverse/raft-shared";
import { detectNodeHostKind, type NodeHostKindOptions } from "./drivers/nodeHostLaunch";

export interface DaemonInstallFacts {
  /** Absent when the host cannot be classified (`detectNodeHostKind` says "unknown"). */
  installKind?: DaemonInstallKind;
  nodeOnPath: boolean;
}

export interface DaemonInstallFactsDeps {
  hostKind?: NodeHostKindOptions;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutableFile?: (file: string) => boolean;
}

function defaultIsExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    // Windows has no execute bit: a `node.exe` file on PATH is what a spawn finds.
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when some absolute PATH entry holds an executable `node` (`node.exe` on Windows). */
export function nodeOnPath(deps: Omit<DaemonInstallFactsDeps, "hostKind"> = {}): boolean {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const isExecutableFile = deps.isExecutableFile ?? ((file: string) => defaultIsExecutableFile(file, platform));
  // Windows keeps the variable as `Path`; env lookups there are case-insensitive
  // only on the real process.env, not on a copied object.
  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const name = platform === "win32" ? "node.exe" : "node";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const isAbsolute = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    if (isExecutableFile(join(dir, name))) return true;
  }
  return false;
}

export function daemonInstallFacts(deps: DaemonInstallFactsDeps = {}): DaemonInstallFacts {
  const kind = detectNodeHostKind(deps.hostKind);
  return {
    ...(kind === "unknown" ? {} : { installKind: kind }),
    nodeOnPath: nodeOnPath(deps),
  };
}
