import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  bookStreamEntries,
  bookTargetAlias,
  __setReadRecordExportHookForTest,
  deleteDraftEntryIfSavedAt,
  LedgerVersionError,
  readDraftEntry,
  writeDraftEntry,
  isTrustedCanonicalTarget,
  readAllStreamEntries,
  readExactSeqs,
  readMeta,
  readStreamEntry,
  resolveCanonicalTarget,
  resolveStateDbPath,
} from "./agentLedger";
import {
  recordConsumedRead,
  getConsumedSeq,
  getConsumedReadOrder,
} from "../commands/message/_consumedSeqState";
import { setSavedDraft, getSavedDraft } from "../commands/message/_continueDraftState";

// Child mode for the cross-process export test: book `count` reads of one
// target as fast as possible, each its own ledger transaction.
const readerChildMode = process.argv.indexOf("--ledger-reader-child");
if (readerChildMode >= 0) {
  const agentId = process.argv[readerChildMode + 1]!;
  const target = process.argv[readerChildMode + 2]!;
  const count = Number(process.argv[readerChildMode + 3]);
  for (let seq = 1; seq <= count; seq += 1) recordConsumedRead(agentId, target, seq);
  process.exit(0);
}

function isolatedEnv(): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-ledger-test-"));
  const prior = {
    state: process.env.SLOCK_CLI_STATE_DIR,
    consumed: process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR,
    draft: process.env.SLOCK_CLI_DRAFT_STATE_DIR,
    raftHome: process.env.RAFT_HOME,
  };
  process.env.SLOCK_CLI_STATE_DIR = dir;
  // Hermetic: the ledger's legacy import and its read-record export resolve
  // through the Raft home when no per-store override is set; never let a test
  // read or write the real one.
  process.env.RAFT_HOME = dir;
  delete process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR;
  delete process.env.SLOCK_CLI_DRAFT_STATE_DIR;
  return {
    dir,
    restore: () => {
      if (prior.state === undefined) delete process.env.SLOCK_CLI_STATE_DIR;
      else process.env.SLOCK_CLI_STATE_DIR = prior.state;
      if (prior.raftHome === undefined) delete process.env.RAFT_HOME;
      else process.env.RAFT_HOME = prior.raftHome;
      if (prior.consumed === undefined) delete process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR;
      else process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = prior.consumed;
      if (prior.draft === undefined) delete process.env.SLOCK_CLI_DRAFT_STATE_DIR;
      else process.env.SLOCK_CLI_DRAFT_STATE_DIR = prior.draft;
    },
  };
}

test("ledger path resolution prefers the explicit override, then legacy aliases, then the Raft home", () => {
  const env: NodeJS.ProcessEnv = {
    SLOCK_CLI_STATE_DIR: "/x/state",
    SLOCK_CLI_CONSUMED_SEQ_STATE_DIR: "/x/consumed",
    SLOCK_CLI_DRAFT_STATE_DIR: "/x/draft",
    SLOCK_HOME: "/x/home",
  };
  assert.equal(
    resolveStateDbPath("a1", env),
    path.join("/x/state", "slock-cli-ledger", "a1", "state.db"),
  );
  delete env.SLOCK_CLI_STATE_DIR;
  assert.equal(
    resolveStateDbPath("a1", env),
    path.join("/x/consumed", "slock-cli-ledger", "a1", "state.db"),
  );
  delete env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR;
  assert.equal(
    resolveStateDbPath("a1", env),
    path.join("/x/draft", "slock-cli-ledger", "a1", "state.db"),
  );
  delete env.SLOCK_CLI_DRAFT_STATE_DIR;
  // Outside the agent workspace (`agents/<id>/`) by design: the attestation
  // record must not live where the attested agent routinely edits.
  assert.equal(
    resolveStateDbPath("a1", env),
    path.join(path.resolve("/x/home"), "agent-state", "a1", "state.db"),
  );
});

