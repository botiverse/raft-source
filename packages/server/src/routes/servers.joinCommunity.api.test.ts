import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { servers, subscriptions, users } from "../db/schema";
import { createServer as createServerRecord } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * Regression guard for `POST /api/servers/join-community`.
 *
 * Contract: any authenticated (verified) user can call this endpoint and be
 * added as a regular member of the server whose slug is "community". If the
 * community server isn't seeded on this deployment the endpoint returns 404;
 * if the caller is already a member it returns 400.
 *
 * This test exists because the Sidebar "Join community" menu entry
 * depends on exactly this endpoint shape — the same regression that flipped
 * the button from "join" to "this server doesn't exist" would happen if the
 * route path, verb, or error-code mapping changed silently.
 */

async function seedVerifiedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



test("POST /servers/join-community joins the community server as a new member", async ({ app }) => {
  const owner = await seedVerifiedUser("jc-owner@slock.test", "jc-owner");
  await createServerRecord("The Community", "community", owner.id);

  const joiner = await seedVerifiedUser("jc-joiner@slock.test", "jc-joiner");
  const token = await tokenForHuman("jc-joiner@slock.test");

  const res = await fetch(`${app.baseUrl}/api/servers/join-community`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  assert.equal(res.status, 200, `join must succeed (status=${res.status})`);
  const body = await res.json() as { serverId: string; serverName: string };
  assert.equal(body.serverName, "The Community");
  assert.ok(body.serverId);

  // The /servers listing must now include the community server for this
  // user — this is what the sidebar's "already joined?" check reads from.
  const listRes = await fetch(`${app.baseUrl}/api/servers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(listRes.status, 200);
  const list = await listRes.json() as Array<{ slug: string; role: string }>;
  const joined = list.find((s) => s.slug === "community");
  assert.ok(joined, "joined user must see /community in their server list");
  assert.equal(joined!.role, "member", "community joiner must land as 'member', not 'owner'/'admin'");

  // joiner just to keep the linter from flagging it as unused data
  void joiner;
});

test("POST /servers/join-community on a full Pro server answers the seat code, not the head counts", async ({ app }) => {
  const owner = await seedVerifiedUser("jc-full-owner@slock.test", "jc-full-owner");
  const community = await createServerRecord("The Community", "community", owner.id);
  // Billing applies to `free` plus a Pro subscription; one seat, which the owner takes.
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, community.id));
  await getDb().insert(subscriptions).values({
    serverId: community.id,
    plan: "pro",
    provider: "stripe",
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripeProPackItemId: `si_pro_${randomUUID()}`,
    status: "active",
    provisionedHumanSeats: 1,
    provisionedAgentSeats: 10,
    proPackQuantity: 1,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdByUserId: owner.id,
    updatedByUserId: owner.id,
  });

  await seedVerifiedUser("jc-full-joiner@slock.test", "jc-full-joiner");
  const res = await fetch(`${app.baseUrl}/api/servers/join-community`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await tokenForHuman("jc-full-joiner@slock.test")}`,
    },
  });
  assert.equal(res.status, 403);
  const body = await res.json() as { error: string; code?: string; capacityLimit?: unknown };
  assert.match(body.error, /Seat limit reached/);
  assert.equal(body.code, "human_seat_limit_reached");
  assert.equal(body.capacityLimit, undefined, "someone joining isn't a member yet");
});

test("POST /servers/join-community can join the Chinese community slug", async ({ app }) => {
  const owner = await seedVerifiedUser("jc-cn-owner@slock.test", "jc-cn-owner");
  await createServerRecord("中文社区", "community-cn", owner.id);

  await seedVerifiedUser("jc-cn-joiner@slock.test", "jc-cn-joiner");
  const token = await tokenForHuman("jc-cn-joiner@slock.test");

  const res = await fetch(`${app.baseUrl}/api/servers/join-community`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ slug: "community-cn" }),
  });
  assert.equal(res.status, 200, `Chinese community join must succeed (status=${res.status})`);
  const body = await res.json() as { serverId: string; serverName: string };
  assert.equal(body.serverName, "中文社区");

  const listRes = await fetch(`${app.baseUrl}/api/servers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(listRes.status, 200);
  const list = await listRes.json() as Array<{ slug: string; role: string }>;
  const joined = list.find((s) => s.slug === "community-cn");
  assert.ok(joined, "joined user must see /community-cn in their server list");
  assert.equal(joined!.role, "member");
});

test("POST /servers/join-community rejects unknown community slugs", async ({ app }) => {
  await seedVerifiedUser("jc-invalid@slock.test", "jc-invalid");
  const token = await tokenForHuman("jc-invalid@slock.test");

  const res = await fetch(`${app.baseUrl}/api/servers/join-community`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ slug: "not-community" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error?: string };
  assert.match(body.error ?? "", /unsupported/i);
});

test("POST /servers/join-community returns 400 if the caller is already a member", async ({ app }) => {
  const owner = await seedVerifiedUser("jc-owner2@slock.test", "jc-owner2");
  await createServerRecord("The Community", "community", owner.id);

  // Owner is already a member (implicit from createServer). Trying to
  // re-join must be refused — the sidebar uses this signal to keep the
  // button hidden for existing members.
  const ownerToken = await tokenForHuman("jc-owner2@slock.test");
  const res = await fetch(`${app.baseUrl}/api/servers/join-community`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
  });
  assert.equal(res.status, 400, `already-member path must return 400 (status=${res.status})`);
  const body = await res.json() as { error?: string };
  assert.match(body.error ?? "", /already/i);
});

test("POST /servers/join-community returns 404 when the community server is not seeded", async ({ app }) => {
  await seedVerifiedUser("jc-lonely@slock.test", "jc-lonely");
  const token = await tokenForHuman("jc-lonely@slock.test");

  const res = await fetch(`${app.baseUrl}/api/servers/join-community`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  assert.equal(res.status, 404, `missing-community path must return 404 (status=${res.status})`);
  const body = await res.json() as { error?: string };
  assert.match(body.error ?? "", /not available/i);
});

test("POST /servers/join-community rejects unauthenticated callers", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/servers/join-community`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  // requireAuth middleware returns 401 on missing token. We only assert
  // the class of response so any reasonable auth surface is acceptable.
  assert.ok(res.status === 401 || res.status === 403, `must refuse unauth (status=${res.status})`);
});
