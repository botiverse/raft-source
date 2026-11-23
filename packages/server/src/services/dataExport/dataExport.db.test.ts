// Data export jobs below the routes (#triage:#512): the runner
// (runner.ts) writes the archive from a producer into zip volumes and ends
// it ready, failed or not at all, and a run that lost the job writes and
// deletes nothing of the run that took it over; maintenance (maintenance.ts)
// expires, fails stuck jobs and aborts uploads nobody owns; account deletion
// and the closed-server purge take the exports with them, running ones too.
// Storage is in memory (dataExportFixture.ts), the producer scripted: no real
// producer exists yet.
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { asServerId, type DataExportKind } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import { dataExports, durableTasks, notificationOutbox, serverMembers, servers } from "../../db/schema";
import { MemoryExportStorage, scriptedProducer, setDataExportFlag, zipEntry, zipEntryNames } from "../../test/dataExportFixture";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { accountDeletionCleanupSteps } from "../accountDeletion/cleanup";
import { CLOSED_SERVER_PURGE_FINISH_STEPS } from "../closedServerPurgeFinish";
import { runDurableTask } from "../durableTasks";
import { __setStorageForTests, resetStorageForTests } from "../storageService";
import { createDataExport, dataExportVolumeKey, deleteDataExport, deleteDataExportsOfDeletedUser, listDataExports } from "./jobs";
import { DATA_EXPORT_ORPHAN_UPLOAD_MS, DATA_EXPORT_STUCK_MS, runDataExportMaintenance } from "./maintenance";
import { DataExportProducerRegistry, dataExportProducers, type DataExportBatch, type DataExportOp } from "./producer";
import { __fillDataExportSlotsForTests, continuedEntryName, dataExportTaskDefinition, dataExportTaskRegistry, generateDataExport } from "./runner";

type Seed = ReturnType<typeof createSeed>;
const DAY = 24 * 60 * 60 * 1000;

let storage: MemoryExportStorage;
beforeEach(() => {
  storage = new MemoryExportStorage();
  __setStorageForTests(storage);
});
afterEach(() => {
  resetStorageForTests();
  __fillDataExportSlotsForTests(false);
  dataExportProducers.unregister("personal");
});

const lease = { extendLease: async () => true };
const quiet = async () => undefined;
const lines = (path: string, n: number, from = 0): DataExportOp => ({ type: "lines", path, lines: Array.from({ length: n }, (_, i) => ({ seq: from + i, text: `message ${from + i} ${"x".repeat(200)}` })) });
const registry = (...producers: Parameters<DataExportProducerRegistry["register"]>[0][]) => {
  const made = new DataExportProducerRegistry();
  for (const producer of producers) made.register(producer);
  return made;
};

async function queued(seed: Seed, kind: DataExportKind = "personal", at = new Date()) {
  const human = await seed.human();
  const server = kind === "server" ? await seed.server({ owner: human }) : null;
  const created = await createDataExport({
    kind,
    requesterUserId: human.id,
    requesterSessionFamilyId: "00000000-0000-4000-8000-000000000001",
    serverId: server?.id ?? null,
    scope: kind === "server" ? { includeFiles: false, fullHistoryAfterClose: false } : { serverIds: "all", includeContext: false, includeFiles: false },
    now: at,
    taskSpec: dataExportTaskDefinition,
  });
  assert.ok(created.ok);
  return { human, server, row: created.row, claim: created.claim };
}

const rowOf = async (id: string) => (await getDb().select().from(dataExports).where(eq(dataExports.id, id)))[0];
const object = (key: string) => storage.objects.get(key)!;

