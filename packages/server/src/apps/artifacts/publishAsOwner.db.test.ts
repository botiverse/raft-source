// Publishing through a personal assistant AS ITS OWNER (publishAs.ts
// publishArtifactAs with a person author, #proj-assistant:#31 step 3), called
// as its caller calls it: the function, no HTTP. Proves what its header
// promises for a person author: the Artifact and its versions are the
// person's and carry the assistant's mark; a new Artifact goes only into a
// top-level conversation the person may post in (channels included, whether
// the assistant is in it or not); a new version only to an Artifact with
// that mark that the person may rename; the unseen-comments hold is the
// assistant's (its read position, the owner's comments too), and neither the
// owner's read position nor their Activity moves; the assistant isn't told of
// its own push; a repeated create replays only an Artifact with that mark.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { asServerId, CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { channels, featureFlagRules, objectEventRecipients, objectEvents, objectInboxStates, serverMembers, thirdPartyAgentEvents } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { addAgent, addHuman, createChannel, findOrCreateDM, getOrCreateThreadForChannel } from "../../services/channelService";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { appNoticeOutbox } from "../../services/firstPartyAppHost";
import { addMember } from "../../services/serverService";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { advanceReadPosition, notVisible, readPositionOf, TARGET_NOT_FOUND_ERROR } from "./apiCommon";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { createPublishOperations } from "./publish";
import { publishArtifactAs, type ArtifactPublishAsInput, type ArtifactPublishAsResult, type ArtifactPublishedAs } from "./publishAs";
import { artifactsApp } from "./register";
import { artifactComments, artifactItems, artifactSubscriptions, artifactVersions } from "./schema";
import { createWebCommentOperations } from "./webComments";

afterEach(() => {
  __setArtifactR2StoreForTests(undefined);
});

const label = () => randomUUID().slice(0, 8);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign() { return null; },
  };
}

/**
 * One server with Artifacts on: its owner (the assistant's owner), another
 * member, the assistant and another agent (ordinary agents here: whose
 * assistant an agent is, is the caller's knowledge), a private channel with
 * the owner, the member and both agents (`shared`), and a private channel
 * with the owner alone (`closed`: the assistant isn't in it).
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const serverId = asServerId(server.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  __setArtifactR2StoreForTests(memoryR2(new Map()));
  const assistant = await createAgent(server.id, `pa-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const other = await createAgent(server.id, `pa-b-${label()}`, { runtime: "claude", model: "sonnet" });
  const shared = await createChannel(server.id, `po-shared-${label()}`, undefined, "private");
  for (const human of [owner, member]) await addHuman(shared.id, human.id);
  for (const agent of [assistant, other]) await addAgent(shared.id, agent.id);
  const closed = await createChannel(server.id, `po-closed-${label()}`, undefined, "private");
  await addHuman(closed.id, owner.id);
  const outbox = appNoticeOutbox(artifactsApp, undefined);
  /** As the owner, through `via` (the assistant by default). */
  const asOwner = (rest: Pick<ArtifactPublishAsInput, "home" | "request" | "requireHome">, via: { id: string } = assistant, person: { id: string } = owner): ArtifactPublishAsInput => ({
    serverId,
    author: { type: "user", id: person.id },
    publishedByAssistantAgentId: via.id,
    outbox,
    ...rest,
  });
  /** As the assistant itself (step 2's author). */
  const asItself = (rest: Pick<ArtifactPublishAsInput, "home" | "request">, agent: { id: string } = assistant): ArtifactPublishAsInput => ({
    serverId,
    author: { type: "agent", id: agent.id },
    publishedByAssistantAgentId: agent.id,
    outbox,
    ...rest,
  });
  return { owner, member, server, serverId, assistant, other, shared, closed, outbox, asOwner, asItself };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

const page = (text: string) => [{ path: "index.md", content: text }];

async function published(input: ArtifactPublishAsInput): Promise<{ status: number | undefined; body: ArtifactPublishedAs }> {
  const result = await publishArtifactAs(input);
  assert.equal(result.kind, "json", JSON.stringify(result));
  if (result.kind !== "json") throw new Error("unreachable");
  return { status: result.status, body: result.body };
}

