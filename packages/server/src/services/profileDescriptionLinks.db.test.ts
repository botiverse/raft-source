// #457: what a saved profile description's links warn about, with a fake
// object kind (its links `https://docs.test/d/<id>`) whose homes the test
// sets: core's visibility decides each code from who reads the description
// (the agent's server, its guests, the joint channels it is in; a person's
// every server), never the kind. Warnings only: nothing here refuses.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { asServerId, type ServerId } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { agents, featureFlagRules, featureFlags, serverMembers } from "../db/schema";
import type { AppObjectHome, AppObjectKind, FirstPartyApp } from "../platform/apps";
import { dbTest as test } from "../test/integration/dbTest";
import { seedJointChannel } from "../test/integration/jointFixture";
import { addAgent, addHuman, createChannel } from "./channelService";
import { changedDescriptionLinkWarnings, descriptionLinkWarnings, MAX_DESCRIPTION_LINKS, MAX_DESCRIPTION_WARNINGS } from "./profileDescriptionLinks";

const fake = vi.hoisted(() => ({
  flag: `docs_links_${Math.random().toString(36).slice(2, 10)}`,
  homes: new Map<string, unknown>(),
  asked: [] as string[][],
  failing: false,
}));

vi.mock("../apps/firstPartyApps", async (importOriginal) => {
  const original = await importOriginal<typeof import("../apps/firstPartyApps")>();
  const objectKind = {
    // Named as the Artifact kind so the shared fix words (its commands) apply; everything else is the fake's.
    kind: "artifact",
    linkId: (url: string) => /^https:\/\/docs\.test\/d\/([\w-]+)$/.exec(url)?.[1] ?? null,
    homes: async (ids: readonly string[]) => {
      fake.asked.push([...ids]);
      if (fake.failing) throw new Error("homes failed");
      return new Map(ids.flatMap((id) => (fake.homes.has(id) ? [[id, fake.homes.get(id)] as const] : [])));
    },
  };
  return { ...original, linkedObjectKinds: () => [{ app: { id: "docs", flag: fake.flag }, objectKind }] as unknown as Array<{ app: FirstPartyApp; objectKind: AppObjectKind & Required<Pick<AppObjectKind, "linkId">> }> };
});

let rules = 0;
const link = (id: string) => `https://docs.test/d/${id}`;
const tag = () => randomUUID().slice(0, 6);

async function allowFlag(db: Database, serverIds: readonly string[]) {
  await db.insert(featureFlags).values({ key: fake.flag, randomizationUnit: "server", salt: "links" }).onConflictDoNothing();
  await db.insert(featureFlagRules).values({ flagKey: fake.flag, stage: "server", priority: rules++, decision: "allow", values: [...serverIds] });
}

function setHomes(entries: Record<string, AppObjectHome>) {
  fake.homes = new Map(Object.entries(entries));
  fake.asked = [];
  fake.failing = false;
}

/** code@server-name per link, sorted: the warnings in short. */
const summary = (warnings: Awaited<ReturnType<typeof descriptionLinkWarnings>>) =>
  warnings.map((warning) => `${warning.object.id}:${warning.code}${warning.server ? `@${warning.server.name}` : ""}${warning.unreadable ? `(${warning.unreadable.join("+")})` : ""}`).sort();