test("volumes end after the op that fills them, mid-batch too; an open file continues under .partN; the last volume's manifest has the earlier checksums; ready, kept 7 days, the person told", async ({ seed }) => {
  await setDataExportFlag(true);
  const { human, row } = await queued(seed);
  const producer = scriptedProducer({
    kind: "personal",
    batches: [
      { ops: [{ type: "json", path: "account.json", value: { id: "me" } }, lines("conversations/general/2026-11.jsonl", 40)], counts: { messages: 40 } },
      { ops: [lines("conversations/general/2026-11.jsonl", 40, 40)], counts: { messages: 40 } },
      { ops: [lines("conversations/general/2026-11.jsonl", 10, 80), lines("conversations/random/2026-11.jsonl", 5)], counts: { messages: 15 } },
    ],
  });
  const notified: string[] = [];
  // 1-byte volumes: every op fills one.
  await generateDataExport(row.id, lease, { producers: registry(producer), volumeBytes: 1, notify: async (r, outcome) => { notified.push(`${r.id}:${outcome}`); } });

  const done = await rowOf(row.id);
  assert.equal(done!.status, "ready");
  assert.deepEqual(notified, [`${row.id}:ready`]);
  assert.equal(done!.expiresAt!.getTime() - done!.finishedAt!.getTime(), 7 * DAY);
  assert.equal(done!.sizeBytes, done!.volumes.reduce((total, volume) => total + volume.sizeBytes, 0));
  // A batch cut by a volume is read again, its first ops skipped.
  assert.deepEqual(producer.calls, [0, 0, 1, 2, 2]);
  assert.deepEqual(done!.volumes.map((volume) => zipEntryNames(object(volume.key))), [
    ["account.json"],
    ["conversations/general/2026-11.jsonl"],
    ["conversations/general/2026-11.part3.jsonl"],
    ["conversations/general/2026-11.part4.jsonl"],
    ["conversations/random/2026-11.jsonl", "manifest.json"],
  ]);
  assert.equal(zipEntry(object(done!.volumes[2]!.key), "conversations/general/2026-11.part3.jsonl").toString().trim().split("\n").length, 40);
  const manifest = JSON.parse(zipEntry(object(done!.volumes[4]!.key), "manifest.json").toString());
  assert.equal(manifest.exportId, row.id);
  assert.equal(manifest.requesterUserId, human.id);
  assert.equal(manifest.requestedAt, row.createdAt.toISOString());
  assert.deepEqual(manifest.counts, { messages: 95 }, "each batch counted once");
  assert.deepEqual(manifest.earlierVolumes.map((volume: { sha256: string }) => volume.sha256), done!.volumes.slice(0, 4).map((volume) => volume.sha256));
  assert.equal(storage.uploads.size, 0, "no upload left open");
  assert.equal(continuedEntryName("files/a", 2), "files/a.part2");
});

test("a volume that fails aborts its upload at once; the next run writes that volume again from its cursor; a lost run's recorded upload is aborted when a run takes over", async ({ seed }) => {
  await setDataExportFlag(true);
  const { row } = await queued(seed);
  const producer = scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 3)] }, { ops: [lines("b.jsonl", 3)] }] });
  storage.failPart = 1;
  await assert.rejects(generateDataExport(row.id, lease, { producers: registry(producer), notify: quiet }), /part upload failed/);
  assert.equal(storage.aborted.length, 1, "the failed volume's upload was aborted (Tenny 542c7777)");
  assert.equal(storage.uploads.size, 0);
  const afterFailure = await rowOf(row.id);
  assert.equal(afterFailure!.status, "running");
  assert.equal(afterFailure!.progress!.uploadId, null);

  // A run lost after recording its upload: the next one aborts it and starts the volume over.
  const lostKey = dataExportVolumeKey(row.id, 1, afterFailure!.progress!.runToken!);
  const lostUpload = await storage.multipart.createMultipartUpload(lostKey, "application/zip");
  await getDb().update(dataExports).set({ progress: { ...afterFailure!.progress!, key: lostKey, uploadId: lostUpload } }).where(eq(dataExports.id, row.id));
  producer.calls.length = 0;
  await generateDataExport(row.id, lease, { producers: registry(producer), notify: quiet });
  assert.ok(storage.aborted.includes(lostUpload));
  assert.deepEqual(producer.calls, [0, 1], "from the volume's starting cursor");
  assert.equal((await rowOf(row.id))!.status, "ready");
});

