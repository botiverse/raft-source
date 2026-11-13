// Real-PostgreSQL proof that binding an agent to a machine and taking that machine's Computer away cannot interleave
// into "bound onto a revoked Computer", nor slip an agent past the others' agents gate (computerAgents.ts), through
// either way a person takes one Computer away: the web revoke (POST /api/servers/:id/machines/:machineId/revoke-computer-key)
// and the Computer's own detach (POST /internal/computer/detach, `raft-computer detach`).
//
// Both revokes lock the machine row FOR UPDATE, read what is bound to it, and revoke the key in one transaction. A bind
// (here creating an agent onto the machine, agentService.createAgent) takes the machine row FOR SHARE first
// (lockMachineTakingAgents) and then checks the key is live. So one order wins:
// - the bind first: the revoke waits for it, then sees someone else's agent and answers the 409, revoking nothing;
// - the revoke first: the bind waits until the revoke has committed, then sees the key revoked and binds nothing.
// Every wait is proven to be blocked by the expected backend (pg_blocking_pids). PGlite serializes transactions, so
// only a real multi-connection Postgres can show this.
//
// Runs with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the other fence teeth; `test:actor-membership-fence-real-pg`).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { getDb } from "../db/index";
import { agents, computers, integrationAuditEvents, machines, serverMembers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { MachineKeyRevokedError } from "../services/computerAgents";
import { attachComputer } from "../services/computerCredentialService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";

const test = createApiTest();

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: TEST_TIMEOUT_MS };

type TestApp = Awaited<ReturnType<typeof openTestApp>>;
type Reply = { status: number; body: Record<string, any> | null };

async function withRealPgApp(run: (app: TestApp, observer: pg.Pool) => Promise<void>) {
  assert.ok(REAL_PG_URL, "ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL is required");
  const observer = new pg.Pool({ connectionString: REAL_PG_URL, max: 4 });
  try {
    await migrateRealPgTestDatabase(observer, MIGRATIONS_FOLDER);
    const app = await openTestApp(REAL_PG_URL, 0, { skipAuthRateLimit: true });
    try {
      await run(app, observer);
    } finally {
      await app.close();
    }
  } finally {
    await observer.end();
  }
}

/** Waits until a backend running `queryLike` is lock-waiting behind `blockedBy`, and returns its pid. */
async function waitForLockWaiter(observer: pg.Pool, queryLike: string, blockedBy: number): Promise<number> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND $2::int = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [queryLike, blockedBy],
    );
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`no backend waited on a lock for ${queryLike} behind pid ${blockedBy} within ${LOCK_WAIT_TIMEOUT_MS}ms`);
}

function trackSettled<T>(promise: Promise<T>) {
  const state = { settled: false };
  const tracked = promise.finally(() => { state.settled = true; });
  tracked.catch(() => undefined);
  return { tracked, state };
}

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `revoke-bind-race-${label}-${suffix}@raft.test`,
    name: `revoke-bind-race-${label}-${suffix}`,
    displayName: `revoke-bind-race-${label}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/**
 * The person's attached laptop (a real Computer key) in a server shared with a colleague, and the colleague's agent
 * on the colleague's own box.
 */
async function seed(app: TestApp) {
  const person = await seedUser("person");
  const colleague = await seedUser("colleague");
  const suffix = randomUUID().slice(0, 8);
  const server = await createServer(`Revoke Bind Race ${suffix}`, `revoke-bind-race-${suffix}`, person.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: colleague.id, role: "member" });
  const attached = await attachComputer({ userId: person.id, serverSlug: server.slug, name: "laptop" });
  assert.ok(attached.ok, "attach");
  const laptop = { apiKey: attached.apiKey, computerId: attached.serverMachineId, machineId: attached.machineId };
  const [box] = await getDb().insert(machines).values({ serverId: server.id, userId: colleague.id, name: "their-box", apiKeyHash: `hash-${randomUUID()}`, runtimes: ["claude"] }).returning();
  const agent = await createAgent(server.id, `colleagues-${suffix}`, { runtime: "claude", machineId: box!.id, creatorType: "user", creatorId: colleague.id });
  // The key's first use stamps last_used_at; done now, so no auth write touches the Computer row during the race.
  const self = await fetch(`${app.baseUrl}/internal/computer/self`, { headers: { Authorization: `Bearer ${laptop.apiKey}` } });
  assert.equal(self.status, 200);
  return { person, colleague, server, laptop, agent };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function json(res: Response): Promise<Reply> {
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
}

/** The two ways to take the laptop away, as their real HTTP routes. */
const REVOKES = {
  web: async (app: TestApp, s: Seeded) => json(await fetch(`${app.baseUrl}/api/servers/${s.server.id}/machines/${s.laptop.machineId}/revoke-computer-key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenForHuman(s.person.email)}`, "X-Server-Id": s.server.id, "Content-Type": "application/json" },
    body: "{}",
  })),
  detach: async (app: TestApp, s: Seeded) => json(await fetch(`${app.baseUrl}/internal/computer/detach`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.laptop.apiKey}`, "Content-Type": "application/json" },
    body: "{}",
  })),
} as const;

async function laptopState(s: Seeded) {
  const [key] = await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.id, s.laptop.computerId));
  const onLaptop = await getDb().select({ id: agents.id }).from(agents).where(eq(agents.machineId, s.laptop.machineId));
  return { keyRevoked: Boolean(key!.revokedAt), agentsOnLaptop: onLaptop.map((agent) => agent.id) };
}

