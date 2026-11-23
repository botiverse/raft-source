// A closed server's Artifacts for core's closed-server purge (purge.ts,
// FirstPartyApp.purgeServer): refused for a server that isn't closed; `count`
// deletes nothing and says what would go; `delete` takes at most `limit`
// Artifacts a batch, their versions, files and comments with them, until
// `remaining` is false; the blobs stay for prune_artifact_blobs, and another
// server's Artifacts are never touched; an Artifact homed in one of the
// channels core keeps (`keepChannelIds`: joint projections, their threads,
// migration receipt channels, the storage channels of the joints the server is still in)
// stays, in either mode; core's purge run tells it so (the last test).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { asServerId, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, type ServerId } from "@botiverse/raft-shared";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { getDb } from "../../db/index";
import { channels, jointChannels, jointChannelServers, servers, tasks, userChannelDisplayPrefs } from "../../db/schema";
import { close as closeAt, daysAgo, deleteFor, insertMessage, run, seedServer as seedClosedServerContent } from "../../test/closedServerPurgeFixture";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { r2KeyOf } from "./blobStore";
import { closedServerJointObjects } from "../../platform/visibility";
import { itemsReadable } from "./apiCommon";
import { ArtifactPurgeRefusedError, purgeArtifactsOfServer } from "./purge";
import { artifactsApp } from "./register";
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
    await addParts(serverId, id, owner.id);
  }
  return { serverId, ids };
}

/** Two versions of one file (a blob each) and a comment on the second, for an Artifact of `serverId`. */
async function addParts(serverId: ServerId, id: string, ownerId: string) {
  const db = getDb();
  for (const number of [1, 2]) {
    const text = `${id} v${number}`;
    const sha256 = createHash("sha256").update(text).digest("hex");
    const blobId = `b_${randomUUID()}`;
    await db.insert(artifactBlobs).values({ id: blobId, serverId, sha256, sizeBytes: text.length, r2Key: r2KeyOf(serverId, sha256, blobId) });
    const [version] = await db.insert(artifactVersions).values({
      id: `v_${randomUUID()}`, itemId: id, number, entry: "index.html", spa: false, fileCount: 1, sizeBytes: text.length,
      publishDigest: "digest", status: "published", publisherType: "user", publisherId: ownerId, position: number,
    }).returning();
    await db.insert(artifactVersionFiles).values({ versionId: version!.id, path: "index.html", sha256, sizeBytes: text.length, blobId });
    await db.update(artifactItems).set({ currentVersionId: version!.id, lastPosition: number }).where(eq(artifactItems.id, id));
    if (number === 2) {
      await db.insert(artifactComments).values({ id: `c_${randomUUID()}`, itemId: id, versionId: version!.id, authorType: "user", authorId: ownerId, body: "looks good", position: 3 });
    }
  }
}

afterEach(() => __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, undefined));

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