const refusal = (result: ArtifactPublishAsResult) => (result.kind === "error" ? [result.status, result.body.code] : ["json", JSON.stringify(result.body)]);

const itemRow = async (id: string) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!;
const versionRows = async (id: string) => (await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id))).sort((a, b) => a.number - b.number);
const itemCount = async (world: World) => (await getDb().select({ id: artifactItems.id }).from(artifactItems).where(eq(artifactItems.serverId, world.serverId))).length;
/** The Artifacts notices queued for an agent about one Artifact (its inbox item). */
const noticesTo = async (agentId: string, itemId: string) => (await getDb().select({ event: thirdPartyAgentEvents.payload }).from(thirdPartyAgentEvents)
  .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.objectRef, itemId))))
  .map((row) => (row.event as { app_event?: { reason?: string; renamed?: unknown; channelAnnouncement?: unknown } }).app_event!);
/** A person's Activity row for an Artifact, or undefined. */
const activityOf = async (userId: string, itemId: string) => (await getDb().select().from(objectInboxStates)
  .where(and(eq(objectInboxStates.userId, userId), eq(objectInboxStates.objectId, itemId))))[0];
const subscribers = async (itemId: string) => (await getDb().select({ type: artifactSubscriptions.actorType, id: artifactSubscriptions.actorId }).from(artifactSubscriptions)
  .where(eq(artifactSubscriptions.itemId, itemId))).map((row) => `${row.type}:${row.id}`).sort();

test("a new Artifact as the owner, in a channel the owner may post in and the assistant isn't in: the owner's, with the assistant's mark; no notice of their own push", async ({ seed }) => {
  const world = await seedWorld(seed);
  const made = await published(world.asOwner({ home: world.closed.id, request: { title: "Owner's plan", files: page("# Plan") } }));
  assert.deepEqual([made.status, made.body.version, made.body.homeConversationId, made.body.unchanged], [201, 1, world.closed.id, false]);

  const row = await itemRow(made.body.itemId);
  assert.deepEqual(
    [row.createdByType, row.createdById, row.publishedByAssistantAgentId, row.homeKind, row.homeChannelId, row.title],
    ["user", world.owner.id, world.assistant.id, "conversation", world.closed.id, "Owner's plan"],
  );
  const [v1] = await versionRows(made.body.itemId);
  assert.deepEqual([v1!.publisherType, v1!.publisherId], ["user", world.owner.id]);

  // The owner follows what they published; the assistant doesn't.
  assert.deepEqual(await subscribers(made.body.itemId), [`user:${world.owner.id}`]);
  // The event is the owner's, and for no one: no Activity row of their own push.
  const events = await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, made.body.itemId));
  assert.deepEqual(events.map((event) => [event.eventKind, event.actorType, event.actorId]), [["version", "user", world.owner.id]]);
  assert.deepEqual(await getDb().select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, events[0]!.id)), []);
  assert.equal(await activityOf(world.owner.id, made.body.itemId), undefined);
  // Nothing is read for the owner, and the assistant is told nothing.
  assert.equal(await readPositionOf({ type: "user", id: world.owner.id }, made.body.itemId), null);
  assert.deepEqual(await noticesTo(world.assistant.id, made.body.itemId), []);
});

