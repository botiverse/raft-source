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

import {
  describeInvalidAgentIdShape,
  describeMintError,
  formatAuthorizedLoginReport,
} from "./login";

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
import { registerAgentLoginCommand } from "./login";
import { PassThrough, Readable } from "node:stream";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const profileDir = await mkdtemp(path.join(tmpdir(), "raft-direct-login-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
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
  if (inputMode === "tty") assert.doesNotMatch(stderr.join(""), /No interactive terminal/);
  if (inputMode === "pipe") {
    assert.match(stderr.join(""), /stdin/);
    assert.match(stderr.join(""), /secret manager/);
    assert.match(stderr.join(""), /< \/path\/to\/agent-token/);
    const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", fileURLToPath(new URL("../../index.ts", import.meta.url)),
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

test("non-TTY login explains input before waiting and rejects empty input without creating a profile", { timeout: 5000 }, async (t) => {
  const profileDir = await mkdtemp(path.join(tmpdir(), "raft-login-empty-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  for (const ending of ["", "   \n"]) {
    const { io, stdout, stderr } = loginMemoryIo();
    const input = new PassThrough();
    io.stdin = input;
    let sawGuidance!: () => void;
    const guidance = new Promise<void>((resolve) => { sawGuidance = resolve; });
    io.stderr = { write(chunk: string | Uint8Array) { stderr.push(String(chunk)); sawGuidance(); return true; } };
    const program = new Command();
    program.exitOverride();
    registerAgentLoginCommand(program.command("agent"), { io });
    const pending = program.parseAsync(["agent", "login", "--server", "http://127.0.0.1:1", "--agent", "agent-1", "--profile-dir", profileDir], { from: "user" });
    const rejected = assert.rejects(pending);
    await guidance;
    // No bytes or EOF yet: the caller must already know how to provide stdin.
    assert.match(stderr.join(""), /No interactive terminal/);
    assert.match(stderr.join(""), /secret manager/);
    assert.match(stderr.join(""), /< \/path\/to\/agent-token/);
    assert.equal(stdout.join(""), "");
    input.end(ending);
    await rejected;
    assert.match(stderr.join(""), /AGENT_TOKEN_REQUIRED/);
    assert.match(stderr.join(""), /No agent token was received on stdin/);
    assert.doesNotMatch(stderr.join(""), /CREDENTIAL_CHECK_FAILED|INVALID_AGENT_TOKEN/);
    await assert.rejects(readFile(path.join(profileDir, "credential.json")), { code: "ENOENT" });
  }
});

test("login help explains non-TTY token input without a token argument", () => {
  let help = "";
  const program = new Command();
  program.configureOutput({ writeOut: (text) => { help += text; } });
  const agent = program.command("agent");
  registerAgentLoginCommand(agent);
  agent.commands.find((command) => command.name() === "login")!.outputHelp();
  assert.match(help, /Without a TTY/);
  assert.match(help, /secret manager/);
  assert.match(help, /raft agent login .*< \/path\/to\/agent-token/);
  assert.match(help, /first line/);
  assert.doesNotMatch(help, /--token/);
});

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
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const profileDir = await mkdtemp(path.join(tmpdir(), "raft-login-reject-"));
    onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
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
import type { CliIo } from "../../core/io";

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
  onTestFinished(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));

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
  // Never the pre-filled link an older server still sends: the page and the code to type.
  assert.match(out, /Browser authorization URL: http:\/\/127\.0\.0\.1:\d+\/approve\n/, `start should print a browser authorization URL; stdout: ${out}`);
  assert.match(out, /Enter code USER-CODE, choose this agent as the one the key is for, and approve\./, `start should print the code to type; stdout: ${out}`);
  assert.doesNotMatch(out, /code=USER-CODE|pre-filled/, `start must not hand out a link with the code in it; stdout: ${out}`);
});

// A server older than one-time grants ignores the agent_key grant and answers
// the poll with a device session: `login wait` then mints with it as before.
// That re-login rotates: the mint names the credential this profile held
// (same agent + server), so the server revokes it in the same transaction.
// A fresh profile, or one bound to another agent, names nothing.
test("login wait sends the profile's previous credential as replacesCredentialId (rotation)", async (t) => {
  const { io } = loginMemoryIo();
  const agentId = "11111111-2222-3333-4444-555555555555";
  const mintBodies: unknown[] = [];
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/auth/device/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accessToken: "session-access", refreshToken: "session-refresh", userId: "user-1" }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/agents/${agentId}/credentials`) {
        mintBodies.push(JSON.parse(raw || "{}"));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          credentialId: `cred-${mintBodies.length}`,
          apiKey: `sk_agent_test${mintBodies.length}`,
          scopes: ["read", "send"],
          agentId,
          agentName: "Rotator",
          serverId: "server-1",
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "unexpected_route" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const profileDir = await mkdtemp(path.join(tmpdir(), "raft-login-rotate-"));
  onTestFinished(async () => {
    await rm(profileDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  const runWait = async () => {
    const program = new Command();
    program.exitOverride();
    registerAgentLoginCommand(program.command("agent"), { io });
    await program.parseAsync(
      ["agent", "login", "wait", "--server", serverUrl, "--agent", agentId, "--device-code", "dev-1", "--profile-dir", profileDir],
      { from: "user" },
    );
  };

  await runWait();
  assert.deepEqual(mintBodies[0], {}, "first login has nothing to rotate");
  await runWait();
  assert.deepEqual(mintBodies[1], { replacesCredentialId: "cred-1" }, "re-login rotates the profile's credential");
  assert.equal(JSON.parse(await readFile(path.join(profileDir, "credential.json"), "utf8")).credentialId, "cred-2");

  // A profile bound to another agent never names its credential.
  const { readReplaceableCredentialId } = await import("./login");
  assert.equal(await readReplaceableCredentialId(path.join(profileDir, "credential.json"), { server: serverUrl, agent: "other-agent" }), null);
  assert.equal(await readReplaceableCredentialId(path.join(profileDir, "credential.json"), { server: "https://elsewhere.example", agent: agentId }), null);
  assert.equal(await readReplaceableCredentialId(path.join(profileDir, "missing.json"), { server: serverUrl, agent: agentId }), null);
});

// --- agent_key grant (device-auth PR 1 #12116): `login start` asks for the
// agent's own key and `login wait` saves the sk_agent_* the token poll
// returns. No user session is requested, used or written. ---

const GRANT_AGENT_ID = "11111111-2222-3333-4444-555555555555";

type SelfRevokeAnswer = { status: number; body: unknown } | "drop";

async function startGrantServer(
  token: (call: number) => { status: number; body: unknown },
  options: { selfRevoke?: (authorization: string | undefined) => SelfRevokeAnswer | Promise<SelfRevokeAnswer> } = {},
) {
  const http = await import("node:http");
  const requests: Array<{ method?: string; url?: string; body: unknown; authorization?: string }> = [];
  let tokenCalls = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null, authorization: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      if (options.selfRevoke && req.method === "POST" && req.url === "/internal/agent-api/credentials/self/revoke") {
        const answer = await options.selfRevoke(req.headers.authorization);
        if (answer === "drop") { req.socket.destroy(); return; }
        res.writeHead(answer.status).end(JSON.stringify(answer.body));
        return;
      }
      if (req.method === "POST" && req.url === "/api/auth/device/authorize") {
        res.writeHead(201).end(JSON.stringify({ deviceCode: "dev-grant", userCode: "GRNT-CODE", verificationUri: "/login/device", expiresIn: 600, interval: 5 }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/auth/device/token") {
        tokenCalls += 1;
        const answer = token(tokenCalls);
        res.writeHead(answer.status).end(JSON.stringify(answer.body));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ code: "unexpected_route" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const profileDir = await mkdtemp(path.join(tmpdir(), "raft-login-grant-"));
  onTestFinished(async () => {
    await rm(profileDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  return { serverUrl: `http://127.0.0.1:${port}`, requests, profileDir };
}

async function runLogin(args: string[]) {
  const { io, stdout, stderr } = loginMemoryIo();
  const program = new Command();
  program.exitOverride();
  registerAgentLoginCommand(program.command("agent"), { io });
  let error: unknown = null;
  try {
    await program.parseAsync(["agent", "login", ...args], { from: "user" });
  } catch (err) {
    error = err;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), error };
}