test("the purge itself keeps the server's Artifacts in the storage channels of the joints it is still in, as it keeps its messages there; one in a joint it left, or moved to the server or public, goes; the finish still clears its rows naming a storage channel", async ({ seed }) => {
  const db = getDb();
  const content = await seedClosedServerContent(seed);
  const { serverId, owner } = content;
  const storageServerId = content.storage.id;
  const storageChannel = async () =>
    (await db.insert(channels).values({ serverId: storageServerId, name: `joint-storage-${randomUUID()}`, type: "channel" }).returning())[0]!.id;
  const projection = async (serverOf: string) =>
    (await db.insert(channels).values({ serverId: serverOf, name: `joint-${randomUUID().slice(0, 8)}`, type: "joint" }).returning())[0]!.id;
  // The fixture's joint (an active projection); under its storage channel a thread with no joint record of its own,
  // a joint thread and a joint task conversation (each its own record and the server's projection of it); and three
  // more joints: one the server has disconnected from (purged), one it created (its host projection), one it was never in.
  const joined = content.jointStorage.channelId;
  const localJoint = content.skipped.joint[0]!;
  // A thread's storage channel hangs off a storage message (parent_channel_id follows it: trigger).
  const storageThreadOf = async () => (await db.insert(channels).values({
    serverId: storageServerId, name: `thread-${randomUUID().slice(0, 8)}`, type: "thread", parentMessageId: (await insertMessage(joined, owner.id)).id,
  }).returning())[0]!.id;
  const storageThread = await storageThreadOf();
  const jointThread = await storageThreadOf();
  const [threadJoint] = await db.insert(jointChannels).values({ canonicalChannelId: jointThread, createdByServerId: serverId }).returning();
  const [localThread] = await db.insert(channels).values({ serverId, name: `thread-${randomUUID().slice(0, 8)}`, type: "thread", parentMessageId: (await insertMessage(localJoint, owner.id)).id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: threadJoint!.id, serverId, localChannelId: localThread!.id });
  const [task] = await db.insert(tasks).values({ channelId: joined, taskNumber: 1, title: "joint task", createdByType: "user", createdById: owner.id }).returning();
  const [taskConversation] = await db.insert(channels).values({ serverId: storageServerId, name: `task-${randomUUID().slice(0, 8)}`, type: "task", taskId: task!.id, parentChannelId: joined }).returning();
  const [taskJoint] = await db.insert(jointChannels).values({ canonicalChannelId: taskConversation!.id, createdByServerId: serverId }).returning();
  const [localTask] = await db.insert(channels).values({ serverId, name: `task-${randomUUID().slice(0, 8)}`, type: "task", taskId: task!.id, parentChannelId: localJoint }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: taskJoint!.id, serverId, localChannelId: localTask!.id });
  const left = await storageChannel();
  const [leftJoint] = await db.insert(jointChannels).values({ canonicalChannelId: left, createdByServerId: storageServerId }).returning();
  const leftProjection = await projection(serverId);
  await db.insert(jointChannelServers).values({ jointChannelId: leftJoint!.id, serverId, localChannelId: leftProjection, status: "disconnected", disconnectedAt: new Date() });
  // Under the joint it left: a thread, and a task conversation whose own projection a disconnect leaves active.
  const leftThread = (await db.insert(channels).values({
    serverId: storageServerId, name: `thread-${randomUUID().slice(0, 8)}`, type: "thread", parentMessageId: (await insertMessage(left, owner.id)).id,
  }).returning())[0]!.id;
  const [leftTask] = await db.insert(tasks).values({ channelId: left, taskNumber: 1, title: "left task", createdByType: "user", createdById: owner.id }).returning();
  const [leftTaskConversation] = await db.insert(channels).values({ serverId: storageServerId, name: `task-${randomUUID().slice(0, 8)}`, type: "task", taskId: leftTask!.id, parentChannelId: left }).returning();
  const [leftTaskJoint] = await db.insert(jointChannels).values({ canonicalChannelId: leftTaskConversation!.id, createdByServerId: serverId }).returning();
  const [leftLocalTask] = await db.insert(channels).values({ serverId, name: `task-${randomUUID().slice(0, 8)}`, type: "task", taskId: leftTask!.id, parentChannelId: leftProjection }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: leftTaskJoint!.id, serverId, localChannelId: leftLocalTask!.id });
  const created = await storageChannel();
  const [createdJoint] = await db.insert(jointChannels).values({ canonicalChannelId: created, createdByServerId: serverId }).returning();
  const createdProjection = await projection(serverId);
  await db.insert(jointChannelServers).values({ jointChannelId: createdJoint!.id, serverId, localChannelId: createdProjection, role: "host" });
  const other = await seed.server({ owner });
  const notIn = await storageChannel();
  const [otherJoint] = await db.insert(jointChannels).values({ canonicalChannelId: notIn, createdByServerId: other.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: otherJoint!.id, serverId: other.id, localChannelId: await projection(other.id) });

  const [normal] = await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, serverId), notInArray(channels.id, [...content.skipped.joint, ...content.skipped.receipt])))
    .limit(1);
  const artifact = async (homeKind: "conversation" | "server" | "public", homeChannelId: string | null) => {
    const id = `pt_${randomUUID()}`;
    await db.insert(artifactItems).values({ id, serverId, urlKey: id, title: "a", homeKind, homeChannelId, createdByType: "user", createdById: owner.id });
    await addParts(serverId, id, owner.id);
    return id;
  };
  const kept = {
    storage: await artifact("conversation", joined),
    storageThread: await artifact("conversation", storageThread),
    jointThread: await artifact("conversation", jointThread),
    taskConversation: await artifact("conversation", taskConversation!.id),
    created: await artifact("conversation", created),
    projection: await artifact("conversation", localJoint),
    // The server's own copies of a joint it is still in, and of that joint's thread and task conversation.
    createdCopy: await artifact("conversation", createdProjection),
    projectionThread: await artifact("conversation", localThread!.id),
    projectionTask: await artifact("conversation", localTask!.id),
  };
  const purged = {
    // Homed in the joint's storage channel once, moved since: the server's own, so it goes with the server.
    movedToServer: await artifact("server", null),
    movedToPublic: await artifact("public", null),
    ownChannel: await artifact("conversation", normal!.id),
    jointNeverIn: await artifact("conversation", notIn),
    // A joint the server has left (Tenny, 2026-11: kept only while the server is still in), and what is under it.
    disconnected: await artifact("conversation", left),
    disconnectedThread: await artifact("conversation", leftThread),
    disconnectedTaskConversation: await artifact("conversation", leftTaskConversation!.id),
    // On the server's own copy of the joint it left (a home may name a copy: published before homes named the
    // storage channel, or in a channel converted since), and on its copy of that joint's task conversation.
    disconnectedCopy: await artifact("conversation", leftProjection),
    disconnectedCopyTask: await artifact("conversation", leftLocalTask!.id),
  };
  // Finish-step rows (user_channel_display_prefs, channels: channel_id): one naming the projection stays (as before), one naming the storage channel goes.
  await db.insert(userChannelDisplayPrefs).values([
    { userId: owner.id, serverId, channelId: content.skipped.joint[0]! },
    { userId: owner.id, serverId, channelId: joined },
  ]);

  // What is read of a closed server (platform/visibility closedServerJointObjects, apiCommon itemsReadable) is
  // exactly what the purge keeps: one rule (services/closedServerKeptChannels.ts keptChannelsOf), pinned here
  // on the same Artifacts, before the purge runs.
  const rowsOf = async (ids: readonly string[]) => {
    const rows = await db.select().from(artifactItems).where(inArray(artifactItems.id, [...ids]));
    return ids.map((id) => rows.find((row) => row.id === id)!);
  };
  const [keptRows, purgedRows] = [await rowsOf(Object.values(kept)), await rowsOf(Object.values(purged))];
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const answers = async (rows: Awaited<ReturnType<typeof rowsOf>>) => {
    const [kept, readable] = await Promise.all([closedServerJointObjects(rows), itemsReadable(rows)]);
    return { kept, readable };
  };
  const every = (rows: readonly unknown[], kept: boolean, readable: boolean) => ({ kept: rows.map(() => kept), readable: rows.map(() => readable) });
  // Live: none is a closed server's kept one; every one is read as its live server's.
  assert.deepEqual(await answers([...keptRows, ...purgedRows]), every([...keptRows, ...purgedRows], false, true), "live");
  await closeAt(serverId, daysAgo(40));
  assert.deepEqual(await answers(keptRows), every(keptRows, true, true), `kept by the purge: read (read-only) ${Object.keys(kept)}`);
  assert.deepEqual(await answers(purgedRows), every(purgedRows, false, false), `purged: read by no one ${Object.keys(purged)}`);
  await deleteFor(serverId);
  const result = await run({ apps: [artifactsApp] });
  assert.equal(result.purged.find((entry) => entry.serverId === serverId)?.outcome, "done");

  const keptIds = Object.values(kept);
  const remaining = (await db.select({ id: artifactItems.id }).from(artifactItems).where(eq(artifactItems.serverId, serverId))).map((row) => row.id).sort();
  assert.deepEqual(remaining, [...keptIds].sort(), "the joint-homed ones stay, the rest go");
  assert.equal((await db.select().from(artifactVersions).where(inArray(artifactVersions.itemId, keptIds))).length, 2 * keptIds.length, "a kept one's versions stay");
  assert.equal((await db.select().from(artifactComments).where(inArray(artifactComments.itemId, keptIds))).length, keptIds.length, "a kept one's comments stay");
  assert.equal((await db.select().from(artifactVersions).where(inArray(artifactVersions.itemId, Object.values(purged)))).length, 0);
  const prefs = (await db.select({ channelId: userChannelDisplayPrefs.channelId }).from(userChannelDisplayPrefs).where(eq(userChannelDisplayPrefs.serverId, serverId))).map((row) => row.channelId);
  assert.deepEqual(prefs, [content.skipped.joint[0]!], "the finish keeps the projection's row, and deletes the storage channel's as before");
});
