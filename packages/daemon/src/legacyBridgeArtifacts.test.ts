// Tests for the legacy chat-bridge artifact migration (task #261, audit #259).
// Every fixture uses a fake bearer; nothing here touches a real credential.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LEGACY_BRIDGE_ARTIFACT_FILES,
  isLegacyBridgeEntry,
  migrateAllLegacyBridgeArtifacts,
  migrateLegacyBridgeArtifacts,
} from "./legacyBridgeArtifacts";

const AGENT = "agent-aaaa-1111";
const OTHER_AGENT = "agent-bbbb-2222";
const FAKE_TOKEN = "sk_machine_TESTFIXTURE_not_a_real_token";
const F1 = ".slock-claude-mcp.json";
const F2 = path.join(".slock", "claude-mcp-config.json");
const F3 = path.join(".gemini", "settings.json");

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "legacy-bridge-"));
  tmpRoots.push(dir);
  return dir;
}

function bridgeEntry(agentId = AGENT, overrides: Record<string, unknown> = {}) {
  return {
    command: "node",
    args: [
      "/opt/old-daemon/dist/chat-bridge.js",
      "--agent-id",
      agentId,
      "--server-url",
      "https://example.invalid",
      "--auth-token",
      FAKE_TOKEN,
      "--runtime",
      "claude",
      "--runtime-actions-only",
    ],
    ...overrides,
  };
}

function writeJson(root: string, rel: string, value: unknown, mode?: number): string {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  if (mode !== undefined) chmodSync(file, mode);
  return file;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function actionOf(results: ReturnType<typeof migrateLegacyBridgeArtifacts>, rel: string): string {
  const hit = results.find((r) => r.file === rel);
  assert.ok(hit, `no result for ${rel}`);
  return hit.action;
}

test("artifact list is exactly the three audited files", () => {
  assert.deepEqual([...LEGACY_BRIDGE_ARTIFACT_FILES], [F1, F2, F3]);
});

test("isLegacyBridgeEntry: accepts the three historical shapes bound to this agent only", () => {
  // F1 shape (March): no --runtime / --runtime-actions-only.
  assert.equal(
    isLegacyBridgeEntry(
      { command: "node", args: ["/x/chat-bridge.js", "--agent-id", AGENT, "--server-url", "u", "--auth-token", FAKE_TOKEN] },
      AGENT,
    ),
    true,
  );
  // TS-source variant (npx tsx).
  assert.equal(
    isLegacyBridgeEntry(
      { command: "npx", args: ["tsx", "/x/chat-bridge.ts", "--agent-id", AGENT, "--server-url", "u", "--auth-token", FAKE_TOKEN, "--runtime", "gemini", "--launch-id", "L", "--runtime-actions-only"] },
      AGENT,
    ),
    true,
  );
  assert.equal(isLegacyBridgeEntry(bridgeEntry(OTHER_AGENT), AGENT), false, "other agent's binding");
  assert.equal(isLegacyBridgeEntry(bridgeEntry(AGENT, { command: "python" }), AGENT), false, "unknown command");
  const noToken = bridgeEntry();
  noToken.args = noToken.args.filter((a) => a !== "--auth-token" && a !== FAKE_TOKEN);
  assert.equal(isLegacyBridgeEntry(noToken, AGENT), false, "no --auth-token");
  const danglingToken = bridgeEntry();
  danglingToken.args = [...danglingToken.args.slice(0, danglingToken.args.indexOf("--auth-token") + 1)];
  assert.equal(isLegacyBridgeEntry(danglingToken, AGENT), false, "--auth-token without a value");
  assert.equal(isLegacyBridgeEntry({ command: "node", args: ["a", 1] }, AGENT), false, "non-string arg");
  assert.equal(isLegacyBridgeEntry("node --auth-token x", AGENT), false, "not an object");
});

test("F1 that is entirely ours is unlinked", () => {
  const root = makeRoot();
  const file = writeJson(root, F1, { mcpServers: { chat: bridgeEntry() } });
  const results = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(results, F1), "unlinked");
  assert.equal(existsSync(file), false);
  assert.equal(actionOf(results, F2), "absent");
  assert.equal(actionOf(results, F3), "absent");
});

