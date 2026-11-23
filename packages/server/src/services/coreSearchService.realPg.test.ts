// The latency target of core's `channels` and `people` search groups
// (docs/contracts/web-search.md, Performance): p95 under 150 ms in a server
// with ~1,000 channels and ~1,000 members, on a real PostgreSQL holding 20
// other servers of that size too. Seeds that
// server (public, private, archived channels; the reader in a fifth of them;
// members and Guests; agents), runs each group's search the way the route
// does (searchCoreGroup: its own read-only transaction under the statement
// timeout) for broad and narrow words, and prints p50/p95.
//
// A measurement, not a CI gate: runs when CORE_SEARCH_REAL_PG_URL is set (an
// admin URL; a database is created and dropped), e.g. a local
// `docker run -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16`;
// CORE_SEARCH_REPORT_FILE=<path> also writes the timings there.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { asServerId } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { agents, channelHumans, channels, serverMembers, users } from "../db/schema";
import { searchCoreGroup } from "../routes/search";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { createServer } from "./serverService";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const REAL_PG_URL = process.env.CORE_SEARCH_REAL_PG_URL;
const CHANNELS = 1_000;
const MEMBERS = 1_000;
const OTHER_SERVERS = 20;
const RUNS = 40;
const P95_TARGET_MS = 150;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

