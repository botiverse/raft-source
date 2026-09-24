import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { seedPlaywrightScenario } from "../test/seedPlaywrightScenario.js";
import { getDb } from "../db/index.js";
import { announcements, users, serverMembers } from "./schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// The exact grandfathering backfill from migration 0157 (task #118). Kept in sync
// with drizzle/0157_ambiguous_piledriver.sql — pre-migration servers with any live
// agent grandfather ALL their members' durable setup state to complete. The
// migration runs this once, before any live data exists in the check DB, so this
// test exercises the backfill LOGIC directly against seeded data (verify behavior,
// not just that the migration applies).
const GRANDFATHER_BACKFILL = sql`
  UPDATE "server_members" sm
  SET "setup_status" = 'complete', "setup_completion_reason" = 'grandfathered'
  FROM "servers" s
  WHERE sm."server_id" = s."id"
    AND s."deleted_at" IS NULL
    AND EXISTS (SELECT 1 FROM "agents" a WHERE a."server_id" = s."id" AND a."deleted_at" IS NULL)
`;

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

test("0157 backfill: agent-having server → members complete+grandfathered; agentless stays not_started", async ({ app }) => {
  const db = getDb();
  const ownerA = await seedUser("gf-a");
  const ownerB = await seedUser("gf-b");
  const serverA = await createServer("GF A", `gf-a-${randomUUID()}`, ownerA.id);
  const serverB = await createServer("GF B", `gf-b-${randomUUID()}`, ownerB.id);
  await createAgent(serverA.id, "gf-agent", { runtime: "codex" });
  // serverB intentionally has no agent.

  // This test is about what the MIGRATION does to PRE-migration rows, so it has to reproduce
  // a pre-migration row. `createAgent` now records setup completion itself (the ordinary
  // Add-Computer-then-Create-Agent path used to write nothing, which is how servers that were
  // fully configured stayed `not_started` and got the setup gate shoved in their face). So
  // rewind the row by hand here — that is precisely the shape the old data was in, and the
  // shape 0157 was written for.
  await db.update(serverMembers)
    .set({ setupStatus: "not_started", setupCompletionReason: null })
    .where(eq(serverMembers.serverId, serverA.id));

  const [aBefore] = await db.select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverA.id), eq(serverMembers.userId, ownerA.id)));
  assert.equal(aBefore.setupStatus, "not_started", "rewound to the pre-migration shape");
  // New servers are born under the v2 contract now — the one with no bypass. The COLUMN
  // default is still v1, and stays that way for the rows already holding it.
  assert.equal(aBefore.setupContractVersion, "onboarding-setup-v2", "new servers sign the v2 contract");

  await db.execute(GRANDFATHER_BACKFILL);

  const [aRow] = await db.select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverA.id), eq(serverMembers.userId, ownerA.id)));
  const [bRow] = await db.select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverB.id), eq(serverMembers.userId, ownerB.id)));

  assert.equal(aRow.setupStatus, "complete", "agent-having server owner grandfathered to complete");
  assert.equal(aRow.setupCompletionReason, "grandfathered", "grandfathered is the migration-only reason");
  assert.equal(bRow.setupStatus, "not_started", "agentless server owner NOT grandfathered");
  assert.equal(bRow.setupCompletionReason, null, "no completion reason when not complete");
  // contract_version is non-null on every row regardless of grandfathering.
  // The contract version is untouched by grandfathering — it records which rules the row was
  // signed under, not whether setup finished. New servers are born v2 (no bypass).
  assert.equal(aRow.setupContractVersion, "onboarding-setup-v2");
  assert.equal(bRow.setupContractVersion, "onboarding-setup-v2");
});