test("F2 mixed with user MCP servers keeps the user entries byte-for-byte and becomes 0600", () => {
  const root = makeRoot();
  const user = { command: "uvx", args: ["mcp-server-fetch"], env: { FOO: "bar" } };
  const file = writeJson(root, F2, { mcpServers: { fetch: user, chat: bridgeEntry() } }, 0o644);
  const results = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(results, F2), "removed-entry");
  assert.deepEqual(readJson(file), { mcpServers: { fetch: user } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8").includes(FAKE_TOKEN), false);
});

test("F3 keeps unrelated Gemini settings and drops an emptied mcpServers key", () => {
  const root = makeRoot();
  const file = writeJson(root, F3, { theme: "dark", mcpServers: { chat: bridgeEntry() }, telemetry: { enabled: false } });
  const results = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(results, F3), "removed-entry");
  assert.deepEqual(readJson(file), { theme: "dark", telemetry: { enabled: false } });
});

test("repeat run is a no-op and does not rewrite the file", () => {
  const root = makeRoot();
  const file = writeJson(root, F2, { mcpServers: { fetch: { command: "uvx" }, chat: bridgeEntry() } });
  migrateLegacyBridgeArtifacts(root, AGENT);
  const before = statSync(file);
  const bytes = readFileSync(file);
  const again = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(again, F2), "unchanged");
  const after = statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(readFileSync(file), bytes);
});

test("an entry bound to a different agent is left untouched", () => {
  const root = makeRoot();
  const original = { mcpServers: { chat: bridgeEntry(OTHER_AGENT) } };
  const file = writeJson(root, F1, original);
  const results = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(results, F1), "skipped:unknown-provenance");
  assert.deepEqual(readJson(file), original);
});

test("a chat entry without --auth-token or with an unknown command is left untouched", () => {
  const root = makeRoot();
  const userChat = { command: "node", args: ["/home/user/my-chat-server.js", "--agent-id", AGENT] };
  const file1 = writeJson(root, F1, { mcpServers: { chat: userChat } });
  const file3 = writeJson(root, F3, { mcpServers: { chat: bridgeEntry(AGENT, { command: "deno" }) } });
  const results = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(results, F1), "skipped:unknown-provenance");
  assert.equal(actionOf(results, F3), "skipped:unknown-provenance");
  assert.deepEqual(readJson(file1), { mcpServers: { chat: userChat } });
  assert.equal(readFileSync(file3, "utf8").includes(FAKE_TOKEN), true, "untouched file keeps its bytes");
});

test("a symlinked artifact is never followed", () => {
  const root = makeRoot();
  const outside = makeRoot();
  const target = writeJson(outside, "real.json", { mcpServers: { chat: bridgeEntry() } });
  symlinkSync(target, path.join(root, F1));
  const results = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(results, F1), "skipped:symlink");
  assert.equal(existsSync(target), true);
  assert.deepEqual(readJson(target), { mcpServers: { chat: bridgeEntry() } });
});

test("a symlinked parent directory is never followed", () => {
  const root = makeRoot();
  const outside = makeRoot();
  const realDir = path.join(outside, "gemini-elsewhere");
  mkdirSync(realDir);
  const target = path.join(realDir, "settings.json");
  writeFileSync(target, JSON.stringify({ mcpServers: { chat: bridgeEntry() } }));
  symlinkSync(realDir, path.join(root, ".gemini"));
  const results = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(results, F3), "skipped:parent-symlink");
  assert.deepEqual(readJson(target), { mcpServers: { chat: bridgeEntry() } });
});

test("invalid JSON and non-object JSON are left untouched", () => {
  const root = makeRoot();
  const f1 = path.join(root, F1);
  writeFileSync(f1, "{ not json");
  const f3 = writeJson(root, F3, ["array", "not", "object"]);
  const results = migrateLegacyBridgeArtifacts(root, AGENT);
  assert.equal(actionOf(results, F1), "skipped:invalid-json");
  assert.equal(actionOf(results, F3), "skipped:not-an-object");
  assert.equal(readFileSync(f1, "utf8"), "{ not json");
  assert.deepEqual(readJson(f3), ["array", "not", "object"]);
});

test("no plaintext copy of the removed entry is left anywhere under the workspace", () => {
  const root = makeRoot();
  writeJson(root, F2, { mcpServers: { fetch: { command: "uvx" }, chat: bridgeEntry() } });
  writeJson(root, F3, { theme: "x", mcpServers: { chat: bridgeEntry() } });
  migrateLegacyBridgeArtifacts(root, AGENT);
  const walk = (dir: string): string[] =>
    readdirRecursive(dir).filter((f) => statSync(f).isFile());
  for (const file of walk(root)) {
    assert.equal(readFileSync(file, "utf8").includes(FAKE_TOKEN), false, `token still present in ${file}`);
    assert.equal(file.endsWith(".tmp"), false, `temp file left behind: ${file}`);
  }
});

