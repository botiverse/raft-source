import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { SLOCK_CLI_TRANSPORT_DIR_ENV } from "./auth/managedTransport";
import { readCliVersion } from "./version";

interface CliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function repositoryCliEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };

  // A daemon-managed shell exports the current launch's transport directory.
  // The production CLI correctly forwards to that wrapper before parsing, but
  // these parser tests must exercise the repository entry they explicitly
  // spawn. Managed-wrapper forwarding has its own integration coverage.
  delete env[SLOCK_CLI_TRANSPORT_DIR_ENV];
  return env;
}

function runCli(args: string[], parentEnv: NodeJS.ProcessEnv = process.env): CliRunResult {
  const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", "src/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: repositoryCliEnv(parentEnv),
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("app config help names its flags (flag names are the interface)", () => {
  const result = runCli(["app", "config", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  for (const flag of ["--app <app-id>", "--set <key=value>", "--unset <key>"]) assert.ok(result.stdout.includes(flag), flag);
});

test("root --version identifies the CLI carrier and never emits a placeholder", () => {
  const result = runCli(["--version"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `Raft CLI: ${readCliVersion()}\n`);
  assert.equal(result.stdout.includes("0.0.0"), false);
});

test("parser harness isolates the repository CLI from an inherited managed transport", () => {
  const inheritedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [SLOCK_CLI_TRANSPORT_DIR_ENV]: "/synthetic-managed-transport-must-not-run",
  };
  delete inheritedEnv.SLOCK_AGENT_PROXY_TOKEN_FILE;
  delete inheritedEnv.SLOCK_AGENT_PROXY_TOKEN;
  delete inheritedEnv.SLOCK_AGENT_TOKEN_FILE;

  const result = runCli(["--version"], inheritedEnv);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `Raft CLI: ${readCliVersion()}\n`);
});