test("a new Artifact as the owner needs a top-level conversation the OWNER may post in: else 404 TARGET_NOT_FOUND and nothing is made", async ({ seed }) => {
  const world = await seedWorld(seed);
  const request = { title: "Nowhere", files: page("x") };
  // A public channel the owner can read but isn't in, a private one only the assistant is in, an archived one, another server's.
  const open = await createChannel(world.server.id, `po-open-${label()}`, undefined, "channel");
  const assistantOnly = await createChannel(world.server.id, `po-pa-${label()}`, undefined, "private");
  await addAgent(assistantOnly.id, world.assistant.id);
  const archived = await seed.channel({ server: world.server, members: [world.owner], visibility: "private", archivedAt: new Date() });
  const elsewhere = await seed.server({ owner: world.owner });
  const theirs = await seed.channel({ server: elsewhere, members: [world.owner] });
  // A thread of a channel the owner may post in: a thread is never a home.
  const root = await seed.message({ channel: world.closed, author: world.owner, content: "root" });
  const thread = await getOrCreateThreadForChannel(world.closed.id, root.id, world.owner.id, "user");
  const before = await itemCount(world);

  for (const [what, home] of [
    ["unknown", randomUUID()],
    ["not an id", "#general"],
    ["public, not a member", open.id],
    ["the assistant's, not the owner's", assistantOnly.id],
    ["archived", archived.id],
    ["another server's", theirs.id],
    ["a thread", thread.id],
  ] as const) {
    const refused = await publishArtifactAs(world.asOwner({ home, request }));
    assert.deepEqual(
      [refused.kind, refused.kind === "error" ? [refused.status, refused.body.code, refused.body.error, refused.body.details] : null],
      ["error", [404, "TARGET_NOT_FOUND", TARGET_NOT_FOUND_ERROR, { home }]],
      what,
    );
  }
  assert.equal(await itemCount(world), before);
  // The same owner may publish into the thread's own conversation.
  const ok = await published(world.asOwner({ home: world.closed.id, request }));
  assert.equal(ok.status, 201);
});

test("a new version as the owner: only with the assistant's mark and where the owner may rename it; the version is the owner's", async ({ seed }) => {
  const world = await seedWorld(seed);
  // The assistant's own (as itself), and one it published as the owner.
  const itself = await published(world.asItself({ home: world.shared.id, request: { title: "Assistant's", files: page("one") } }));
  const owners = await published(world.asOwner({ home: world.shared.id, request: { title: "Owner's", files: page("one") } }));
  for (const id of [itself.body.itemId, owners.body.itemId]) {
    const second = await published(world.asOwner({ request: { artifact: id, base: 1, files: page("two") } }));
    assert.deepEqual([second.status, second.body.version, second.body.unchanged], [201, 2, false]);
    const versions = await versionRows(id);
    assert.deepEqual([versions[1]!.publisherType, versions[1]!.publisherId], ["user", world.owner.id]);
    assert.equal((await itemRow(id)).publishedByAssistantAgentId, world.assistant.id, "the mark never changes");
  }

  // Another assistant's mark (as itself, or as the same owner), or none: 403 NOT_PUBLISHED_BY_ASSISTANT, nothing written.
  const theirs = await published(world.asItself({ home: world.shared.id, request: { title: "Theirs", files: page("x") } }, world.other));
  const theirsAsOwner = await published(world.asOwner({ home: world.shared.id, request: { title: "Theirs, as the owner", files: page("x") } }, world.other));
  const plain = await createPublishOperations().publish({ agentId: world.assistant.id, serverId: world.serverId }, { target: `#${world.shared.name}`, title: "Plain", files: page("x") }, world.outbox);
  if (plain.kind !== "json" || "missing" in plain.body) assert.fail(JSON.stringify(plain));
  for (const id of [theirs.body.itemId, theirsAsOwner.body.itemId, plain.body.artifact.id]) {
    assert.deepEqual(refusal(await publishArtifactAs(world.asOwner({ request: { artifact: id, base: 1, files: page("mine now") } }))), [403, "NOT_PUBLISHED_BY_ASSISTANT"]);
    assert.equal((await versionRows(id)).length, 1);
  }

  // One the owner can't see (the assistant's DM with someone else), though its mark is on it: the one 404, before the mark.
  const hidden = (await findOrCreateDM(world.server.id, world.member.id, world.assistant.id))!;
  const unseen = await published(world.asItself({ home: hidden.id, request: { title: "Hidden", files: page("x") } }));
  assert.deepEqual(await publishArtifactAs(world.asOwner({ request: { artifact: unseen.body.itemId, base: 1, files: page("y") } })), notVisible());
  // Homed elsewhere than `requireHome`: the same 404.
  assert.deepEqual(await publishArtifactAs(world.asOwner({ requireHome: world.closed.id, request: { artifact: owners.body.itemId, base: 2, files: page("y") } })), notVisible());

  // A guest owner may push only to what they are the author of (mayRename): not the assistant's own.
  const guest = await seed.human();
  await addMember(world.server.id, guest.id);
  await addHuman(world.shared.id, guest.id);
  await getDb().update(serverMembers).set({ role: "guest", guestChannelId: world.shared.id }).where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, guest.id)));
  const forbidden = await publishArtifactAs(world.asOwner({ request: { artifact: itself.body.itemId, base: 2, files: page("guest") } }, world.assistant, guest));
  assert.deepEqual(refusal(forbidden), [403, "FORBIDDEN"]);
  assert.equal((await versionRows(itself.body.itemId)).length, 2);
  const guestsOwn = await published(world.asOwner({ home: world.shared.id, request: { title: "Guest's", files: page("g") } }, world.assistant, guest));
  const guestsSecond = await published(world.asOwner({ request: { artifact: guestsOwn.body.itemId, base: 1, files: page("g2") } }, world.assistant, guest));
  assert.equal(guestsSecond.body.version, 2);
});

