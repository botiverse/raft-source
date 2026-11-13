// A closed server's Artifacts for core's closed-server purge (purge.ts,
// FirstPartyApp.purgeServer): refused for a server that isn't closed; `count`
// deletes nothing and says what would go; `delete` takes at most `limit`
// Artifacts a batch, their versions, files and comments with them, until
// `remaining` is false; the blobs stay for prune_artifact_blobs, and another
// server's Artifacts are never touched; an Artifact homed in one of the
// channels core keeps (`keepChannelIds`: joint projections, their threads,
// migration receipt channels) stays, in either mode.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { asServerId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { channels, servers } from "../../db/schema";
import { seedServer as seedClosedServerContent } from "../../test/closedServerPurgeFixture";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { r2KeyOf } from "./blobStore";
import { ArtifactPurgeRefusedError, purgeArtifactsOfServer } from "./purge";
import { artifactBlobs, artifactComments, artifactItems, artifactVersionFiles, artifactVersions } from "./schema";

/** A server whose owner made `artifacts` Artifacts, each with two versions of one file and a comment. */
async function seedServer(seed: ReturnType<typeof createSeed>, artifacts: number) {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const ids: string[] = [];
  for (let i = 0; i < artifacts; i++) {
    const id = `pt_${randomUUID()}`;
    ids.push(id);
    await db.insert(artifactItems).values({ id, serverId, urlKey: id, title: `Artifact ${i}`, homeKind: "server", createdByType: "user", createdById: owner.id });
    for (const number of [1, 2]) {
      const text = `${id} v${number}`;
      const sha256 = createHash("sha256").update(text).digest("hex");
      const blobId = `b_${randomUUID()}`;
      await db.insert(artifactBlobs).values({ id: blobId, serverId, sha256, sizeBytes: text.length, r2Key: r2KeyOf(serverId, sha256, blobId) });
      const [version] = await db.insert(artifactVersions).values({
        id: `v_${randomUUID()}`, itemId: id, number, entry: "index.html", spa: false, fileCount: 1, sizeBytes: text.length,
        publishDigest: "digest", status: "published", publisherType: "user", publisherId: owner.id, position: number,
      }).returning();
      await db.insert(artifactVersionFiles).values({ versionId: version!.id, path: "index.html", sha256, sizeBytes: text.length, blobId });
      await db.update(artifactItems).set({ currentVersionId: version!.id, lastPosition: number }).where(eq(artifactItems.id, id));
      if (number === 2) {
        await db.insert(artifactComments).values({ id: `c_${randomUUID()}`, itemId: id, versionId: version!.id, authorType: "user", authorId: owner.id, body: "looks good", position: 3 });
      }
    }
  }
  return { serverId, ids };
}

const close = (serverId: ServerId) => getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, serverId));
const batch = (serverId: ServerId, mode: "count" | "delete", limit = 2) =>
  getDb().transaction((executor) => purgeArtifactsOfServer(serverId, { executor, limit, mode }));

test("a server that isn't closed is refused, in either mode, and nothing goes", async ({ seed }) => {
  const live = await seedServer(seed, 1);
  for (const mode of ["count", "delete"] as const) {
    await assert.rejects(batch(live.serverId, mode), ArtifactPurgeRefusedError, mode);
  }
  await assert.rejects(batch(asServerId(randomUUID()), "delete"), ArtifactPurgeRefusedError, "a server that doesn't exist");
  assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.serverId, live.serverId))).length, 1);
});

test("count says what would go and deletes nothing", async ({ seed }) => {
  const closed = await seedServer(seed, 3);
  await close(closed.serverId);
  const answer = await batch(closed.serverId, "count");
  assert.equal(answer.remaining, true);
  assert.equal(answer.counts.artifacts, 3);
  assert.equal(answer.counts.versions, 6);
  assert.equal(answer.counts.comments, 3);
  assert.equal(answer.counts.blobs, 6);
  assert.ok(answer.counts.blobBytes! > 0);
  assert.equal((await getDb().select().from(artifactItems).where(eq(artifactItems.serverId, closed.serverId))).length, 3, "nothing deleted");
});

test("delete takes at most limit a batch, their parts with them, until nothing remains; blobs and other servers stay", async ({ seed }) => {
  const db = getDb();
  const closed = await seedServer(seed, 3);
  const other = await seedServer(seed, 1);
  await close(closed.serverId);

  const first = await batch(closed.serverId, "delete", 2);
  assert.deepEqual(first, { remaining: true, counts: { artifacts: 2 } });
  const second = await batch(closed.serverId, "delete", 2);
  assert.deepEqual(second, { remaining: false, counts: { artifacts: 1 } });
  assert.deepEqual(await batch(closed.serverId, "delete", 2), { remaining: false, counts: { artifacts: 0 } }, "a rerun is a no-op");

  assert.equal((await db.select().from(artifactItems).where(eq(artifactItems.serverId, closed.serverId))).length, 0);
  assert.equal((await db.select().from(artifactVersions).where(inArray(artifactVersions.itemId, closed.ids))).length, 0, "versions cascade");
  assert.equal((await db.select().from(artifactComments).where(inArray(artifactComments.itemId, closed.ids))).length, 0, "comments cascade");
  assert.equal((await db.select().from(artifactBlobs).where(eq(artifactBlobs.serverId, closed.serverId))).length, 6, "blobs stay for prune_artifact_blobs");
  assert.equal((await db.select().from(artifactItems).where(eq(artifactItems.serverId, other.serverId))).length, 1, "another server's Artifact untouched");
});

test("an Artifact homed in a kept channel (joint projection, its thread, receipt channel) stays, in either mode; the rest go", async ({ seed }) => {
  const db = getDb();
  // Core's closed-server fixture: a normal channel, a joint projection with a thread under it, a receipt channel.
  const content = await seedClosedServerContent(seed);
  const serverId = content.serverId;
  const [normal] = await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, serverId), notInArray(channels.id, [...content.skipped.joint, ...content.skipped.receipt])))
    .limit(1);
  const artifact = async (homeKind: "conversation" | "server", homeChannelId: string | null) => {
    const id = `pt_${randomUUID()}`;
    await db.insert(artifactItems).values({ id, serverId, urlKey: id, title: "a", homeKind, homeChannelId, createdByType: "user", createdById: content.owner.id });
    return id;
  };
  const [jointProjection, jointThread] = content.skipped.joint;
  const kept = [await artifact("conversation", jointProjection!), await artifact("conversation", jointThread!), await artifact("conversation", content.skipped.receipt[0]!)];
  // A conversation home whose channel is gone (home_channel_id set null) is not kept.
  const purged = [await artifact("conversation", normal!.id), await artifact("server", null), await artifact("conversation", null)];
  await close(serverId);
  const keepChannelIds = [...content.skipped.joint, ...content.skipped.receipt];
  const run = (mode: "count" | "delete") => getDb().transaction((executor) => purgeArtifactsOfServer(serverId, { executor, limit: 10, mode, keepChannelIds }));

  const counted = await run("count");
  assert.equal(counted.counts.artifacts, purged.length, "count leaves the kept ones out");
  const deleted = await run("delete");
  assert.deepEqual(deleted, { remaining: false, counts: { artifacts: purged.length } }, "nothing remaining: the kept ones aren't waited for");
  const left = (await db.select({ id: artifactItems.id }).from(artifactItems).where(eq(artifactItems.serverId, serverId))).map((row) => row.id).sort();
  assert.deepEqual(left, [...kept].sort());
});