test("two runs of one job: the run that took over finishes; the stale one, still going, writes nothing and deletes only what it could not record", async ({ seed }) => {
  await setDataExportFlag(true);
  const { row } = await queued(seed);
  const file = "attachments/one.bin";
  storage.objects.set(file, Buffer.alloc(64, 7));
  const producer = scriptedProducer({ kind: "personal", batches: [{ ops: [{ type: "file", path: "files/one.bin", storageKey: file }] }, { ops: [lines("b.jsonl", 2)] }] });
  // The stale run (A) has just completed its first volume when a newer run (B) takes the job over and finishes it.
  let raced = false;
  storage.onComplete = async (key) => {
    if (raced || !key.endsWith(`-${"a".repeat(8)}.zip`)) return;
    raced = true;
    await generateDataExport(row.id, lease, { producers: registry(producer), runToken: "b".repeat(8), volumeBytes: 1, notify: quiet });
  };
  await generateDataExport(row.id, lease, { producers: registry(producer), runToken: "a".repeat(8), volumeBytes: 1, notify: quiet });

  const done = await rowOf(row.id);
  assert.equal(done!.status, "ready");
  assert.equal(done!.progress!.runToken, "b".repeat(8));
  assert.deepEqual(done!.volumes.map((volume) => volume.key), [dataExportVolumeKey(row.id, 1, "b".repeat(8)), dataExportVolumeKey(row.id, 2, "b".repeat(8))]);
  for (const volume of done!.volumes) assert.ok(storage.objects.has(volume.key), `${volume.key}: the winner's objects stay`);
  // A finished its volume as B took over: the record was fenced out and A deleted its own object, only that.
  assert.ok(raced);
  assert.equal(storage.objects.has(dataExportVolumeKey(row.id, 1, "a".repeat(8))), false);
  assert.equal(storage.uploads.size, 0);

  // A lease that is lost: the run stops before its next op, writes nothing more, and aborts its upload.
  const second = await queued(seed);
  let beats = 0;
  const losing = { extendLease: async () => (beats += 1) < 2 };
  const many = scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 1), lines("b.jsonl", 1)] }, { ops: [lines("c.jsonl", 1)] }] });
  await generateDataExport(second.row.id, losing, { producers: registry(many), notify: quiet, now: (() => { let t = 0; return () => new Date((t += 60_000)); })() });
  const stopped = await rowOf(second.row.id);
  assert.equal(stopped!.status, "running", "left for the run that takes it over");
  assert.ok(stopped!.progress!.uploadId, "its recorded upload is the next run's to abort");
  assert.equal(storage.uploads.size, 0, "its own upload was aborted already");
  assert.deepEqual(many.calls, [0]);
});

