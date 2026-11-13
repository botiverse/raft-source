// Publishing through a personal assistant (publishAs.ts publishArtifactAs),
// called as its caller calls it: the function, no HTTP. Proves what its
// header promises: a new Artifact is the author's and carries the
// assistant's mark; a new version goes only to an Artifact with that same
// mark; what the author can't see or can't place into is refused as the
// agent API refuses it; and a refusal writes nothing.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { artifactLinkId, asArtifactId, asServerId } from "@botiverse/raft-shared";
import { getAppUrl } from "../../config/appUrl";
import { getDb } from "../../db/index";
import { createAgent } from "../../services/agentService";
import { addAgent, addHuman, createChannel, findOrCreateDM } from "../../services/channelService";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { appNoticeOutbox } from "../../services/firstPartyAppHost";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { ARTIFACTS_NOT_ENABLED, notVisible, TARGET_NOT_FOUND_ERROR } from "./apiCommon";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { createPublishOperations } from "./publish";
import { knownRequest, publishArtifactAs, type ArtifactPublishAsInput, type ArtifactPublishedAs } from "./publishAs";
import { artifactsApp } from "./register";
import { artifactItems, artifactVersions } from "./schema";

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
 * One server with Artifacts on: its owner, two assistants (ordinary agents
 * here; whether an agent is someone's assistant is the caller's knowledge),
 * each with a DM with the owner, a channel both are in, and a private channel
 * neither is in.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  __setArtifactR2StoreForTests(memoryR2(new Map()));
  const assistant = await createAgent(server.id, `pa-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const other = await createAgent(server.id, `pa-b-${label()}`, { runtime: "claude", model: "sonnet" });
  const dm = (await findOrCreateDM(server.id, owner.id, assistant.id))!;
  const otherDm = (await findOrCreateDM(server.id, owner.id, other.id))!;
  const shared = await createChannel(server.id, `pa-shared-${label()}`, undefined, "private");
  await addHuman(shared.id, owner.id);
  for (const agent of [assistant, other]) await addAgent(shared.id, agent.id);
  const closed = await createChannel(server.id, `pa-closed-${label()}`, undefined, "private");
  await addHuman(closed.id, owner.id);
  const outbox = appNoticeOutbox(artifactsApp, undefined);
  const as = (agent: { id: string }, rest: Pick<ArtifactPublishAsInput, "home" | "request">): ArtifactPublishAsInput => ({
    serverId,
    author: { type: "agent", id: agent.id },
    publishedByAssistantAgentId: agent.id,
    outbox,
    ...rest,
  });
  return { owner, serverId, assistant, other, dm, otherDm, shared, closed, outbox, as };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

const page = (text: string) => [{ path: "index.md", content: text }];

async function published(input: ArtifactPublishAsInput): Promise<{ status: number | undefined; body: ArtifactPublishedAs }> {
  const result = await publishArtifactAs(input);
  assert.equal(result.kind, "json", JSON.stringify(result));
  if (result.kind !== "json") throw new Error("unreachable");
  return { status: result.status, body: result.body };
}

const itemRow = async (id: string) => (await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)))[0]!;
const versionNumbers = async (id: string) => (await getDb().select({ number: artifactVersions.number }).from(artifactVersions).where(eq(artifactVersions.itemId, id))).map((row) => row.number).sort();
const itemCount = async (world: World) => (await getDb().select({ id: artifactItems.id }).from(artifactItems).where(eq(artifactItems.serverId, world.serverId))).length;

test("a new Artifact is the author's, homed where it was asked, and carries the assistant's mark", async ({ seed }) => {
  const world = await seedWorld(seed);
  const made = await published(world.as(world.assistant, { home: world.dm.id, request: { title: "Trip plan", files: page("# Trip plan") } }));
  assert.equal(made.status, 201);
  assert.deepEqual(made.body, {
    itemId: made.body.itemId,
    version: 1,
    url: `${getAppUrl()}/artifacts/${artifactLinkId(asArtifactId(made.body.itemId))}`,
    homeConversationId: world.dm.id,
    unchanged: false,
  });
  const row = await itemRow(made.body.itemId);
  assert.deepEqual(
    [row.createdByType, row.createdById, row.publishedByAssistantAgentId, row.homeKind, row.homeChannelId, row.title],
    ["agent", world.assistant.id, world.assistant.id, "conversation", world.dm.id, "Trip plan"],
  );
});

test("the assistant pushes new versions to the Artifact it published; the same content again makes none", async ({ seed }) => {
  const world = await seedWorld(seed);
  const made = await published(world.as(world.assistant, { home: world.dm.id, request: { title: "Notes", files: page("one") } }));
  const id = made.body.itemId;

  const second = await published(world.as(world.assistant, { request: { artifact: id, base: 1, files: page("two") } }));
  assert.deepEqual([second.status, second.body.version, second.body.unchanged, second.body.itemId], [201, 2, false, id]);

  const same = await published(world.as(world.assistant, { request: { artifact: id, base: 2, files: page("two") } }));
  assert.deepEqual([same.status, same.body.version, same.body.unchanged], [200, 2, true]);
  assert.deepEqual(await versionNumbers(id), [1, 2]);
  assert.equal((await itemRow(id)).publishedByAssistantAgentId, world.assistant.id, "the mark never changes");
});

test("403 NOT_PUBLISHED_BY_ASSISTANT for an Artifact with another assistant's mark or with none, and nothing is written", async ({ seed }) => {
  const world = await seedWorld(seed);
  // Another assistant's, in a channel both are in.
  const theirs = await published(world.as(world.other, { home: world.shared.id, request: { title: "Theirs", files: page("theirs") } }));
  // The same agent's own, but published through the agent API: no mark.
  const plain = await createPublishOperations().publish(
    { agentId: world.assistant.id, serverId: world.serverId },
    { target: `#${world.shared.name}`, title: "Plain", files: page("plain") },
    world.outbox,
  );
  assert.equal(plain.kind, "json", JSON.stringify(plain));
  if (plain.kind !== "json" || "missing" in plain.body) throw new Error("unreachable");
  const plainId = plain.body.artifact.id;
  assert.equal((await itemRow(plainId)).publishedByAssistantAgentId, null, "the agent API's publish marks nothing");

  for (const id of [theirs.body.itemId, plainId]) {
    const refused = await publishArtifactAs(world.as(world.assistant, { request: { artifact: id, base: 1, files: page("mine now") } }));
    assert.deepEqual(
      [refused.kind, refused.kind === "error" ? refused.status : null, refused.kind === "error" ? refused.body.code : null],
      ["error", 403, "NOT_PUBLISHED_BY_ASSISTANT"],
    );
    assert.deepEqual(await versionNumbers(id), [1]);
  }
  // The one that did publish it still can.
  const own = await published(world.as(world.other, { request: { artifact: theirs.body.itemId, base: 1, files: page("theirs, again") } }));
  assert.equal(own.body.version, 2);
});

