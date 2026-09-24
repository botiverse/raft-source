import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, serverMembers, servers, users } from "./schema.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// The defer-retirement backfill (task #172, Phase N).
//
// This test executes the MIGRATION FILE ITSELF, read off disk, not a copy of its SQL. An earlier
// draft inlined the statement here and described itself as "kept in sync with the migration" —
// which is a promise, not a mechanism. Nothing would have failed if the shipped migration and
// this test drifted apart, and a green run would then be evidence about a string that no
// environment will ever execute. Reading the artifact makes drift impossible instead of
// discouraged.
//
// ONE statement, deliberately GLOBAL — no server join, no kind/deleted/role scope. Phase N+1
// drops the `deferred` value and tightens the CHECK, and a single stray `deferred` row anywhere
// (a soft-deleted server, a joint_storage server, an ordinary member) would break that. Clearing
// globally is what makes the full-table `deferred = 0` receipt true.
//
// A deferred row is blocksChat = false — the owner had already bypassed into chat — so it moves
// FORWARD to complete. Rewinding to not_started would re-lock a server that works today.
//
// There is deliberately no second "ever had an agent" bucket. An earlier draft carried one keyed
// on `EXISTS (SELECT 1 FROM agents …)`, which disagreed with the runtime's own checkpoint
// (`everHadAgent = !!servers.onboarding_agent_id`) and matched 0 rows in production. The online
// reconcile in serverService already holds that invariant on every owner-entry and checkpoint
// write path, so a second, differently-defined patch would only widen the surface for mistakes.
const MIGRATION_FILE = "0223_retire_defer_setup_status.sql";
const MIGRATION_PATH = fileURLToPath(new URL(`../../drizzle/${MIGRATION_FILE}`, import.meta.url));

/**
 * The shipped migration, minus comment-only lines. Statement text is untouched.
 *
 * If the file is renamed or renumbered this throws rather than silently testing nothing, and the
 * guard below fails loudly if it ever stops being the one statement this suite reasons about.
 */
function readMigrationSql(): string {
  const raw = readFileSync(MIGRATION_PATH, "utf8");
  const body = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
  assert.ok(body.length > 0, `${MIGRATION_FILE} has no executable SQL`);
  assert.equal(
    body.split("--> statement-breakpoint").length,
    1,
    `${MIGRATION_FILE} gained a second statement; this suite reasons about exactly one`,
  );
  assert.match(body, /UPDATE\s+"server_members"/i);
  assert.match(body, /WHERE\s+"setup_status"\s*=\s*'deferred'/i);
  return body;
}

const RETIRE_DEFER_BACKFILL = sql.raw(readMigrationSql());

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

type SetupStatus = "not_started" | "in_progress" | "deferred" | "complete";
type SetupReason = "normal" | "grandfathered" | "complete_after_defer" | "admin_override" | null;

async function setSetup(serverId: string, userId: string, status: SetupStatus, reason: SetupReason) {
  await getDb().update(serverMembers)
    .set({ setupStatus: status, setupCompletionReason: reason })
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
}

async function joinAs(serverId: string, userId: string, role: "member" | "owner", status: SetupStatus) {
  await getDb().insert(serverMembers).values({ serverId, userId, role });
  await setSetup(serverId, userId, status, null);
}

async function readSetup(serverId: string, userId: string) {
  const [row] = await getDb().select({
    role: serverMembers.role,
    status: serverMembers.setupStatus,
    reason: serverMembers.setupCompletionReason,
  }).from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row;
}