test("before every batch: the flag off fails it export_disabled, a flag that can't be read is retried, a requester who lost the right (or the server owner role) fails it not_authorized, a delete stops it; each leaves nothing stored", async ({ seed }) => {
  await setDataExportFlag(true);
  const notified: string[] = [];
  const notify = async (r: { id: string }, outcome: string) => { notified.push(`${r.id}:${outcome}`); };

  const flagged = await queued(seed);
  const flagOff = scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 2)] }, { ops: [lines("a.jsonl", 2)] }], beforeBatch: async (cursor) => { if (cursor === 0) await setDataExportFlag(false); } });
  await generateDataExport(flagged.row.id, lease, { producers: registry(flagOff), notify });
  assert.deepEqual([(await rowOf(flagged.row.id))!.status, (await rowOf(flagged.row.id))!.errorCode], ["failed", "export_disabled"]);
  assert.deepEqual(flagOff.calls, [0], "no batch after the flag went off");
  await setDataExportFlag(true);

  const unreadable = await queued(seed);
  await assert.rejects(generateDataExport(unreadable.row.id, lease, {
    producers: registry(scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 1)] }] })),
    notify,
    flagEnabled: async () => { throw new Error("flag store unavailable"); },
  }), /flag store unavailable/);
  assert.equal((await rowOf(unreadable.row.id))!.status, "running", "retried, not failed");

  const revoked = await queued(seed);
  let allowed = true;
  const lostRight = scriptedProducer({
    kind: "personal",
    batches: [{ ops: [lines("a.jsonl", 2)] }, { ops: [lines("a.jsonl", 2)] }],
    authorize: () => allowed ? { ok: true } : { ok: false, code: "gone", error: "The person left." },
    beforeBatch: () => { allowed = false; },
  });
  await generateDataExport(revoked.row.id, lease, { producers: registry(lostRight), notify });
  assert.deepEqual([(await rowOf(revoked.row.id))!.status, (await rowOf(revoked.row.id))!.errorCode], ["failed", "not_authorized"]);

  // A server export: the framework itself re-checks exportServerData, whatever the producer says.
  const demoted = await queued(seed, "server");
  const serverProducer = scriptedProducer({
    kind: "server",
    batches: [{ ops: [lines("a.jsonl", 2)] }, { ops: [lines("a.jsonl", 2)] }],
    beforeBatch: async () => {
      await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, demoted.server!.id), eq(serverMembers.userId, demoted.human.id)));
    },
  });
  await generateDataExport(demoted.row.id, lease, { producers: registry(serverProducer), notify });
  assert.deepEqual([(await rowOf(demoted.row.id))!.status, (await rowOf(demoted.row.id))!.errorCode], ["failed", "not_authorized"]);

  const deleted = await queued(seed);
  const deletedMidway = scriptedProducer({
    kind: "personal",
    batches: [{ ops: [lines("a.jsonl", 2)] }, { ops: [lines("a.jsonl", 2)] }, { ops: [lines("a.jsonl", 2)] }],
    beforeBatch: async (cursor) => { if (cursor === 0) assert.ok(await deleteDataExport({ requesterUserId: deleted.human.id, exportId: deleted.row.id, now: new Date() })); },
  });
  await generateDataExport(deleted.row.id, lease, { producers: registry(deletedMidway), notify });
  assert.equal((await rowOf(deleted.row.id))!.status, "deleted");
  assert.deepEqual(deletedMidway.calls, [0], "stopped at the next batch");

  assert.deepEqual(notified.sort(), [`${flagged.row.id}:failed`, `${revoked.row.id}:failed`, `${demoted.row.id}:failed`].sort(), "failures told, a delete not");
  assert.equal(storage.objects.size, 0);
  assert.equal([...storage.uploads.values()].length, 0, "every upload aborted");

  // No producer for the kind: failed kind_unavailable, not retried forever.
  const orphan = await queued(seed);
  await generateDataExport(orphan.row.id, lease, { producers: registry(), notify });
  assert.equal((await rowOf(orphan.row.id))!.errorCode, "kind_unavailable");
});

test("every slot taken: the task is deferred without spending an attempt, the export stays queued; with a slot it runs", async ({ seed }) => {
  await setDataExportFlag(true);
  dataExportProducers.register(scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 1)] }] }));
  const { row, claim } = await queued(seed);
  __fillDataExportSlotsForTests(true);
  assert.equal(await runDurableTask(claim, dataExportTaskRegistry), "deferred");
  const [task] = await getDb().select().from(durableTasks).where(eq(durableTasks.id, claim.task.id));
  assert.deepEqual([task!.state, task!.maxAttempts - task!.attempts, task!.lastError], ["open", dataExportTaskDefinition.maxAttempts, "DATA_EXPORT_BUSY"]);
  assert.equal((await rowOf(row.id))!.status, "queued");
  __fillDataExportSlotsForTests(false);
  await generateDataExport(row.id, lease, { notify: quiet });
  assert.equal((await rowOf(row.id))!.status, "ready");
});

