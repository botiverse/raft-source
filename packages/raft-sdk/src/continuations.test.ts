import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asContinuationId } from "@botiverse/raft-shared/src/continuations/index";
import { continuationStoreContract, sampleContinuationRecord } from "@botiverse/raft-shared/src/continuations/store.testkit";
import * as agent from "./agent";
import * as continuations from "./continuations";
import { releaseLock } from "./continuationFileStore";
import * as root from "./index";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "raft-sdk-continuations-"));
  dirs.push(dir);
  return join(dir, "state");
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

continuationStoreContract("SDK file store", () => continuations.createFileContinuationStore({ dir: freshDir() }));

test("records and tombstones are private to the agent: 0700 directories, 0600 files", async () => {
  const dir = freshDir();
  const store = continuations.createFileContinuationStore({ dir });
  const record = sampleContinuationRecord({ id: asContinuationId("k7q2m3x9ab") });
  assert.equal(await store.put(record), true);
  await store.update({ ...record, revision: record.revision + 1 }, record.revision);
  await store.putTombstone({
    formatVersion: continuations.CONTINUATION_FORMAT_VERSION,
    id: record.id,
    rootId: record.id,
    ownerAgentId: record.ownerAgentId,
    command: record.command,
    finishedAt: null,
    deleteAfter: record.deleteAfter,
  });
  if (process.platform === "win32") return;
  for (const sub of ["", "records", "tombstones"]) {
    assert.equal(statSync(join(dir, sub)).mode & 0o777, 0o700, `${sub || "dir"} mode`);
  }
  for (const sub of ["records", "tombstones"]) {
    const files = readdirSync(join(dir, sub));
    assert.deepEqual(files, [`${record.id}.json`], `${sub} holds only the record file`);
    assert.equal(statSync(join(dir, sub, files[0]!)).mode & 0o777, 0o600, `${sub} file mode`);
  }
});

test("a store refuses names that are not continuation ids, so a file never lands outside its directory", async () => {
  const store = continuations.createFileContinuationStore({ dir: freshDir() });
  assert.throws(() => store.get(asContinuationId("../../etc/passwd")), /not a continuation id/);
});

test("a lock left by a process that died is taken over; a live one makes update answer false", async () => {
  const dir = freshDir();
  const store = continuations.createFileContinuationStore({ dir });
  const record = sampleContinuationRecord({ id: asContinuationId("k7q2m3x9ab") });
  await store.put(record);
  const lock = join(dir, "records", `${record.id}.json.lock`);

  writeFileSync(lock, "");
  assert.equal(await store.update({ ...record, revision: 2 }, record.revision), false, "a fresh lock is held by a live process");

  const { utimesSync } = await import("node:fs");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(await store.update({ ...record, revision: 2 }, record.revision), true, "a stale lock is taken over");
  assert.equal((await store.get(record.id))?.revision, 2);
});

test("releasing a lock removes it, but never a lock another process created under the same name", async () => {
  const { existsSync, openSync, renameSync } = await import("node:fs");
  const dir = freshDir();
  continuations.createFileContinuationStore({ dir });
  const lock = join(dir, "records", "k7q2m3x9ab.json.lock");

  releaseLock(lock, openSync(lock, "wx"));
  assert.equal(existsSync(lock), false, "this process's own lock is removed");

  // This process's lock was renamed aside and dropped, and a third process created a fresh one.
  const mine = openSync(lock, "wx");
  renameSync(lock, `${lock}.aside`);
  writeFileSync(lock, "");
  releaseLock(lock, mine);
  assert.equal(existsSync(lock), true, "another process's lock under the same name stays");
});

test("the continuations entry names the runtime for SDK users; root and ./agent export none of it", () => {
  for (const name of ["defineCommand", "startCommand", "resumeContinuation", "createFileContinuationStore", "createMemoryContinuationStore", "formatContinuationPaused", "formatContinuationRefusal", "CONTINUATION_PAUSED_EXIT_CODE"]) {
    assert.equal(name in continuations, true, `${name} on ./continuations`);
    assert.equal(name in root, false, `${name} not on the root`);
    assert.equal(name in agent, false, `${name} not on ./agent`);
  }
  assert.equal("start" in continuations, false, "the SDK names it startCommand");
  assert.equal("resume" in continuations, false, "the SDK names it resumeContinuation");
  assert.equal("asContinuationId" in continuations, false, "the unchecked brand cast stays internal: SDK users parse ids");
  assert.equal(continuations.CONTINUATION_PAUSED_EXIT_CODE, 10);
});

test("a command pauses, resumes from the file store, and a read-only step is not run again", async () => {
  const store = continuations.createFileContinuationStore({ dir: freshDir() });
  const options = { store, ownerAgentId: "agent-1", program: { name: "sdk-test", version: "1" } };
  let reads = 0;
  const greet = continuations.defineCommand<{ name: string }, { said: string }>("greet", async (ctx, args) => {
    await ctx.step("read", () => { reads += 1; return { seen: true }; }, { readOnly: true });
    const answer = await ctx.ask("how", { question: `Greet ${args.name}?`, options: { a: "Hello", b: "Hi" } });
    return { said: `${answer.choice === "a" ? "Hello" : "Hi"}, ${args.name}` };
  });

  const paused = await continuations.startCommand(greet, { ...options, args: { name: "Ada" } });
  assert.equal(paused.kind, "paused");
  if (paused.kind !== "paused") return;
  const done = await continuations.resumeContinuation(paused.continuation.id, { choice: "b" }, { ...options, commands: [greet] });
  assert.deepEqual(done.kind === "done" ? done.result : done, { said: "Hi, Ada" });
  assert.equal(reads, 1, "the journaled read is replayed, not run again");
});
