import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index.js";
import { channels, jointChannels, jointChannelServers, messages, users } from "../db/schema.js";
import { createServer } from "./serverService.js";
import { resolveServerMessageStorageChannelIds } from "./channelService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

function exportedFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function asyncFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf("\nasync function ", start + 1);
  const nextExported = source.indexOf("\nexport async function ", start + 1);
  const candidates = [next, nextExported].filter((index) => index !== -1);
  const end = candidates.length === 0 ? source.length : Math.min(...candidates);
  return source.slice(start, end);
}

test("server message storage scope stays set-based and Wiki keeps a narrower public-only scope", () => {
  const channelSource = readFileSync(new URL("./channelService.ts", import.meta.url), "utf8");
  const resolverSource = exportedFunctionSource(channelSource, "resolveServerMessageStorageChannelIds");
  assert.equal((resolverSource.match(/\.execute\(sql`/g) ?? []).length, 1);
  assert.doesNotMatch(resolverSource, /Promise\.all|resolveChannelAccess|getJointThreadProjectionByLocalThread/);
  assert.match(resolverSource, /WITH local_channels AS/);
  assert.match(resolverSource, /ordinary_local AS/);
  assert.match(resolverSource, /active_joint_channels AS/);
  assert.match(resolverSource, /active_joint_threads AS/);
  assert.match(resolverSource, /NOT EXISTS[\s\S]*mapped_projection\.local_channel_id/);
  assert.match(resolverSource, /thread_projection\.status = 'active'/);
  assert.match(resolverSource, /parent_projection\.status = 'active'/);
  assert.match(resolverSource, /canonical_thread\.type = 'thread'/);

  const wikiSource = readFileSync(new URL("./wikiService.ts", import.meta.url), "utf8");
  assert.doesNotMatch(wikiSource, /resolveServerMessageStorageChannelIds/);
  assert.doesNotMatch(wikiSource, /runWikiCoverageRefresh|getBoundedRoundUpperSeq/);

  const publicSource = asyncFunctionSource(wikiSource, "listEligibleWikiPublicChannelIds");
  assert.match(publicSource, /eq\(channels\.serverId, space\.serverId\)/);
  assert.match(publicSource, /eq\(channels\.type, "channel"\)/);
  assert.match(publicSource, /ne\(channels\.name, "all"\)/);
  assert.match(publicSource, /ne\(channels\.id, space\.wikiChannelId\)/);
  assert.match(publicSource, /isNull\(channels\.archivedAt\)/);
  assert.match(publicSource, /isNull\(channels\.deletedAt\)/);

  const threadSource = asyncFunctionSource(wikiSource, "listActiveWikiThreadScopes");
  assert.match(threadSource, /eq\(channels\.serverId, serverId\)/);
  assert.match(threadSource, /eq\(channels\.type, "thread"\)/);
  assert.match(threadSource, /isNotNull\(channels\.parentMessageId\)/);
  assert.match(threadSource, /isNull\(channels\.archivedAt\)/);
  assert.match(threadSource, /isNull\(channels\.deletedAt\)/);

  const parentSource = asyncFunctionSource(wikiSource, "loadWikiParentMessageChannels");
  assert.match(parentSource, /\.from\(messages\)/);
  assert.match(parentSource, /inArray\(messages\.id, parentMessageIds\)/);
  assert.doesNotMatch(parentSource, /channels\.serverId/);

  // The eligible scope is resolved in one place and expressed in two keys:
  // storage channel ids, and the coverage channel each one belongs to. Threads
  // fold into their parent, which is what lets a channel's coverage stand for
  // its threads at every site that measures source.
  const scopeSource = asyncFunctionSource(wikiSource, "getEligibleWikiSourceScope");
  assert.equal((scopeSource.match(/listEligibleWikiPublicChannelIds\(/g) ?? []).length, 1);
  assert.equal((scopeSource.match(/listActiveWikiThreadScopes\(/g) ?? []).length, 1);
  assert.equal((scopeSource.match(/loadWikiParentMessageChannels\(/g) ?? []).length, 1);
  // Public-only teeth: a thread is attached only when its parent message sits
  // in the eligible public set, and it is keyed to that parent.
  assert.match(scopeSource, /parentById\.get\(channel\.parentMessageId\) \?\? ""/);
  assert.match(scopeSource, /if \(!publicChannelIds\.has\(parentChannelId\)\) continue;/);
  assert.match(scopeSource, /coverageIdByStorageId\.set\(channel\.id, parentChannelId\)/);

  const eligibleSource = asyncFunctionSource(wikiSource, "getEligibleWikiSourceChannelIds");
  assert.match(eligibleSource, /getEligibleWikiSourceScope\(space\)/);

  const upperSeqSource = asyncFunctionSource(wikiSource, "getEligibleWikiSourceUpperSeq");
  assert.match(upperSeqSource, /MAX\(\$\{messages\.seq\}\)/);
  assert.match(upperSeqSource, /inArray\(messages\.channelId, scope\.storageChannelIds\)/);
});

test("server message storage scope maps active joint channels and threads and fails closed", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `message-scope-${randomUUID()}@slock.test`,
    name: "message-scope-owner",
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer("Message Scope", `message-scope-${randomUUID()}`, owner.id);
  const storageServer = await createServer("Message Storage", `message-storage-${randomUUID()}`, owner.id);

  const [ordinary, jointLocal, jointCanonical, inactiveLocal, inactiveCanonical] = await db.insert(channels).values([
    { serverId: server.id, name: "ordinary", type: "channel" },
    { serverId: server.id, name: "joint-local", type: "joint" },
    { serverId: storageServer.id, name: "joint-canonical", type: "channel" },
    { serverId: server.id, name: "inactive-local", type: "joint" },
    { serverId: storageServer.id, name: "inactive-canonical", type: "channel" },
  ]).returning();

  const [activeJoint, inactiveJoint] = await db.insert(jointChannels).values([
    { canonicalChannelId: jointCanonical.id, createdByServerId: server.id, createdByUserId: owner.id },
    { canonicalChannelId: inactiveCanonical.id, createdByServerId: server.id, createdByUserId: owner.id },
  ]).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: activeJoint.id,
      serverId: server.id,
      localChannelId: jointLocal.id,
      role: "host",
      joinedByUserId: owner.id,
    },
    {
      jointChannelId: inactiveJoint.id,
      serverId: server.id,
      localChannelId: inactiveLocal.id,
      role: "host",
      status: "disconnected",
      joinedByUserId: owner.id,
    },
  ]);

  const [parentMessage] = await db.insert(messages).values({
    channelId: jointCanonical.id,
    senderType: "user",
    senderId: owner.id,
    content: "joint parent",
  }).returning();
  const [localThread, canonicalThread, wrongTypeLocalThread, wrongTypeCanonicalThread] = await db
    .insert(channels)
    .values([
      { serverId: server.id, name: "joint-thread-local", type: "thread" },
      {
        serverId: storageServer.id,
        name: "joint-thread-canonical",
        type: "thread",
        parentMessageId: parentMessage.id,
      },
      { serverId: server.id, name: "wrong-type-thread-local", type: "thread" },
      {
        serverId: storageServer.id,
        name: "wrong-type-thread-canonical",
        type: "channel",
        parentMessageId: parentMessage.id,
      },
    ])
    .returning();
  const [threadJoint, wrongTypeThreadJoint] = await db.insert(jointChannels).values([
    {
      canonicalChannelId: canonicalThread.id,
      createdByServerId: server.id,
      createdByUserId: owner.id,
    },
    {
      canonicalChannelId: wrongTypeCanonicalThread.id,
      createdByServerId: server.id,
      createdByUserId: owner.id,
    },
  ]).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: threadJoint.id,
      serverId: server.id,
      localChannelId: localThread.id,
      role: "host",
      joinedByUserId: owner.id,
    },
    {
      jointChannelId: wrongTypeThreadJoint.id,
      serverId: server.id,
      localChannelId: wrongTypeLocalThread.id,
      role: "host",
      joinedByUserId: owner.id,
    },
  ]);

  const resolved = new Set(await resolveServerMessageStorageChannelIds(server.id));
  assert.equal(resolved.has(ordinary.id), true, "ordinary local channels use identity storage");
  assert.equal(resolved.has(jointCanonical.id), true, "active joint channels map to canonical storage");
  assert.equal(resolved.has(canonicalThread.id), true, "active joint threads map to canonical storage");
  assert.equal(resolved.has(jointLocal.id), false, "joint local projections are never storage authority");
  assert.equal(resolved.has(localThread.id), false, "joint thread local projections are never storage authority");
  assert.equal(resolved.has(wrongTypeLocalThread.id), false, "mapped local threads never fall back to identity storage");
  assert.equal(resolved.has(wrongTypeCanonicalThread.id), false, "wrong-type canonical thread authorities fail closed");
  assert.equal(resolved.has(inactiveLocal.id), false, "inactive local projections fail closed");
  assert.equal(resolved.has(inactiveCanonical.id), false, "inactive canonical streams fail closed");
});
