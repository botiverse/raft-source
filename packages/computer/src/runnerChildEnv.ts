import { OS_SUPERVISOR_KIND_ENV_VAR } from "./osSupervisorLifecycle.js";

export const PARENT_LOCK_HELD_ENV_VAR = "RAFT_COMPUTER_PARENT_MUTATION_LOCK_HELD";
export const SOURCE_SERVICE_PID_ENV_VAR = "RAFT_COMPUTER_SOURCE_SERVICE_PID";

/** Preserve launch/runtime env while stripping service-only ownership state. */
export function buildRunnerChildEnv(
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const {
    [PARENT_LOCK_HELD_ENV_VAR]: _parentLockMarker,
    [SOURCE_SERVICE_PID_ENV_VAR]: _sourceServicePid,
    [OS_SUPERVISOR_KIND_ENV_VAR]: _osSupervisorKind,
    ...childEnv
  } = baseEnv;
  return childEnv;
}
