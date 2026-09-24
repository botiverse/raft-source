import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

export const SLOCK_CLI_TRANSPORT_DIR_ENV = "SLOCK_CLI_TRANSPORT_DIR";
export const SLOCK_AGENT_LAUNCH_DIR_ENV = "SLOCK_AGENT_LAUNCH_DIR";

export class ManagedTransportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ManagedTransportError";
  }
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function isRealDirectory(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealFile(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve the current managed launch's daemon-owned wrapper when a host-global
 * CLI won PATH resolution. The transport directory is accepted only when it
 * exactly matches the daemon's non-secret SLOCK_HOME/agent/launch projection;
 * an arbitrary environment pathname is never executed.
 */
export function resolveManagedTransportWrapper(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const transportDir = env[SLOCK_CLI_TRANSPORT_DIR_ENV];
  if (!transportDir) return null;

  // A wrapper invocation already carries one of these credential carriers.
  // Do not recurse back into itself.
  if (
    env.SLOCK_AGENT_PROXY_TOKEN_FILE
    || env.SLOCK_AGENT_PROXY_TOKEN
    || env.SLOCK_AGENT_TOKEN_FILE
  ) {
    return null;
  }

  const slockHome = env.SLOCK_HOME;
  const agentId = env.SLOCK_AGENT_ID;
  const launchDir = env[SLOCK_AGENT_LAUNCH_DIR_ENV];
  if (!slockHome || !agentId || !launchDir) {
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_UNAVAILABLE",
      "This command is inside a managed Raft runtime, but its current CLI wrapper identity is incomplete. Restart the managed runtime; no local profile was used.",
    );
  }

  const expectedDir = path.join(
    path.resolve(slockHome),
    "cli-transport",
    safePathPart(agentId),
    safePathPart(launchDir),
  );
  if (path.resolve(transportDir) !== expectedDir || !isRealDirectory(expectedDir)) {
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_UNAVAILABLE",
      "This command is inside a managed Raft runtime, but its CLI transport directory does not match the current agent launch. Restart the managed runtime; no local profile was used.",
    );
  }

  if (platform === "win32") {
    // Node cannot safely execute a .cmd wrapper without a shell, while a shell
    // would reinterpret user command arguments. Fail closed instead of adding
    // a command-injection surface. Native managed Windows launches already put
    // the .cmd wrapper first in PATH; this branch is only the bypass recovery.
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_REQUIRED",
      `The host-global Raft CLI was selected inside a managed runtime. Run the current daemon wrapper at ${path.join(expectedDir, "raft.cmd")} or restart the runtime; no local profile was used.`,
    );
  }

  const wrapperPath = path.join(expectedDir, "raft");
  if (!isRealFile(wrapperPath)) {
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_UNAVAILABLE",
      `The current managed Raft wrapper is missing at ${wrapperPath}. Restart the managed runtime; no local profile was used.`,
    );
  }
  return wrapperPath;
}

export function forwardManagedTransportIfNeeded(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: {
    platform?: NodeJS.Platform;
    spawnSync?: typeof spawnSync;
  } = {},
): SpawnSyncReturns<Buffer> | null {
  const wrapperPath = resolveManagedTransportWrapper(env, deps.platform);
  if (!wrapperPath) return null;
  return (deps.spawnSync ?? spawnSync)(wrapperPath, argv, {
    env,
    stdio: "inherit",
  });
}