test(
  "real PostgreSQL: channels and people search stay under the p95 target in a server of ~1k channels and ~1k members",
  { skip: !REAL_PG_URL, timeout: 600_000 },
  async () => {
    const databaseName = `slock_core_search_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL });
    let initialized = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(REAL_PG_URL!);
      url.pathname = `/${databaseName}`;
      const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
      await migrateRealPgTestDatabase(pool, MIGRATIONS_FOLDER);
      await pool.end();
      await initDatabase(url.toString(), undefined, { log: () => {} });
      initialized = true;
      const db = getDb();

      const words = ["design", "infra", "launch", "support", "growth", "billing", "mobile", "search", "ops", "data"];
      const people = await db.insert(users).values(Array.from({ length: MEMBERS }, (_, i) => ({
        name: `user-${words[i % words.length]}-${i}`,
        email: `user-${i}@perf.invalid`,
        displayName: `${words[(i * 7) % words.length]} person ${i}`,
        passwordHash: "x",
        emailVerified: true,
      }))).returning({ id: users.id });
      const reader = people[0]!.id;
      const server = await createServer("Perf", `perf-${randomBytes(3).toString("hex")}`, reader);
      const serverId = asServerId(server.id);
      const created = await db.insert(channels).values(Array.from({ length: CHANNELS }, (_, i) => ({
        serverId,
        name: `${words[i % words.length]}-${i}`,
        description: i % 3 === 0 ? `About ${words[(i + 3) % words.length]} work` : null,
        type: (i % 5 === 0 ? "private" : "channel") as "private" | "channel",
        archivedAt: i % 4 === 0 ? new Date() : null,
      }))).returning({ id: channels.id, type: channels.type });
      // Members (a few Guests, each bound to a channel), the reader in every fifth channel.
      await db.insert(serverMembers).values(people.slice(1).map((person, i) => (i % 50 === 0
        ? { serverId, userId: person.id, role: "guest" as const, guestChannelId: created[i]!.id }
        : { serverId, userId: person.id, role: "member" as const })));
      await db.insert(channelHumans).values(created.filter((_, i) => i % 5 === 0 || i % 7 === 0).map((channel) => ({ channelId: channel.id, userId: reader })));
      await db.insert(agents).values(Array.from({ length: 100 }, (_, i) => ({
        serverId, name: `bot-${words[i % words.length]}-${i}`, displayName: `${words[i % words.length]} bot`, model: "sonnet", runtime: "claude",
      })) as never);
      // Other servers' rows, as a shared database has them: 20 servers of 1,000
      // channels and 1,000 members each, so the plans below are the ones a
      // big table gets (the reader's server read through its indexes).
      for (let other = 0; other < OTHER_SERVERS; other += 1) {
        const otherPeople = await db.insert(users).values(Array.from({ length: MEMBERS }, (_, i) => ({
          name: `o${other}-user-${words[i % words.length]}-${i}`,
          email: `o${other}-user-${i}@perf.invalid`,
          displayName: `${words[(i * 3) % words.length]} other ${i}`,
          passwordHash: "x",
          emailVerified: true,
        }))).returning({ id: users.id });
        const otherServer = await createServer(`Other ${other}`, `perf-o${other}-${randomBytes(3).toString("hex")}`, otherPeople[0]!.id);
        await db.insert(serverMembers).values(otherPeople.slice(1).map((person) => ({ serverId: otherServer.id, userId: person.id, role: "member" as const })));
        await db.insert(channels).values(Array.from({ length: CHANNELS }, (_, i) => ({
          serverId: otherServer.id, name: `${words[i % words.length]}-${i}`, type: "channel" as const,
        })));
      }
      const target = new pg.Client({ connectionString: url.toString() });
      await target.connect();
      await target.query("ANALYZE");
      await target.end();

      const report: string[] = [];
      for (const group of ["channels", "people"] as const) {
        for (const q of ["s", "design", "growth-1", "nothing-matches"]) {
          const times: number[] = [];
          let total = 0;
          for (let run = 0; run < RUNS; run += 1) {
            const started = performance.now();
            const answer = await searchCoreGroup(group, { viewer: { userId: reader, serverId }, q, limit: 10, cursor: null });
            times.push(performance.now() - started);
            assert.equal(answer.kind, "page", JSON.stringify(answer));
            if (answer.kind === "page") total = answer.total;
          }
          const warm = times.slice(5);
          const p50 = percentile(warm, 50);
          const p95 = percentile(warm, 95);
          report.push(`${group} q=${JSON.stringify(q)} total=${total} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
          assert.ok(p95 < P95_TARGET_MS, `${group} q=${q}: p95 ${p95.toFixed(1)} ms`);
        }
      }
      // The plans the match queries get (the server-scoped indexes, not a sequential scan of the table).
      const plans: string[] = [];
      const planClient = new pg.Client({ connectionString: url.toString() });
      await planClient.connect();
      for (const statement of [
        `EXPLAIN SELECT id FROM channels WHERE server_id = $1 AND type IN ('channel', 'private', 'joint') AND deleted_at IS NULL AND (name ILIKE '%design%' OR description ILIKE '%design%')`,
        `EXPLAIN SELECT person.id FROM server_members sm CROSS JOIN LATERAL (SELECT u.id, u.name, u.display_name, u.retired_at FROM users u WHERE u.id = sm.user_id OFFSET 0) person WHERE sm.server_id = $1 AND person.retired_at IS NULL AND (person.name ILIKE '%design%' OR person.display_name ILIKE '%design%')`,
        `EXPLAIN SELECT id FROM agents WHERE server_id = $1 AND deleted_at IS NULL AND (name ILIKE '%design%' OR display_name ILIKE '%design%')`,
      ]) {
        const plan = await planClient.query(statement, [serverId]);
        plans.push(plan.rows.map((row: Record<string, string>) => row["QUERY PLAN"]).join("\n"));
      }
      await planClient.end();
      const summary = `core search on real PostgreSQL (${CHANNELS} channels, ${MEMBERS} members, ${OTHER_SERVERS} other servers alike, ${RUNS - 5} warm runs each):\n${report.join("\n")}\n\n${plans.join("\n\n")}\n`;
      // Printed where vitest shows it; CORE_SEARCH_REPORT_FILE also keeps it.
      process.stderr.write(summary);
      if (process.env.CORE_SEARCH_REPORT_FILE) writeFileSync(process.env.CORE_SEARCH_REPORT_FILE, summary);
    } finally {
      if (initialized) await closeDatabase();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