test("the real notifications: one system notice per outcome however often the run repeats", async ({ seed }) => {
  await setDataExportFlag(true);
  const { human, row } = await queued(seed);
  await seed.server({ owner: human });
  const producer = scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 1)] }] });
  await generateDataExport(row.id, lease, { producers: registry(producer) });
  const notices = () => getDb().select().from(notificationOutbox).where(and(eq(notificationOutbox.receiverId, human.id), eq(notificationOutbox.category, "system_notice")));
  assert.equal((await notices()).length, 1);
  assert.match(JSON.stringify((await notices())[0]!.payload), /Your data export is ready/);
  // A repeated run finds it ready and does nothing.
  await generateDataExport(row.id, lease, { producers: registry(producer) });
  assert.equal((await notices()).length, 1);
});

test("maintenance: a ready archive past 7 days expires (objects deleted, row kept); a job whose task gave up, or a running one silent for a day, fails stuck with its upload aborted; a queued one waiting for a slot does not; an unfinished upload nobody owns is aborted after a day, an owned or young one is not", async ({ seed }) => {
  await setDataExportFlag(true);
  const now = new Date();
  const runningProgress = (key: string, uploadId: string) => ({ runToken: "r", volume: 1, cursorAtVolumeStart: 0, writtenPathsAtVolumeStart: [], openPathAtVolumeStart: null, key, uploadId, counts: {} });
  // Ready, 8 days ago.
  const old = await queued(seed, "personal", new Date(now.getTime() - 8 * DAY));
  await generateDataExport(old.row.id, lease, { producers: registry(scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 1)] }] })), notify: quiet });
  await getDb().update(dataExports).set({ expiresAt: new Date(now.getTime() - DAY) }).where(eq(dataExports.id, old.row.id));
  const oldKey = (await rowOf(old.row.id))!.volumes[0]!.key;
  assert.ok(storage.objects.has(oldKey));

  // Running, with a recorded upload, whose durable task ran out of attempts.
  const gaveUp = await queued(seed);
  const gaveUpUpload = await storage.multipart.createMultipartUpload(dataExportVolumeKey(gaveUp.row.id, 1, "r"), "application/zip");
  await getDb().update(dataExports).set({ status: "running", progress: runningProgress(dataExportVolumeKey(gaveUp.row.id, 1, "r"), gaveUpUpload) }).where(eq(dataExports.id, gaveUp.row.id));
  await getDb().update(durableTasks).set({ state: "needs_attention", claimedBy: null }).where(eq(durableTasks.id, gaveUp.row.durableTaskId!));
  // Running, task open, but nothing written for over a day.
  const silent = await queued(seed);
  const silentUpload = await storage.multipart.createMultipartUpload(dataExportVolumeKey(silent.row.id, 1, "r"), "application/zip");
  await getDb().update(dataExports).set({ status: "running", progress: runningProgress(dataExportVolumeKey(silent.row.id, 1, "r"), silentUpload) }).where(eq(dataExports.id, silent.row.id));
  await getDb().update(dataExports).set({ updatedAt: new Date(now.getTime() - DATA_EXPORT_STUCK_MS - 60_000) }).where(eq(dataExports.id, silent.row.id));
  // Queued for over a day, task open (deferred while busy): only waiting.
  const waiting = await queued(seed);
  await getDb().update(dataExports).set({ updatedAt: new Date(now.getTime() - 2 * DAY) }).where(eq(dataExports.id, waiting.row.id));

  // Running and healthy, with its own upload (owned), and two unrecorded uploads: old and young.
  const healthy = await queued(seed);
  const owned = await storage.multipart.createMultipartUpload(dataExportVolumeKey(healthy.row.id, 1, "r"), "application/zip");
  await getDb().update(dataExports).set({ status: "running", progress: runningProgress(dataExportVolumeKey(healthy.row.id, 1, "r"), owned) }).where(eq(dataExports.id, healthy.row.id));
  const orphan = await storage.multipart.createMultipartUpload("data-exports/v1/gone/1-x.zip", "application/zip");
  const young = await storage.multipart.createMultipartUpload("data-exports/v1/young/1-x.zip", "application/zip");
  const longAgo = new Date(now.getTime() - DATA_EXPORT_ORPHAN_UPLOAD_MS - 60_000);
  storage.uploads.get(orphan)!.initiatedAt = longAgo;
  storage.uploads.get(owned)!.initiatedAt = longAgo;

  const result = await runDataExportMaintenance({ now });
  assert.deepEqual(result, { expired: 1, stuck: 2, objectsRemoved: 1, orphanUploadsAborted: 1 });
  const expired = await rowOf(old.row.id);
  assert.deepEqual([expired!.status, expired!.volumes], ["expired", []]);
  assert.equal(storage.objects.has(oldKey), false);
  for (const job of [gaveUp, silent]) assert.deepEqual([(await rowOf(job.row.id))!.status, (await rowOf(job.row.id))!.errorCode], ["failed", "stuck"]);
  assert.ok(storage.aborted.includes(gaveUpUpload) && storage.aborted.includes(silentUpload));
  assert.equal((await rowOf(waiting.row.id))!.status, "queued");
  assert.ok(storage.aborted.includes(orphan));
  assert.ok(!storage.aborted.includes(owned), "a running job's upload is its own");
  assert.ok(!storage.aborted.includes(young), "a day's grace");
  assert.equal((await rowOf(healthy.row.id))!.status, "running");

  // Idempotent: nothing more to do.
  assert.deepEqual(await runDataExportMaintenance({ now }), { expired: 0, stuck: 0, objectsRemoved: 0, orphanUploadsAborted: 0 });
});

