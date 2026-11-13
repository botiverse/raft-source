// Shared scenario for the `GET /internal/agent-api/users/:name/channels`
// parity tests (`internalAgentApi.userChannels.test.ts` on PGlite and
// `internalAgentApi.userChannels.realPg.test.ts` on PostgreSQL): one seeded
// pair of servers, today's `raft user info` algorithm kept verbatim as the
// oracle (server info, then one channel roster per inspected channel, over the
// real routes) for everything but its listed differences, and the shared
// `userInfo` operation over the new route. The differences:
// - Q3: joint channels are matched by identity, not by name.
// - Q1: a membership row is the channel plus the subject's membership, not the
//   caller's server.info row: the caller's fields (CALLER_CHANNEL_FIELDS) are
//   gone, and the subject's own `channelRole` is there where channel roles
//   exist (public and private channels other than #all).
// - Q2: the caller's built-in app conversations are inspected and list no one:
//   no longer skipped when `#<appId>` resolves nothing, and no longer decided
//   by a same-named regular channel's roster when it resolves one.
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import {
  createAgentApiClient,
  formatAgentUserInfo,
  formatHint,
  hintStep,
  RAFT_HINTS,
  userInfo,
  failureFromClientResult,
  failureOutcome,
  opError,
  type AgentAgentInfo,
  type AgentApiClient,
  type AgentChannelInfo,
  type AgentHumanInfo,
  type AgentPageInfo,
  type RaftNextStep,
  type RaftOutcome,
  type RaftUserInfo,
  type RaftUserRef,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  channelAgents,
  channelHumans,
  agents,
  channels,
  jointChannels,
  jointChannelServers,
  serverAgentMembers,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { resolveConversation } from "../services/rapRegistryStore";
import { createServer } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { fixturePasswordHash } from "../test/integration/credentials";

/**
 * Today's `raft user info` (shared `userInfo` before `users.channels`), kept
 * verbatim as the parity oracle: server.info, then `channels.members` on
 * `#<name>` for each inspected channel; a refused roster is skipped.
 */
export async function legacyUserInfo(
  client: Pick<AgentApiClient, "server" | "channels">,
  request: { name: string; offset?: number; limit?: number },
): Promise<RaftOutcome<RaftUserInfo, "info">> {
  const trimmed = request.name.trim();
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const limit = request.limit ?? 50;
  const offset = request.offset ?? 0;

  const info = await client.server.info();
  if (!info.ok) return failureFromClientResult(info);
  const agent = info.data.agents.find((candidate) => candidate.name === name);
  const human = info.data.humans.find((candidate) => candidate.name === name);
  const user: RaftUserRef | null = agent
    ? { kind: "agent", value: agent as AgentAgentInfo }
    : human
      ? { kind: "human", value: human as AgentHumanInfo }
      : null;
  if (!user) {
    return failureOutcome(opError("NOT_FOUND", {
      message: `User not found or not visible: @${name}`,
      nextAction: `Run \`${formatHint(RAFT_HINTS.serverInfo({ view: "agents", query: true }))}\` or \`${formatHint(RAFT_HINTS.serverInfo({ view: "humans", query: true }))}\` to inspect visible users.`,
    }));
  }

  const visibleChannels = info.data.channels as AgentChannelInfo[];
  const memberships: AgentChannelInfo[] = [];
  let skippedChannels = 0;
  for (const channel of visibleChannels.slice(offset, offset + limit)) {
    const members = await client.channels.members({ channel: `#${channel.name}` });
    if (!members.ok) {
      skippedChannels += 1;
      continue;
    }
    const roster = user.kind === "agent" ? members.data.agents ?? [] : members.data.humans ?? [];
    if (roster.some((candidate) => candidate.name === name)) {
      memberships.push({ ...channel, joined: true, muted: undefined, activityMuted: undefined });
    }
  }

  const nextOffset = offset + limit;
  const nextHint = nextOffset < visibleChannels.length ? RAFT_HINTS.userInfo({ name, offset: nextOffset, limit }) : null;
  const page: AgentPageInfo = {
    total: visibleChannels.length,
    offset,
    limit,
    nextCommand: nextHint ? formatHint(nextHint) : undefined,
  };
  const next: RaftNextStep | null = nextHint
    ? hintStep("next_page", nextHint, "Only one page of visible channels was inspected for memberships.", undefined, { name: `@${name}`, offset: nextOffset, limit })
    : null;
  return {
    ok: true,
    state: "info",
    data: { user, memberships, skippedChannels, page },
    next,
    text: formatAgentUserInfo(user, memberships, page, skippedChannels),
  };
}

export interface CountingClient {
  client: AgentApiClient;
  paths: string[];
}

export function agentApiClientFor(baseUrl: string, apiKey: string): CountingClient {
  const paths: string[] = [];
  const client = createAgentApiClient({
    fetch: {
      baseUrl,
      auth: { authorization: `Bearer ${apiKey}` },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        paths.push(`${url.pathname}${url.search}`);
        return fetch(input, init);
      },
    },
  });
  return { client, paths };
}

