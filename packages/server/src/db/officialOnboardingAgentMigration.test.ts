import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";
import { OFFICIAL_ONBOARDING_AGENT_IDENTITY } from "../services/officialOnboardingAgentIdentity";

// servers.official_onboarding_agent_id: the greeter split from Cindy. The backfill copies a
// greeter that is this server's live agent named Cindy, whether or not she passes the strict
// identity test (that test judges usable/unusable, and identity adoption repairs her);
// servers whose only completion record was that pointer get their owner rows completed as
// reconcileOwnersToSetupCheckpoint does ('grandfathered').
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_official_onboarding_agent"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("hot tables: a 2 s lock wait, then the column, the backfill and the completion records", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "official_onboarding_agent", { maxMs: 2_000 });
  assert.equal(steps[1], `ALTER TABLE "servers" ADD COLUMN "official_onboarding_agent_id" uuid;`);
  assert.equal(steps.length, 4);
});

test("the backfill keys on the name (trimmed, case-insensitive), not on the strict identity test", async () => {
  const backfill = (await migration())[2]!;
  assert.ok(backfill.includes(`lower(btrim(a."name")) = '${OFFICIAL_ONBOARDING_AGENT_IDENTITY.name.toLowerCase()}'`));
  assert.ok(!backfill.includes(`deleted_at`), "a deleted Cindy keeps her official pointer");
  for (const strict of ["avatar_url", "display_name", "description", "server_agent_members"]) {
    assert.ok(!backfill.includes(strict), `${strict} is the usable/unusable test, not the backfill's`);
  }
});

const SCHEMA = `
  CREATE TABLE servers (id text PRIMARY KEY, onboarding_agent_id uuid);
  CREATE TABLE agents (id uuid PRIMARY KEY, server_id text NOT NULL, name text NOT NULL, display_name text,
    description text, avatar_url text, deleted_at timestamptz);
  CREATE TABLE server_agent_members (server_id text NOT NULL, agent_id uuid NOT NULL, role text NOT NULL);
  CREATE TABLE server_members (server_id text NOT NULL, user_id text NOT NULL, role text NOT NULL,
    setup_status text NOT NULL DEFAULT 'not_started', setup_completion_reason text);
`;

let nextId = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

async function seed(db: PGlite, server: string, agent: {
  name?: string; displayName?: string | null; description?: string | null; avatarUrl?: string | null;
  role?: string | null; agentServer?: string; deleted?: boolean;
}, members: Array<[user: string, role: string, status?: string, reason?: string | null]>) {
  const id = uuid();
  const identity = OFFICIAL_ONBOARDING_AGENT_IDENTITY;
  await db.query(`INSERT INTO agents (id, server_id, name, display_name, description, avatar_url, deleted_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    id, agent.agentServer ?? server, agent.name ?? identity.name,
    agent.displayName === undefined ? identity.displayName : agent.displayName,
    agent.description === undefined ? identity.description : agent.description,
    agent.avatarUrl === undefined ? identity.avatarUrl : agent.avatarUrl,
    agent.deleted ? new Date() : null,
  ]);
  const role = agent.role === undefined ? identity.serverRole : agent.role;
  if (role) await db.query(`INSERT INTO server_agent_members VALUES ($1, $2, $3)`, [agent.agentServer ?? server, id, role]);
  await db.query(`INSERT INTO servers VALUES ($1, $2)`, [server, id]);
  for (const [user, memberRole, status = "not_started", reason = null] of members) {
    await db.query(`INSERT INTO server_members VALUES ($1, $2, $3, $4, $5)`, [server, user, memberRole, status, reason]);
  }
  return id;
}

test("backfills a greeter that is the server's live Cindy, conforming or not, and completes owners only where nobody completed", async () => {
  const db = new PGlite();
  try {
    await db.exec(SCHEMA);
    const cindy = await seed(db, "cindy", {}, [["o1", "owner"], ["o2", "owner"], ["m1", "member"]]);
    await seed(db, "helper", { name: "Helper", displayName: "Helper", description: null, avatarUrl: "pixel:robot" }, [["o", "owner"]]);
    // Old or owner-edited Cindys: they fail the strict identity test and ARE her.
    const memberRole = await seed(db, "member-role", { role: "member" }, [["o", "owner"]]);
    const renamed = await seed(db, "renamed", { displayName: "Cindy Bot", description: null }, [["o", "owner"]]);
    const oldAvatar = await seed(db, "old-avatar", { avatarUrl: "pixel:finch", role: null }, [["o", "owner"]]);
    // deleteAgent sets deleted_at and drops the membership.
    const deleted = await seed(db, "deleted", { role: null, deleted: true }, [["o", "owner"]]);
    await seed(db, "foreign", { agentServer: "elsewhere" }, [["o", "owner"]]);
    // Trimmed and case-insensitive, like Create Cindy's duplicate check.
    const lowercase = await seed(db, "lowercase", { name: " cindy " }, [["o", "owner"]]);
    const done = await seed(db, "done", {}, [["o1", "owner", "complete", "normal"], ["o2", "owner"]]);
    await db.query(`INSERT INTO servers VALUES ('none', NULL)`);
    await db.query(`INSERT INTO server_members VALUES ('none', 'o', 'owner', 'not_started', NULL)`);

    const run = async () => {
      await db.exec("BEGIN");
      for (const step of await migration()) {
        if (step.startsWith("ALTER TABLE") && (await db.query(`SELECT 1 FROM information_schema.columns WHERE column_name = 'official_onboarding_agent_id'`)).rows.length) continue;
        await db.exec(step);
      }
      await db.exec("COMMIT");
    };
    await run();

    const official = Object.fromEntries((await db.query<{ id: string; official: string | null }>(
      `SELECT id, official_onboarding_agent_id AS official FROM servers`,
    )).rows.map((row) => [row.id, row.official]));
    assert.deepEqual(official, {
      cindy, helper: null, "member-role": memberRole, renamed, "old-avatar": oldAvatar, deleted, foreign: null, lowercase, done, none: null,
    });

    const setup = async () => (await db.query<{ k: string; s: string; r: string | null }>(
      `SELECT server_id || '/' || user_id AS k, setup_status AS s, setup_completion_reason AS r FROM server_members ORDER BY 1`,
    )).rows;
    const after = await setup();
    assert.deepEqual(after, [
      { k: "cindy/m1", s: "not_started", r: null },
      { k: "cindy/o1", s: "complete", r: "grandfathered" },
      { k: "cindy/o2", s: "complete", r: "grandfathered" },
      { k: "deleted/o", s: "complete", r: "grandfathered" },
      { k: "done/o1", s: "complete", r: "normal" },
      { k: "done/o2", s: "not_started", r: null }, // already complete through o1; the projection reads that
      { k: "foreign/o", s: "not_started", r: null },
      { k: "helper/o", s: "not_started", r: null },
      { k: "lowercase/o", s: "complete", r: "grandfathered" },
      { k: "member-role/o", s: "complete", r: "grandfathered" },
      { k: "none/o", s: "not_started", r: null },
      { k: "old-avatar/o", s: "complete", r: "grandfathered" },
      { k: "renamed/o", s: "complete", r: "grandfathered" },
    ]);

    await run();
    assert.deepEqual(await setup(), after, "a rerun of the backfill changes nothing");
  } finally {
    await db.close();
  }
});