test("account deletion takes every export the person asked for, a running one too: its recorded volume and open upload go, and the run, going on, records nothing and leaves nothing", async ({ seed }) => {
  await setDataExportFlag(true);
  assert.ok(accountDeletionCleanupSteps().some((step) => step.name === "data_exports.requester_user_id"), "the cleanup has the step");
  // An older, finished export of the person (8 days ago: outside the limit) and a running one.
  const finished = await queued(seed, "personal", new Date(Date.now() - 8 * DAY));
  const human = finished.human;
  await generateDataExport(finished.row.id, lease, { producers: registry(scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 1)] }] })), notify: quiet });
  const created = await createDataExport({
    kind: "personal", requesterUserId: human.id, requesterSessionFamilyId: "00000000-0000-4000-8000-000000000001", serverId: null,
    scope: { serverIds: "all", includeContext: false, includeFiles: false }, now: new Date(), taskSpec: dataExportTaskDefinition,
  });
  assert.ok(created.ok);
  const row = created.row;
  let outcome: string | null = null;
  // The deletion runs while the export is mid-way: volume 1 recorded, volume 2's upload open.
  const producer = scriptedProducer({
    kind: "personal",
    batches: [{ ops: [lines("a.jsonl", 2)] }, { ops: [lines("b.jsonl", 2)] }, { ops: [lines("c.jsonl", 2)] }],
    beforeBatch: async (cursor) => {
      if (cursor !== 1) return;
      const midway = await rowOf(row.id);
      assert.equal(midway!.volumes.length, 1);
      assert.ok(midway!.progress!.uploadId);
      outcome = await deleteDataExportsOfDeletedUser(human.id);
    },
  });
  await generateDataExport(row.id, lease, { producers: registry(producer), volumeBytes: 1, notify: quiet });
  assert.equal(outcome, "done");
  assert.deepEqual(await getDb().select().from(dataExports).where(eq(dataExports.requesterUserId, human.id)), []);
  assert.deepEqual([...storage.objects.keys()], [], "every archive object is gone, the run's last volume too");
  assert.equal(storage.uploads.size, 0);
  assert.deepEqual(producer.calls, [0, 1], "the run stopped after the deletion");
});

