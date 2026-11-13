// Publishing's locks on a real multi-connection PostgreSQL (PGlite serializes
// transactions, so publish.api.test.ts can't see them):
// - two publishes on one base wait on the item row (FOR UPDATE) and the
//   second re-checks against the first: different files both land, the same
//   file is BASE_MOVED (without the lock, both write version 2 and one fails);
// - uploads near the per-server cap check it under the server's quota lock;
// - concurrent stores of the same new bytes count them once against the
//   monthly file upload quota, and a store of bytes a stopped store left
//   pending, racing the sweep that releases that store's reservation, still
//   ends with them counted once and nothing left reserved;
// - the unreferenced-blob sweep skips a blob a publish is committing with;
// - the notice flush skips a batch another flush holds (SKIP LOCKED) instead
//   of waiting on it, and takes it once it is free.
//
// Runs when ARTIFACT_PUBLISH_REAL_PG_URL is set (an admin URL; a database is
// created and dropped), and fails without it when
// ARTIFACT_PUBLISH_REAL_PG_REQUIRED=1 (CI).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES, asServerId } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../../db/index";
import * as schema from "../../db/schema";
import { agents, channels, serverFileUploadUsageMonths, servers, users } from "../../db/schema";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { billingUsageMonth } from "../../services/fileUploadQuotaService";
import { pruneUnreferencedArtifactBlobs, storeBlob, UNREFERENCED_BLOB_TTL_MS } from "./blobs";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { flushDueArtifactNotices } from "./notices";
import { fillVersionExcerpt } from "./excerpt";
import { deleteArtifact } from "./manage";
import { createArtifactAgentApi, type ArtifactAgent } from "./routes";
import { artifactBlobs, artifactComments, artifactItems, artifactPendingNotices, artifactSubscriptions, artifactVersionFiles, artifactVersions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const REAL_PG_URL_ENV = "ARTIFACT_PUBLISH_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.ARTIFACT_PUBLISH_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign() { return null; },
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
  };
}

