import { homedir } from "node:os";
import { join } from "node:path";

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Where a web sign-in for the Pi runtime is saved: the daemon's own Pi agent
 * dir (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`), the one a Pi agent reads
 * unless its own env sets another (drivers/pi.ts: `spawnEnv.PI_CODING_AGENT_DIR
 * ?? getAgentDir()`, then `<agentDir>/auth.json` and `models.json`). Passed
 * explicitly, so OAR's `OAR_PI_AGENT_DIR` can never point a sign-in elsewhere.
 * It is also where pi run outside Raft by this account signs in.
 */
export function piSignInPaths(): { authPath: string; modelsPath: string } {
  const agentDir = getAgentDir();
  return { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") };
}

/**
 * Pi's own stable id for this installation, kept in its agent dir's settings
 * (`deviceId`, as pi's `/login` passes it): OpenAI's "Sign in with ChatGPT"
 * names the installation by it. Read (or created) only when that flow asks.
 */
export function piSignInDeviceId(): string {
  return SettingsManager.create(homedir(), getAgentDir()).getOrCreateDeviceId();
}