/** The colleague creates another agent of theirs onto the laptop; `afterInsert` runs inside its transaction. */
function createOntoLaptop(s: Seeded, afterInsert?: NonNullable<Parameters<typeof createAgent>[2]>["afterInsert"]) {
  return createAgent(s.server.id, `onto-laptop-${randomUUID().slice(0, 8)}`, {
    runtime: "claude",
    machineId: s.laptop.machineId,
    creatorType: "user",
    creatorId: s.colleague.id,
    afterInsert,
  });
}

for (const via of ["web", "detach"] as const) {
  test(`real PG (${via}): a bind in flight first — the revoke waits on the machine row, then sees the agent and answers the 409`, REAL_PG_TEST, async () => {
    await withRealPgApp(async (app, observer) => {
      const s = await seed(app);
      // The real bind (createAgent onto the laptop), held open after its machine lock and write until released.
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let bound!: (pid: number) => void;
      const bindPid = new Promise<number>((resolve) => { bound = resolve; });
      const bind = trackSettled(createOntoLaptop(s, async (tx) => {
        const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        bound(Number(rows[0]!.pid));
        await held;
      }));
      let revoke: ReturnType<typeof trackSettled<Reply>> | undefined;
      try {
        const pid = await bindPid;
        revoke = trackSettled(REVOKES[via](app, s));
        await waitForLockWaiter(observer, '%from "daemons"%for update%', pid);
        assert.equal(revoke.state.settled, false, "the revoke waits for the bind");
      } finally {
        release();
      }
      const created = await bind.tracked;
      const res = await revoke!.tracked;
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body?.code, "others_agents_on_computer");
      assert.deepEqual(res.body?.agents.map((agent: { id: string }) => agent.id), [created.id]);
      assert.deepEqual(await laptopState(s), { keyRevoked: false, agentsOnLaptop: [created.id] }, "bound onto a live Computer; nothing revoked");
    });
  });

  test(`real PG (${via}): the revoke first — a bind waits on the machine row until the revoke has committed, then binds nothing`, REAL_PG_TEST, async () => {
    await withRealPgApp(async (app, observer) => {
      const s = await seed(app);
      // Hold the laptop's Computer row so the revoke stops at its key revoke, after its check, with the machine locked.
      const hold = await observer.connect();
      let revoke: ReturnType<typeof trackSettled<Reply>> | undefined;
      let assign: ReturnType<typeof trackSettled<unknown>> | undefined;
      try {
        await hold.query("BEGIN");
        const { rows: [holder] } = await hold.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await hold.query("SELECT 1 FROM computers WHERE id = $1 FOR UPDATE", [s.laptop.computerId]);
        revoke = trackSettled(REVOKES[via](app, s));
        // The web revoke stops at its key revoke; the detach at its Computer row lock, also after the machine lock.
        const revokePid = await waitForLockWaiter(observer, via === "web" ? '%update "computers"%' : '%from "computers"%for update%', holder!.pid);
        assign = trackSettled(createOntoLaptop(s));
        await waitForLockWaiter(observer, '%from "daemons"%for share%', revokePid);
        assert.equal(assign.state.settled, false, "the bind waits behind the revoke's machine lock");
        await hold.query("COMMIT");
      } finally {
        await hold.query("ROLLBACK").catch(() => undefined);
        hold.release();
      }
      const revoked = await revoke!.tracked;
      assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
      await assert.rejects(assign!.tracked, MachineKeyRevokedError);
      assert.deepEqual(await laptopState(s), { keyRevoked: true, agentsOnLaptop: [] }, "never bound onto the revoked Computer");
    });
  });
}

test("real PG (detach): a forced detach racing an ungated revoke (the revoke link) unbinds nothing and audits nothing when the other revoke wins", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const s = await seed(app);
    await getDb().update(agents).set({ machineId: s.laptop.machineId, status: "active" }).where(eq(agents.id, s.agent.id));
    // The revoke link takes the Computer row only: hold it, revoke it there, and commit while the detach waits.
    const link = await observer.connect();
    let detach: ReturnType<typeof trackSettled<Reply>> | undefined;
    try {
      await link.query("BEGIN");
      const { rows: [holder] } = await link.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await link.query("SELECT 1 FROM computers WHERE id = $1 FOR UPDATE", [s.laptop.computerId]);
      detach = trackSettled(fetch(`${app.baseUrl}/internal/computer/detach`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.laptop.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ forceAgentIds: [s.agent.id] }),
      }).then(json));
      await waitForLockWaiter(observer, '%from "computers"%for update%', holder!.pid);
      assert.equal(detach.state.settled, false, "the detach waits on the Computer row before its gate");
      await link.query("UPDATE computers SET revoked_at = now(), revoked_reason = 'computer_key_revoked' WHERE id = $1", [s.laptop.computerId]);
      await link.query("COMMIT");
    } finally {
      await link.query("ROLLBACK").catch(() => undefined);
      link.release();
    }
    const res = await detach!.tracked;
    assert.deepEqual([res.status, res.body?.code], [401, "computer_revoked"], JSON.stringify(res.body));
    const [agent] = await getDb().select({ machineId: agents.machineId, status: agents.status, reason: agents.machineReleaseReason }).from(agents).where(eq(agents.id, s.agent.id));
    assert.deepEqual(agent, { machineId: s.laptop.machineId, status: "active", reason: null }, "still bound: nothing unbound");
    const audits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "computer.revoke_unbound_others_agents"), eq(integrationAuditEvents.targetId, s.laptop.machineId)));
    assert.deepEqual(audits, [], "no unbind audit");
  });
});
