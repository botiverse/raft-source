import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { test as unitTest } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";
import { integrationAuditEvents, oauthAppLinkPreviews, oauthClientInstalls } from "./schema";
import { createOAuthClient } from "../services/oauthService";

// Card buttons moved to the installation (RFC 076 §17). The migration adds
// three nullable columns and a CHECK NOT VALID to oauth_client_installs under
// a 2 s lock wait, and moves the own-Server confirmation: a server_local App
// whose admins withdrew it stays off (its source installation's
// actions_off_at is the withdrawal's time); one confirmed, or never decided,
// is on (the new default). The data step is the migration file's own
// statement, read off disk and run on seeded rows.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const test = createApiTest();

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migrationSteps(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_card_buttons_per_installation"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

unitTest("adds the three nullable columns and the CHECK NOT VALID under a 2 s lock wait, then one UPDATE", async () => {
  const steps = await migrationSteps();
  assertBoundedLockTimeout(steps[0], "oauth_client_installs is read by every link card read", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '5s';");
  assert.deepEqual(steps.slice(2, 6), [
    `ALTER TABLE "oauth_client_installs" ADD COLUMN "allowed_action_endpoint" text;`,
    `ALTER TABLE "oauth_client_installs" ADD COLUMN "actions_allowed_at" timestamp with time zone;`,
    `ALTER TABLE "oauth_client_installs" ADD COLUMN "actions_off_at" timestamp with time zone;`,
    `ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_actions_allowed" CHECK (("oauth_client_installs"."allowed_action_endpoint" IS NULL) = ("oauth_client_installs"."actions_allowed_at" IS NULL)) NOT VALID;`,
  ]);
  assert.equal(steps.length, 7);
  assert.match(steps[6]!, /^UPDATE "oauth_client_installs" AS i\s+SET "actions_off_at" = latest\.created_at/);
});

test("withdrawn stays off at the withdrawal's time; confirmed, never decided, or re-confirmed is on; only server_local Apps' own Server rows", async ({ db, seed }) => {
  const update = (await migrationSteps())[6]!;
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const elsewhere = await seed.server({ owner });
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes));
  const event = (clientId: string, eventType: "app.link_card_actions_confirmed" | "app.link_card_actions_withdrawn", createdAt: Date) => db.insert(integrationAuditEvents).values({
    serverId: server.id, clientId, eventType, eventCategory: eventType.endsWith("confirmed") ? "registration" : "revocation", outcome: "success", source: "web",
    actorType: "human", actorId: owner.id, targetType: "app", targetId: clientId, createdAt,
  });
  async function app(name: string, input: { appType?: "server_local" | "third_party_global"; confirmed?: boolean; events?: Array<["app.link_card_actions_confirmed" | "app.link_card_actions_withdrawn", Date]> }) {
    const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `migrate-${name}-${Date.now()}`, name, appType: input.appType });
    const origin = `https://${name}-${Date.now()}.example.test`;
    await db.insert(oauthAppLinkPreviews).values({
      clientId: client.id, origin, endpoint: `${origin}/callback`, paths: ["/p"], actionEndpoint: `${origin}/act`,
      ...(input.confirmed ? { ownServerActionEndpoint: `${origin}/act`, ownServerActionsConfirmedAt: at(0) } : {}),
    });
    const [own] = await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).returning();
    const [other] = await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: elsewhere.id, installedByUserId: owner.id }).returning();
    for (const [type, when] of input.events ?? []) await event(client.id, type, when);
    return { own: own!.id, other: other!.id };
  }
  const withdrawn = await app("withdrawn", { events: [["app.link_card_actions_confirmed", at(1)], ["app.link_card_actions_withdrawn", at(2)]] });
  const confirmed = await app("confirmed", { confirmed: true, events: [["app.link_card_actions_confirmed", at(1)]] });
  const never = await app("never", {});
  const reconfirmed = await app("reconfirmed", { confirmed: true, events: [["app.link_card_actions_withdrawn", at(1)], ["app.link_card_actions_confirmed", at(2)]] });
  const shared = await app("shared", { appType: "third_party_global", events: [["app.link_card_actions_confirmed", at(1)], ["app.link_card_actions_withdrawn", at(2)]] });

  await db.execute(sql.raw(update));
  const offAt = async (id: string) => (await db.select({ offAt: oauthClientInstalls.actionsOffAt }).from(oauthClientInstalls).where(eq(oauthClientInstalls.id, id)))[0]!.offAt;
  assert.deepEqual(await offAt(withdrawn.own), at(2), "withdrawn: off, at the withdrawal");
  assert.equal(await offAt(withdrawn.other), null, "another Server's row is not the switch");
  for (const [why, rows] of [["confirmed", confirmed], ["never decided", never], ["withdrawn then confirmed again", reconfirmed], ["a shared App", shared]] as const) {
    assert.equal(await offAt(rows.own), null, why);
    assert.equal(await offAt(rows.other), null, why);
  }
});