test("an agent's description: unavailable, other_server, conversation each warn; a server home never (only full members read it), not even with guests or a joint; public never", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner, name: `Home ${tag()}` });
  const serverId = asServerId(server.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner, name: `Peer ${tag()}` });
  const peerId = asServerId(peer.id);
  await allowFlag(db, [server.id, peer.id]);
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `a-${tag()}` }).returning();
  const channel = await createChannel(server.id, `links-${tag()}`, undefined, "private");
  await addAgent(channel.id, agent!.id);
  const unseen = await createChannel(server.id, `links-unseen-${tag()}`, undefined, "private");
  const at = (sid: ServerId, homeKind: AppObjectHome["homeKind"], homeChannelId: string | null): AppObjectHome => ({ serverId: sid, homeKind, homeChannelId, author: { type: "user", id: owner.id } });
  setHomes({
    conv: at(serverId, "conversation", channel.id),
    hidden: at(serverId, "conversation", unseen.id),
    whole: at(serverId, "server", null),
    open: at(serverId, "public", null),
    peerWhole: at(peerId, "server", null),
    peerOpen: at(peerId, "public", null),
  });
  const self = { type: "agent" as const, id: agent!.id, serverId: server.id };
  const description = `Lists: ${["conv", "hidden", "whole", "open", "peerWhole", "peerOpen", "gone"].map(link).join(" ")} and https://example.com/x.`;

  // No guests, not in a joint: the whole server's object reaches everyone who reads it.
  assert.deepEqual(summary(await descriptionLinkWarnings({ description, owner: self, writer: self })), [
    "conv:conversation",
    // The writer can't see it (a private channel it isn't in, another server's): the same as a missing one.
    "gone:unavailable",
    "hidden:unavailable",
    "peerWhole:unavailable",
  ]);
  assert.deepEqual(fake.asked.map((ids) => [...ids].sort()), [["conv", "gone", "hidden", "open", "peerOpen", "peerWhole", "whole"]], "one homes call, each id once, only the kind's links");

  // A guest in the server, and the agent in a joint channel: neither reads an agent's description, so the server home still reaches every reader.
  const guest = await seed.human();
  const guestChannel = await createChannel(server.id, `guest-${tag()}`, undefined, "private");
  await db.insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest", guestChannelId: guestChannel.id });
  const joint = await seedJointChannel({ name: `joint-${tag()}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  await addAgent(joint.projections[0]!.id, agent!.id);
  // The peer's object homed in the joint: the agent sees it, but it is another server's.
  setHomes({ whole: at(serverId, "server", null), peerInJoint: at(peerId, "conversation", joint.canonical.id) });
  const agentWarnings = await descriptionLinkWarnings({ description: `${link("whole")} ${link("peerInJoint")}`, owner: self, writer: self });
  assert.deepEqual(summary(agentWarnings), ["peerInJoint:other_server"]);
  assert.deepEqual(agentWarnings[0]!.object, { kind: "artifact", id: "peerInJoint" });
  assert.equal(agentWarnings[0]!.server, undefined, "an agent's description is one server's: no server named");
  assert.ok(agentWarnings[0]!.fixes.length >= 3, "every fix is offered, not only one");
});

test("a person's description: a server home warns server_partial where the server has guests or the person is in a joint, naming who", async ({ db, seed }) => {
  const person = await seed.human();
  const server = await seed.server({ owner: person, name: `Home ${tag()}` });
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner, name: `Peer ${tag()}` });
  await allowFlag(db, [server.id, peer.id]);
  setHomes({ whole: { serverId: asServerId(server.id), homeKind: "server", homeChannelId: null, author: { type: "user", id: person.id } } });
  const me = { type: "user" as const, id: person.id };
  // Only the person's own server, no guests, no joint: nothing to say.
  assert.deepEqual(summary(await descriptionLinkWarnings({ description: link("whole"), owner: me, writer: me })), []);

  const guest = await seed.human();
  const guestChannel = await createChannel(server.id, `guest-${tag()}`, undefined, "private");
  await db.insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest", guestChannelId: guestChannel.id });
  assert.deepEqual(summary(await descriptionLinkWarnings({ description: link("whole"), owner: me, writer: me })), [`whole:server_partial@${server.name}(guests)`]);

  const joint = await seedJointChannel({ name: `joint-${tag()}`, serverIds: [server.id, peer.id], createdByUserId: person.id });
  await addHuman(joint.projections[0]!.id, person.id);
  assert.deepEqual(summary(await descriptionLinkWarnings({ description: link("whole"), owner: me, writer: me })), [`whole:server_partial@${server.name}(guests+other_servers)`]);
});

test("an editor who can't see the object gets only its link: no home, no channel, no server", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner, name: `Home ${tag()}` });
  await allowFlag(db, [server.id]);
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `a-${tag()}` }).returning();
  // The agent's DM-like private conversation, which the server's owner (an editor of the agent) isn't in.
  const theirs = await createChannel(server.id, `agent-only-${tag()}`, undefined, "private");
  await addAgent(theirs.id, agent!.id);
  setHomes({ private: { serverId: asServerId(server.id), homeKind: "conversation", homeChannelId: theirs.id, author: { type: "agent", id: agent!.id } } });
  const description = link("private");
  const owned = { type: "agent" as const, id: agent!.id, serverId: server.id };

  const [asEditor] = await descriptionLinkWarnings({ description, owner: owned, writer: { type: "user", id: owner.id, serverId: server.id } });
  assert.deepEqual(Object.keys(asEditor!).sort(), ["code", "fixes", "object", "url"]);
  assert.equal(asEditor!.code, "unavailable");
  assert.equal(asEditor!.url, description);
  assert.ok(asEditor!.fixes.every((fix) => !fix.includes(theirs.name) && !fix.includes("raft ")), JSON.stringify(asEditor!.fixes));

  // The agent itself sees it: the same link is a conversation's, with the channel named in its fix.
  const [asAgent] = await descriptionLinkWarnings({ description, owner: owned, writer: owned });
  assert.equal(asAgent!.code, "conversation");
  assert.ok(asAgent!.fixes.some((fix) => fix.includes(`#${theirs.name}`) && fix.includes("--announcement private")), JSON.stringify(asAgent!.fixes));
  assert.ok(asAgent!.fixes.some((fix) => fix.includes("raft artifact move private --to server")), "the agent's own command, with the real id");
  assert.notEqual(asAgent!.fixes[0]!.includes("raft artifact move private"), true, "widening this one is never the first fix");
  assert.ok(asAgent!.fixes.every((fix) => !fix.includes("Anyone with the link")), "an agent's description never asks for public");
});