test("old-daemon coexistence: a re-created artifact is removed again on the next pass", () => {
  const root = makeRoot();
  const file = writeJson(root, F1, { mcpServers: { chat: bridgeEntry() } });
  assert.equal(actionOf(migrateLegacyBridgeArtifacts(root, AGENT), F1), "unlinked");
  writeJson(root, F1, { mcpServers: { chat: bridgeEntry() } }); // old daemon spawns again
  assert.equal(actionOf(migrateLegacyBridgeArtifacts(root, AGENT), F1), "unlinked");
  assert.equal(existsSync(file), false);
});

test("active consumer: a descriptor opened before the pass still reads the old bytes (rename, not truncate)", () => {
  const root = makeRoot();
  const file = writeJson(root, F2, { mcpServers: { fetch: { command: "uvx" }, chat: bridgeEntry() } });
  const originalBytes = readFileSync(file);
  const fd = openSync(file, "r");
  try {
    migrateLegacyBridgeArtifacts(root, AGENT);
    const buf = Buffer.alloc(originalBytes.length + 16);
    const n = readSync(fd, buf, 0, buf.length, 0);
    assert.deepEqual(buf.subarray(0, n), originalBytes);
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(readJson(file), { mcpServers: { fetch: { command: "uvx" } } });
});

test("daemon-start batch walks <agentsRoot>/<agentId> and binds each workspace to its directory name", () => {
  const agentsRoot = makeRoot();
  const a = path.join(agentsRoot, AGENT);
  const b = path.join(agentsRoot, OTHER_AGENT);
  writeJson(a, F1, { mcpServers: { chat: bridgeEntry(AGENT) } });
  writeJson(b, F2, { mcpServers: { keep: { command: "x" }, chat: bridgeEntry(AGENT) } }); // bound to A, lives in B
  writeJson(b, F3, { mcpServers: { chat: bridgeEntry(OTHER_AGENT) } });
  writeFileSync(path.join(agentsRoot, "not-a-dir"), "x");
  symlinkSync(a, path.join(agentsRoot, "linked-workspace"));
  const summary = migrateAllLegacyBridgeArtifacts(agentsRoot);
  assert.deepEqual(summary, { scanned: 2, removedEntries: 0, unlinked: 2, skipped: 1, currentKeyExposed: 0 });
  assert.equal(existsSync(path.join(a, F1)), false);
  assert.equal(existsSync(path.join(b, F3)), false);
  assert.deepEqual(readJson(path.join(b, F2)), { mcpServers: { keep: { command: "x" }, chat: bridgeEntry(AGENT) } });
});

test("daemon-start batch tolerates a missing agents root", () => {
  assert.deepEqual(migrateAllLegacyBridgeArtifacts(path.join(os.tmpdir(), "does-not-exist-" + Date.now())), {
    scanned: 0,
    removedEntries: 0,
    unlinked: 0,
    skipped: 0,
    currentKeyExposed: 0,
  });
});

function readdirRecursive(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

test("an entry carrying this daemon's own machine key is removed whichever agent it names", () => {
  const root = makeRoot();
  const file = writeJson(root, F2, { mcpServers: { fetch: { command: "uvx" }, chat: bridgeEntry(OTHER_AGENT) } });
  // Without the key, another agent's binding is left alone (provenance unknown).
  assert.equal(actionOf(migrateLegacyBridgeArtifacts(root, AGENT), F2), "skipped:unknown-provenance");
  assert.equal(actionOf(migrateLegacyBridgeArtifacts(root, AGENT, { machineKey: FAKE_TOKEN }), F2), "removed-entry");
  assert.deepEqual(readJson(file), { mcpServers: { fetch: { command: "uvx" } } });
  assert.equal(isLegacyBridgeEntry(bridgeEntry(OTHER_AGENT), AGENT, "sk_machine_other"), false, "another key is not ours");
});

test("a FIFO or an oversized artifact is skipped without blocking or reading it", () => {
  if (process.platform === "win32") return;
  const root = makeRoot();
  mkdirSync(path.join(root, ".slock"), { recursive: true });
  execFileSync("mkfifo", [path.join(root, F2)]);
  assert.equal(actionOf(migrateLegacyBridgeArtifacts(root, AGENT), F2), "skipped:not-a-file");
  writeFileSync(path.join(root, F1), JSON.stringify({ mcpServers: { chat: bridgeEntry() }, pad: "x".repeat(1024 * 1024) }));
  assert.equal(actionOf(migrateLegacyBridgeArtifacts(root, AGENT), F1), "skipped:too-large");
});

test("the daemon's own directories beside the workspaces are never scanned as workspaces", () => {
  const root = makeRoot();
  writeJson(path.join(root, ".agent-state"), F1, { mcpServers: { chat: bridgeEntry(".agent-state") } });
  writeJson(path.join(root, AGENT), F1, { mcpServers: { chat: bridgeEntry() } });
  const summary = migrateAllLegacyBridgeArtifacts(root);
  assert.equal(summary.scanned, 1);
  assert.equal(summary.unlinked, 1);
  assert.ok(existsSync(path.join(root, ".agent-state", F1)));
});

for (const pin of ["proc-fd", "child-cwd"] as const) {
  const runs = pin === "child-cwd" || process.platform === "linux";
  test(`${pin}: .gemini swapped for a link to a host directory before the edit is held: the host file is untouched`, { skip: !runs || process.platform === "win32" }, () => {
    const root = makeRoot();
    const workspace = path.join(root, "ws");
    const host = path.join(root, "host-gemini");
    writeJson(workspace, F3, { mcpServers: { chat: bridgeEntry() }, theme: "agent-chosen" });
    mkdirSync(host, { recursive: true });
    const hostFile = path.join(host, "settings.json");
    writeFileSync(hostFile, JSON.stringify({ mcpServers: { chat: bridgeEntry() }, theme: "host" }));
    const results = migrateLegacyBridgeArtifacts(workspace, AGENT, {
      pin,
      beforePin: (dir) => {
        if (!dir.endsWith(".gemini")) return;
        renameSync(dir, `${dir}.moved`);
        symlinkSync(host, dir);
      },
    });
    assert.match(actionOf(results, F3), /^skipped:/);
    assert.deepEqual(readJson(hostFile), { mcpServers: { chat: bridgeEntry() }, theme: "host" });
  });

  test(`${pin}: .gemini swapped after the directory is held: the edit stays in the held directory`, { skip: pin !== "proc-fd" || process.platform !== "linux" }, () => {
    const root = makeRoot();
    const workspace = path.join(root, "ws");
    const host = path.join(root, "host-gemini");
    writeJson(workspace, F3, { mcpServers: { chat: bridgeEntry() }, theme: "agent-chosen" });
    mkdirSync(host, { recursive: true });
    const hostFile = path.join(host, "settings.json");
    writeFileSync(hostFile, JSON.stringify({ theme: "host" }));
    const results = migrateLegacyBridgeArtifacts(workspace, AGENT, {
      pin,
      afterPin: (dir) => {
        if (!dir.endsWith(".gemini")) return;
        renameSync(dir, `${dir}.moved`);
        symlinkSync(host, dir);
      },
    });
    assert.equal(actionOf(results, F3), "removed-entry");
    assert.deepEqual(readJson(hostFile), { theme: "host" });
    assert.deepEqual(readJson(path.join(workspace, ".gemini.moved", "settings.json")), { theme: "agent-chosen" });
    assert.deepEqual(readdirSync(host), ["settings.json"]);
  });

  test(`${pin}: a normal edit removes the entry, keeps the rest, and reports a current key`, { skip: !runs || process.platform === "win32" }, () => {
    const root = makeRoot();
    const file = writeJson(root, F2, { mcpServers: { fetch: { command: "uvx" }, chat: bridgeEntry(OTHER_AGENT) } });
    const results = migrateLegacyBridgeArtifacts(root, AGENT, { pin, machineKey: FAKE_TOKEN });
    assert.equal(actionOf(results, F2), "removed-entry");
    assert.equal(results.find((r) => r.file === F2)?.currentKey, true);
    assert.deepEqual(readJson(file), { mcpServers: { fetch: { command: "uvx" } } });
    assert.equal(readFileSync(file, "utf8").includes(FAKE_TOKEN), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
}

test("the machine key reaches the child on stdin, never in its arguments", () => {
  const source = readFileSync(path.join(__dirname, "legacyBridgeArtifacts.ts"), "utf8");
  assert.match(source, /input: JSON\.stringify\(\{ \.\.\.input, expectedDir \}\)/);
  assert.match(source, /\[\.\.\.host\.execArgv, "-e", childEditorScript\(\)\]/);
});