test("Playwright seed explicitly grandfathers post-migration fixtures past setup and announcement gates", async ({ app }) => {
  const adjacentNewcomer = await seedUser("playwright-scope-control");
  const adjacentServer = await createServer(
    "Playwright scope control",
    `playwright-scope-control-${randomUUID()}`,
    adjacentNewcomer.id,
  );
  const seed = await seedPlaywrightScenario({ messageCount: 1, focusFromEnd: 1 });
  const db = getDb();
  const seededUsers = await db
    .select({
      id: users.id,
      email: users.email,
      profileSetupCompletedAt: users.profileSetupCompletedAt,
      signupSurveyCompletedAt: users.signupSurveyCompletedAt,
      firstOnboardingCompletedAt: users.firstOnboardingCompletedAt,
      firstOnboardingCompletedSessionFamilyId: users.firstOnboardingCompletedSessionFamilyId,
    })
    .from(users)
    .where(inArray(users.email, [seed.user.email, seed.extraHuman.email]));

  assert.equal(seededUsers.length, 2);
  for (const user of seededUsers) {
    assert.ok(user.profileSetupCompletedAt, `${user.email} must bypass account identity setup`);
    assert.ok(user.signupSurveyCompletedAt, `${user.email} must bypass the signup survey`);
    assert.ok(user.firstOnboardingCompletedAt, `${user.email} must carry the legacy onboarding terminal fact`);
    assert.equal(
      user.firstOnboardingCompletedSessionFamilyId,
      null,
      `${user.email} predates session-family onboarding and is eligible in any family-bearing login`,
    );
  }

  const memberships = await db
    .select({
      userId: serverMembers.userId,
      setupStatus: serverMembers.setupStatus,
      setupCompletionReason: serverMembers.setupCompletionReason,
    })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, seed.server.id),
      inArray(serverMembers.userId, seededUsers.map((user) => user.id)),
    ));

  assert.equal(memberships.length, 2);
  for (const membership of memberships) {
    assert.equal(membership.setupStatus, "complete");
    assert.equal(membership.setupCompletionReason, "grandfathered");
  }

  const loginResponse = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: seed.user.email, password: seed.user.password }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json() as { accessToken: string };

  const projectionResponse = await fetch(
    `${app.baseUrl}/api/servers/${seed.server.id}/setup-projection`,
    {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seed.server.id,
      },
    },
  );
  assert.equal(projectionResponse.status, 200);
  const projection = await projectionResponse.json() as {
    surface: string;
    phase: string | null;
    blocksChat: boolean;
    postSetup: { surveyPending: boolean; handoffPending: boolean };
  };
  assert.equal(projection.surface, "complete");
  assert.equal(projection.phase, "complete");
  assert.equal(projection.blocksChat, false);
  assert.equal(projection.postSetup.surveyPending, false);
  assert.equal(projection.postSetup.handoffPending, false);

  const dismissedActiveResponse = await fetch(`${app.baseUrl}/api/announcements/active`, {
    headers: { Authorization: `Bearer ${login.accessToken}` },
  });
  assert.equal(dismissedActiveResponse.status, 200);
  assert.deepEqual(
    (await dismissedActiveResponse.json() as { announcements: Array<{ id: string }> }).announcements,
    [],
    "the pre-dismissed owner must not receive the fixture announcement",
  );

  const extraHumanLoginResponse = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: seed.extraHuman.email, password: seed.extraHuman.password }),
  });
  assert.equal(extraHumanLoginResponse.status, 200);
  const extraHumanLogin = await extraHumanLoginResponse.json() as { accessToken: string };
  const undismissedActiveResponse = await fetch(`${app.baseUrl}/api/announcements/active`, {
    headers: { Authorization: `Bearer ${extraHumanLogin.accessToken}` },
  });
  assert.equal(undismissedActiveResponse.status, 200);
  const undismissedActive = await undismissedActiveResponse.json() as {
    announcements: Array<{ id: string; title: string }>;
  };
  assert.deepEqual(
    undismissedActive.announcements.map((announcement) => announcement.id),
    [seed.announcement.id],
    "the undismissed current fixture must receive the published announcement",
  );
  assert.equal(undismissedActive.announcements[0]?.title, seed.announcement.title);

  await db.delete(announcements).where(eq(announcements.id, seed.announcement.id));
  const noAnnouncementResponse = await fetch(`${app.baseUrl}/api/announcements/active`, {
    headers: { Authorization: `Bearer ${extraHumanLogin.accessToken}` },
  });
  assert.equal(noAnnouncementResponse.status, 200);
  assert.deepEqual(
    (await noAnnouncementResponse.json() as { announcements: unknown[] }).announcements,
    [],
    "an eligible undismissed user still receives nothing when no announcement is published",
  );

  const [adjacentUserAfterSeed] = await db
    .select({
      profileSetupCompletedAt: users.profileSetupCompletedAt,
      signupSurveyCompletedAt: users.signupSurveyCompletedAt,
      firstOnboardingCompletedAt: users.firstOnboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.id, adjacentNewcomer.id));
  assert.equal(
    adjacentUserAfterSeed.profileSetupCompletedAt,
    null,
    "fixture grandfathering must not bypass identity setup for another new user",
  );
  assert.equal(
    adjacentUserAfterSeed.signupSurveyCompletedAt,
    null,
    "fixture grandfathering must not bypass the signup survey for another new user",
  );
  assert.equal(
    adjacentUserAfterSeed.firstOnboardingCompletedAt,
    null,
    "fixture grandfathering must not grant announcement eligibility to another new user",
  );

  const [adjacentMembershipAfterSeed] = await db
    .select({
      setupStatus: serverMembers.setupStatus,
      setupCompletionReason: serverMembers.setupCompletionReason,
    })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, adjacentServer.id),
      eq(serverMembers.userId, adjacentNewcomer.id),
    ));
  assert.equal(
    adjacentMembershipAfterSeed.setupStatus,
    "not_started",
    "fixture grandfathering must not complete another agentless server",
  );
  assert.equal(adjacentMembershipAfterSeed.setupCompletionReason, null);
});