export interface UserChannelsScenario {
  serverId: string;
  /** Callers: a server-admin agent and a plain member agent, with `read` + `channels`. */
  callers: Array<{ label: string; agentId: string; apiKey: string }>;
  /** The member agent's credential without the `channels` capability. */
  noChannelsApiKey: string;
  adminApiKey: string;
  memberApiKey: string;
  ownerUserId: string;
  ownerName: string;
  /** A human of server B only (in A's joint channel roster, not in A's directory). */
  otherServerHumanName: string;
  /**
   * Q3, fixed: the old algorithm matched a joint channel's roster, which spans
   * every server's projection, by name, so a same-named agent of server B made
   * A's agent a member. These (subject, joint channel) pairs, where only the
   * namesake is a member, are the only difference from it. (Human names are
   * unique across users, so for humans name and identity agree.)
   */
  jointNamesakeOnly: ReadonlyArray<{ subject: string; channel: string }>;
  /** (subject, joint channel) pairs where the subject itself is a member: listed by both. */
  jointSelfMember: ReadonlyArray<{ subject: string; channel: string }>;
  /**
   * A joint channel whose server B projection is disconnected: both callers and
   * Mem in A's projection; Scout of B and alice in B's.
   */
  addPeerDisconnectedJoint(): Promise<string>;
  hiddenHumanName: string;
  setHumanDirectoryHidden(hidden: boolean): Promise<void>;
  hideAllChannelForAdmin(): Promise<void>;
  /** Delete the regular `system.canary` channel, so `#system.canary` (the built-in conversations' reference) resolves nothing. */
  removeAppTwin(): Promise<void>;
}