test("ledger round-trips streams, drafts, and meta through one database", () => {
  const { restore } = isolatedEnv();
  try {
    bookStreamEntries("agent-rt", { "#general": 42 });
    setSavedDraft("agent-rt", "#general", {
      content: "hello",
      attachmentIds: [],
      savedAt: Date.now(),
      reholdCount: 0,
    });
    assert.equal(readStreamEntry("agent-rt", "#general")?.seq, 42);
    assert.equal(getSavedDraft("agent-rt", "#general")?.content, "hello");
    assert.equal(readMeta("agent-rt", "version"), "1");
    assert.equal(readMeta("agent-rt", "generation"), undefined, "context lifetime lives in observations (RFC 072 §7.3), not meta");
  } finally {
    restore();
  }
});

test("first open imports both legacy tmpdir stores once, preserving cursors and drafts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-ledger-import-"));
  const prior = {
    state: process.env.SLOCK_CLI_STATE_DIR,
    consumed: process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR,
    draft: process.env.SLOCK_CLI_DRAFT_STATE_DIR,
  };
  // Legacy envs point at this dir; the ledger resolves to the same dir via
  // the alias chain, exactly the transitional topology of a live seat.
  delete process.env.SLOCK_CLI_STATE_DIR;
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = dir;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = dir;
  try {
    const consumedPath = path.join(dir, "slock-cli-consumed-seq", "agent-mig", "consumed-seqs.json");
    fs.mkdirSync(path.dirname(consumedPath), { recursive: true });
    fs.writeFileSync(consumedPath, JSON.stringify({
      targets: { "#a": 150, "#a:thread": { seq: 200, readOrder: 7 } },
      nextReadOrder: 8,
    }));
    const draftPath = path.join(dir, "slock-cli-attested-send", "agent-mig", "continue-state.json");
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, JSON.stringify({
      targets: { "#a": { content: "draft body", attachmentIds: [], savedAt: Date.now(), reholdCount: 2 } },
    }));

    assert.equal(getConsumedSeq("agent-mig", "#a"), 150);
    assert.equal(getConsumedSeq("agent-mig", "#a:thread"), 200);
    assert.equal(getConsumedReadOrder("agent-mig", "#a:thread"), 7);
    const draft = getSavedDraft("agent-mig", "#a");
    assert.equal(draft?.content, "draft body");
    assert.equal(draft?.reholdCount, 2);

    // The import ran exactly once: the database exists and later legacy
    // edits are no longer consulted.
    assert.ok(fs.existsSync(resolveStateDbPath("agent-mig")));
    fs.writeFileSync(consumedPath, JSON.stringify({ targets: { "#a": 999 } }));
    assert.equal(getConsumedSeq("agent-mig", "#a"), 150, "post-import legacy writes are ignored");
  } finally {
    if (prior.state === undefined) delete process.env.SLOCK_CLI_STATE_DIR;
    else process.env.SLOCK_CLI_STATE_DIR = prior.state;
    if (prior.consumed === undefined) delete process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR;
    else process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = prior.consumed;
    if (prior.draft === undefined) delete process.env.SLOCK_CLI_DRAFT_STATE_DIR;
    else process.env.SLOCK_CLI_DRAFT_STATE_DIR = prior.draft;
  }
});

// Mutation kill (RFC 072 §4: a check that could never have gone red is not
// evidence): booking through the adapter must be load-bearing for what the
// getters return, and the two sections must not clobber each other.
test("cursor booking is load-bearing and sections do not clobber each other", () => {
  const { restore } = isolatedEnv();
  try {
    assert.equal(getConsumedSeq("agent-mut", "#m"), undefined, "no booking → absent (fail-closed)");
    recordConsumedRead("agent-mut", "#m", 33);
    assert.equal(getConsumedSeq("agent-mut", "#m"), 33, "booking → visible to attestation");
    recordConsumedRead("agent-mut", "#m", 20);
    assert.equal(getConsumedSeq("agent-mut", "#m"), 33, "monotonic max: lower seq never regresses the cursor");
    setSavedDraft("agent-mut", "#m", {
      content: "x",
      attachmentIds: [],
      savedAt: Date.now(),
      reholdCount: 0,
    });
    assert.equal(getConsumedSeq("agent-mut", "#m"), 33, "draft writes must not clobber stream entries");
    assert.equal(getSavedDraft("agent-mut", "#m")?.content, "x");
    recordConsumedRead("agent-mut", "#m", 44);
    assert.equal(getSavedDraft("agent-mut", "#m")?.content, "x", "stream writes must not clobber drafts");
  } finally {
    restore();
  }
});

