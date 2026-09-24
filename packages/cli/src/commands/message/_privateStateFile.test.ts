import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSavedDraft, setSavedDraft } from "./_continueDraftState.js";
import { recordConsumedSeqs, getConsumedSeq } from "./_consumedSeqState.js";

for (const kind of ["draft", "cursor"] as const) test(`${kind} state is private and never follows symlinks`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-state-"));
  const env = kind === "draft" ? "SLOCK_CLI_DRAFT_STATE_DIR" : "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR";
  const old = process.env[env]; process.env[env] = root;
  const dir = path.join(root, kind === "draft" ? "slock-cli-attested-send" : "slock-cli-consumed-seq", "agent-1");
  const file = path.join(dir, kind === "draft" ? "continue-state.json" : "consumed-seqs.json");
  const write = () => kind === "draft" ? setSavedDraft("agent-1", "dm:@peer", { content: "private draft", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 }) : recordConsumedSeqs("agent-1", { "dm:@peer": 7 });
  try {
    write();
    assert.equal(kind === "draft" ? getSavedDraft("agent-1", "dm:@peer")?.content : getConsumedSeq("agent-1", "dm:@peer"), kind === "draft" ? "private draft" : 7);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      const victim = path.join(root, "victim"); fs.writeFileSync(victim, "must survive");
      fs.unlinkSync(file); fs.symlinkSync(victim, file); write();
      assert.equal(fs.readFileSync(victim, "utf8"), "must survive");
      fs.rmSync(dir, { recursive: true }); fs.symlinkSync(root, dir);
      if (kind === "draft") assert.throws(write); else write();
      assert.equal(fs.existsSync(path.join(root, path.basename(file))), false);
    }
  } finally { if (old === undefined) delete process.env[env]; else process.env[env] = old; fs.rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ["draft", "cursor"] as const) test(`${kind} state written by the pre-hardening layout is imported once on first read`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-home-"));
  const agentId = `legacy-import-${process.pid}-${kind}`;
  const namespace = kind === "draft" ? "slock-cli-attested-send" : "slock-cli-consumed-seq";
  const filename = kind === "draft" ? "continue-state.json" : "consumed-seqs.json";
  const legacyDir = path.join(os.tmpdir(), namespace, agentId);
  const legacyFile = path.join(legacyDir, filename);
  const env = kind === "draft" ? "SLOCK_CLI_DRAFT_STATE_DIR" : "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR";
  const saved = { override: process.env[env], home: process.env.RAFT_HOME, slockHome: process.env.SLOCK_HOME };
  delete process.env[env]; delete process.env.SLOCK_HOME; process.env.RAFT_HOME = home;
  const legacyContent = kind === "draft"
    ? JSON.stringify({ targets: { "dm:@peer": { content: "draft from before the upgrade", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 } } })
    : JSON.stringify({ targets: { "dm:@peer": { seq: 41, readOrder: 1 } }, nextReadOrder: 2 });
  try {
    // The old layout: shared tmpdir, default (group/other readable) mode.
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyFile, legacyContent, { mode: 0o644 });
    const read = () => kind === "draft" ? getSavedDraft(agentId, "dm:@peer")?.content : getConsumedSeq(agentId, "dm:@peer");
    assert.equal(read(), kind === "draft" ? "draft from before the upgrade" : 41, "state saved before the upgrade must still be readable");
    const privateFile = path.join(home, namespace, agentId, filename);
    assert.equal(fs.existsSync(privateFile), true, "the import writes the private copy");
    if (process.platform !== "win32") assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(legacyFile), false, "the world-readable copy is removed after import");
    // A later legacy file never overrides the private copy.
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyFile, legacyContent.replace("41", "99").replace("before the upgrade", "stale"), { mode: 0o644 });
    assert.equal(read(), kind === "draft" ? "draft from before the upgrade" : 41);
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.override === undefined) delete process.env[env]; else process.env[env] = saved.override;
    if (saved.home === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = saved.home;
    if (saved.slockHome !== undefined) process.env.SLOCK_HOME = saved.slockHome;
  }
});

test("legacy import refuses symlinks and does not run under an explicit state directory", () => {
  if (process.platform === "win32") return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-home-"));
  const agentId = `legacy-symlink-${process.pid}`;
  const legacyDir = path.join(os.tmpdir(), "slock-cli-attested-send", agentId);
  const legacyFile = path.join(legacyDir, "continue-state.json");
  const planted = path.join(home, "planted.json");
  const saved = { override: process.env.SLOCK_CLI_DRAFT_STATE_DIR, home: process.env.RAFT_HOME, slockHome: process.env.SLOCK_HOME };
  delete process.env.SLOCK_CLI_DRAFT_STATE_DIR; delete process.env.SLOCK_HOME; process.env.RAFT_HOME = home;
  try {
    fs.writeFileSync(planted, JSON.stringify({ targets: { "dm:@peer": { content: "planted", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 } } }));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.symlinkSync(planted, legacyFile);
    assert.equal(getSavedDraft(agentId, "dm:@peer"), null, "a symlink at the legacy path is not imported");
    assert.equal(fs.existsSync(path.join(home, "slock-cli-attested-send", agentId, "continue-state.json")), false);
    assert.equal(fs.lstatSync(legacyFile).isSymbolicLink(), true, "the symlink is left untouched");

    fs.unlinkSync(legacyFile);
    fs.writeFileSync(legacyFile, JSON.stringify({ targets: { "dm:@peer": { content: "legacy", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 } } }), { mode: 0o644 });
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cli-override-"));
    process.env.SLOCK_CLI_DRAFT_STATE_DIR = overrideDir;
    try {
      assert.equal(getSavedDraft(agentId, "dm:@peer"), null, "an explicit state directory has no legacy location to import from");
      assert.equal(fs.existsSync(legacyFile), true);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.override === undefined) delete process.env.SLOCK_CLI_DRAFT_STATE_DIR; else process.env.SLOCK_CLI_DRAFT_STATE_DIR = saved.override;
    if (saved.home === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = saved.home;
    if (saved.slockHome !== undefined) process.env.SLOCK_HOME = saved.slockHome;
  }
});
