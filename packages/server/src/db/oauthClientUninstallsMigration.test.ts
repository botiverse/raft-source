import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { integrationAuditEvents, oauthClients, oauthClientUninstalls, servers } from "./schema";
import { dbTest as test } from "../test/integration/dbTest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// oauth_client_uninstalls (GET /api/integrations/marketplace `uninstalledHereAt`):
// one migration adds the new, empty table, its foreign keys (servers and users
// are hot: a 2 s lock wait) and the index the closed-server purge needs, and
// touches nothing else; the next fills it from the audit log with one INSERT,
// the latest successful uninstall a person made per (Server, App). Found by tag
// suffix: numbers change on every renumber.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(suffix: string): Promise<{ idx: number; steps: string[] }> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
  assert.ok(entry, `${suffix} is in the journal`);
  return { idx: entry.idx, steps: statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8")) };
}

test("the table's migration touches only the new table, under a 2 s lock wait; the backfill is one INSERT after it", async () => {
  const table = await migration("_oauth_client_uninstalls");
  assertBoundedLockTimeout(table.steps[0], "the foreign keys lock servers and users (hot)", { maxMs: 2_000 });
  for (const step of table.steps.slice(1)) {
    assert.match(step, /^(CREATE TABLE "oauth_client_uninstalls"|ALTER TABLE "oauth_client_uninstalls" ADD CONSTRAINT|CREATE INDEX "idx_oauth_client_uninstalls_client" ON "oauth_client_uninstalls")/, step);
  }
  const backfill = await migration("_oauth_client_uninstalls_backfill");
  assert.equal(backfill.idx, table.idx + 1, "the backfill runs right after the table exists");
  assertBoundedLockTimeout(backfill.steps[0], "the backfill's lock wait", { maxMs: 2_000 });
  assert.equal(backfill.steps.length, 2);
  assert.match(backfill.steps[1]!, /^INSERT INTO "oauth_client_uninstalls"/);
  assert.match(backfill.steps[1]!, /ON CONFLICT DO NOTHING;$/);
  assert.doesNotMatch(backfill.steps[1]!, /\b(UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
});

test("the backfill keeps each (Server, App)'s latest successful uninstall by a person, and nothing else", async ({ db, seed }) => {
  const owner = await seed.human();
  const admin = await seed.human();
  const publisher = await seed.server({ owner });
  const one = await seed.server({ owner });
  const two = await seed.server({ owner });
  const purged = await seed.server({ owner });
  await db.update(servers).set({ purgeState: "done", purgedAt: new Date() }).where(eq(servers.id, purged.id));
  const app = async (name: string) => (await db.insert(oauthClients).values({
    serverId: publisher.id, clientId: `${name}-${randomUUID().slice(0, 8)}`, clientSecretHash: "hash", appType: "third_party_global", name, createdByUserId: owner.id,
  }).returning())[0]!;
  const alpha = await app("alpha");
  const beta = await app("beta");
  const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z`);
  const event = (values: {
    serverId: string | null; clientId: string | null; createdAt: Date; actorId?: string | null;
    eventType?: string; actorType?: "human" | "system"; outcome?: "success" | "failure";
  }) => db.insert(integrationAuditEvents).values({
    serverId: values.serverId,
    clientId: values.clientId,
    eventType: values.eventType ?? "marketplace.uninstalled",
    eventCategory: "revocation",
    outcome: values.outcome ?? "success",
    source: values.actorType === "system" ? "system" : "api",
    actorType: values.actorType ?? "human",
    actorId: values.actorType === "system" ? null : (values.actorId === undefined ? owner.id : values.actorId),
    targetType: "server",
    targetId: values.serverId,
    createdAt: values.createdAt,
  });
  // one/alpha: two by people (the later one counts), then later the system's and a failed one.
  await event({ serverId: one.id, clientId: alpha.id, createdAt: at(1) });
  await event({ serverId: one.id, clientId: alpha.id, createdAt: at(3), actorId: admin.id });
  await event({ serverId: one.id, clientId: alpha.id, createdAt: at(5), actorType: "system" });
  await event({ serverId: one.id, clientId: alpha.id, createdAt: at(6), outcome: "failure" });
  // one/beta: a private share's uninstall counts too.
  await event({ serverId: one.id, clientId: beta.id, createdAt: at(2), eventType: "private_share.uninstalled" });
  // two/alpha: the system's only (the closed-server purge). two/beta: an install, not an uninstall.
  await event({ serverId: two.id, clientId: alpha.id, createdAt: at(4), actorType: "system" });
  await event({ serverId: two.id, clientId: beta.id, createdAt: at(4), eventType: "marketplace.installed" });
  // two/beta again: by someone no longer in users: kept, without the person.
  await event({ serverId: two.id, clientId: beta.id, createdAt: at(7), actorId: randomUUID() });
  // A Server the purge has claimed, and an App that is gone (client_id set null).
  await event({ serverId: purged.id, clientId: alpha.id, createdAt: at(8) });
  await event({ serverId: one.id, clientId: null, createdAt: at(9) });

  const backfill = await migration("_oauth_client_uninstalls_backfill");
  const apply = () => db.transaction(async (tx) => {
    for (const step of backfill.steps) await tx.execute(sql.raw(step));
  });
  await db.delete(oauthClientUninstalls);
  await apply();
  const rows = () => db.select().from(oauthClientUninstalls);
  const byKey = (list: Array<typeof oauthClientUninstalls.$inferSelect>) =>
    list.map((row) => ({ ...row })).sort((a, b) => `${a.serverId}${a.clientId}`.localeCompare(`${b.serverId}${b.clientId}`));
  const expected = byKey([
    { serverId: one.id, clientId: alpha.id, uninstalledAt: at(3), actorUserId: admin.id },
    { serverId: one.id, clientId: beta.id, uninstalledAt: at(2), actorUserId: owner.id },
    { serverId: two.id, clientId: beta.id, uninstalledAt: at(7), actorUserId: null },
  ]);
  assert.deepEqual(byKey(await rows()), expected);

  // Again (a retried deploy): nothing changes.
  await apply();
  assert.deepEqual(byKey(await rows()), expected);
});