test("the assistant isn't told of its own push as the owner (a changed file, a rename, an announcement); other agents are", async ({ seed }) => {
  const world = await seedWorld(seed);
  // v1 by the assistant as itself (it follows it, and is index.md's last publisher), v2 by another agent (other.md).
  const made = await published(world.asItself({ home: world.shared.id, request: { title: "Shared", files: page("one") } }));
  const id = made.body.itemId;
  const v2 = await createPublishOperations().publish({ agentId: world.other.id, serverId: world.serverId }, { artifact: id, base: 1, files: [{ path: "other.md", content: "theirs" }] }, world.outbox);
  assert.equal(v2.kind, "json", JSON.stringify(v2));

  // v3 as the owner changes both files: the other agent is told its file changed, the assistant isn't.
  const v3 = await published(world.asOwner({ request: { artifact: id, base: 2, files: [...page("owner's"), { path: "other.md", content: "owner's too" }] } }));
  assert.equal(v3.body.version, 3);
  assert.deepEqual((await noticesTo(world.other.id, id)).map((notice) => notice.reason), ["your_file_changed"]);
  assert.deepEqual(await noticesTo(world.assistant.id, id), []);

  // A title alone, as the owner: the other agent (it follows: it published) is told of the rename, the assistant isn't.
  const renamed = await published(world.asOwner({ request: { artifact: id, base: 3, title: "Shared, renamed", files: [] } }));
  assert.deepEqual([renamed.status, renamed.body.unchanged, (await itemRow(id)).title], [200, true, "Shared, renamed"]);
  assert.equal((await noticesTo(world.other.id, id)).filter((notice) => notice.renamed !== undefined).length, 1);
  assert.deepEqual(await noticesTo(world.assistant.id, id), []);

  // The channel's announcement: its other agents hear of the owner's new version, the assistant (a member) doesn't.
  await getDb().insert(featureFlagRules).values({ flagKey: CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [world.server.id] });
  await getDb().update(channels).set({ announcementArtifactId: id }).where(eq(channels.id, world.shared.id));
  const v4 = await published(world.asOwner({ request: { artifact: id, base: 3, files: page("owner's, again") } }));
  assert.equal(v4.body.version, 4);
  assert.equal((await noticesTo(world.other.id, id)).filter((notice) => notice.channelAnnouncement !== undefined).length, 1);
  assert.deepEqual(await noticesTo(world.assistant.id, id), []);
});

