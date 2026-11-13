/**
 * `raft agent logout` (#wg-device-auth:#1): the profile's key revokes itself
 * through POST /internal/agent-api/credentials/self/revoke, and only a 200 or
 * a 401 (the key is already gone) removes credential.json. Driven through the
 * real program (root `--profile`), the shared ApiClient and a loopback server.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRaftProgram, runRaftArgv } from "../../program";

const AGENT_ID = "11111111-2222-3333-4444-555555555555";
const API_KEY = "sk_agent_logout-secret";
const SELF_REVOKE = "/internal/agent-api/credentials/self/revoke";

type Answer = { status: number; body: unknown } | "drop";

async function startServer(answer: () => Answer, onRevoke: (authorization: string | undefined) => Promise<void> | void = () => {}) {
  const requests: Array<{ method?: string; url?: string; authorization?: string }> = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.method !== "POST" || req.url !== SELF_REVOKE) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    await onRevoke(req.headers.authorization);
    const result = answer();
    if (result === "drop") { req.socket.destroy(); return; }
    res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return { serverUrl: `http://127.0.0.1:${port}`, requests };
}

async function writeProfile(serverUrl: string): Promise<{ profileDir: string; file: string }> {
  const profileDir = await mkdtemp(path.join(tmpdir(), "raft-logout-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  const file = path.join(profileDir, "credential.json");
  await writeFile(file, JSON.stringify({
    schemaVersion: 1, serverUrl, agentId: AGENT_ID, agentName: "Keyed", serverId: "server-1",
    credentialId: "cred-1", scopes: ["read"], apiKey: API_KEY, createdAt: "2026-11-05T00:00:00.000Z",
  }), { mode: 0o600 });
  return { profileDir, file };
}

async function runLogout(profileDir: string, argv = ["--profile", "keyed", "agent", "logout"]) {
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk); return true; } },
  };
  const program = buildRaftProgram({ io, env: { RAFT_PROFILE_DIR: profileDir } });
  const exitCode = await runRaftArgv(program, ["node", "raft", ...argv], io);
  return { stdout, stderr, exitCode };
}

const exists = (file: string) => stat(file).then(() => true, () => false);

for (const scenario of [
  { name: "revoked (200)", answer: { status: 200, body: { revoked: true, credentialId: "cred-1" } }, copy: /This profile's key \(credential cred-1\) was revoked\. Removed / },
  { name: "already not active (401)", answer: { status: 401, body: { error: "Invalid agent credential" } }, copy: /This profile's key \(credential cred-1\) was already not active on the server\. Removed / },
] as const) {
  test(`logout removes the credential file once the key is ${scenario.name}`, async () => {
    let fileAtRevoke: boolean | null = null;
    let file = "";
    const { serverUrl, requests } = await startServer(() => scenario.answer, async () => { fileAtRevoke = await exists(file); });
    const profile = await writeProfile(serverUrl);
    file = profile.file;
    const result = await runLogout(profile.profileDir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [`POST ${SELF_REVOKE}`]);
    assert.equal(requests[0]!.authorization, `Bearer ${API_KEY}`, "the profile's own key authenticates the revoke");
    assert.equal(fileAtRevoke, true, "the file is still there while the key is being revoked");
    assert.equal(await exists(file), false, "the credential file is removed");
    assert.match(result.stdout, /^state: logged_out\n/);
    assert.match(result.stdout, scenario.copy);
    assert.match(result.stdout, /\nNext: to use this agent from this machine again, run `raft agent login start --server \S+ --agent 11111111-2222-3333-4444-555555555555 --profile-slug keyed`\.\n$/);
    assert.ok(!(result.stdout + result.stderr).includes(API_KEY), "the key is never printed");
  });
}

for (const scenario of [
  { name: "a server error (500)", answer: { status: 500, body: { error: "boom" } }, code: "CREDENTIAL_REVOKE_FAILED", next: /Retry `raft --profile keyed agent logout` when the server is reachable/ },
  { name: "a dropped connection", answer: "drop", code: "CREDENTIAL_REVOKE_FAILED", next: /Retry `raft --profile keyed agent logout`/ },
  { name: "an older server without the route (404)", answer: { status: 404, body: { error: "Not found" } }, code: "UNSUPPORTED_BY_SERVER", next: /ask the user to revoke credential cred-1 .* then run `raft --profile keyed agent logout` again/ },
  { name: "a key that cannot revoke itself (403)", answer: { status: 403, body: { code: "credential_not_self_revocable", error: "managed" } }, code: "credential_not_self_revocable", next: /ask the user to revoke credential cred-1/ },
] as const) {
  test(`logout keeps the credential file and names the next step on ${scenario.name}`, async () => {
    const { serverUrl } = await startServer(() => scenario.answer);
    const { profileDir, file } = await writeProfile(serverUrl);
    const before = await readFile(file, "utf8");
    const result = await runLogout(profileDir);
    assert.notEqual(result.exitCode, 0);
    assert.equal(await readFile(file, "utf8"), before, "the credential file is kept unchanged");
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`Code: ${scenario.code}\\n`));
    assert.match(result.stderr, new RegExp(`was kept`));
    assert.match(result.stderr, /Next action: [^\n]*/);
    assert.match(result.stderr, scenario.next);
    assert.ok(!(result.stdout + result.stderr).includes(API_KEY), "the key is never printed");
  });
}

test("logout with no credential file says there is nothing to log out and calls nothing", async () => {
  const { requests } = await startServer(() => ({ status: 200, body: { revoked: true } }));
  const profileDir = await mkdtemp(path.join(tmpdir(), "raft-logout-empty-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  const result = await runLogout(profileDir);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /^state: not_logged_in\nNo credential for profile 'keyed' at .*credential\.json\. Nothing to log out; no action needed\.\n$/);
  assert.deepEqual(requests, []);
});

test("logout without a selected profile refuses and names the profile flag", async () => {
  const { requests } = await startServer(() => ({ status: 200, body: { revoked: true } }));
  const result = await runLogout("/nonexistent", ["agent", "logout"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Code: LOGOUT_REQUIRES_PROFILE\n/);
  assert.match(result.stderr, /raft --profile <slug> agent logout/);
  assert.deepEqual(requests, []);
});