test("the closed-server purge takes the server's server exports, archives first, before server_rows; its owner's personal export stays and still lists (known leftover)", async ({ seed }) => {
  await setDataExportFlag(true);
  const serverExport = await queued(seed, "server");
  await generateDataExport(serverExport.row.id, lease, { producers: registry(scriptedProducer({ kind: "server", batches: [{ ops: [lines("a.jsonl", 1)] }] })), notify: quiet });
  const serverKey = (await rowOf(serverExport.row.id))!.volumes[0]!.key;
  // The same owner's personal export, of all their servers (this one included).
  const personal = await createDataExport({
    kind: "personal", requesterUserId: serverExport.human.id, requesterSessionFamilyId: "00000000-0000-4000-8000-000000000001", serverId: null,
    scope: { serverIds: [serverExport.server!.id], includeContext: false, includeFiles: false }, now: new Date(), taskSpec: dataExportTaskDefinition,
  });
  assert.ok(personal.ok);
  await generateDataExport(personal.row.id, lease, { producers: registry(scriptedProducer({ kind: "personal", batches: [{ ops: [lines("a.jsonl", 1)] }] })), notify: quiet });
  const personalKey = (await rowOf(personal.row.id))!.volumes[0]!.key;
  await getDb().update(servers).set({ deletedAt: new Date(Date.now() - 31 * DAY) }).where(eq(servers.id, serverExport.server!.id));

  const order = CLOSED_SERVER_PURGE_FINISH_STEPS.map((candidate) => candidate.name);
  assert.ok(order.indexOf("data_exports") < order.indexOf("server_rows"), "before server_rows");
  const step = CLOSED_SERVER_PURGE_FINISH_STEPS.find((candidate) => candidate.name === "data_exports");
  assert.ok(step && "run" in step);
  const counts: Record<string, number> = {};
  assert.equal(await step.run({
    serverId: asServerId(serverExport.server!.id),
    batch: (work) => getDb().transaction((tx) => work(tx)),
    add: (key, n) => { counts[key] = (counts[key] ?? 0) + n; },
    clock: () => new Date(),
    keepChannelIds: [],
  }), "done");
  assert.equal(counts.data_exports_deleted, 1);
  assert.equal(await rowOf(serverExport.row.id), undefined);
  assert.equal(storage.objects.has(serverKey), false);
  const listed = await listDataExports({ requesterUserId: serverExport.human.id, kind: "personal" });
  assert.deepEqual(listed.map((r) => [r.id, r.status]), [[personal.row.id, "ready"]]);
  assert.ok(storage.objects.has(personalKey), "its archive is still there");
});

