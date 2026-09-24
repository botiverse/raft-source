#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../../..");
const appDir = resolve(import.meta.dirname, "..");
function expandHome(input, homeDir = homedir()) {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return resolve(homeDir, input.slice(2));
  return input;
}

export function prepareDevStartEnv(baseEnv = process.env, homeDir = homedir(), tempDir = tmpdir()) {
  const realHome = resolve(homeDir, ".slock");
  const configuredHome = baseEnv.RAFT_HOME?.trim() || baseEnv.SLOCK_HOME?.trim();
  const allowRealHome = baseEnv.RAFT_COMPUTER_APP_ALLOW_REAL_HOME === "1";
  const env = { ...baseEnv };

  if (configuredHome) {
    const resolved = resolve(expandHome(configuredHome, homeDir));
    if (resolved === realHome && !allowRealHome) {
      throw new Error(
        [
          "Refusing to start the Desktop app dev build against real ~/.slock.",
          "Use SLOCK_HOME=$(mktemp -d) for manual testing, or set",
          "RAFT_COMPUTER_APP_ALLOW_REAL_HOME=1 if you intentionally need the real home.",
        ].join("\n"),
      );
    }
    env.SLOCK_HOME = resolved;
  } else {
    const isolatedHome = mkdtempSync(resolve(tempDir, "raft-computer-app-dev-"));
    env.SLOCK_HOME = isolatedHome;
    console.error(`Using isolated SLOCK_HOME=${isolatedHome}`);
  }

  if (env.RAFT_HOME && env.SLOCK_HOME !== env.RAFT_HOME) {
    delete env.RAFT_HOME;
  }

  return env;
}

function main() {
  let env;
  try {
    env = prepareDevStartEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const binDir = resolve(repoRoot, "node_modules/.bin");
  env.PATH = `${binDir}${delimiter}${env.PATH ?? ""}`;

  const electronBin = process.platform === "win32" ? "electron.cmd" : "electron";
  const result = spawnSync(electronBin, [appDir], {
    cwd: appDir,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
