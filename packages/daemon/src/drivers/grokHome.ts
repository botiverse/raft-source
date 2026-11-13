import os from "node:os";
import path from "node:path";
import { GROK_HOME_ENV } from "@botiverse/raft-shared";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveGrokHomeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { homeDir?: string; cwd?: string } = {},
): string {
  const cwd = opts.cwd ?? process.cwd();
  // The one agent env var the Grok home depends on (RUNTIME_SESSION_HOME_ENV_KEYS);
  // HOME below is the daemon's own fallback, and callers that resolve an agent's home pass `homeDir`.
  const configured = nonEmptyString(env[GROK_HOME_ENV]);
  if (configured) return path.resolve(cwd, configured);
  const homeDir = opts.homeDir ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  return path.join(homeDir, ".grok");
}
