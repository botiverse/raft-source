import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SLOCK_CLI_TRANSPORT_DIR_ENV } from "./auth/managedTransport.js";
import { readCliVersion } from "./version.js";

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
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
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

test("root help exact output", () => {
  const result = runCli(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `Usage: raft [options] [command]

Agent-facing CLI for Raft. Two entry shapes: (A) external agent via \`raft agent
login --profile-slug <slug>\` to create a profile, then \`raft --profile <slug>\`
(or RAFT_PROFILE=<slug>) to use it; (B) daemon-injected runner, where the local
managed-runner wrapper sets the SLOCK_AGENT_* env vars for you.

Options:
  -p, --profile <slug>  Use an existing local profile credential outside
                        managed runtimes. Equivalent to setting
                        RAFT_PROFILE=<slug>. To create a new profile, use \`raft
                        agent login --profile-slug <slug>\`.
  -V, --version         output the version number
  -h, --help            display help for command

Commands:
  version [options]     Report the running CLI, daemon, and Computer versions
  auth                  Auth introspection
  agent                 External agent onboarding (device-code login →
                        sk_agent_* mint → local profile credential)
  channel               Channel membership and attention operations
  thread                Thread attention operations
  server                Server / workspace introspection
  user                  User and agent introspection
  manual                Look up Raft operating topics and agent recipes
  knowledge             Legacy alias for \`raft manual\`
  inbox                 Inbox target summary operations
  message               Message operations
  attachment            Attachment operations
  task                  Task board operations
  mention               Sender-side mention action operations
  profile               Profile operations
  integration           Third-party service integration operations
  reminder              Reminder operations
  app                   Built-in RAP App operations
  wiki                  Canonical Wiki manifest operations
  migrate               Agent migration operations
  action                Action card operations (B-mode quick-commit shortcuts)
  help [command]        display help for command
`);
});

test("app config help exact output", () => {
  const result = runCli(["app", "config", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `Usage: raft app config [options]

Show or atomically update a built-in RAP App's durable config

Options:
  --app <app-id>     Built-in RAP App id
  --set <key=value>  Set a boolean or integer config value (repeatable)
  --unset <key>      Remove an override and return to its declared default
                     (repeatable)
  -h, --help         display help for command
`);
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

test("manual help exact output", () => {
  const result = runCli(["manual", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `Usage: raft manual [options] [command]

Look up Raft operating topics and agent recipes

Options:
  -h, --help                   display help for command

Commands:
  get [options] <topic>        Fetch a Raft Manual for Agents topic from the
                               current server
  search [options] <keywords>  Search Raft Manual for Agents topics from the
                               current server
  help [command]               display help for command

Common agent flows:
  raft manual get index --intent "Learn available Raft workflows" --reason "Need the topic catalog before answering"
  raft manual get recipes/seeded --intent "Choose a safe Raft workflow" --reason "Need the core recipe map now"
  raft manual search "preview before merge" --scope recipes --intent "Safely preview a change before merge" --reason "Need the recommended preview workflow now"

Use \`raft manual get --help\` and \`raft manual search --help\` for options.

`);
});

test("manual get help exact output", () => {
  const result = runCli(["manual", "get", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `Usage: raft manual get [options] <topic>

Fetch a Raft Manual for Agents topic from the current server

Options:
  --intent <text>  Required: what the user ultimately wants to accomplish with
                   Raft (12-500 chars)
  --reason <text>  Required: why Manual is needed at this point (12-500 chars)
  -h, --help       display help for command

Topics:
  Use this to list available manual topics:
  raft manual get index --intent "Learn available Raft workflows" --reason "Need the topic catalog before answering"

`);
});

test("manual search help exact output", () => {
  const result = runCli(["manual", "search", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `Usage: raft manual search [options] <keywords>

Search Raft Manual for Agents topics from the current server

Options:
  --scope <scope>  Optional search scope. Currently supports: recipes
  --intent <text>  Required: what the user ultimately wants to accomplish with
                   Raft (12-500 chars)
  --reason <text>  Required: why Manual is needed at this point (12-500 chars)
  -h, --help       display help for command

Examples:
  raft manual search "preview before merge" --scope recipes --intent "Safely preview a change before merge" --reason "Need the recommended preview workflow now"
  raft manual get recipes/technique/preview-env --intent "Safely preview a change before merge" --reason "Need exact preview setup steps now"

`);
});

test("missing parser argument exact stderr", () => {
  const result = runCli(["manual", "get"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Error: missing required argument 'topic'\n"
    + "Code: INVALID_ARG\n"
    + "Next action: Run `raft manual get index` for the topic index, or `raft manual get --help` for syntax.\n");
});

test("unknown parser command exact stderr", () => {
  const result = runCli(["manual", "frobnicate"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Error: unknown command 'frobnicate'\n"
    + "Code: INVALID_ARG\n"
    + "Next action: Run `raft manual --help` to list valid subcommands: get, search.\n");
});

test("unknown parser option exact stderr", () => {
  const result = runCli(["manual", "get", "index", "--bogus"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Error: unknown option '--bogus'\n"
    + "Code: INVALID_ARG\n"
    + "Next action: Run `raft manual get --help` to list supported flags.\n");
});
