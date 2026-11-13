import { OS_SUPERVISOR_KIND_ENV_VAR } from "./osSupervisorLifecycle";

export const PARENT_LOCK_HELD_ENV_VAR = "RAFT_COMPUTER_PARENT_MUTATION_LOCK_HELD";
export const SOURCE_SERVICE_PID_ENV_VAR = "RAFT_COMPUTER_SOURCE_SERVICE_PID";

/**
 * Pin the Raft home this service resolved into a child's env. Children
 * (service replacement, per-server daemon, agent `raft` CLI, Stamp/Hands under
 * an agent) must not re-run the default-home rule: with both ~/.slock and
 * ~/.raft holding state they could land on the other directory (task #915).
 * Both names are set because older consumers read only SLOCK_HOME.
 */
export function pinRaftHomeEnv(env: NodeJS.ProcessEnv, raftHome: string): NodeJS.ProcessEnv {
  return { ...env, RAFT_HOME: raftHome, SLOCK_HOME: raftHome };
}

/**
 * glibc malloc settings the runner starts with on Linux (#wg-memory-usage:#36).
 * A runner with a Built-in Pi agent builds a 0.5-4 MB request every model call;
 * with glibc's defaults the freed memory stays in the process. Measured with
 * pi 1.5.0 at a 1M-token window: idle 187 -> 151 MB, right after work
 * 531 -> 419 MB, no speed difference. glibc reads these once at process start,
 * so they must be in the runner's launch env.
 */
export const RUNNER_MALLOC_ENV: Readonly<Record<string, string>> = {
  MALLOC_ARENA_MAX: "2",
  MALLOC_MMAP_THRESHOLD_: "131072",
};

/**
 * Names of the RUNNER_MALLOC_ENV vars the service added (comma separated).
 * The runner removes exactly these at startup, so runtimes and agent commands
 * never inherit them: a fixed mmap threshold can slow allocation-heavy
 * programs such as compilers. Values the user set themselves are not listed
 * and are passed on unchanged.
 */
export const RUNNER_MALLOC_ADDED_ENV_VAR = "RAFT_COMPUTER_RUNNER_MALLOC_ADDED";

/** Preserve launch/runtime env while stripping service-only ownership state. */
export function buildRunnerChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  raftHome?: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const {
    [PARENT_LOCK_HELD_ENV_VAR]: _parentLockMarker,
    [SOURCE_SERVICE_PID_ENV_VAR]: _sourceServicePid,
    [OS_SUPERVISOR_KIND_ENV_VAR]: _osSupervisorKind,
    [RUNNER_MALLOC_ADDED_ENV_VAR]: _mallocAdded,
    ...childEnv
  } = baseEnv;
  if (platform === "linux") {
    const added = Object.keys(RUNNER_MALLOC_ENV).filter((name) => childEnv[name] === undefined);
    for (const name of added) childEnv[name] = RUNNER_MALLOC_ENV[name];
    if (added.length > 0) childEnv[RUNNER_MALLOC_ADDED_ENV_VAR] = added.join(",");
  }
  return raftHome === undefined ? childEnv : pinRaftHomeEnv(childEnv, raftHome);
}

/**
 * Runner startup: drop the malloc vars the service added (glibc has already
 * read them), so nothing the runner spawns inherits them. Mutates `env`.
 */
export function removeServiceAddedMallocEnv(env: NodeJS.ProcessEnv = process.env): void {
  const added = env[RUNNER_MALLOC_ADDED_ENV_VAR];
  if (added === undefined) return;
  for (const name of added.split(",")) {
    if (Object.hasOwn(RUNNER_MALLOC_ENV, name)) delete env[name];
  }
  delete env[RUNNER_MALLOC_ADDED_ENV_VAR];
}