test("a person's description is read in every server they are in: each server is judged and named", async ({ db, seed }) => {
  const person = await seed.human();
  const a = await seed.server({ owner: person, name: `Alpha ${tag()}` });
  const otherOwner = await seed.human();
  const b = await seed.server({ owner: otherOwner, members: [person], name: `Beta ${tag()}` });
  await allowFlag(db, [a.id, b.id]);
  const channel = await createChannel(a.id, `mine-${tag()}`, undefined, "private");
  await addHuman(channel.id, person.id);
  const at = (homeKind: AppObjectHome["homeKind"], homeChannelId: string | null): AppObjectHome => ({ serverId: asServerId(a.id), homeKind, homeChannelId, author: { type: "user", id: person.id } });
  setHomes({ whole: at("server", null), conv: at("conversation", channel.id), open: at("public", null) });
  const me = { type: "user" as const, id: person.id };
  const warnings = await descriptionLinkWarnings({ description: `${link("whole")} ${link("conv")} ${link("open")}`, owner: me, writer: me });
  assert.deepEqual(summary(warnings), [
    `conv:conversation@${a.name}`,
    `conv:other_server@${b.name}`,
    `whole:other_server@${b.name}`,
  ]);
  assert.deepEqual(warnings.find((warning) => warning.code === "conversation")!.server, { id: a.id, name: a.name });
});

test("links are read once each, at most MAX_DESCRIPTION_LINKS; an unchanged or empty description asks nothing; a failure is no warnings", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await allowFlag(db, [server.id]);
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `a-${tag()}` }).returning();
  const self = { type: "agent" as const, id: agent!.id, serverId: server.id };
  setHomes({});
  const ids = Array.from({ length: MAX_DESCRIPTION_LINKS + 5 }, (_, index) => `d${index}`);
  const description = [...ids, ids[0]!, ids[1]!].map(link).join(" ");
  const warnings = await descriptionLinkWarnings({ description, owner: self, writer: self });
  assert.equal(fake.asked.length, 1);
  assert.deepEqual(fake.asked[0], ids.slice(0, MAX_DESCRIPTION_LINKS), "the first links, each once");
  assert.equal(warnings.length, MAX_DESCRIPTION_LINKS);
  assert.ok(warnings.every((warning) => warning.code === "unavailable"));

  setHomes({});
  assert.deepEqual(await changedDescriptionLinkWarnings({ before: description, after: description, owner: self, writer: self }), []);
  assert.deepEqual(await changedDescriptionLinkWarnings({ before: description, after: "  ", owner: self, writer: self }), []);
  assert.deepEqual(await changedDescriptionLinkWarnings({ before: description, after: undefined, owner: self, writer: self }), []);
  assert.deepEqual(await descriptionLinkWarnings({ description: "no links https://example.com", owner: self, writer: self }), []);
  assert.equal(fake.asked.length, 0, "nothing asked without a new description or a kind's link");

  setHomes({});
  fake.failing = true;
  assert.deepEqual(await descriptionLinkWarnings({ description: link("x"), owner: self, writer: self }), [], "any failure: no warnings");
});

