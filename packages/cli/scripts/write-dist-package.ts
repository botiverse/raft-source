import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Post-build step for the canonical @botiverse/raft package (source-of-truth
// inversion, #proj-aiax:4c235f84): emits dist/package.json plus the bin
// entries. `raft` is the canonical verb; `slock` stays as a compatibility
// alias over the same CLI core (the invocation name drives alias-specific
// behavior in src/index.ts). `cont <id> [choice]` answers a command that
// paused for the agent: it is `raft __continue`, the same command the daemon's
// `cont` wrapper runs (daemon/src/drivers/cliTransport.ts), for agents that
// installed the CLI themselves.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const distDir = join(root, "dist");

mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify(
    { name: pkg.name, version: pkg.version, type: pkg.type, engines: pkg.engines },
    null,
    2,
  ) + "\n",
);

const raftBin = join(distDir, "raft.js");
const slockBin = join(distDir, "slock.js");
const contBin = join(distDir, "cont.js");
const runtimePreflight = `const match = process.version.match(/^v?(\\d+)\\./);
const major = match ? Number.parseInt(match[1], 10) : 0;
if (major < 24) {
  process.stderr.write("Error: Node " + (process.version || "<unknown>") + " is unsupported; raft requires Node >=24 before loading CLI runtime dependencies.\\n");
  process.stderr.write("No network requests, credentials, or local state were touched.\\n");
  process.stderr.write("Next action: Install/activate Node 24.22.1 (the repository pin), then retry.\\n");
  process.exit(1);
}
`;

writeFileSync(
  raftBin,
  `#!/usr/bin/env node\n${runtimePreflight}process.env.SLOCK_CLI_INVOCATION_NAME = "raft";\nawait import("./index.js");\n`,
);
writeFileSync(
  slockBin,
  `#!/usr/bin/env node\n${runtimePreflight}process.env.SLOCK_CLI_INVOCATION_NAME = "slock";\nawait import("./index.js");\n`,
);
writeFileSync(
  contBin,
  `#!/usr/bin/env node\n${runtimePreflight}process.env.SLOCK_CLI_INVOCATION_NAME = "raft";\nprocess.argv.splice(2, 0, "__continue");\nawait import("./index.js");\n`,
);
chmodSync(raftBin, 0o755);
chmodSync(slockBin, 0o755);
chmodSync(contBin, 0o755);
