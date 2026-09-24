import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, serverMembers, servers, users } from "../db/schema.js";
import { addMember, createServer, transitionMemberRole, updateServerOnboardingAgent, updateServerOnboardingSettings } from "./serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * #4883 — a member promoted to owner on an already-configured server must NOT be dropped back
 * into "Meet Cindy". Setup is owner-only, so once promoted the projection reads their row; if it
 * is still pre-checkpoint on a server that already has Cindy, they are shown Create Cindy for an
 * agent that already exists. `transitionMemberRole` reconciles the row in the same transaction.
 */

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "test-hash",
    emailVerified: true,
  }).returning();
  return user;
}

// Give the server a Cindy: create an agent and point servers.onboarding_agent_id at it — the
// exact fact the projection reads as `everHadAgent` / "checkpoint crossed".
async function giveServerCindy(serverId: string) {
  const db = getDb();
  const [agent] = await db.insert(agents).values({
    serverId,
    name: "Cindy",
    displayName: "Onboarding Assistant",
    description: "official",
    avatarUrl: "pixel:mug",
    runtime: "claude",
  }).returning();
  await db.update(servers).set({ onboardingAgentId: agent.id }).where(eq(servers.id, serverId));
  return agent;
}

type SetupStatus = "not_started" | "in_progress" | "deferred" | "complete";

async function joinAsMember(serverId: string, userId: string, setupStatus: SetupStatus = "not_started") {
  await getDb().insert(serverMembers).values({ serverId, userId, role: "member" });
  await getDb().update(serverMembers)
    .set({ setupStatus })
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
}

async function readSetup(serverId: string, userId: string) {
  const [row] = await getDb().select({
    role: serverMembers.role,
    status: serverMembers.setupStatus,
    reason: serverMembers.setupCompletionReason,
  }).from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row;
}

async function promoteToOwner(serverId: string, actorUserId: string, targetUserId: string) {
  await transitionMemberRole({
    serverId,
    actorUserId,
    targetUserId,
    nextRole: "owner",
    guestTransitionsEnabled: true,
  });
}

test("promoting a member to owner on a server with Cindy reconciles their setup to complete", async ({ app }) => {
  const owner = await seedUser("promote-owner");
  const joiner = await seedUser("promote-joiner");
  const server = await createServer("Promote", `promote-${randomUUID()}`, owner.id);
  await giveServerCindy(server.id);
  await joinAsMember(server.id, joiner.id);

  // Pre: the joiner is a not_started member — the drift that Meet Cindy reads after promotion.
  assert.deepEqual(await readSetup(server.id, joiner.id), { role: "member", status: "not_started", reason: null });

  await promoteToOwner(server.id, owner.id, joiner.id);

  assert.deepEqual(
    await readSetup(server.id, joiner.id),
    { role: "owner", status: "complete", reason: "grandfathered" },
    "the promoted owner inherits the server's crossed checkpoint",
  );
});

test("promotion on a server WITHOUT Cindy does not fabricate completion", async ({ app }) => {
  const owner = await seedUser("nocindy-owner");
  const joiner = await seedUser("nocindy-joiner");
  const server = await createServer("NoCindy", `nocindy-${randomUUID()}`, owner.id);
  // No giveServerCindy: checkpoint not crossed.
  await joinAsMember(server.id, joiner.id);

  await promoteToOwner(server.id, owner.id, joiner.id);

  assert.deepEqual(
    await readSetup(server.id, joiner.id),
    { role: "owner", status: "not_started", reason: null },
    "setup genuinely pending — the new owner should still be guided to set up",
  );
});

test("promotion never clobbers an already-complete row's reason", async ({ app }) => {
  const owner = await seedUser("clobber-owner");
  const joiner = await seedUser("clobber-joiner");
  const server = await createServer("Clobber", `clobber-${randomUUID()}`, owner.id);
  await giveServerCindy(server.id);
  await joinAsMember(server.id, joiner.id, "complete");
  // A row that finished the real flow keeps its 'normal' reason.
  await getDb().update(serverMembers)
    .set({ setupCompletionReason: "normal" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, joiner.id)));

  await promoteToOwner(server.id, owner.id, joiner.id);

  assert.deepEqual(
    await readSetup(server.id, joiner.id),
    { role: "owner", status: "complete", reason: "normal" },
    "an already-complete owner keeps their original completion reason",
  );
});

test("adding a member straight in as owner on a server with Cindy reconciles their setup", async ({ app }) => {
  const owner = await seedUser("directadd-owner");
  const joiner = await seedUser("directadd-joiner");
  const server = await createServer("DirectAdd", `directadd-${randomUUID()}`, owner.id);
  await giveServerCindy(server.id);

  // The second write path into (owner × checkpoint): direct add, not promote.
  await addMember(server.id, joiner.id, "owner");

  assert.deepEqual(
    await readSetup(server.id, joiner.id),
    { role: "owner", status: "complete", reason: "grandfathered" },
    "a directly-added owner must not land on Meet Cindy either",
  );
});

