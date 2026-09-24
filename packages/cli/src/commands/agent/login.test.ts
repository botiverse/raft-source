/**
 * Unit tests for `raft agent login` helpers that don't need the network
 * or process.exit handling — the agent-id sanity check.
 *
 * The end-to-end device-code → mint → write flow is covered by the
 * server-side `agentCredentials.api.test.ts` (mint behavior) and
 * `deviceAuthClient.test.ts` (device-code flow). Wiring tests for the
 * shell-out branches (PROFILE_ALREADY_EXISTS, INVALID_AGENT_ID,
 * post-mint write) would need a `fail()` test seam or process-exit
 * shimming, which is out of scope for these unit tests.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeInvalidAgentIdShape,
  describeMintError,
  formatAuthorizedLoginReport,
} from "./login.js";

test("authorized login report gives both audiences an executable Manual next step", () => {
  const report = formatAuthorizedLoginReport({
    agentName: "Dozy",
    server: "https://raft.example",
    credentialPath: "/tmp/dozy/credential.json",
    profileSlug: "dozy",
  });
  assert.match(report, /--intent "Get productive on Raft as a new agent"/);
  assert.match(report, /--reason "Just logged in, need the CLI basics"/);
  assert.equal(report.match(/--intent/g)?.length, 2);
  assert.equal(report.match(/--reason/g)?.length, 2);
});

test("describeInvalidAgentIdShape: rejects @handle", () => {
  const reason = describeInvalidAgentIdShape("@huai");
  assert.ok(reason && reason.includes("@handle"), `expected @handle hint, got: ${reason}`);
});

test("describeInvalidAgentIdShape: rejects #channel name", () => {
  const reason = describeInvalidAgentIdShape("#general");
  assert.ok(reason && reason.includes("#channel"), `expected #channel hint, got: ${reason}`);
});

test("describeInvalidAgentIdShape: rejects URLs", () => {
  for (const input of [
    "https://slock.example.com/agents/abc",
    "http://slock.example.com/",
    "slock.example.com/agents/abc",
  ]) {
    const reason = describeInvalidAgentIdShape(input);
    assert.ok(
      reason && (reason.includes("URL") || reason.includes("path")),
      `expected URL/path hint for ${input}, got: ${reason}`,
    );
  }
});

test("describeInvalidAgentIdShape: rejects empty / whitespace-only", () => {
  for (const input of ["", "   "]) {
    const reason = describeInvalidAgentIdShape(input);
    assert.ok(reason && reason.includes("not be empty"), `expected empty hint, got: ${reason}`);
  }
});

test("describeInvalidAgentIdShape: accepts plausible agent ids", () => {
  for (const input of [
    "agent_abc",
    "11111111-2222-3333-4444-555555555555",
    "huai-test",
    "abc123",
  ]) {
    assert.equal(describeInvalidAgentIdShape(input), null, `expected ${input} to be accepted`);
  }
});

test("credential-mint denial names the action capability and human-creator recovery path", () => {
  const detail = describeMintError("insufficient_role", "https://raft.example");
  assert.ok(detail);
  const copy = `${detail.message}\n${detail.suggestedNextAction ?? ""}`;
  assert.match(copy, /issueAgentCredentials/);
  assert.match(copy, /human user who created this agent|human-creator authority/);
  assert.doesNotMatch(copy, /manageAgents/);
  assert.doesNotMatch(
    detail.message,
    /isn't a server owner or admin/,
    "creator-member authority must not be described as owner/admin-only",
  );
});

// --- Parser contract regression: --profile-slug must not collide with root
// `raft --profile` (Hao #wg-self-hosted-agent:4707250a msg=319e1c26,
// Jianwei msg=f206a886). The Computer `--version` root-shadow PR-E pattern
// applies here too: any subcommand option that duplicates a root flag name
// is silently shadowed by Commander, so the action runs with the wrong
// option value (or none at all). The login `--profile <slug>` regression
// caused Jianwei's fresh-home smoke to write `agent-id` instead of the
// operator-requested slug. ---
import { Command } from "commander";
import { registerAgentLoginCommand } from "./login.js";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const inputMode of ["pipe", "tty"] as const) {
test(`ordinary login consumes an existing token from ${inputMode} without device authorization or minting`, async (t) => {
  const http = await import("node:http");
  const token = "sk_agent_login-test-secret";
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url !== "/internal/agent-api/" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agentId: "agent-1", agentName: "bot", serverId: "server-1", credentialId: "credential-1", scopes: ["send"] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const profileDir = await mkdtemp(path.join(tmpdir(), "raft-direct-login-"));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  const { io, stdout, stderr } = loginMemoryIo();
  io.stdin = Readable.from([token + "\n"]);
  const rawModes: boolean[] = [];
  if (inputMode === "tty") {
    Object.assign(io.stdin, { isTTY: true, setRawMode: (enabled: boolean) => { rawModes.push(enabled); } });
  }
  const program = new Command();
  program.exitOverride();
  registerAgentLoginCommand(program.command("agent"), { io });
  await program.parseAsync(["agent", "login", "--server", `http://127.0.0.1:${address.port}`, "--agent", "agent-1", "--profile-dir", profileDir], { from: "user" });
  assert.deepEqual(requests, ["GET /internal/agent-api/"]);
  const file = path.join(profileDir, "credential.json");
  assert.equal(JSON.parse(await readFile(file, "utf8")).apiKey, token);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(stdout.join("").includes("bot"));
  assert.ok(![...stdout, ...stderr].join("").includes(token), "token must not be printed");
  if (inputMode === "tty") assert.deepEqual(rawModes, [true, false], "restore terminal mode after hidden input");
  if (inputMode === "pipe") {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../index.ts", import.meta.url)),
      "agent", "login", "--server", `http://127.0.0.1:${address.port}`, "--agent", "agent-1", "--profile-dir", path.join(profileDir, "process")],
    { env: { PATH: process.env.PATH }, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdin.end(token + "\n");
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    assert.equal(exitCode, 0, "the real CLI process must exit successfully");
    assert.ok(!output.includes(token));
    assert.equal(JSON.parse(await readFile(path.join(profileDir, "process", "credential.json"), "utf8")).apiKey, token);
    assert.deepEqual(requests, ["GET /internal/agent-api/", "GET /internal/agent-api/"]);
  }
});
}

for (const scenario of ["revoked", "wrong-agent", "malformed", "server-error", "redirect", "existing-mismatch", "existing-unreachable"] as const) {
  test(`direct login preserves the profile on ${scenario}`, async (t) => {
    const http = await import("node:http");
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (scenario === "revoked") { res.writeHead(401).end(); return; }
      if (scenario === "server-error" || scenario === "existing-unreachable") { res.writeHead(503).end(); return; }
      if (scenario === "redirect") { res.writeHead(307, { location: "/unexpected" }).end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(scenario === "malformed" ? {} : {
        agentId: "another-agent", agentName: "bot", serverId: "server-1", credentialId: "credential-1", scopes: ["send"],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const profileDir = await mkdtemp(path.join(tmpdir(), "raft-login-reject-"));
    t.after(() => rm(profileDir, { recursive: true, force: true }));
    const file = path.join(profileDir, "credential.json");
    const existing = scenario.startsWith("existing-");
    const original = JSON.stringify({ apiKey: "sk_agent_prior", agentId: scenario === "existing-mismatch" ? "another-agent" : "agent-1", serverId: "server-1", serverUrl });
    if (existing) await writeFile(file, original, { mode: 0o600 });
    const { io, stdout, stderr } = loginMemoryIo();
    io.stdin = Readable.from(["sk_agent_rejected-fixture\n"]);
    const program = new Command();
    program.exitOverride();
    registerAgentLoginCommand(program.command("agent"), { io });
    await assert.rejects(program.parseAsync(["agent", "login", "--server", serverUrl, "--agent", "agent-1", "--profile-dir", profileDir], { from: "user" }));
    if (existing) assert.equal(await readFile(file, "utf8"), original);
    else await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.deepEqual(requests, scenario === "existing-mismatch" ? [] : ["GET /internal/agent-api/"]);
    assert.doesNotMatch([...stdout, ...stderr].join(""), /sk_agent_|device\/authorize/);
    assert.match(stderr.join(""), /INVALID_AGENT_TOKEN|AGENT_IDENTITY_MISMATCH|CREDENTIAL_CHECK_FAILED|PROFILE_ALREADY_EXISTS/);
  });
}

test("login subcommand uses --profile-slug, never --profile (root-shadow contract)", () => {
  const program = new Command();
  // Mirror the real root: `-p, --profile <slug>` is the "use a profile"
  // selector. Subcommands MUST NOT declare a colliding `--profile`.
  program.option("-p, --profile <slug>", "Use existing profile");
  const agentCmd = program.command("agent");
  registerAgentLoginCommand(agentCmd);

  const loginCmd = agentCmd.commands.find((c) => c.name() === "login");
  assert.ok(loginCmd, "login subcommand should be registered");

  const profileSlugOption = loginCmd!.options.find((o) => o.long === "--profile-slug");
  const profileOption = loginCmd!.options.find((o) => o.long === "--profile");

  assert.ok(
    profileSlugOption,
    "login subcommand must declare --profile-slug (the create-side flag).",
  );
  assert.equal(
    profileOption,
    undefined,
    "login subcommand MUST NOT declare --profile — Commander silently shadows it with root --profile, so the action's options.profile would be undefined. Use --profile-slug instead. See #wg-self-hosted-agent:4707250a msg=f206a886 for the field repro.",
  );
});

test("login subcommand --profile-dir option preserved (separate semantics from --profile-slug)", () => {
  // `--profile-dir` overrides the per-profile directory path (test/operator
  // escape hatch); `--profile-slug` names the new profile. Both must coexist.
  const program = new Command();
  program.option("-p, --profile <slug>", "Use existing profile");
  const agentCmd = program.command("agent");
  registerAgentLoginCommand(agentCmd);

  const loginCmd = agentCmd.commands.find((c) => c.name() === "login");
  const profileDirOption = loginCmd!.options.find((o) => o.long === "--profile-dir");
  assert.ok(profileDirOption, "login subcommand must keep --profile-dir override.");
});

test("login exposes the agent-safe start / wait / status subcommands", () => {
  const program = new Command();
  program.option("-p, --profile <slug>", "Use existing profile");
  const agentCmd = program.command("agent");
  registerAgentLoginCommand(agentCmd);

  const loginCmd: Command | undefined = agentCmd.commands.find((c: Command) => c.name() === "login");
  assert.ok(loginCmd, "login should be registered");

  for (const name of ["start", "wait", "status"]) {
    const sub: Command | undefined = loginCmd!.commands.find((c: Command) => c.name() === name);
    assert.ok(sub, `login should expose the \`${name}\` subcommand`);
    // Same root-shadow contract as the parent: no subcommand may declare
    // --profile (Commander would shadow it with the root selector).
    assert.equal(
      sub!.options.find((o) => o.long === "--profile"),
      undefined,
      `login ${name} MUST NOT declare --profile (root-shadow); use --profile-slug.`,
    );
  }

  // `wait` carries the device_code handle issued by `start`.
  const waitCmd: Command | undefined = loginCmd!.commands.find((c: Command) => c.name() === "wait");
  assert.ok(
    waitCmd!.options.find((o) => o.long === "--device-code"),
    "login wait must accept --device-code (the handle from `login start`).",
  );
});

// --- Parse-level regression (task #61, xxchan field repro on 0.0.4): the
// parent `login` command declares the same --server/--agent/--profile-slug
// flags as its start/wait/status subcommands, and Commander (without
// positional-options mode) binds a flag written AFTER the subcommand to the
// PARENT — so `login start --server x` used to fail "--server is required"
// even though --server was right there. Handler-direct tests can never catch
// this class: the bug lives in argv parsing, so this test goes through a
// real program.parseAsync. ---
import type { CliIo } from "../../core/io.js";

function loginMemoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

test("login start parses --server/--agent written after the subcommand (parent-shadow regression)", async (t) => {
  const { io, stdout, stderr } = loginMemoryIo();
  // deviceAuthClient uses undici fetch directly, so stub at the HTTP layer
  // with a real loopback server rather than monkey-patching globals.
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/auth/device/authorize") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        deviceCode: "dev-code-1",
        userCode: "USER-CODE",
        verificationUri: "/approve",
        verificationUriComplete: "/approve?code=USER-CODE",
        expiresIn: 600,
        interval: 5,
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "unexpected_route" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serverUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));

  const program = new Command();
  program.option("-p, --profile <slug>", "Use existing profile");
  program.exitOverride();
  const agentCmd = program.command("agent");
  registerAgentLoginCommand(agentCmd, { io });

  await program.parseAsync(
    [
      "agent", "login", "start",
      "--server", serverUrl,
      "--agent", "11111111-2222-3333-4444-555555555555",
      "--profile-slug", "regress-61",
      "--profile-dir", "/tmp/slock-login-test-61",
    ],
    { from: "user" },
  );

  const out = stdout.join("");
  const err = stderr.join("");
  assert.doesNotMatch(err, /--server is required/, `start must see --server written after the subcommand; stderr: ${err}`);
  assert.match(out, /dev-code-1|USER-CODE|approve/, `start should print the device-code handoff; stdout: ${out}`);
  assert.match(out, /Browser authorization URL \(code pre-filled\)/, `start should print a browser authorization URL; stdout: ${out}`);
});
