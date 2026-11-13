import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const TAG_SUFFIX = "_app_bot_avatar_follows_logo";

type JournalEntry = { idx: number; tag: string };

async function journalEntries(): Promise<JournalEntry[]> {
  const journal = JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

// One transaction per migration, as drizzle's migrator runs them (LOCK TABLE
// and SET LOCAL need one).
async function apply(client: PGlite, entries: JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    const migration = await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    await client.exec(`BEGIN;\n${migration}\n;COMMIT;`);
  }
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";
const LOGO_APP = "33333333-3333-4333-8333-333333333331";
const NO_LOGO_APP = "33333333-3333-4333-8333-333333333332";
const LOGO_INSTALL = "44444444-4444-4444-8444-444444444441";
const NO_LOGO_INSTALL = "44444444-4444-4444-8444-444444444442";
const BOT_WITHOUT_AVATAR = "55555555-5555-4555-8555-555555555551";
const BOT_WITH_STALE_LOGO = "55555555-5555-4555-8555-555555555552";
const BOT_OF_APP_WITHOUT_LOGO = "55555555-5555-4555-8555-555555555553";
const ORDINARY_AGENT = "55555555-5555-4555-8555-555555555554";
const LOGO = `/api/integration-logos/${LOGO_APP}/${"a".repeat(32)}.webp`;
const STALE_LOGO = `/api/integration-logos/${LOGO_APP}/${"b".repeat(32)}.webp`;
const OWN_AVATAR = `/api/avatars/${SERVER}/${"c".repeat(32)}.webp`;
const BEFORE = "2026-10-01T00:00:00.000Z";

test("app_bot_avatar_follows_logo sets every App bot's avatar to its App logo and leaves other agents alone", async () => {
  const entries = await journalEntries();
  const target = entries.find((entry) => entry.tag.endsWith(TAG_SUFFIX));
  assert.ok(target, `journal has a *${TAG_SUFFIX} migration`);
  const client = new PGlite();
  try {
    await client.exec(`SET TIME ZONE 'UTC'`);
    await apply(client, entries.filter((entry) => entry.idx < target.idx));
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('${OWNER}', 'bot-avatar-owner@example.com', 'bot-avatar-owner', 'hash');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('${SERVER}', 'Bot avatar server', 'bot-avatar-server', '${OWNER}');
      INSERT INTO "oauth_clients" ("id", "server_id", "client_id", "client_secret_hash", "name", "created_by_user_id", "logo_url")
      VALUES
        ('${LOGO_APP}', '${SERVER}', 'logo-app', 'hash', 'Logo App', '${OWNER}', '${LOGO}'),
        ('${NO_LOGO_APP}', '${SERVER}', 'no-logo-app', 'hash', 'No Logo App', '${OWNER}', NULL);
      INSERT INTO "oauth_client_installs" ("id", "server_id", "client_id", "installed_by_user_id")
      VALUES
        ('${LOGO_INSTALL}', '${SERVER}', '${LOGO_APP}', '${OWNER}'),
        ('${NO_LOGO_INSTALL}', '${SERVER}', '${NO_LOGO_APP}', '${OWNER}');
      INSERT INTO "agents" ("id", "server_id", "name", "avatar_url", "managed_by_app_install_id", "updated_at")
      VALUES
        ('${BOT_WITHOUT_AVATAR}', '${SERVER}', 'logo-app', NULL, '${LOGO_INSTALL}', '${BEFORE}'),
        ('${BOT_WITH_STALE_LOGO}', '${SERVER}', 'logo-app-old', '${STALE_LOGO}', '${LOGO_INSTALL}', '${BEFORE}'),
        ('${BOT_OF_APP_WITHOUT_LOGO}', '${SERVER}', 'no-logo-app', NULL, '${NO_LOGO_INSTALL}', '${BEFORE}'),
        ('${ORDINARY_AGENT}', '${SERVER}', 'ordinary', '${OWN_AVATAR}', NULL, '${BEFORE}');
    `);

    await apply(client, [target]);

    const { rows } = await client.query<{ id: string; avatar_url: string | null; touched: boolean }>(
      `SELECT "id", "avatar_url", "updated_at" > '${BEFORE}'::timestamptz AS "touched" FROM "agents" ORDER BY "id"`,
    );
    assert.deepEqual(rows, [
      { id: BOT_WITHOUT_AVATAR, avatar_url: LOGO, touched: true },
      { id: BOT_WITH_STALE_LOGO, avatar_url: LOGO, touched: true },
      { id: BOT_OF_APP_WITHOUT_LOGO, avatar_url: null, touched: false },
      { id: ORDINARY_AGENT, avatar_url: OWN_AVATAR, touched: false },
    ]);
  } finally {
    await client.close();
  }
});