function agentKeyAnswer(n: number, agentId = GRANT_AGENT_ID) {
  return {
    status: 200,
    body: { kind: "agent_key", credentialId: `cred-${n}`, apiKey: `sk_agent_granted${n}`, scopes: ["read", "send"], agentId, agentName: "Keyed", serverId: "server-1" },
  };
}

test("login start asks the server for an agent_key grant for the requested agent", async () => {
  const { serverUrl, requests, profileDir } = await startGrantServer(() => ({ status: 500, body: {} }));
  const result = await runLogin(["start", "--server", serverUrl, "--agent", GRANT_AGENT_ID, "--client-name", "ci-runner", "--profile-dir", profileDir]);
  assert.equal(result.error, null, result.stderr);
  assert.equal(requests.length, 1);
  const body = requests[0]!.body as { clientName: string; grant: Record<string, unknown> };
  assert.equal(body.clientName, "ci-runner");
  assert.equal(body.grant.kind, "agent_key");
  assert.equal(body.grant.agentId, GRANT_AGENT_ID);
  assert.equal(body.grant.machineName, "ci-runner");
  assert.equal(typeof body.grant.hostname, "string");
  assert.equal(typeof body.grant.os, "string");
  assert.match(result.stdout, /^state: pending_human_action\n/);
  assert.match(result.stdout, /Next: after the user approves, run `raft agent login wait --server \S+ --agent \S+ --device-code dev-grant`/);
  // A non-UUID --agent is not sent as the grant's agentId (the server refuses one).
  const other = await runLogin(["start", "--server", serverUrl, "--agent", "agent_abc", "--profile-dir", profileDir]);
  assert.equal(other.error, null, other.stderr);
  const otherGrant = (requests[1]!.body as { grant: Record<string, unknown> }).grant;
  assert.equal(otherGrant.kind, "agent_key");
  assert.equal("agentId" in otherGrant, false);
  assert.equal(otherGrant.machineName, "raft-cli");
});

