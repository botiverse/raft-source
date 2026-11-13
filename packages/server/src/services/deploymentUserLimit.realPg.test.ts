// Real-PostgreSQL proof that the Raft License's user limit (deploymentUserLimit.ts)
// holds under concurrency: two transactions that would each make one more person
// count serialize on the deployment-wide advisory lock and count after it, so
// exactly one of them commits. PGlite runs one transaction at a time and cannot
// show this.
//
// Each case holds the lock from a separate session, starts both transactions,
// waits until both have written their seat and are queued on the lock, then
// lets them go. Without the lock (or with the count read before it) both would
// see the deployment at the limit only with their own row, and both commit.
//
// Runs in `test:joint-source-preview-real-pg` (JOINT_SOURCE_PREVIEW_REAL_PG_URL,
// an admin URL: the case creates its own database, as the deployment-wide count
// must not see other files' rows, and drops it).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import pg from "pg";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import { serverMembers, users } from "../db/schema";
import { HUMAN_USER_LIMIT } from "../edition";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { fixturePasswordHash } from "../test/integration/credentials";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { createChannel } from "./channelService";
import { countHumanUserAccounts, DEPLOYMENT_USER_LIMIT_LOCK_NAMESPACE, DeploymentUserLimitError } from "./deploymentUserLimit";
import { addMember, createServer } from "./serverService";

vi.mock("../edition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../edition")>();
  return { ...actual, humanUserLimit: () => actual.humanUserLimit("source-available") };
});

const outside = AsyncResource.bind(<T>(run: () => Promise<T>): Promise<T> => run());
type Settled = { ok: true } | { ok: false; error: unknown };
const start = (run: () => Promise<unknown>): Promise<Settled> => outside(async () => {
  assert.equal(isInTransaction(), false, "each competitor runs its own transaction");
  return run();
}).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));

async function person(label: string) {
  const name = `${label}-${randomUUID().slice(0, 8)}`;
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

/** Until `count` sessions wait on the deployment-wide lock (held by the observer). */
async function untilQueued(observer: pg.Client, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ n: number }>(
      `SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = $1::bigint::oid AND objid = 0 AND objsubid = 2`,
      [DEPLOYMENT_USER_LIMIT_LOCK_NAMESPACE],
    );
    if (Number(rows[0]?.n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${count} sessions to queue on the user limit lock`);
}

async function withDeployment(label: string, body: (observer: pg.Client) => Promise<void>): Promise<void> {
  await withJointRealPgDatabase(label, async (url) => {
    await openTestDatabase(url);
    const observer = new pg.Client({ connectionString: url, application_name: `${label}-observer` });
    observer.on("error", () => {});
    await observer.connect();
    try {
      await body(observer);
    } finally {
      await observer.end();
      await closeTestDatabase();
    }
  });
}

/** Both competitors written and queued behind the observer's hold of the lock, then let go. */
async function race(observer: pg.Client, competitors: Array<() => Promise<unknown>>): Promise<Settled[]> {
  await observer.query("SELECT pg_advisory_lock($1, 0)", [DEPLOYMENT_USER_LIMIT_LOCK_NAMESPACE]);
  let released = false;
  try {
    const running = competitors.map((run) => start(run));
    await untilQueued(observer, competitors.length);
    await observer.query("SELECT pg_advisory_unlock($1, 0)", [DEPLOYMENT_USER_LIMIT_LOCK_NAMESPACE]);
    released = true;
    return await Promise.all(running);
  } finally {
    if (!released) await observer.query("SELECT pg_advisory_unlock_all()");
  }
}

function assertOneRefused(results: Settled[]): void {
  assert.equal(results.filter((result) => result.ok).length, 1, "exactly one commits");
  const refused = results.find((result) => !result.ok);
  assert.ok(refused && !refused.ok && refused.error instanceof DeploymentUserLimitError, `the other is refused: ${refused && !refused.ok ? String(refused.error) : ""}`);
}

test.skipIf(skipJointRealPg)("two people joining at once for the last place: exactly one gets in", async () => {
  await withDeployment("user_limit_last_place", async (observer) => {
    const owner = await person("owner");
    const home = await createServer("Home", `home-${randomUUID().slice(0, 8)}`, owner.id);
    for (let i = 1; i < HUMAN_USER_LIMIT - 1; i += 1) {
      await getDb().insert(serverMembers).values({ serverId: home.id, userId: (await person(`member-${i}`)).id, role: "member" });
    }
    // Two servers: joining one server also takes its rows (#all), which would queue the second join there instead.
    const other = await createServer("Other", `other-${randomUUID().slice(0, 8)}`, owner.id);
    assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT - 1);
    const [fifth, sixth] = [await person("fifth"), await person("sixth")];

    assertOneRefused(await race(observer, [() => addMember(home.id, fifth.id), () => addMember(other.id, sixth.id)]));
    assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT);
  });
}, 60_000);

test.skipIf(skipJointRealPg)("one person taking two Guest seats at once at the limit: only the first, which takes no place", async () => {
  await withDeployment("user_limit_two_guest_seats", async (observer) => {
    const owner = await person("owner");
    const home = await createServer("Home", `home-${randomUUID().slice(0, 8)}`, owner.id);
    for (let i = 1; i < HUMAN_USER_LIMIT; i += 1) {
      await getDb().insert(serverMembers).values({ serverId: home.id, userId: (await person(`member-${i}`)).id, role: "member" });
    }
    const hostA = await createServer("Host A", `host-a-${randomUUID().slice(0, 8)}`, owner.id);
    const hostB = await createServer("Host B", `host-b-${randomUUID().slice(0, 8)}`, owner.id);
    const roomA = await createChannel(hostA.id, "room-a", undefined, "private");
    const roomB = await createChannel(hostB.id, "room-b", undefined, "private");
    assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT);
    const guest = await person("guest");

    assertOneRefused(await race(observer, [
      () => addMember(hostA.id, guest.id, "guest", { guestChannelId: roomA.id }),
      () => addMember(hostB.id, guest.id, "guest", { guestChannelId: roomB.id }),
    ]));
    assert.equal(await countHumanUserAccounts(), HUMAN_USER_LIMIT);
  });
}, 60_000);