test("crossing the checkpoint sweeps a co-owner who existed before Cindy; original owner keeps normal", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("precheckpoint-owner");
  const coOwner = await seedUser("precheckpoint-coowner");
  const server = await createServer("PreCheckpoint", `precheckpoint-${randomUUID()}`, owner.id);

  // Original owner has finished the real flow (as first-agent creation would stamp them).
  await db.update(serverMembers).set({ setupStatus: "complete", setupCompletionReason: "normal" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));

  // A co-owner exists BEFORE the checkpoint — no Cindy yet, so promotion leaves them pending.
  await joinAsMember(server.id, coOwner.id);
  await promoteToOwner(server.id, owner.id, coOwner.id);
  assert.equal((await readSetup(server.id, coOwner.id)).status, "not_started", "no Cindy yet ⇒ still pending");

  // Now Cindy is created and the checkpoint is crossed through the real setter.
  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: "Cindy", displayName: "Onboarding Assistant",
    description: "official", avatarUrl: "pixel:mug", runtime: "claude",
  }).returning();
  await updateServerOnboardingAgent(server.id, agent.id);

  assert.deepEqual(await readSetup(server.id, coOwner.id), { role: "owner", status: "complete", reason: "grandfathered" }, "the pre-existing co-owner is swept on checkpoint crossing");
  assert.deepEqual(await readSetup(server.id, owner.id), { role: "owner", status: "complete", reason: "normal" }, "the original owner's normal completion is preserved");
});

test("crossing the checkpoint via Settings (onboarding-settings) also sweeps a pre-existing co-owner", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("settings-owner");
  const coOwner = await seedUser("settings-coowner");
  const server = await createServer("Settings", `settings-${randomUUID()}`, owner.id);
  await joinAsMember(server.id, coOwner.id);
  await promoteToOwner(server.id, owner.id, coOwner.id); // no Cindy yet ⇒ stays not_started

  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: "Cindy", displayName: "Onboarding Assistant",
    description: "official", avatarUrl: "pixel:mug", runtime: "claude",
  }).returning();
  // The Settings path (PATCH /onboarding-settings) is a distinct checkpoint setter.
  await updateServerOnboardingSettings(server.id, { onboardingAgentId: agent.id });

  assert.deepEqual(
    await readSetup(server.id, coOwner.id),
    { role: "owner", status: "complete", reason: "grandfathered" },
    "setting the onboarding agent through Settings must reconcile owners too",
  );
});

// Mirrors drizzle/0193 — kept in sync so the backfill LOGIC is exercised against seeded drift.
const BACKFILL = sql`
  UPDATE "server_members" sm
  SET "setup_status" = 'complete', "setup_completion_reason" = 'grandfathered'
  FROM "servers" s
  WHERE sm."server_id" = s."id"
    AND s."deleted_at" IS NULL
    AND s."onboarding_agent_id" IS NOT NULL
    AND sm."role" = 'owner'
    AND sm."setup_status" <> 'complete'
`;

test("0193 backfill: drifted owners on checkpoint-crossed servers, keyed on role not owner_id", async ({ app }) => {
  const db = getDb();

  // Server with Cindy: original owner (drifted), a promoted co-owner (drifted), an ordinary
  // member (must NOT be touched — setup is owner-only), all not_started.
  const ownerA = await seedUser("bf-ownerA");
  const coOwnerA = await seedUser("bf-coownerA");
  const memberA = await seedUser("bf-memberA");
  const serverA = await createServer("A", `bf-a-${randomUUID()}`, ownerA.id);
  await giveServerCindy(serverA.id);
  await db.update(serverMembers).set({ setupStatus: "not_started", setupCompletionReason: null })
    .where(and(eq(serverMembers.serverId, serverA.id), eq(serverMembers.userId, ownerA.id)));
  await joinAsMember(serverA.id, coOwnerA.id);
  await db.update(serverMembers).set({ role: "owner" })
    .where(and(eq(serverMembers.serverId, serverA.id), eq(serverMembers.userId, coOwnerA.id)));
  await joinAsMember(serverA.id, memberA.id);

  // Server without Cindy: owner not_started — genuinely pending, out of scope.
  const ownerB = await seedUser("bf-ownerB");
  const serverB = await createServer("B", `bf-b-${randomUUID()}`, ownerB.id);
  await db.update(serverMembers).set({ setupStatus: "not_started", setupCompletionReason: null })
    .where(and(eq(serverMembers.serverId, serverB.id), eq(serverMembers.userId, ownerB.id)));

  // Server with Cindy but owner already complete via normal flow — reason must be preserved.
  const ownerC = await seedUser("bf-ownerC");
  const serverC = await createServer("C", `bf-c-${randomUUID()}`, ownerC.id);
  await giveServerCindy(serverC.id);
  await db.update(serverMembers).set({ setupStatus: "complete", setupCompletionReason: "normal" })
    .where(and(eq(serverMembers.serverId, serverC.id), eq(serverMembers.userId, ownerC.id)));

  await db.execute(BACKFILL);

  assert.deepEqual(await readSetup(serverA.id, ownerA.id), { role: "owner", status: "complete", reason: "grandfathered" }, "original owner reconciled");
  assert.deepEqual(await readSetup(serverA.id, coOwnerA.id), { role: "owner", status: "complete", reason: "grandfathered" }, "promoted co-owner reconciled (role, not owner_id)");
  assert.deepEqual(await readSetup(serverA.id, memberA.id), { role: "member", status: "not_started", reason: null }, "ordinary member untouched");
  assert.deepEqual(await readSetup(serverB.id, ownerB.id), { role: "owner", status: "not_started", reason: null }, "no-Cindy server out of scope");
  assert.deepEqual(await readSetup(serverC.id, ownerC.id), { role: "owner", status: "complete", reason: "normal" }, "existing normal completion preserved");

  // Idempotent: rerun changes nothing.
  const before = await db.select({ n: sql<number>`count(*)::int` }).from(serverMembers)
    .where(and(eq(serverMembers.setupStatus, "complete"), eq(serverMembers.setupCompletionReason, "grandfathered")));
  await db.execute(BACKFILL);
  const after = await db.select({ n: sql<number>`count(*)::int` }).from(serverMembers)
    .where(and(eq(serverMembers.setupStatus, "complete"), eq(serverMembers.setupCompletionReason, "grandfathered")));
  assert.equal(after[0].n, before[0].n, "rerun grandfathers no additional rows");
});