async function insertUser(name: string): Promise<string> {
  const [row] = await getDb().insert(users).values({
    email: `user-channels-${randomUUID()}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return row.id;
}

async function insertMember(serverId: string, userId: string, role: "member"): Promise<void> {
  await getDb().insert(serverMembers).values({ serverId, userId, role });
}

async function insertChannel(serverId: string, name: string, type: "channel" | "private" | "joint"): Promise<string> {
  const [row] = await getDb().insert(channels).values({ serverId, name, type }).returning();
  return row.id;
}

/**
 * Server A (the callers' server) and server B (a joint-channel peer):
 * enabled #all (with a Guest), public, private-joined (both callers / admin
 * only), private-not-joined, archived, a joint channel whose roster lists
 * same-named users only through B's projection (Q3), a joint channel with
 * local members, a joint channel whose projection is disconnected (the roster
 * route 404s), the callers' built-in app conversations (`system.canary`) next
 * to a regular channel named `system.canary`, a channel whose name reads as a
 * thread reference, names differing only in case, and an agent and a human
 * sharing a name.
 */
export async function seedUserChannelsScenario(): Promise<UserChannelsScenario> {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await insertUser(`uc-owner-${suffix}`);
  const aliceId = await insertUser("alice");
  const gwenId = await insertUser("gwen");
  // Names are exact and case-sensitive: "ALICE" is someone else.
  const aliceUpperId = await insertUser("ALICE");
  const boltHumanId = await insertUser("Bolt");
  const bobId = await insertUser(`uc-bob-${suffix}`);

  const serverA = await createServer("User Channels A", `uc-a-${suffix}`, ownerId);
  const serverB = await createServer("User Channels B", `uc-b-${suffix}`, bobId);
  await insertMember(serverA.id, aliceId, "member");
  await insertMember(serverA.id, aliceUpperId, "member");
  await insertMember(serverA.id, boltHumanId, "member");
  await insertMember(serverB.id, aliceId, "member");

  const agentOptions = { runtime: "claude", model: "sonnet" } as const;
  const ada = await createAgent(serverA.id, "Ada", agentOptions);
  const mem = await createAgent(serverA.id, "Mem", agentOptions);
  const scout = await createAgent(serverA.id, "Scout", agentOptions);
  const boltAgent = await createAgent(serverA.id, "Bolt", agentOptions);
  const scoutElsewhere = await createAgent(serverB.id, "Scout", agentOptions);
  await db.update(serverAgentMembers).set({ role: "admin" }).where(eq(serverAgentMembers.agentId, ada.id));

  const pubOne = await createChannel(serverA.id, "pub-one");
  await addAgent(pubOne.id, scout.id);
  await addAgent(pubOne.id, ada.id);
  await addHuman(pubOne.id, aliceId);

  const pubTwo = await createChannel(serverA.id, "pub-two");
  await addAgent(pubTwo.id, boltAgent.id);
  await addAgent(pubTwo.id, mem.id);
  // gwen is server A's Guest, bound to (and a member of) pub-two.
  await seedBoundGuest({ serverId: serverA.id, userId: gwenId, channelId: pubTwo.id });
  await addHuman(pubTwo.id, aliceUpperId);

  const privAda = await createChannel(serverA.id, "priv-ada", undefined, "private");
  await addAgent(privAda.id, ada.id);
  await addAgent(privAda.id, scout.id);
  await addHuman(privAda.id, aliceId);

  const privBoth = await createChannel(serverA.id, "priv-both", undefined, "private");
  await addAgent(privBoth.id, ada.id);
  await addAgent(privBoth.id, mem.id);
  await addHuman(privBoth.id, boltHumanId);

  // Channel roles (Q1): the admin agent is a channel admin of priv-both, where
  // Mem is a plain member; Scout and alice are channel admins of pub-one and
  // priv-ada, where the callers are plain members (or not members).
  await db.update(channelAgents).set({ role: "admin" }).where(and(eq(channelAgents.channelId, privBoth.id), eq(channelAgents.agentId, ada.id)));
  await db.update(channelAgents).set({ role: "admin" }).where(and(eq(channelAgents.channelId, pubOne.id), eq(channelAgents.agentId, scout.id)));
  await db.update(channelHumans).set({ role: "admin" }).where(and(eq(channelHumans.channelId, privAda.id), eq(channelHumans.userId, aliceId)));

  const privNone = await createChannel(serverA.id, "priv-none", undefined, "private");
  await addAgent(privNone.id, scout.id);
  await addHuman(privNone.id, aliceId);

  const archived = await createChannel(serverA.id, "archived-one");
  await addAgent(archived.id, scout.id);
  await addHuman(archived.id, aliceId);
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));

  // Joint channels: canonical storage on B; A participates through projections.
  const joint = async (name: string, projectionStatus: "active" | "disconnected", hostStatus: "active" | "disconnected" = "active") => {
    const canonical = await insertChannel(serverB.id, `${name}-storage`, "channel");
    const hostProjection = await insertChannel(serverB.id, name, "joint");
    const localProjection = await insertChannel(serverA.id, name, "joint");
    const [row] = await db.insert(jointChannels).values({
      canonicalChannelId: canonical,
      createdByServerId: serverB.id,
      createdByUserId: bobId,
    }).returning();
    await db.insert(jointChannelServers).values([
      { jointChannelId: row.id, serverId: serverB.id, localChannelId: hostProjection, role: "host", joinedByUserId: bobId, status: hostStatus },
      { jointChannelId: row.id, serverId: serverA.id, localChannelId: localProjection, role: "participant", joinedByUserId: ownerId, status: projectionStatus },
    ]);
    return { hostProjection, localProjection };
  };
  const jointPeers = await joint(`joint-peers-${suffix}`, "active");
  await addAgent(jointPeers.localProjection, ada.id);
  await addAgent(jointPeers.localProjection, mem.id);
  // Only B's projection lists a "Scout" (server B's namesake of A's: Q3) and
  // alice (herself, through her server B membership). Human names are unique
  // across users, so a human namesake on another server cannot exist.
  await db.insert(channelAgents).values({ channelId: jointPeers.hostProjection, agentId: scoutElsewhere.id });
  await db.insert(channelHumans).values({ channelId: jointPeers.hostProjection, userId: aliceId });
  await db.insert(channelHumans).values({ channelId: jointPeers.hostProjection, userId: bobId });
  const jointLocal = await joint(`joint-local-${suffix}`, "active");
  await addAgent(jointLocal.localProjection, ada.id);
  await addAgent(jointLocal.localProjection, scout.id);
  await db.insert(channelHumans).values({ channelId: jointLocal.localProjection, userId: aliceId });
  await db.insert(channelHumans).values({ channelId: jointLocal.localProjection, userId: aliceUpperId });
  // Server B's Scout is in it too; A's Scout is listed for its own row.
  await db.insert(channelAgents).values({ channelId: jointLocal.hostProjection, agentId: scoutElsewhere.id });
  const jointGone = await joint(`joint-gone-${suffix}`, "active");
  await addAgent(jointGone.localProjection, ada.id);
  await addAgent(jointGone.localProjection, mem.id);
  await addAgent(jointGone.localProjection, scout.id);
  // The CH rows above, as joint members (computed joint membership).
  await fillJointMembersFromChannelHumans();
  // Keep historical membership rows, then revoke this projection.
  await db.update(jointChannelServers).set({ status: "disconnected" })
    .where(eq(jointChannelServers.localChannelId, jointGone.localProjection));

  // Built-in app conversations (type dm, named by app id) and a regular
  // channel that `#system.canary` resolves to instead.
  const appTwin = await insertChannel(serverA.id, "system.canary", "channel");
  await db.insert(channelAgents).values({ channelId: appTwin, agentId: scout.id });
  for (const agentId of [ada.id, mem.id]) {
    const resolved = await resolveConversation(serverA.id, "system.canary" as Parameters<typeof resolveConversation>[1], agentId);
    assert.equal(resolved.kind, "resolved");
  }
  // `#weird:abcdef12` reads as a thread reference, so its roster never resolves.
  const weird = await insertChannel(serverA.id, "weird:abcdef12", "channel");
  await db.insert(channelAgents).values({ channelId: weird, agentId: scout.id });

  // Distinct createdAt so serverInfo order is total.
  const rows = await db.select({ id: channels.id, name: channels.name }).from(channels).where(eq(channels.serverId, serverA.id));
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (const [index, row] of [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).entries()) {
    await db.update(channels).set({ createdAt: new Date(base + index * 1000) }).where(eq(channels.id, row.id));
  }

  const mint = async (agentId: string, scopes: Array<"read" | "channels">, name: string) => (await mintAgentCredential({
    agentId,
    scopes,
    name,
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const adminApiKey = await mint(ada.id, ["read", "channels"], "user-channels-admin");
  const memberApiKey = await mint(mem.id, ["read", "channels"], "user-channels-member");
  const noChannelsApiKey = await mint(mem.id, ["read"], "user-channels-no-channels");

  return {
    serverId: serverA.id,
    callers: [
      { label: "admin agent", agentId: ada.id, apiKey: adminApiKey },
      { label: "member agent", agentId: mem.id, apiKey: memberApiKey },
    ],
    noChannelsApiKey,
    adminApiKey,
    memberApiKey,
    ownerUserId: ownerId,
    ownerName: `uc-owner-${suffix}`,
    otherServerHumanName: `uc-bob-${suffix}`,
    jointNamesakeOnly: [
      { subject: "Scout", channel: `joint-peers-${suffix}` },
    ],
    jointSelfMember: [
      { subject: "Scout", channel: `joint-local-${suffix}` },
      { subject: "ALICE", channel: `joint-local-${suffix}` },
      { subject: "alice", channel: `joint-local-${suffix}` },
      { subject: "alice", channel: `joint-peers-${suffix}` },
    ],
    async addPeerDisconnectedJoint() {
      const name = `joint-peer-gone-${suffix}`;
      const peerGone = await joint(name, "active", "disconnected");
      await addAgent(peerGone.localProjection, ada.id);
      await addAgent(peerGone.localProjection, mem.id);
      await db.insert(channelAgents).values({ channelId: peerGone.hostProjection, agentId: scoutElsewhere.id });
      await db.insert(channelHumans).values({ channelId: peerGone.hostProjection, userId: aliceId });
      return name;
    },
    hiddenHumanName: "alice",
    async setHumanDirectoryHidden(hidden) {
      await db.update(servers).set({ hideHumansFromMembers: hidden }).where(eq(servers.id, serverA.id));
    },
    async hideAllChannelForAdmin() {
      const [allChannel] = await db.select({ id: channels.id }).from(channels)
        .where(and(eq(channels.serverId, serverA.id), eq(channels.name, "all")));
      await db.update(channels).set({ type: "private" }).where(eq(channels.id, allChannel.id));
      await db.insert(channelAgents).values({ channelId: allChannel.id, agentId: ada.id }).onConflictDoNothing();
    },
    async removeAppTwin() {
      await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, appTwin));
    },
  };
}

type Window = { offset?: number; limit?: number };

/**
 * Subject × window cases. Every request authenticates (an argon2 verify), and
 * the old path costs one roster per inspected channel, so the matrix pairs the
 * subjects with real memberships with several windows and the rest with one.
 */
export interface UserChannelsCase {
  subjects: readonly string[];
  windows: readonly Window[];
}

const SEVERAL_WINDOWS: readonly Window[] = [
  {},
  { offset: 0, limit: 1 },
  { offset: 1, limit: 2 },
  { offset: 5, limit: 4 },
  { offset: 9, limit: 200 },
  { offset: 100, limit: 5 },
];

export function userChannelsCases(scenario: UserChannelsScenario, kind: "all" | "humans" = "all"): UserChannelsCase[] {
  const humans: UserChannelsCase[] = [
    { subjects: ["alice"], windows: SEVERAL_WINDOWS },
    { subjects: ["ALICE", "gwen", "@Bolt", scenario.ownerName], windows: [{}] },
  ];
  if (kind === "humans") return humans;
  return [
    { subjects: ["Scout", "Bolt"], windows: SEVERAL_WINDOWS },
    ...humans,
    { subjects: ["@Scout", " @Mem ", "Ada"], windows: [{ offset: 2, limit: 6 }] },
    { subjects: ["nobody", "scout", scenario.otherServerHumanName], windows: [{}] },
  ];
}

function subjectName(request: string): string {
  const trimmed = request.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

/**
 * The caller's fields of a `server.info` channel row (listChannelsForAgent):
 * its membership, authority, and attention state. Q1: a membership row carries
 * none of them (the shared `userInfo` operation still sets `muted` and
 * `activityMuted` to undefined on every row, as the old algorithm did).
 */
export const CALLER_CHANNEL_FIELDS = [
  "channelRole",
  "channelAuthorityRevision",
  "channelAdminBasis",
  "channelCapabilities",
  "activityMuted",
  "muteFromSeq",
  "prefsVersion",
  "activityMuteSupported",
] as const;

/** The subject's stored channel role in each of these channels (server A's agent or user by exact name), read from the membership tables. */
async function subjectChannelRoles(
  serverId: string,
  user: RaftUserRef,
  channelIds: readonly string[],
): Promise<Map<string, "member" | "admin">> {
  if (channelIds.length === 0) return new Map();
  const db = getDb();
  const rows = user.kind === "agent"
    ? await db.select({ channelId: channelAgents.channelId, role: channelAgents.role })
      .from(channelAgents)
      .innerJoin(agents, eq(agents.id, channelAgents.agentId))
      .where(and(eq(agents.serverId, serverId), eq(agents.name, user.value.name), inArray(channelAgents.channelId, [...channelIds])))
    : await db.select({ channelId: channelHumans.channelId, role: channelHumans.role })
      .from(channelHumans)
      .innerJoin(users, eq(users.id, channelHumans.userId))
      .where(and(eq(users.name, user.value.name), inArray(channelHumans.channelId, [...channelIds])));
  return new Map(rows.map((row) => [row.channelId, row.role]));
}

/** Counts of the old algorithm's results the listed differences changed. */
export interface ListedDifferences {
  /** Q3: joint memberships of a namesake only, dropped. */
  jointNamesakeOnly: number;
  /** Q2: built-in conversations the old algorithm listed (a same-named regular channel's roster), dropped. */
  builtInListed: number;
  /** Q2: built-in conversations the old algorithm skipped (`#<appId>` resolved nothing), now inspected. */
  builtInSkipped: number;
  /** Q1: rows whose caller fields were removed. */
  callerFieldRows: number;
  /** Q1: rows given the subject's channel role, by role. */
  subjectRoles: { member: number; admin: number };
}

/**
 * The old algorithm's outcome with the listed differences applied (Q3, Q2,
 * Q1; see the header). `client` is the caller's: Q2 reads which inspected
 * channels are built-in conversations from its server.info, and whether their
 * roster read was refused from its roster route.
 */
async function withListedDifferences(
  outcome: RaftOutcome<RaftUserInfo, "info">,
  name: string,
  request: { offset?: number; limit?: number },
  scenario: UserChannelsScenario,
  client: Pick<AgentApiClient, "server" | "channels">,
): Promise<{ outcome: RaftOutcome<RaftUserInfo, "info">; differences: ListedDifferences }> {
  const differences: ListedDifferences = {
    jointNamesakeOnly: 0,
    builtInListed: 0,
    builtInSkipped: 0,
    callerFieldRows: 0,
    subjectRoles: { member: 0, admin: 0 },
  };
  if (!outcome.ok) return { outcome, differences };
  const { user, page } = outcome.data;
  let { memberships, skippedChannels } = outcome.data;

  // Q3
  const namesakeOnly = new Set(scenario.jointNamesakeOnly.filter((pair) => pair.subject === name).map((pair) => pair.channel));
  const withoutNamesakes = memberships.filter((channel) => !(channel.type === "joint" && namesakeOnly.has(channel.name)));
  differences.jointNamesakeOnly = memberships.length - withoutNamesakes.length;
  memberships = withoutNamesakes;

  // Q2
  const info = await client.server.info();
  assert.ok(info.ok);
  const offset = request.offset ?? 0;
  const limit = request.limit ?? 50;
  const builtIns = (info.data.channels as AgentChannelInfo[]).slice(offset, offset + limit).filter((channel) => channel.type === "dm");
  for (const builtIn of builtIns) {
    const listed = memberships.some((channel) => channel.id === builtIn.id);
    if (listed) {
      memberships = memberships.filter((channel) => channel.id !== builtIn.id);
      differences.builtInListed += 1;
    } else if (!(await client.channels.members({ channel: `#${builtIn.name}` })).ok) {
      skippedChannels -= 1;
      differences.builtInSkipped += 1;
    }
  }

  // Q1
  const roleBearing = memberships.filter((channel) => (channel.type === "channel" || channel.type === "private") && channel.name !== "all");
  const roles = await subjectChannelRoles(scenario.serverId, user, roleBearing.map((channel) => String(channel.id)));
  memberships = memberships.map((channel) => {
    const row: Record<string, unknown> = { ...channel };
    if (CALLER_CHANNEL_FIELDS.some((field) => field in row)) differences.callerFieldRows += 1;
    for (const field of CALLER_CHANNEL_FIELDS) delete row[field];
    row.activityMuted = undefined;
    const role = roleBearing.includes(channel) ? roles.get(String(channel.id)) : undefined;
    assert.ok(!roleBearing.includes(channel) || role, `${name} is listed in #${channel.name} without a membership row`);
    if (role) {
      row.channelRole = role;
      differences.subjectRoles[role] += 1;
    }
    return row as unknown as AgentChannelInfo;
  });

  return {
    outcome: {
      ...outcome,
      data: { ...outcome.data, memberships, skippedChannels },
      text: formatAgentUserInfo(user, memberships, page, skippedChannels),
    },
    differences,
  };
}

/**
 * Old algorithm vs `userInfo` over the new route for every caller × case:
 * identical outcome (data, text, next) but for the listed differences (Q3,
 * Q2, Q1), and one request on the new path. Returns counts so a scenario that
 * quietly lost its memberships (or its cases of a difference) fails the
 * caller's floor.
 */
export async function assertUserChannelsParity(
  baseUrl: string,
  scenario: UserChannelsScenario,
  label: string,
  cases: readonly UserChannelsCase[] = userChannelsCases(scenario),
  callers: UserChannelsScenario["callers"] = scenario.callers,
): Promise<{
  comparisons: number;
  memberships: number;
  skipped: number;
  notFound: number;
  /** Old-algorithm memberships dropped as namesake-only (Q3), by subject kind (humans: always 0). */
  jointNamesakeOnly: { agent: number; human: number };
  /** Joint memberships of the subject itself, listed, by subject kind. */
  jointSelfMember: { agent: number; human: number };
  /** Q2 and Q1 differences, summed (see ListedDifferences). */
  builtInListed: number;
  builtInSkipped: number;
  callerFieldRows: number;
  subjectRoles: { member: number; admin: number };
}> {
  const totals = {
    comparisons: 0,
    memberships: 0,
    skipped: 0,
    notFound: 0,
    jointNamesakeOnly: { agent: 0, human: 0 },
    jointSelfMember: { agent: 0, human: 0 },
    builtInListed: 0,
    builtInSkipped: 0,
    callerFieldRows: 0,
    subjectRoles: { member: 0, admin: 0 },
  };
  for (const caller of callers) {
    for (const { subjects, windows } of cases) {
      for (const name of subjects) {
        for (const window of windows) {
          const request = { name, ...window };
          const context = `${label} / ${caller.label} / ${JSON.stringify(request)}`;
          const subject = subjectName(name);
          const oracleClient = agentApiClientFor(baseUrl, caller.apiKey).client;
          const legacy = await legacyUserInfo(oracleClient, request);
          const { outcome: expected, differences } = await withListedDifferences(legacy, subject, window, scenario, oracleClient);
          const current = agentApiClientFor(baseUrl, caller.apiKey);
          const actual = await userInfo(current.client, request);
          assert.deepStrictEqual(actual, expected, context);
          assert.deepEqual(current.paths.map((path) => path.split("?")[0]), [`/internal/agent-api/users/${encodeURIComponent(subject)}/channels`], context);
          totals.comparisons += 1;
          if (actual.ok) {
            const kind = actual.data.user.kind;
            totals.jointNamesakeOnly[kind] += differences.jointNamesakeOnly;
            totals.builtInListed += differences.builtInListed;
            totals.builtInSkipped += differences.builtInSkipped;
            totals.callerFieldRows += differences.callerFieldRows;
            totals.subjectRoles.member += differences.subjectRoles.member;
            totals.subjectRoles.admin += differences.subjectRoles.admin;
            // Q1, directly: no row carries a caller field, and every role is the subject's.
            for (const channel of actual.data.memberships) {
              for (const field of CALLER_CHANNEL_FIELDS) {
                if (field === "channelRole" || field === "activityMuted") continue;
                assert.ok(!(field in channel), `${context}: #${channel.name} carries ${field}`);
              }
            }
            const selfMember = new Set(scenario.jointSelfMember.filter((pair) => pair.subject === subject).map((pair) => pair.channel));
            totals.jointSelfMember[kind] += actual.data.memberships.filter((channel) => channel.type === "joint" && selfMember.has(channel.name)).length;
          }
          if (expected.ok) {
            totals.memberships += expected.data.memberships.length;
            totals.skipped += expected.data.skippedChannels;
          } else {
            assert.equal(expected.error.code, "NOT_FOUND", context);
            totals.notFound += 1;
          }
        }
      }
    }
  }
  return totals;
}

/** A credential without `channels`: today every roster is refused; now the route is, and server.info answers (two requests). */
export async function assertNoChannelsCapabilityParity(
  baseUrl: string,
  scenario: UserChannelsScenario,
  label: string,
): Promise<number> {
  let comparisons = 0;
  for (const request of [{ name: "Scout" }, { name: "alice", offset: 3, limit: 2 }, { name: "nobody" }]) {
    const context = `${label} / no channels capability / ${JSON.stringify(request)}`;
    const expected = await legacyUserInfo(agentApiClientFor(baseUrl, scenario.noChannelsApiKey).client, request);
    const current = agentApiClientFor(baseUrl, scenario.noChannelsApiKey);
    const actual = await userInfo(current.client, request);
    assert.deepStrictEqual(actual, expected, context);
    assert.equal(current.paths.length, 2, context);
    assert.equal(current.paths[1], "/internal/agent-api/server", context);
    comparisons += 1;
  }
  return comparisons;
}