// Rolling-upgrade safety, structural edition: a newer CLI's additive tables
// and meta keys must survive this version's writes — older writers cannot
// destroy what they do not know.
test("additive tables and meta keys from a newer CLI survive this version's writes", () => {
  const { restore } = isolatedEnv();
  try {
    bookStreamEntries("agent-fwd", { "#f": 1 });
    const dbPath = resolveStateDbPath("agent-fwd");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE future_section (k TEXT PRIMARY KEY, v TEXT)");
    db.exec("INSERT INTO future_section (k, v) VALUES ('fromNewerCli', 'true')");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('futureKey', 'kept')").run();
    db.close();

    recordConsumedRead("agent-fwd", "#f", 5);

    const check = new DatabaseSync(dbPath);
    const row = check.prepare("SELECT v FROM future_section WHERE k = 'fromNewerCli'").get() as { v: string } | undefined;
    assert.equal(row?.v, "true", "unknown tables survive older-writer mutation");
    check.close();
    assert.equal(readMeta("agent-fwd", "futureKey"), "kept", "unknown meta keys survive");
    assert.equal(readStreamEntry("agent-fwd", "#f")?.seq, 5, "known sections still update");
  } finally {
    restore();
  }
});

// Defence against the #8173 alias regression (task #172): on CLI 0.0.28 every
// target's spelling was aliased to the literal "#undefined" and their consumed
// evidence merged into one record, so a read in channel A could attest
// freshness for channel B (FH-EXT-001 gate 3 violation). The ledger must
// neither import that pollution nor let it be re-created.
test("a legacy store polluted by the #undefined alias collapse imports without merging evidence across targets", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-undefined-alias-"));
  const agentId = `polluted-${process.pid}`;
  const legacyDir = path.join(home, "slock-cli-consumed-seq", agentId);
  fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacyDir, "consumed-seqs.json"), JSON.stringify({
    targets: {
      "#undefined": { seq: 16496783, readOrder: 500 },
      "#proj-a": { seq: 100, readOrder: 1 },
      "#proj-b:abcd1234": { seq: 50, readOrder: 2, exactSeqs: [60, 61] },
    },
    aliases: { "#proj-a": "#undefined", "#proj-b:abcd1234": "#undefined", "dm:@peer": "#undefined" },
    nextReadOrder: 501,
  }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, RAFT_HOME: home };
  delete env.SLOCK_CLI_STATE_DIR; delete env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR; delete env.SLOCK_HOME;
  try {
    // The merged record never enters the ledger and no alias points at it.
    assert.equal(readStreamEntry(agentId, "#undefined", env), undefined);
    assert.equal(resolveCanonicalTarget(agentId, "#proj-a", env), "#proj-a");
    assert.equal(resolveCanonicalTarget(agentId, "dm:@peer", env), "dm:@peer");
    // Per-target evidence survives on its own key, including sparse exact seqs.
    assert.equal(readStreamEntry(agentId, "#proj-a", env)?.seq, 100);
    assert.equal(readStreamEntry(agentId, "#proj-b:abcd1234", env)?.seq, 50);
    assert.deepEqual(readExactSeqs(agentId, "#proj-b:abcd1234", env), [60, 61]);
    // Booking the poisoned destination again is refused; a real alias still works.
    bookTargetAlias(agentId, "#Proj-A", "#undefined", env);
    assert.equal(resolveCanonicalTarget(agentId, "#Proj-A", env), "#Proj-A");
    bookTargetAlias(agentId, "#Proj-A", "#proj-a", env);
    assert.equal(resolveCanonicalTarget(agentId, "#Proj-A", env), "#proj-a");
    // And channel A's evidence still proves nothing about a never-read channel.
    assert.equal(readStreamEntry(agentId, "#never-read", env), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("isTrustedCanonicalTarget rejects every undefined-shaped spelling and accepts real targets", () => {
  for (const bad of ["", " ", "#undefined", "undefined", "#Undefined", "#UNDEFINED:abcd1234", "#undefined:abcd1234", "dm:@undefined", "dm:@Undefined:abcd1234", "#chan:undefined", "#chan:UNDEFINED", " #chan"]) {
    assert.equal(isTrustedCanonicalTarget(bad), false, JSON.stringify(bad));
  }
  for (const good of ["#chan", "#chan:abcd1234", "dm:@peer", "dm:@peer:abcd1234", "#undefined-but-real-channel-name"]) {
    assert.equal(isTrustedCanonicalTarget(good), true, good);
  }
});

// The ledger is losable by contract, so a corrupt file must cost one
// conservative hold — not fail every read and swallow every write forever.
test("a corrupt ledger is moved aside and the next operation starts fresh", () => {
  const { restore } = isolatedEnv();
  try {
    recordConsumedRead("agent-corrupt", "#c", 5);
    const dbPath = resolveStateDbPath("agent-corrupt");
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
    fs.writeFileSync(dbPath, "not a database ".repeat(512));
    // The fresh ledger re-imports the CLI's own private read record — the
    // export written at the last booking — so the cursor survives; nothing
    // beyond what was really booked appears.
    assert.equal(getConsumedSeq("agent-corrupt", "#c"), 5, "the cursor is restored from the read record, not forged");
    recordConsumedRead("agent-corrupt", "#c", 9);
    assert.equal(getConsumedSeq("agent-corrupt", "#c"), 9, "writes land again after self-heal");
    setSavedDraft("agent-corrupt", "#c", { content: "after heal", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 });
    assert.equal(getSavedDraft("agent-corrupt", "#c")?.content, "after heal");
    assert.ok(fs.existsSync(`${dbPath}.corrupt`), "the corrupt file is kept aside for diagnosis");
  } finally {
    restore();
  }
});

// A ledger written under a newer, incompatible schema must be neither read
// (its rows may mean something else) nor written; draft writes fail loudly.
test("a ledger with a newer meta.version fails closed", () => {
  const { restore } = isolatedEnv();
  try {
    recordConsumedRead("agent-newer", "#v", 12);
    setSavedDraft("agent-newer", "#v", { content: "v1 draft", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 });
    const db = new DatabaseSync(resolveStateDbPath("agent-newer"));
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'version'").run();
    db.close();
    assert.equal(getConsumedSeq("agent-newer", "#v"), undefined, "no evidence is read from a newer ledger");
    assert.throws(() => getSavedDraft("agent-newer", "#v"), LedgerVersionError, "a newer ledger says upgrade, not draft-not-found");
    assert.throws(
      () => setSavedDraft("agent-newer", "#v", { content: "x", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 }),
      LedgerVersionError,
    );
    recordConsumedRead("agent-newer", "#v", 99);
    const check = new DatabaseSync(resolveStateDbPath("agent-newer"));
    const row = check.prepare("SELECT seq FROM streams WHERE target = '#v'").get() as { seq: number };
    check.close();
    assert.equal(row.seq, 12, "a best-effort booking does not write into a newer ledger");
  } finally {
    restore();
  }
});

// The legacy import runs under the write lock, exactly once, and merges:
// a booking a live writer already made is never lowered or reordered.
test("legacy import is exactly-once and never regresses live bookings", () => {
  const { dir, restore } = isolatedEnv();
  try {
    const agentId = "agent-merge";
    recordConsumedRead(agentId, "#chan", 99_999);
    recordConsumedRead(agentId, "#chan:bbbb2222", 50);
    // Simulate the window before the import committed: marker absent,
    // legacy file present with older state.
    const db = new DatabaseSync(resolveStateDbPath(agentId));
    db.prepare("DELETE FROM meta WHERE key = 'legacyImported'").run();
    db.close();
    // The legacy-store override points the import at this test's directory.
    process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = dir;
    const consumedPath = path.join(dir, "slock-cli-consumed-seq", agentId, "consumed-seqs.json");
    fs.mkdirSync(path.dirname(consumedPath), { recursive: true });
    fs.writeFileSync(consumedPath, JSON.stringify({
      targets: { "#chan": { seq: 10, readOrder: 5 }, "#chan:aaaa1111": { seq: 40, readOrder: 6 } },
      nextReadOrder: 7,
    }));
    assert.equal(getConsumedSeq(agentId, "#chan"), 99_999, "the import never lowers a live seq");
    assert.equal(getConsumedSeq(agentId, "#chan:aaaa1111"), 40, "legacy-only targets are imported");
    recordConsumedRead(agentId, "#chan:cccc3333", 60);
    assert.ok(
      getConsumedReadOrder(agentId, "#chan:cccc3333")! > getConsumedReadOrder(agentId, "#chan:aaaa1111")!,
      "the read-order counter is never rewound below imported orders",
    );
    // Exactly once: the marker now exists, later legacy edits are ignored.
    fs.writeFileSync(consumedPath, JSON.stringify({ targets: { "#chan:dddd4444": 70 } }));
    assert.equal(getConsumedSeq(agentId, "#chan:dddd4444"), undefined);
  } finally {
    restore();
  }
});

test("the TTL delete only removes the exact draft it read", () => {
  const { restore } = isolatedEnv();
  try {
    writeDraftEntry("agent-ttl", "#t", { content: "stale", attachmentIds: [], savedAt: 1_000, reholdCount: 0 });
    const stale = readDraftEntry("agent-ttl", "#t");
    // A concurrent send saves a fresh draft between the read and the delete.
    writeDraftEntry("agent-ttl", "#t", { content: "fresh", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 });
    assert.equal(deleteDraftEntryIfSavedAt("agent-ttl", "#t", stale!.savedAt), false);
    assert.equal(readDraftEntry("agent-ttl", "#t")?.content, "fresh");
  } finally {
    restore();
  }
});

test("an agent id that could name another directory is refused", () => {
  assert.throws(() => resolveStateDbPath("../other-agent"), /Invalid local state agent identity/);
  assert.throws(() => resolveStateDbPath("a/b"), /Invalid local state agent identity/);
  const { restore } = isolatedEnv();
  try {
    assert.throws(() => setSavedDraft("../other-agent", "#x", { content: "x", attachmentIds: [], savedAt: Date.now(), reholdCount: 0 }));
    assert.equal(getConsumedSeq("../other-agent", "#x"), undefined);
  } finally {
    restore();
  }
});

// Glimpse layer 2: the daemon reads "no counts table" as a CLI that predates
// the counts, so any open by this CLI, a read included, must create it.
test("any ledger open creates the passive render counts table, also in a ledger an older CLI made", () => {
  const { restore } = isolatedEnv();
  try {
    const hasTable = () => {
      const db = new DatabaseSync(resolveStateDbPath("agent-counts"), { readOnly: true });
      try {
        return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'passive_render_counts'").get());
      } finally {
        db.close();
      }
    };
    assert.equal(readStreamEntry("agent-counts", "#x"), undefined);
    assert.equal(hasTable(), true, "fresh ledger");
    const db = new DatabaseSync(resolveStateDbPath("agent-counts"));
    db.exec("DROP TABLE passive_render_counts");
    db.close();
    assert.equal(hasTable(), false);
    readStreamEntry("agent-counts", "#x");
    assert.equal(hasTable(), true, "an older CLI's ledger gains it on the next open");
  } finally {
    restore();
  }
});

// The exported read record (the SDK's contract) must never be older than the
// ledger: two writers' exports may not land out of order. The hook runs a
// second booking after this booking's snapshot and before its file write —
// exactly the window in which an export outside the write lock would publish
// stale state last.
test("the exported read record is never older than the ledger", () => {
  const { dir, restore } = isolatedEnv();
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = dir;
  try {
    const agentId = "agent-export-order";
    recordConsumedRead(agentId, "#first", 1);
    __setReadRecordExportHookForTest(() => {
      __setReadRecordExportHookForTest(null);
      recordConsumedRead(agentId, "#second", 2);
    });
    recordConsumedRead(agentId, "#third", 3);
    __setReadRecordExportHookForTest(null);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "slock-cli-consumed-seq", agentId, "consumed-seqs.json"), "utf8")) as {
      targets: Record<string, { seq?: number; readOrder?: number }>;
    };
    const ledger = readAllStreamEntries(agentId);
    // Mechanism, stated so a green run is not misread: the hook's booking runs
    // on this same thread while the outer booking holds the write lock, so it
    // waits out busy_timeout and is dropped (best-effort). File and ledger
    // agree because the lock excluded it — with the export moved after COMMIT
    // it would land and the outer export would then overwrite it: red.
    assert.equal(ledger["#second"], undefined, "the inner booking was excluded by the write lock");
    assert.deepEqual(
      Object.fromEntries(Object.entries(onDisk.targets).map(([target, entry]) => [target, { seq: entry.seq, readOrder: entry.readOrder }])),
      ledger,
    );
  } finally {
    __setReadRecordExportHookForTest(null);
    restore();
  }
});