test("a file op: only an object storage confirms missing is skipped; any other read error, a missing bucket's 404 included, fails the volume and the export stays to retry", async ({ seed }) => {
  await setDataExportFlag(true);
  const { row } = await queued(seed);
  storage.objects.set("attachments/x", Buffer.from("x bytes"));
  const producer = scriptedProducer({ kind: "personal", batches: [{ ops: [{ type: "file", path: "files/x", storageKey: "attachments/x" }] }] });
  const run = () => generateDataExport(row.id, lease, { producers: registry(producer), notify: quiet });

  storage.onGet = async () => { throw new Error("socket hang up"); };
  await assert.rejects(run(), /socket hang up/);
  assert.equal((await rowOf(row.id))!.status, "running", "not ready without its file");

  // The bucket is gone: the read's 404 looks like "not found", and the probe can't confirm the object is.
  const noBucket = Object.assign(new Error("The specified bucket does not exist"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
  storage.onGet = async () => { throw noBucket; };
  storage.probeError = noBucket;
  await assert.rejects(run(), /bucket does not exist/);
  assert.equal((await rowOf(row.id))!.status, "running");

  // Storage back: the next run writes the file.
  storage.onGet = null;
  storage.probeError = null;
  await run();
  const done = await rowOf(row.id);
  assert.equal(done!.status, "ready");
  const zip = object(done!.volumes[0]!.key);
  assert.equal(zipEntry(zip, "files/x").toString(), "x bytes");
  const manifest = JSON.parse(zipEntry(zip, "manifest.json").toString());
  assert.deepEqual([manifest.missingFiles, manifest.counts.files], [[], 1]);
});

test("a volume cut mid-batch resumes after the paths it holds, not a count of ops: the batch read again may have shifted", async ({ seed }) => {
  await setDataExportFlag(true);
  const { row } = await queued(seed);
  const json = (path: string): DataExportOp => ({ type: "json", path, value: { path } });
  let reads = 0;
  // Read again, the batch has a new op in front (a message that became visible, say).
  const producer = {
    ...scriptedProducer({ kind: "personal", batches: [{ ops: [] }] }),
    nextBatch: async () => {
      reads += 1;
      return { ops: reads === 1 ? [json("a.json"), json("b.json"), json("c.json")] : [json("x.json"), json("a.json"), json("b.json"), json("c.json")], next: null };
    },
  };
  // 1-byte volumes: every op fills one.
  await generateDataExport(row.id, lease, { producers: registry(producer), volumeBytes: 1, notify: quiet });
  const done = await rowOf(row.id);
  assert.equal(done!.status, "ready");
  const names = done!.volumes.flatMap((volume) => zipEntryNames(object(volume.key)));
  assert.deepEqual([...names].sort(), ["a.json", "b.json", "c.json", "manifest.json", "x.json"], "each op once, the shifted one too");
});

test("a path named again is a producer bug: the export fails producer_error at once (no retry, nothing stored); only a resumed volume's own paths are skipped, and an open entry's lines may continue across batches", async ({ seed }) => {
  await setDataExportFlag(true);
  const json = (path: string): DataExportOp => ({ type: "json", path, value: { path } });
  const notified: string[] = [];
  const notify = async (r: { id: string }, outcome: string) => { notified.push(`${r.id}:${outcome}`); };
  const cases: Array<Array<Omit<DataExportBatch<number>, "next">>> = [
    // A later batch writes a whole entry again.
    [{ ops: [json("a.json"), lines("c/2026-11.jsonl", 1)] }, { ops: [json("a.json")] }],
    // Lines of an entry, another entry, then that first entry's lines again: it was closed.
    [{ ops: [lines("c/2026-11.jsonl", 1), json("b.json"), lines("c/2026-11.jsonl", 1, 1)] }],
  ];
  for (const batches of cases) {
    const { row } = await queued(seed);
    await generateDataExport(row.id, lease, { producers: registry(scriptedProducer({ kind: "personal", batches })), notify });
    const done = await rowOf(row.id);
    assert.deepEqual([done!.status, done!.errorCode], ["failed", "producer_error"]);
    assert.deepEqual(done!.volumes, []);
    assert.equal(storage.uploads.size, 0, "its upload aborted");
    assert.ok(notified.includes(`${row.id}:failed`));
  }
  // Lines of the entry still open, across batches and volumes: one entry, then its .partN.
  const { row } = await queued(seed);
  const open = scriptedProducer({ kind: "personal", batches: [{ ops: [lines("c/2026-11.jsonl", 2)] }, { ops: [lines("c/2026-11.jsonl", 2, 2)] }] });
  await generateDataExport(row.id, lease, { producers: registry(open), notify: quiet });
  assert.equal((await rowOf(row.id))!.status, "ready");
});