test("login wait saves the key an agent_key grant returns, with no session and no mint", async () => {
  const { serverUrl, requests, profileDir } = await startGrantServer((n) => agentKeyAnswer(n));
  const wait = ["wait", "--server", serverUrl, "--agent", GRANT_AGENT_ID, "--device-code", "dev-grant", "--profile-dir", profileDir];

  const first = await runLogin(wait);
  assert.equal(first.error, null, first.stderr);
  const file = path.join(profileDir, "credential.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.apiKey, "sk_agent_granted1");
  assert.equal(saved.credentialId, "cred-1");
  assert.equal(saved.agentId, GRANT_AGENT_ID);
  assert.equal(saved.serverUrl, serverUrl);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(profileDir), ["credential.json"], "only the key is written: no session file");
  assert.doesNotMatch(JSON.stringify(saved), /accessToken|refreshToken/);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ["POST /api/auth/device/token"], "no mint, no session-authenticated call");
  assert.match(first.stdout, /^state: authorized\nLogged in as 'Keyed'/);
  assert.doesNotMatch(first.stdout, /still active/);
  assert.ok(!(first.stdout + first.stderr).includes("sk_agent_granted1"), "the key is never printed");

  // A re-login cannot rotate through the grant: the report names the key this
  // profile held, once, and the profile now holds the new one.
  const second = await runLogin(wait);
  assert.equal(second.error, null, second.stderr);
  assert.equal(JSON.parse(await readFile(file, "utf8")).apiKey, "sk_agent_granted2");
  assert.match(second.stdout, /The key this profile held before \(credential cred-1\) is still active/);
  assert.equal(second.stdout.match(/still active/g)?.length, 1);
  assert.match(second.stdout, /\nNext \(if you are the agent\): [^\n]+\n$/, "Next lines stay last");
  assert.deepEqual(await readdir(profileDir), ["credential.json"]);
});

test("login wait refuses a key for a different agent and leaves the profile unchanged", async () => {
  const { serverUrl, profileDir } = await startGrantServer((n) => agentKeyAnswer(n, "99999999-2222-3333-4444-555555555555"));
  const file = path.join(profileDir, "credential.json");
  const original = JSON.stringify({ apiKey: "sk_agent_prior", agentId: GRANT_AGENT_ID, serverUrl, credentialId: "cred-prior" });
  await writeFile(file, original, { mode: 0o600 });
  const result = await runLogin(["wait", "--server", serverUrl, "--agent", GRANT_AGENT_ID, "--device-code", "dev-grant", "--profile-dir", profileDir]);
  assert.ok(result.error);
  assert.match(result.stderr, /AGENT_IDENTITY_MISMATCH/);
  assert.match(result.stderr, /The profile was not changed/);
  assert.equal(await readFile(file, "utf8"), original);
  assert.ok(!(result.stdout + result.stderr).includes("sk_agent_granted"), "the refused key is never printed");
});

for (const scenario of [
  { name: "denied", status: 403, code: "access_denied", copy: /denied the login request/ },
  { name: "expired", status: 410, code: "expired_token", copy: /login code expired/ },
  { name: "malformed key answer", status: 200, code: "token_response_invalid", copy: /not a usable agent key/ },
] as const) {
  test(`login wait on ${scenario.name} saves nothing`, async () => {
    const { serverUrl, profileDir } = await startGrantServer(() => scenario.status === 200
      ? { status: 200, body: { kind: "agent_key", apiKey: "not-an-agent-key", agentId: GRANT_AGENT_ID } }
      : { status: scenario.status, body: { code: scenario.code } });
    const result = await runLogin(["wait", "--server", serverUrl, "--agent", GRANT_AGENT_ID, "--device-code", "dev-grant", "--profile-dir", profileDir]);
    assert.ok(result.error);
    assert.match(result.stderr, new RegExp(scenario.code));
    assert.match(result.stderr, scenario.copy);
    assert.deepEqual(await readdir(profileDir), []);
  });
}

// --- Re-login revokes the key it replaced (#wg-device-auth:#1): once the new
// key is saved, `wait` calls self-revoke with the PREVIOUS key as the bearer
// (a key can only revoke itself). Any failure keeps the login and asks the
// user to revoke; 401 means the old key is already gone. ---