// Production-shaped happy path: several CLI processes booking at once. Every
// booking must land, and afterwards the published read record equals the
// ledger. This proves the concurrent path lands and converges; it cannot
// deterministically catch an export moved after COMMIT (that depends on the
// interleaving) — the ordering discriminator is the in-process hook test above.
test("concurrent CLI processes all land and the read record matches the ledger", async () => {
  const { dir, restore } = isolatedEnv();
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = dir;
  try {
    const agentId = "agent-export-xproc";
    const childArgs = ["--import", "@oxc-node/core/register", fileURLToPath(import.meta.url)];
    const targets = ["#p1", "#p2", "#p3", "#p4"];
    const children = targets.map((target) => {
      const child = spawn(process.execPath, [...childArgs, "--ledger-reader-child", agentId, target, "25"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env },
      });
      const errors: Buffer[] = [];
      child.stderr.on("data", (chunk) => errors.push(chunk));
      return { exit: once(child, "exit"), errors };
    });
    for (const child of children) {
      const [code] = await child.exit;
      assert.equal(code, 0, Buffer.concat(child.errors).toString());
    }
    const ledger = readAllStreamEntries(agentId);
    for (const target of targets) assert.equal(ledger[target]?.seq, 25, `the last booking of ${target} landed`);
    // Each booking takes one read order, so 4 × 25 bookings leave the counter
    // at 101 only if none was dropped (a final seq of 25 alone would not show it).
    assert.equal(readMeta(agentId, "nextReadOrder"), "101", "all 100 bookings landed");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "slock-cli-consumed-seq", agentId, "consumed-seqs.json"), "utf8")) as {
      targets: Record<string, { seq?: number; readOrder?: number }>;
    };
    assert.deepEqual(onDisk.targets, ledger);
  } finally {
    restore();
  }
}, 60_000);