test("unseen comments hold a push as the owner by the ASSISTANT's read position (the owner's own comments too); `seen` clears it; the owner's read position and Activity never move", async ({ seed }) => {
  const world = await seedWorld(seed);
  const made = await published(world.asOwner({ home: world.shared.id, request: { title: "Discussed", files: page("one") } }));
  const id = made.body.itemId;
  const web = createWebCommentOperations();
  const comment = async (by: { id: string }, text: string) => {
    const posted = await web.postComment({ userId: by.id, serverId: world.serverId, sessionFamilyId: null }, id, { body: [{ type: "text", text }], version: 1, target: { scope: "artifact" }, replyTo: null }, world.outbox);
    if (posted.kind !== "json") assert.fail(JSON.stringify(posted));
    return (await getDb().select().from(artifactComments).where(eq(artifactComments.id, posted.body.comment.id)))[0]!;
  };
  const owner = { type: "user" as const, id: world.owner.id };
  const assistant = { type: "agent" as const, id: world.assistant.id };
  const ownerState = async () => {
    const activity = await activityOf(world.owner.id, id);
    return { position: await readPositionOf(owner, id), activity: activity && { last: activity.lastEventSeq, read: activity.readThroughSeq, done: activity.doneThroughSeq } };
  };
  const push = (text: string, seen?: number) => publishArtifactAs(world.asOwner({ request: { artifact: id, base: 1, files: page(text), ...(seen === undefined ? {} : { seen }) } }));

  // A member's comment, which the owner has read (their Activity row is read through it).
  const theirs = await comment(world.member, "Please change the intro.");
  await advanceReadPosition(owner, id, theirs.position);
  const read = await ownerState();
  assert.equal(read.position, theirs.position);
  assert.ok(read.activity && read.activity.read !== null && read.activity.read >= read.activity.last, "the owner has read it");

  // Held all the same: the assistant hasn't been shown it. Its read position moves over it; the owner's doesn't.
  const held = await push("two");
  assert.deepEqual(refusal(held), [409, "UNSEEN_CHANGES"]);
  assert.equal((await versionRows(id)).length, 1);
  assert.equal(await readPositionOf(assistant, id), theirs.position);
  assert.deepEqual(await ownerState(), read);

  // The owner's own comment holds it too (the owner wrote it; the assistant wasn't shown it).
  const own = await comment(world.owner, "And the title.");
  const afterOwn = await ownerState();
  assert.deepEqual(refusal(await push("two")), [409, "UNSEEN_CHANGES"]);
  assert.deepEqual(await ownerState(), afterOwn);

  // `seen` up to the newest comment clears it.
  const last = await comment(world.member, "One more thing.");
  const beforePush = await ownerState();
  const pushed = await push("two", last.position);
  assert.deepEqual(refusal(pushed).slice(0, 1), ["json"]);
  if (pushed.kind !== "json") throw new Error("unreachable");
  assert.equal(pushed.body.version, 2);
  assert.ok(own.position < last.position);
  // The owner's read position and Activity are as they were. The assistant's
  // stops before the comment it was never shown (`seen` only lifts the hold:
  // publish.ts step 6, as for any agent).
  assert.deepEqual(await ownerState(), beforePush);
  assert.equal(await readPositionOf(assistant, id), own.position);
});

test("a repeated create as the owner replays only an Artifact with the same assistant's mark", async ({ seed }) => {
  const world = await seedWorld(seed);
  const request = { title: "Same", files: page("same") };
  const first = await published(world.asOwner({ home: world.shared.id, request }));
  const again = await published(world.asOwner({ home: world.shared.id, request }));
  assert.deepEqual([again.status, again.body.itemId], [200, first.body.itemId], "the same request through the same assistant replays");

  // Through another assistant of the same owner: another Artifact, with that assistant's mark.
  const viaOther = await published(world.asOwner({ home: world.shared.id, request }, world.other));
  assert.equal(viaOther.status, 201);
  assert.notEqual(viaOther.body.itemId, first.body.itemId);
  assert.equal((await itemRow(viaOther.body.itemId)).publishedByAssistantAgentId, world.other.id);
  // The assistant as itself with the same request: another author, another Artifact.
  const itself = await published(world.asItself({ home: world.shared.id, request }));
  assert.equal(itself.status, 201);
  assert.ok(![first.body.itemId, viaOther.body.itemId].includes(itself.body.itemId));
});

test("a file listed by sha256 whose bytes the server lacks is refused for the owner too, and nothing is made", async ({ seed }) => {
  const world = await seedWorld(seed);
  const before = await itemCount(world);
  const absent = sha("never uploaded");
  const refused = await publishArtifactAs(world.asOwner({ home: world.closed.id, request: { title: "Listed", files: [{ path: "index.md", sha256: absent, size: 14 }] } }));
  assert.deepEqual(refusal(refused), [400, "FILES_NOT_INLINE"]);
  assert.equal(await itemCount(world), before);
});
