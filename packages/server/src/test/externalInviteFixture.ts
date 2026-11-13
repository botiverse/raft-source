import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { isInTransaction } from "../db/ambientTransaction";
import { getDb } from "../db/index";
import { featureFlagRules, featureFlags, serverMembers, users } from "../db/schema";
import { addHuman, createChannel } from "../services/channelService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { __setInviteSourcesStartedBarrierForTests } from "../services/externalInviteConnectService";
import { createServer } from "../services/serverService";
import { fixturePasswordHash } from "./integration/credentials";
import { seedBoundGuest } from "./guestFixture";

// External channel invite fixtures (#wg-rbac:#16): the host side (P2a-1) and the invitee side (P2a-2).

export async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

export async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/**
 * The retired joint_member_connect_v1 (#wg-rbac:#55), as a deployment may
 * still store it until an operator deletes it: on for `allow` (a server allow
 * rule), or off for everyone (`"killed"`: the kill switch, no rule). Nothing
 * reads it; tests store it to prove that.
 */
export async function storeRetiredMemberConnectFlag(state: { allow: string[] } | "killed"): Promise<void> {
  const key = "joint_member_connect_v1";
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, key));
  await getDb().insert(featureFlags)
    .values({ key, randomizationUnit: "server", salt: "retired", defaultEnabled: false, killSwitch: state === "killed" })
    .onConflictDoUpdate({ target: featureFlags.key, set: { killSwitch: state === "killed" } });
  if (state !== "killed") {
    await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: key, stage: "server", priority: 0, decision: "allow", values: state.allow });
  }
}

export async function enableExternalChannelsFlag(serverId: string): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

export function captureEmails(): { deliveries: EmailDelivery[]; stop: () => void } {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

export function tokenOf(delivery: EmailDelivery): string {
  const match = /\/external-invite\/([0-9a-f]{64})/.exec(delivery.html);
  assert.ok(match, "the email links /external-invite/<token>");
  return match[1]!;
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A host Server with an owner, an admin, a member, a channel-admin member and a Guest, and a private channel they all belong to. */
export async function seedWorld(baseUrl: string, options: { flag?: boolean } = {}) {
  const tag = randomUUID().slice(0, 8);
  const owner = await seedUser(`ext-owner-${tag}`);
  const admin = await seedUser(`ext-admin-${tag}`);
  const member = await seedUser(`ext-member-${tag}`);
  const channelAdmin = await seedUser(`ext-chadmin-${tag}`);
  const guest = await seedUser(`ext-guest-${tag}`);
  const server = await createServer("External Host", `ext-host-${tag}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: server.id, userId: channelAdmin.id, role: "member" },
  ]);
  const room = await createChannel(server.id, `ext-room-${tag}`, undefined, "private", { type: "user", id: owner.id });
  await addHuman(room.id, admin.id);
  await addHuman(room.id, member.id);
  await addHuman(room.id, channelAdmin.id, { role: "admin" });
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: room.id });
  if (options.flag !== false) await enableExternalChannelsFlag(server.id);
  const tokens = Object.fromEntries(await Promise.all(
    Object.entries({ owner, admin, member, channelAdmin, guest }).map(async ([key, user]) => [key, await login(baseUrl, user.email)] as const),
  )) as Record<"owner" | "admin" | "member" | "channelAdmin" | "guest", string>;
  const call = (as: keyof typeof tokens, method: string, path: string, body?: unknown) => fetch(`${baseUrl}/api/channels/${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[as]}`, "Content-Type": "application/json", "X-Server-Id": server.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { tag, owner, admin, member, channelAdmin, guest, server, room, call };
}

/**
 * Real-PG race tests: parks connections on their invite rows (`FOR UPDATE` in `holder`'s open transaction) only once
 * `starts` operation starts on them ended. A connection's start (initializeInviteSources) is its own short
 * transaction locking the invite row first and nothing else: a hold taken before it would stop the connection there,
 * holding no lock, instead of at its own transaction's invite row lock, the last lock it takes after every other.
 * Every start is let through once all have ended and the rows are held. Returns the cleanup (idempotent).
 */
export function parkInviteRowsAfterStarts(
  holder: { query: (text: string, values: unknown[]) => Promise<unknown> },
  inviteIds: readonly string[],
  starts = inviteIds.length,
): () => void {
  const ids = new Set(inviteIds);
  let arrived = 0;
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  __setInviteSourcesStartedBarrierForTests(async (inviteId) => {
    if (!ids.has(inviteId)) return;
    // After the start's transaction, in the connection's own context: the hold (a raw client of its own) and the
    // connection after it run in no ambient transaction (db/ambientTransaction), never as a savepoint of another.
    assert.equal(isInTransaction(), false, "the operation start's transaction has ended");
    arrived += 1;
    if (arrived === starts) {
      for (const id of ids) await holder.query("SELECT id FROM channel_external_invites WHERE id = $1 FOR UPDATE", [id]);
      __setInviteSourcesStartedBarrierForTests(null);
      open();
    }
    await held;
  });
  return () => __setInviteSourcesStartedBarrierForTests(null);
}