test("an Artifact the author can't see is the agent API's one 404, whoever's mark it carries", async ({ seed }) => {
  const world = await seedWorld(seed);
  const hidden = await published(world.as(world.other, { home: world.otherDm.id, request: { title: "Hidden", files: page("hidden") } }));
  for (const artifact of [hidden.body.itemId, `pt_${randomUUID()}`]) {
    const refused = await publishArtifactAs(world.as(world.assistant, { request: { artifact, base: 1, files: page("x") } }));
    assert.deepEqual(refused, notVisible());
  }
  assert.deepEqual(await versionNumbers(hidden.body.itemId), [1]);
});

test("a caller's body with keys beside the request's own: only the request's fields go on to the publish", async ({ seed }) => {
  const wide = { title: "Stray", files: page("x"), base: 3, seen: 7, delete: ["old.md"], target: "#elsewhere", home: "x", as: { assistantAgentId: "y" } } as unknown as ArtifactPublishAsInput["request"];
  assert.deepEqual(knownRequest(wide), { title: "Stray", files: page("x"), base: 3, seen: 7, delete: ["old.md"] });
  // And through the function: `home` decides where a new Artifact lives, whatever else the body carries.
  const world = await seedWorld(seed);
  const made = await published(world.as(world.assistant, { home: world.dm.id, request: { title: "Stray", files: page("x"), target: `#${world.shared.name}` } as unknown as ArtifactPublishAsInput["request"] }));
  assert.equal((await itemRow(made.body.itemId)).homeChannelId, world.dm.id);
});

test("a new Artifact needs a home the author can place into: none, an unknown one and one it isn't in make nothing", async ({ seed }) => {
  const world = await seedWorld(seed);
  const before = await itemCount(world);
  const request = { title: "Nowhere", files: page("x") };

  const none = await publishArtifactAs(world.as(world.assistant, { request }));
  assert.deepEqual([none.kind, none.kind === "error" ? [none.status, none.body.code] : null], ["error", [400, "HOME_REQUIRED"]]);

  for (const home of [randomUUID(), world.closed.id, world.otherDm.id]) {
    const refused = await publishArtifactAs(world.as(world.assistant, { home, request }));
    assert.deepEqual(
      [refused.kind, refused.kind === "error" ? [refused.status, refused.body.code, refused.body.error] : null],
      ["error", [404, "TARGET_NOT_FOUND", TARGET_NOT_FOUND_ERROR]],
      `home ${home}`,
    );
  }
  assert.equal(await itemCount(world), before);
});

test("a file listed by sha256 whose bytes the server lacks is refused (there is no upload step), and nothing is made", async ({ seed }) => {
  const world = await seedWorld(seed);
  const before = await itemCount(world);
  const absent = sha("never uploaded");
  const refused = await publishArtifactAs(world.as(world.assistant, {
    home: world.dm.id,
    request: { title: "Listed", files: [{ path: "index.md", sha256: absent, size: 14 }] },
  }));
  assert.deepEqual(
    [refused.kind, refused.kind === "error" ? [refused.status, refused.body.code, refused.body.details] : null],
    ["error", [400, "FILES_NOT_INLINE", { missing: [absent] }]],
  );
  assert.equal(await itemCount(world), before);
});

test("with Artifacts off, both a new Artifact and a new version are 403 ARTIFACTS_NOT_ENABLED", async ({ seed }) => {
  const world = await seedWorld(seed);
  const made = await published(world.as(world.assistant, { home: world.dm.id, request: { title: "Before", files: page("x") } }));
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  try {
    assert.deepEqual(await publishArtifactAs(world.as(world.assistant, { home: world.dm.id, request: { title: "After", files: page("y") } })), ARTIFACTS_NOT_ENABLED);
    assert.deepEqual(await publishArtifactAs(world.as(world.assistant, { request: { artifact: made.body.itemId, base: 1, files: page("y") } })), ARTIFACTS_NOT_ENABLED);
    assert.deepEqual(await versionNumbers(made.body.itemId), [1]);
  } finally {
    __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, undefined);
  }
});