test("an object of a server with the app off is unavailable; an editor in one server gets another server's object as unavailable, even when they are in it too", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner, name: `On ${tag()}` });
  const off = await seed.server({ owner, name: `Off ${tag()}` });
  await allowFlag(db, [server.id]);
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `a-${tag()}` }).returning();
  const self = { type: "agent" as const, id: agent!.id, serverId: server.id };
  setHomes({ offPublic: { serverId: asServerId(off.id), homeKind: "public", homeChannelId: null, author: { type: "user", id: owner.id } } });
  assert.deepEqual(summary(await descriptionLinkWarnings({ description: link("offPublic"), owner: self, writer: self })), ["offPublic:unavailable"]);

  // The owner edits the agent in `server`; the object is the other server's, which the owner is also in: judged from `server` only (pinned).
  await allowFlag(db, [server.id, off.id]);
  setHomes({ elsewhere: { serverId: asServerId(off.id), homeKind: "server", homeChannelId: null, author: { type: "user", id: owner.id } } });
  assert.deepEqual(summary(await descriptionLinkWarnings({ description: link("elsewhere"), owner: self, writer: { type: "user", id: owner.id, serverId: server.id } })), ["elsewhere:unavailable"]);
});

test("a person's object homed in a joint channel they are in: their server's people outside it can't, nor another server's", async ({ db, seed }) => {
  const person = await seed.human();
  const a = await seed.server({ owner: person, name: `Alpha ${tag()}` });
  const otherOwner = await seed.human();
  const b = await seed.server({ owner: otherOwner, members: [person], name: `Beta ${tag()}` });
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner, name: `Peer ${tag()}` });
  await allowFlag(db, [a.id, b.id, peer.id]);
  const joint = await seedJointChannel({ name: `joint-${tag()}`, serverIds: [a.id, peer.id], createdByUserId: person.id });
  await addHuman(joint.projections[0]!.id, person.id);
  setHomes({ inJoint: { serverId: asServerId(a.id), homeKind: "conversation", homeChannelId: joint.canonical.id, author: { type: "user", id: person.id } } });
  const me = { type: "user" as const, id: person.id };
  assert.deepEqual(summary(await descriptionLinkWarnings({ description: link("inJoint"), owner: me, writer: me })), [
    `inJoint:conversation@${a.name}`,
    `inJoint:other_server@${b.name}`,
  ]);
});

test("a person's warnings (per link, per server) are capped at MAX_DESCRIPTION_WARNINGS", async ({ db, seed }) => {
  const person = await seed.human();
  const a = await seed.server({ owner: person });
  const otherOwner = await seed.human();
  const b = await seed.server({ owner: otherOwner, members: [person] });
  await allowFlag(db, [a.id, b.id]);
  const ids = Array.from({ length: 15 }, (_, index) => `w${index}`);
  setHomes(Object.fromEntries(ids.map((id) => [id, { serverId: asServerId(a.id), homeKind: "server" as const, homeChannelId: null, author: { type: "user" as const, id: person.id } }])));
  // Each link: other_server in Beta only (Alpha has no guests): 15; with a guest in Alpha, 30, capped.
  const me = { type: "user" as const, id: person.id };
  assert.equal((await descriptionLinkWarnings({ description: ids.map(link).join(" "), owner: me, writer: me })).length, 15);
  const guest = await seed.human();
  const guestChannel = await createChannel(a.id, `guest-${tag()}`, undefined, "private");
  await db.insert(serverMembers).values({ serverId: a.id, userId: guest.id, role: "guest", guestChannelId: guestChannel.id });
  assert.equal((await descriptionLinkWarnings({ description: ids.map(link).join(" "), owner: me, writer: me })).length, MAX_DESCRIPTION_WARNINGS);
});