/** Until `count` backends wait on a lock (pg_locks), bounded so a bug fails rather than hangs. */
async function waitForLockWaiters(count: number) {
  for (let tries = 0; tries < 200; tries += 1) {
    const result = await getDb().execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
    if (Number((result.rows[0] as { n: number }).n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} lock waiters`);
}

test(
  "real PostgreSQL: concurrent publishes wait on the item row; quota, sweep and notice flush hold their locks",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_artifact_publish_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "artifact-publish-admin" });
    let setupPool: pg.Pool | undefined;
    let initialized = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(REAL_PG_URL);
      url.pathname = `/${databaseName}`;
      setupPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await initDatabase(url.toString());
      initialized = true;
      const db = getDb();
      const r2 = new Map<string, Buffer>();
      __setArtifactR2StoreForTests(memoryR2(r2));

      const [owner] = await db.insert(users).values({ email: `ap-${randomUUID()}@slock.test`, name: `ap-${randomUUID().slice(0, 8)}`, passwordHash: "test" }).returning();
      const [server] = await db.insert(servers).values({ name: "Artifact publish", slug: `ap-${randomBytes(4).toString("hex")}`, ownerId: owner!.id }).returning();
      const serverId = asServerId(server!.id);
      // A public channel: the platform resolves `#artifacts` for any agent of the server.
      await db.insert(channels).values({ serverId, name: "artifacts" });
      const [agentA, agentB] = await db.insert(agents).values([{ serverId, name: "ap-a" }, { serverId, name: "ap-b" }]).returning();
      __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
      const a: ArtifactAgent = { agentId: agentA!.id, serverId };
      const b: ArtifactAgent = { agentId: agentB!.id, serverId };
      const api = createArtifactAgentApi();
      // Notices are counted, not sent.
      const queuedFor: string[] = [];
      const outbox = {
        queue: async (_executor: unknown, input: { agentId: string }) => {
          queuedFor.push(input.agentId);
          return { eventId: randomUUID(), created: true };
        },
        push: async () => {},
        withdraw: async () => {},
        withdrawUnread: async () => ({ withdrawn: 0, pushEventId: null }),
      };
      const text = (path: string, content: string) => ({ path, content });
      const created = await api.publish(a, { target: "#artifacts", title: "Site", files: [text("index.html", "home"), text("a.html", "a1"), text("b.html", "b1")] }, outbox);
      assert.equal(created.kind, "json");
      const id = (created as { body: { artifact: { id: string } } }).body.artifact.id;

      /** Two publishes started while another transaction holds the item row; released once both wait. */
      const race = async (bodies: [Parameters<typeof api.publish>[1], Parameters<typeof api.publish>[1]]) => {
        const locked = deferred();
        const release = deferred();
        const blocker = db.transaction(async (tx) => {
          await tx.select({ id: artifactItems.id }).from(artifactItems).where(eq(artifactItems.id, id)).for("update");
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const racers = [api.publish(a, bodies[0], outbox), api.publish(b, bodies[1], outbox)].map((p) => p.then(
          (result) => (result.kind === "json" ? { status: result.status ?? 200, code: null } : { status: result.status, code: result.body.code }),
          (error: unknown) => ({ status: 500, code: error instanceof Error ? error.message.slice(0, 120) : String(error) }),
        ));
        await waitForLockWaiters(2);
        release.resolve();
        await blocker;
        return Promise.all(racers);
      };

      // Different files on one base: both land, the second on top of the first.
      const apart = await race([
        { artifact: id, base: 1, files: [text("a.html", "a2")] },
        { artifact: id, base: 1, files: [text("b.html", "b2")] },
      ]);
      assert.deepEqual(apart.map((r) => r.status), [201, 201], JSON.stringify(apart));
      const versions = await db.select().from(artifactVersions).where(eq(artifactVersions.itemId, id));
      const v3 = versions.find((v) => v.number === 3)!;
      const files = await db.select().from(artifactVersionFiles).where(eq(artifactVersionFiles.versionId, v3.id));
      assert.deepEqual(Object.fromEntries(files.map((f) => [f.path, f.sha256])), { "index.html": sha("home"), "a.html": sha("a2"), "b.html": sha("b2") });

      // The same file on one base: one lands, the other is told the base moved.
      const clash = await race([
        { artifact: id, base: 3, files: [text("a.html", "A")] },
        { artifact: id, base: 3, files: [text("a.html", "B")] },
      ]);
      assert.deepEqual(clash.map((r) => r.code ?? r.status).sort(), [201, "BASE_MOVED"], JSON.stringify(clash));
      const [item] = await db.select().from(artifactItems).where(eq(artifactItems.id, id));
      assert.equal(item!.lastPosition, 4);

      // Two uploads when only one fits under the cap: the quota lock serializes them.
      const used = AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES - 15;
      await db.insert(artifactBlobs).values({ id: `b_${randomUUID()}`, serverId, sha256: sha("filler"), sizeBytes: used, r2Key: "filler" });
      const quotaHeld = deferred();
      const quotaRelease = deferred();
      const quotaBlocker = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`artifact-upload-quota:${serverId}`}))`);
        quotaHeld.resolve();
        await quotaRelease.promise;
      });
      await quotaHeld.promise;
      const store = memoryR2(r2);
      const uploads = [Buffer.from("ten bytes!"), Buffer.from("ten more!!")].map((bytes) => storeBlob(store, serverId, sha(bytes), bytes));
      await waitForLockWaiters(2);
      quotaRelease.resolve();
      await quotaBlocker;
      assert.deepEqual((await Promise.all(uploads)).map((outcome) => outcome.kind).sort(), ["quota_exceeded", "stored"]);
      await db.delete(artifactBlobs).where(eq(artifactBlobs.sha256, sha("filler")));

      // The monthly file upload quota (a Free server): concurrent stores of the same new bytes count them once.
      const usage = async () => {
        const [row] = await db.select().from(serverFileUploadUsageMonths)
          .where(and(eq(serverFileUploadUsageMonths.serverId, serverId), eq(serverFileUploadUsageMonths.month, billingUsageMonth())));
        return { usedBytes: row?.usedBytes ?? 0, reservedBytes: row?.reservedBytes ?? 0 };
      };
      const before = await usage();
      const same = Buffer.from("the same bytes, five stores");
      const sameStores = await Promise.all(Array.from({ length: 5 }, () => storeBlob(store, serverId, sha(same), same)));
      assert.deepEqual(sameStores.map((outcome) => outcome.kind), Array(5).fill("stored"));
      assert.deepEqual(await usage(), { usedBytes: before.usedBytes + same.length, reservedBytes: before.reservedBytes });
      // A store stopped after reserving (its PUT never returns, as a crash
      // leaves it), then the sweep and a store of the same bytes at once:
      // whichever order they take, the bytes count once and nothing stays reserved.
      const stranded = Buffer.from("a stopped store's bytes");
      let putStarted!: () => void;
      const started = new Promise<void>((resolve) => { putStarted = resolve; });
      void storeBlob({ ...store, put: () => { putStarted(); return new Promise<void>(() => {}); } }, serverId, sha(stranded), stranded);
      await started;
      assert.deepEqual(await usage(), { usedBytes: before.usedBytes + same.length, reservedBytes: before.reservedBytes + stranded.length });
      const [sweptOrStored] = await Promise.all([
        storeBlob(store, serverId, sha(stranded), stranded),
        pruneUnreferencedArtifactBlobs({ store, now: new Date(Date.now() + UNREFERENCED_BLOB_TTL_MS + 60_000) }),
      ]);
      assert.equal(sweptOrStored.kind, "stored");
      assert.deepEqual(await usage(), { usedBytes: before.usedBytes + same.length + stranded.length, reservedBytes: before.reservedBytes });
      const strandedRows = await db.select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, serverId), eq(artifactBlobs.sha256, sha(stranded))));
      assert.deepEqual(strandedRows.map((row) => [row.state, row.quotaMonth, row.quotaReservedBytes]), [["ready", null, null]]);

      // The sweep skips a blob a publish holds (FOR KEY SHARE) while committing.
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const bytes = Buffer.from("about to be used");
      await storeBlob(store, serverId, sha(bytes), bytes);
      await db.update(artifactBlobs).set({ createdAt: old }).where(and(eq(artifactBlobs.serverId, serverId), eq(artifactBlobs.sha256, sha(bytes))));
      const shareHeld = deferred();
      const shareRelease = deferred();
      const publishing = db.transaction(async (tx) => {
        await tx.select({ id: artifactBlobs.id }).from(artifactBlobs).where(eq(artifactBlobs.sha256, sha(bytes))).for("key share");
        shareHeld.resolve();
        await shareRelease.promise;
      });
      await shareHeld.promise;
      await pruneUnreferencedArtifactBlobs({ store });
      shareRelease.resolve();
      await publishing;
      assert.equal((await db.select().from(artifactBlobs).where(eq(artifactBlobs.sha256, sha(bytes)))).length, 1, "a blob being referenced is not swept");

      // The flush skips a batch another transaction holds, rather than waiting on it.
      await db.update(artifactItems).set({ homeKind: "server", homeChannelId: null }).where(eq(artifactItems.id, id));
      const [agentC] = await db.insert(agents).values({ serverId, name: "ap-c" }).returning();
      const [current] = await db.select().from(artifactItems).where(eq(artifactItems.id, id));
      const [note] = await db.insert(artifactComments).values({
        id: `c_${randomUUID()}`, itemId: id, versionId: current!.currentVersionId!, authorType: "agent", authorId: agentC!.id, body: "hi", position: current!.lastPosition + 1,
      }).returning();
      await db.update(artifactItems).set({ lastPosition: note!.position }).where(eq(artifactItems.id, id));
      queuedFor.length = 0;
      const due = new Date(Date.now() - 1000);
      for (const agent of [a, b]) {
        await db.insert(artifactSubscriptions).values({ itemId: id, actorType: "agent", actorId: agent.agentId, reason: "followed" }).onConflictDoNothing();
        await db.insert(artifactPendingNotices).values({ itemId: id, agentId: agent.agentId, commentIds: [note!.id], dueAt: due });
      }
      const flushHeld = deferred();
      const flushRelease = deferred();
      const holder = db.transaction(async (tx) => {
        await tx.select().from(artifactPendingNotices).where(eq(artifactPendingNotices.agentId, a.agentId)).for("update");
        flushHeld.resolve();
        await flushRelease.promise;
      });
      await flushHeld.promise;
      const flushing = flushDueArtifactNotices(outbox);
      const first = await Promise.race([flushing, new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 10_000))]);
      const queuedWhileHeld = [...queuedFor];
      // Released before asserting, so a flush that waited finishes instead of hanging the cleanup.
      flushRelease.resolve();
      await holder;
      await flushing;
      assert.equal(first, 1, "the flush took the free batch without waiting on the held one");
      assert.deepEqual(queuedWhileHeld, [b.agentId]);
      assert.equal(await flushDueArtifactNotices(outbox), 1);
      assert.deepEqual(queuedFor, [b.agentId, a.agentId]);
      assert.equal((await db.select().from(artifactPendingNotices).where(eq(artifactPendingNotices.itemId, id))).length, 0);

      // A fill racing an uncommitted delete must wait on the same item row,
      // then see the deletion. A snapshot-only live check still sees the old
      // parent and can restore text the uncommitted delete already cleared.
      await db.insert(schema.serverMembers).values({ serverId, userId: owner!.id, role: "owner" });
      const markdown = await api.publish(a, { target: "#artifacts", title: "Notes", files: [text("index.md", "Private synthetic notes.")] }, outbox);
      assert.equal(markdown.kind, "json");
      const markdownId = (markdown as { body: { artifact: { id: string } } }).body.artifact.id;
      const [markdownItem] = await db.select().from(artifactItems).where(eq(artifactItems.id, markdownId));
      const [markdownVersion] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, markdownItem!.currentVersionId!));
      assert.equal(markdownVersion!.excerpt, "Private synthetic notes.", "a live version is filled normally");
      // The pending fill has not stored its result yet.
      await db.update(artifactVersions).set({ excerpt: null, excerptBlocks: null }).where(eq(artifactVersions.id, markdownVersion!.id));
      const outside = AsyncResource.bind((run: () => Promise<void>) => run());
      const deletedButUncommitted = deferred();
      const commitDelete = deferred();
      const deleting = db.transaction(async () => {
        assert.equal((await deleteArtifact({ type: "user", id: owner!.id, serverId }, markdownId)).kind, "deleted");
        deletedButUncommitted.resolve();
        await commitDelete.promise;
      });
      let filling: Promise<void> | undefined;
      let waited = true;
      try {
        await deletedButUncommitted.promise;
        filling = outside(() => fillVersionExcerpt(markdownItem!, markdownVersion!, { entry: Buffer.from("Private synthetic notes.") }));
        try {
          await waitForLockWaiters(1);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "fewer than 1 lock waiters") throw error;
          waited = false;
        }
      } finally {
        commitDelete.resolve();
        await deleting;
        await filling;
      }
      const [afterDelete] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, markdownVersion!.id));
      assert.equal(afterDelete!.excerpt, null, "a fill must not restore text after a concurrent delete commits");
      assert.ok(waited, "the fill actually waited on the deleting transaction");

    } finally {
      __setArtifactR2StoreForTests(undefined);
      if (initialized) await closeDatabase();
      if (setupPool) await setupPool.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await admin.end();
      }
    }
  },
);