test("defer retirement backfill: every deferred row anywhere becomes complete/grandfathered, nothing else moves", async ({ app }) => {
  const db = getDb();

  // A — the ordinary case: deferred owner on a live normal server (the 41 in production).
  const ownerA = await seedUser("dr-a");
  const serverA = await createServer("A live-deferred", `dr-a-${randomUUID()}`, ownerA.id);
  await setSetup(serverA.id, ownerA.id, "deferred", null);

  // B — deferred owner on a SOFT-DELETED server (the 9). The global sweep must still clear it,
  // or Phase N+1's CHECK tightening trips on a row nobody can even see.
  const ownerB = await seedUser("dr-b");
  const serverB = await createServer("B deleted", `dr-b-${randomUUID()}`, ownerB.id);
  await setSetup(serverB.id, ownerB.id, "deferred", null);
  await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, serverB.id));

  // C — deferred on a joint_storage server: outside the old scoped predicate, still cleared.
  const ownerC = await seedUser("dr-c");
  const serverC = await createServer("C joint", `dr-c-${randomUUID()}`, ownerC.id);
  await db.update(servers).set({ kind: "joint_storage" }).where(eq(servers.id, serverC.id));
  await setSetup(serverC.id, ownerC.id, "deferred", null);

  // D — a deferred ORDINARY MEMBER row. Setup is owner-only so the state is meaningless for
  // them, but the value still has to go or Phase N+1 breaks. The production audit counts
  // OWNER rows; this sweep is deliberately wider than that count.
  const ownerD = await seedUser("dr-d-owner");
  const memberD = await seedUser("dr-d-member");
  const serverD = await createServer("D member-deferred", `dr-d-${randomUUID()}`, ownerD.id);
  await joinAs(serverD.id, memberD.id, "member", "deferred");

  // E/F/G — untouched controls: genuinely pending, a real completion, and a historical
  // complete_after_defer (task #172 keeps those rows exactly as they are).
  const ownerE = await seedUser("dr-e");
  const serverE = await createServer("E pending", `dr-e-${randomUUID()}`, ownerE.id);
  await setSetup(serverE.id, ownerE.id, "not_started", null);

  const ownerF = await seedUser("dr-f");
  const serverF = await createServer("F normal-complete", `dr-f-${randomUUID()}`, ownerF.id);
  await setSetup(serverF.id, ownerF.id, "complete", "normal");

  const ownerG = await seedUser("dr-g");
  const serverG = await createServer("G after-defer", `dr-g-${randomUUID()}`, ownerG.id);
  await setSetup(serverG.id, ownerG.id, "complete", "complete_after_defer");

  // H — a server that HAS an agent but whose owner is mid-flow. The removed "ever had agent"
  // bucket would have grandfathered this; the online reconcile owns it now, so the backfill
  // must leave it alone.
  const ownerH = await seedUser("dr-h");
  const serverH = await createServer("H agent-in-progress", `dr-h-${randomUUID()}`, ownerH.id);
  await db.insert(agents).values({
    serverId: serverH.id, name: "helper", displayName: "Helper",
    description: "not the onboarding agent", avatarUrl: "pixel:robot", runtime: "codex",
  });
  await setSetup(serverH.id, ownerH.id, "in_progress", null);

  const before = await db.select({ n: sql<number>`count(*)::int` }).from(serverMembers)
    .where(eq(serverMembers.setupStatus, "deferred"));
  assert.equal(before[0].n, 4, "before: A, B, C and the ordinary-member row D are deferred");

  await db.execute(RETIRE_DEFER_BACKFILL);

  for (const [label, serverId, userId] of [
    ["live", serverA.id, ownerA.id],
    ["soft-deleted", serverB.id, ownerB.id],
    ["joint_storage", serverC.id, ownerC.id],
    ["ordinary member", serverD.id, memberD.id],
  ] as const) {
    const row = await readSetup(serverId, userId);
    assert.equal(row.status, "complete", `${label} deferred row moved forward`);
    assert.equal(row.reason, "grandfathered", `${label} row is marked legacy-exempt, not a real completion`);
  }

  assert.deepEqual(await readSetup(serverE.id, ownerE.id), { role: "owner", status: "not_started", reason: null }, "a genuinely pending owner is untouched");
  assert.deepEqual(await readSetup(serverF.id, ownerF.id), { role: "owner", status: "complete", reason: "normal" }, "a real completion keeps its reason");
  assert.deepEqual(await readSetup(serverG.id, ownerG.id), { role: "owner", status: "complete", reason: "complete_after_defer" }, "historical complete_after_defer is preserved");
  assert.deepEqual(await readSetup(serverH.id, ownerH.id), { role: "owner", status: "in_progress", reason: null }, "no ever-had-agent bucket: the online reconcile owns this row");

  const after = await db.select({ n: sql<number>`count(*)::int` }).from(serverMembers)
    .where(eq(serverMembers.setupStatus, "deferred"));
  assert.equal(after[0].n, 0, "full-table deferred = 0, with no scope caveats");

  // Idempotent: a rerun is a no-op, row for row.
  const snapshot = async () => db.select({
    serverId: serverMembers.serverId,
    userId: serverMembers.userId,
    status: serverMembers.setupStatus,
    reason: serverMembers.setupCompletionReason,
  }).from(serverMembers).orderBy(serverMembers.serverId, serverMembers.userId);
  const settled = await snapshot();
  await db.execute(RETIRE_DEFER_BACKFILL);
  assert.deepEqual(await snapshot(), settled, "rerun changes nothing");
});
