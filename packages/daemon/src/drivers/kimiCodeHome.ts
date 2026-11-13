// The Kimi Code SDK home, one rule for everything that needs it: the kimi-sdk
// driver (model detection, session launch) and the transcript resolver.

import path from "node:path";
import { KIMI_CODE_HOME_ENV } from "@botiverse/raft-shared";

/**
 * The Kimi Code SDK home in `env`: its `KIMI_CODE_HOME`, resolved (a relative
 * one against the daemon's cwd), else `<defaultHomeDir>/.kimi-code`. An empty
 * value counts as unset. Callers pass the env the SDK runs with: the agent's
 * env vars over the daemon's.
 */
export function kimiSdkHomeFromEnv(env: Record<string, string | undefined>, defaultHomeDir: string): string {
  // The one env var the SDK home depends on (RUNTIME_SESSION_HOME_ENV_KEYS).
  const configured = env[KIMI_CODE_HOME_ENV];
  return configured ? path.resolve(configured) : path.join(defaultHomeDir, ".kimi-code");
}