test("a trusted shared-tmpdir copy shadowed by the private layout is still removed after import", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-ledger-shadow-"));
  const agentId = `shadow-${process.pid}`;
  const env: NodeJS.ProcessEnv = { ...process.env, RAFT_HOME: home, SLOCK_CLI_STATE_DIR: path.join(home, "ledger") };
  delete env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR; delete env.SLOCK_CLI_DRAFT_STATE_DIR; delete env.SLOCK_HOME;
  const privateFile = path.join(home, "slock-cli-consumed-seq", agentId, "consumed-seqs.json");
  const tmpdirFile = path.join(os.tmpdir(), "slock-cli-consumed-seq", agentId, "consumed-seqs.json");
  try {
    fs.mkdirSync(path.dirname(privateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(privateFile, JSON.stringify({ targets: { "#s": 7 } }), { mode: 0o600 });
    fs.mkdirSync(path.dirname(tmpdirFile), { recursive: true });
    fs.writeFileSync(tmpdirFile, JSON.stringify({ targets: { "#s": 3 } }));
    assert.equal(readStreamEntry(agentId, "#s", env)?.seq, 7, "the private layout wins");
    assert.equal(fs.existsSync(tmpdirFile), false, "the shadowed world-readable copy is removed");
    assert.equal(fs.existsSync(privateFile), true, "the private copy stays");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(path.dirname(tmpdirFile), { recursive: true, force: true });
  }
});
