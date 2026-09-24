import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the ordinary npm bin with native Node after every package build.
// Source/tsx tests and the SEA builder can both hide a dependency that exports
// TypeScript from node_modules, so syntax checks alone are not sufficient.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const binPath = join(root, packageJson.bin["raft-computer"]);

const env = {};
for (const key of [
  "HOME",
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]) {
  if (process.env[key]) env[key] = process.env[key];
}
env.NO_COLOR = "1";

const result = spawnSync(process.execPath, [binPath, "--version"], {
  cwd: root,
  env,
  encoding: "utf8",
  timeout: 30_000,
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `published raft-computer bin failed under native Node (exit ${String(result.status)}):\n${result.stderr}`,
  );
}
if (result.stdout.trim() !== packageJson.version) {
  throw new Error(
    `published raft-computer bin reported ${JSON.stringify(
      result.stdout.trim(),
    )}, expected ${JSON.stringify(packageJson.version)}`,
  );
}
