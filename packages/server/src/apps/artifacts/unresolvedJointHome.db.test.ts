// #460: an Artifact homed in a joint names the joint's canonical channel, a
// channel of the `joint_storage` server (`joint-storage-<uuid>`). Whoever
// still sees one whose joint their server has no projection of (the orphan
// of a server that left: its author) is shown UNRESOLVED_JOINT_HOME: no id,
// no name, a joint (a person's client says "a shared channel"), and for an
// agent no target; never the storage channel's id. Everyone else is shown
// what they were before.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { channels, jointChannelServers, users } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { createChannel } from "../../services/channelService";
import { createServer } from "../../services/serverService";
import { localConversationIds, unresolvedJointHomes } from "../../platform/conversations";
import { dbTest as test } from "../../test/integration/dbTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { homesOf, summarizeForPerson } from "./apiCommon";
import { artifactCardFacts, cardsOf } from "./webCards";
import { artifactItems, artifactVersions } from "./schema";

async function fixture() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [author] = await db.insert(users).values({ email: `uj-${suffix}@slock.test`, name: `uj-${suffix}`, passwordHash: "x", emailVerified: true }).returning();
  const host = await createServer("UJ Host", `uj-host-${suffix}`, author!.id);
  const former = await createServer("UJ Former", `uj-former-${suffix}`, author!.id);
  const joint = await seedJointChannel({ name: `shared-${suffix}`, serverIds: [host.id, former.id], createdByUserId: author!.id });
  const [hostCopy, formerCopy] = joint.projections as [typeof joint.projections[number], typeof joint.projections[number]];
  const gone = await createChannel(former.id, `gone-${suffix}`);
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, gone.id));
  const agent = await createAgent(former.id, `uj-agent-${suffix}`, { runtime: "claude" });
  const hostAgent = await createAgent(host.id, `uj-host-agent-${suffix}`, { runtime: "claude" });
  const item = async (serverId: string, homeChannelId: string) => {
    const id = `pt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const versionId = `v_${randomUUID()}`;
    const [row] = await db.insert(artifactItems).values({
      id, serverId: asServerId(serverId), urlKey: id, name: id, title: `Artifact ${id}`, homeKind: "conversation", homeChannelId, createdByType: "user", createdById: author!.id,
    }).returning();
    const [version] = await db.insert(artifactVersions).values({
      id: versionId, itemId: id, number: 1, entry: "index.html", fileCount: 1, sizeBytes: 1, publishDigest: "d", status: "published", publisherType: "user", publisherId: author!.id, position: 1,
    }).returning();
    await db.update(artifactItems).set({ currentVersionId: versionId }).where(eq(artifactItems.id, id));
    return { item: { ...row!, currentVersionId: versionId }, version: version! };
  };
  return { author: author!, host, former, joint, hostCopy, formerCopy, gone, agent, hostAgent, inJoint: await item(former.id, joint.canonical.id), inGone: await item(former.id, gone.id) };
}

function cardHome(reader: { userId: string; serverId: string }, shown: { item: Parameters<typeof cardsOf>[1][number]["item"]; version: Parameters<typeof cardsOf>[1][number]["version"] }) {
  const webReader = { userId: reader.userId, serverId: asServerId(reader.serverId), sessionFamilyId: null };
  return artifactCardFacts(webReader, [shown.item], [{ item: shown.item, number: null }]).then((facts) => {
    const [card] = cardsOf(webReader, [{ ...shown, current: shown.version, pinned: false }], (actor) => ({ type: actor.type, id: actor.id, name: "n" }) as never, facts);
    return card!.home;
  });
}

test("#460: a joint home no projection of the reader's server names is shown with no id and no name, never the storage channel", async ({ db: _db }) => {
  const f = await fixture();
  const formerId = asServerId(f.former.id);
  // While the former server is in the joint: its own copy, as before.
  assert.deepEqual(await cardHome({ userId: f.author.id, serverId: f.former.id }, f.inJoint), { kind: "conversation", conversation: { id: f.formerCopy.id, name: f.formerCopy.name, type: "joint" } });
  assert.deepEqual((await homesOf({ agentId: f.agent.id, serverId: formerId }, [f.inJoint.item])).get(f.inJoint.item.id), { kind: "conversation", conversation: { id: f.formerCopy.id, type: "joint", target: `#${f.formerCopy.name}` } });

  // The former server leaves the joint: its author still sees its orphan, by no storage id or name.
  await getDb().update(jointChannelServers).set({ status: "disconnected" }).where(eq(jointChannelServers.localChannelId, f.formerCopy.id));
  assert.deepEqual(await cardHome({ userId: f.author.id, serverId: f.former.id }, f.inJoint), { kind: "conversation", conversation: { id: null, name: "", type: "joint" } });
  assert.deepEqual((await homesOf({ agentId: f.agent.id, serverId: formerId }, [f.inJoint.item])).get(f.inJoint.item.id), { kind: "conversation", conversation: { id: null, type: "joint", target: null } });
  const [summary] = await summarizeForPerson({ userId: f.author.id, serverId: formerId }, [f.inJoint.item]);
  assert.deepEqual(summary!.home, { kind: "conversation", conversation: { id: null, type: "joint", target: null } });

  // The host server still in the joint: its own copy.
  assert.deepEqual((await homesOf({ agentId: f.hostAgent.id, serverId: asServerId(f.host.id) }, [f.inJoint.item])).get(f.inJoint.item.id), { kind: "conversation", conversation: { id: f.hostCopy.id, type: "joint", target: `#${f.hostCopy.name}` } });

  // An orphan of a deleted conversation of the server, as before: its id (and, for a person, its name).
  assert.deepEqual(await cardHome({ userId: f.author.id, serverId: f.former.id }, f.inGone), { kind: "conversation", conversation: { id: f.gone.id, name: f.gone.name, type: "channel" } });
  assert.deepEqual((await homesOf({ agentId: f.agent.id, serverId: formerId }, [f.inGone.item])).get(f.inGone.item.id), { kind: "conversation", conversation: { id: f.gone.id, type: null, target: null } });
});

test("#460: localConversationIds never answers a joint's storage channel as it is; unresolvedJointHomes finds only storage channels", async ({ db: _db }) => {
  const f = await fixture();
  const [canonical] = await getDb().select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, f.joint.canonical.id));
  assert.equal((await localConversationIds(asServerId(canonical!.serverId), [f.joint.canonical.id])).size, 0, "not even for the storage server itself");
  assert.deepEqual([...await unresolvedJointHomes([f.joint.canonical.id, f.gone.id, f.hostCopy.id], new Map())].sort(), [f.joint.canonical.id]);
  assert.equal((await unresolvedJointHomes([f.joint.canonical.id], new Map([[f.joint.canonical.id, true]]))).size, 0, "a resolved home is not unresolved");
});
