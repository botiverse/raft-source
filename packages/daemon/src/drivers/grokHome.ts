import os from "node:os";
import path from "node:path";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveGrokHomeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { homeDir?: string; cwd?: string } = {},
): string {
  const cwd = opts.cwd ?? process.cwd();
  const configured = nonEmptyString(env.GROK_HOME);
  if (configured) return path.resolve(cwd, configured);
  const homeDir = opts.homeDir ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  return path.join(homeDir, ".grok");
}
