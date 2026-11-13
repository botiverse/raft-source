// The first-party apps on for an agent's Server, as its daemon tells the CLI
// it spawns: `RAFT_ENABLED_APPS` is `AgentConfig.enabledApps` joined with
// commas (empty when none is on). The daemon sets it only when the Server sent
// `enabledApps`, and restarts an idle agent with the new value when it
// changes (serverFeaturesRefresh), so a CLI under a current daemon can skip a
// request to an app that is off. Absent (an older daemon, a self-hosted
// runner, the SDK) means unknown: ask as before.
//
// A hint for saving a request that would be refused, never an authorization
// check: the agent can set its own environment. Whether an app is on is
// decided by the Server's flag on every request.

export const RAFT_ENABLED_APPS_ENV = "RAFT_ENABLED_APPS";

/** The value the daemon sets for `enabledApps`. */
export function enabledAppsEnvValue(enabledApps: readonly string[]): string {
  return enabledApps.join(",");
}

/** Whether `appId` is on per the environment: true or false when the daemon said, undefined when it didn't. */
export function appEnabledPerEnv(env: Record<string, string | undefined>, appId: string): boolean | undefined {
  const raw = env[RAFT_ENABLED_APPS_ENV];
  if (raw === undefined) return undefined;
  return raw.split(",").map((id) => id.trim()).includes(appId);
}
