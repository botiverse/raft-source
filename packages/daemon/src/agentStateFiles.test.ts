import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentStateDir } from "./agentStateFiles";
import { SessionCompactionFailureLedger } from "./sessionCompactionFailureLedger";
import { StandingPromptLedger } from "./standingPromptRefresh";
import { resolveWorkspaceDirectoryPath, scanWorkspaceDirectories } from "./workspaces";

let root: string;
let agentsDir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "agent-state-"));
  agentsDir = path.join(root, "agents");
  mkdirSync(path.join(agentsDir, "a1", ".raft"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const legacy = (name: string) => path.join(agentsDir, "a1", ".raft", name);

test("records are written in the daemon's agent state, never in the workspace", () => {
  new StandingPromptLedger(agentsDir, () => 1).write("a1", "s1", "h1");
  new SessionCompactionFailureLedger(agentsDir).recordFailure("a1", "s1", "m");
  assert.deepEqual(readdirSync(agentStateDir(agentsDir, "a1")).sort(), ["compaction-failures.json", "standing-prompt.json"]);
  assert.deepEqual(readdirSync(path.join(agentsDir, "a1", ".raft")), []);
});

test("a link planted at the old predictable temp names is never written through", () => {
  const victim = path.join(root, "victim.txt");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, `${legacy("standing-prompt.json")}.${process.pid}.tmp`);
  symlinkSync(victim, `${legacy("compaction-failures.json")}.${process.pid}.tmp`);
  new StandingPromptLedger(agentsDir, () => 1).write("a1", "s1", "h1");
  new SessionCompactionFailureLedger(agentsDir).recordFailure("a1", "s1", "m");
  assert.equal(readFileSync(victim, "utf8"), "untouched");
});

test("`.raft` replaced by a link is never written through", () => {
  rmSync(path.join(agentsDir, "a1", ".raft"), { recursive: true, force: true });
  mkdirSync(path.join(root, "elsewhere"));
  symlinkSync(path.join(root, "elsewhere"), path.join(agentsDir, "a1", ".raft"));
  new StandingPromptLedger(agentsDir, () => 1).write("a1", "s1", "h1");
  new SessionCompactionFailureLedger(agentsDir).recordFailure("a1", "s1", "m");
  assert.deepEqual(readdirSync(path.join(root, "elsewhere")), []);
});

test("the old standing-prompt record is carried over once; the old compaction count is dropped", () => {
  writeFileSync(legacy("standing-prompt.json"), JSON.stringify({ version: 1, sessionId: "s1", promptHash: "h1", recordedAtMs: 7 }));
  writeFileSync(legacy("compaction-failures.json"), JSON.stringify({ version: 1, sessionId: "s1", model: "m", count: 5, updatedAtMs: 7 }));
  const ledger = new StandingPromptLedger(agentsDir, () => 9);
  assert.deepEqual(ledger.read("a1"), { version: 1, sessionId: "s1", promptHash: "h1", recordedAtMs: 7 });
  assert.equal(new SessionCompactionFailureLedger(agentsDir).needsReset("a1", "s1", "m"), null);
  // Once carried over, the old file is never read again.
  writeFileSync(legacy("standing-prompt.json"), JSON.stringify({ version: 1, sessionId: "s9", promptHash: "h9", recordedAtMs: 8 }));
  ledger.write("a1", "s2", "h2");
  assert.equal(ledger.read("a1")?.sessionId, "s2");
  rmSync(path.join(agentStateDir(agentsDir, "a1"), "standing-prompt.json"));
  assert.equal(ledger.read("a1"), null);
});

test("an old record that is a link is not followed", () => {
  const secret = path.join(root, "secret.json");
  writeFileSync(secret, JSON.stringify({ version: 1, sessionId: "s1", promptHash: "leaked", recordedAtMs: 1 }));
  symlinkSync(secret, legacy("standing-prompt.json"));
  assert.equal(new StandingPromptLedger(agentsDir).read("a1"), null);
});

test("the agent state directory is not a workspace: not listed, read or deleted as one", async () => {
  new StandingPromptLedger(agentsDir, () => 1).write("a1", "s1", "h1");
  assert.deepEqual((await scanWorkspaceDirectories(agentsDir)).map((entry) => entry.directoryName), ["a1"]);
  assert.equal(resolveWorkspaceDirectoryPath(agentsDir, ".agent-state"), null);
  assert.equal(resolveWorkspaceDirectoryPath(agentsDir, ".runtime-outcome-outbox"), null);
  assert.equal(resolveWorkspaceDirectoryPath(agentsDir, "a1"), path.join(agentsDir, "a1"));
  assert.ok(existsSync(agentStateDir(agentsDir, "a1")));
});

test("a compaction ledger touching the agent first still carries the standing-prompt record over", () => {
  writeFileSync(legacy("standing-prompt.json"), JSON.stringify({ version: 1, sessionId: "s1", promptHash: "h1", recordedAtMs: 7 }));
  new SessionCompactionFailureLedger(agentsDir).recordFailure("a1", "s1", "m");
  assert.equal(new StandingPromptLedger(agentsDir).read("a1")?.promptHash, "h1");
});

test("an old record that is a FIFO or too large is skipped without blocking", () => {
  if (process.platform === "win32") return;
  execFileSync("mkfifo", [legacy("standing-prompt.json")]);
  assert.equal(new StandingPromptLedger(agentsDir).read("a1"), null);
  mkdirSync(path.join(agentsDir, "a2", ".raft"), { recursive: true });
  writeFileSync(path.join(agentsDir, "a2", ".raft", "standing-prompt.json"), " ".repeat(70 * 1024));
  assert.equal(new StandingPromptLedger(agentsDir).read("a2"), null);
});

test("an agent id is encoded into one directory name; '.' and '..' are refused", () => {
  assert.equal(path.dirname(agentStateDir(agentsDir, "a/b")), path.join(agentsDir, ".agent-state"));
  assert.throws(() => agentStateDir(agentsDir, ".."));
  assert.throws(() => agentStateDir(agentsDir, "."));
  assert.equal(resolveWorkspaceDirectoryPath(agentsDir, ".Agent-State"), null);
  assert.equal(resolveWorkspaceDirectoryPath(agentsDir, ".agent-state."), null);
});