const SELF_REVOKE = "POST /internal/agent-api/credentials/self/revoke";

async function reloginWithSelfRevoke(selfRevoke: (authorization: string | undefined, savedApiKey: string) => SelfRevokeAnswer) {
  let profileFile = "";
  const grant = await startGrantServer((n) => agentKeyAnswer(n), {
    selfRevoke: async (authorization) => selfRevoke(authorization, JSON.parse(await readFile(profileFile, "utf8")).apiKey),
  });
  profileFile = path.join(grant.profileDir, "credential.json");
  const wait = ["wait", "--server", grant.serverUrl, "--agent", GRANT_AGENT_ID, "--device-code", "dev-grant", "--profile-dir", grant.profileDir];
  const first = await runLogin(wait);
  assert.equal(first.error, null, first.stderr);
  assert.ok(!grant.requests.some((r) => `${r.method} ${r.url}` === SELF_REVOKE), "a first login has no previous key to revoke");
  const second = await runLogin(wait);
  return { ...grant, profileFile, second };
}

test("login wait revokes the previous key with that key, after the new key is saved", async () => {
  const seen: Array<{ authorization: string | undefined; savedApiKey: string }> = [];
  const { requests, profileFile, second } = await reloginWithSelfRevoke((authorization, savedApiKey) => {
    seen.push({ authorization, savedApiKey });
    return authorization === "Bearer sk_agent_granted1"
      ? { status: 200, body: { revoked: true, credentialId: "cred-1" } }
      : { status: 401, body: { error: "Invalid agent credential" } };
  });
  assert.equal(second.error, null, second.stderr);
  assert.deepEqual(seen, [{ authorization: "Bearer sk_agent_granted1", savedApiKey: "sk_agent_granted2" }],
    "one self-revoke, authenticated by the previous key, sent after the new key was saved");
  assert.deepEqual(requests.slice(-2).map((r) => `${r.method} ${r.url}`), ["POST /api/auth/device/token", SELF_REVOKE]);
  assert.equal(JSON.parse(await readFile(profileFile, "utf8")).apiKey, "sk_agent_granted2");
  assert.match(second.stdout, /^state: authorized\nLogged in as 'Keyed'/);
  assert.match(second.stdout, /\nThe key this profile held before \(credential cred-1\) was revoked\.\n/);
  assert.equal(second.stdout.match(/credential cred-1/g)?.length, 1);
  assert.doesNotMatch(second.stdout, /still active|ask the user to revoke/);
  assert.match(second.stdout, /\nNext \(if you are the agent\): [^\n]+\n$/, "Next lines stay last");
  assert.ok(!/sk_agent_/.test(second.stdout + second.stderr), "no key material is printed");
});

for (const scenario of [
  { name: "an older server without the route (404)", answer: { status: 404, body: { error: "Not found" } } },
  { name: "a server error (500)", answer: { status: 500, body: { error: "boom" } } },
  { name: "a key that cannot revoke itself (403)", answer: { status: 403, body: { code: "credential_not_self_revocable", error: "managed" } } },
  { name: "a dropped connection", answer: "drop" },
] as const) {
  test(`login wait keeps the new key and asks the user to revoke the previous one on ${scenario.name}`, async () => {
    const { requests, profileFile, second } = await reloginWithSelfRevoke(() => scenario.answer);
    assert.equal(second.error, null, second.stderr);
    assert.equal(requests.filter((r) => `${r.method} ${r.url}` === SELF_REVOKE).length, 1);
    assert.equal(JSON.parse(await readFile(profileFile, "utf8")).apiKey, "sk_agent_granted2");
    assert.match(second.stdout, /^state: authorized\n/);
    assert.match(second.stdout, /The key this profile held before \(credential cred-1\) is still active; if nothing else uses it, ask the user to revoke it/);
    assert.doesNotMatch(second.stdout, /was revoked|already not active/);
    assert.match(second.stdout, /\nNext \(if you are the agent\): [^\n]+\n$/);
    assert.ok(!/sk_agent_/.test(second.stdout + second.stderr), "no key material is printed");
  });
}

test("login wait says the previous key was already not active when self-revoke answers 401", async () => {
  const { profileFile, second } = await reloginWithSelfRevoke(() => ({ status: 401, body: { error: "Invalid agent credential" } }));
  assert.equal(second.error, null, second.stderr);
  assert.equal(JSON.parse(await readFile(profileFile, "utf8")).apiKey, "sk_agent_granted2");
  assert.match(second.stdout, /The key this profile held before \(credential cred-1\) was already not active on the server; nothing to revoke\.\n/);
  assert.doesNotMatch(second.stdout, /still active|ask the user to revoke|was revoked/);
});
