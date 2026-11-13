import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";

/**
 * Share links bound to one target Server (#proj-apps:769a57d4), applied to rows
 * the previous release wrote. At deploy every active link has no target, so
 * every one is retired; links already revoked keep their revocation time; the
 * installations those links made are untouched. Afterwards an unbound link can
 * never be active again, and an App holds one active link per target.
 */

const migrationUrl = (tag: string) => new URL(`../../drizzle/${tag}.sql`, import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: Array<{ tag: string }> };
const tags = journal.entries.map((entry) => entry.tag);

const TAG = "0448_share_link_target_server";
const index = tags.indexOf(TAG);

async function apply(pg: PGlite, applied: readonly string[]): Promise<void> {
  for (const tag of applied) {
    await pg.exec(`BEGIN;\n${readFileSync(migrationUrl(tag), "utf8")}\n;COMMIT;`);
  }
}

const USER = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const INSTALLED = "00000000-0000-4000-8000-0000000000a2";
const CLIENT = "00000000-0000-4000-8000-0000000000b1";
const OTHER_CLIENT = "00000000-0000-4000-8000-0000000000b2";
const INSTALL = "00000000-0000-4000-8000-0000000000c1";
const LINK_ACTIVE = "00000000-0000-4000-8000-0000000000d1";
const LINK_REVOKED = "00000000-0000-4000-8000-0000000000d2";
const LINK_EXPIRED = "00000000-0000-4000-8000-0000000000d3";
const REVOKED_AT = "2026-09-01T00:00:00.000Z";

test("the migration under test is in the journal", () => {
  assert.notEqual(index, -1);
});

async function migratedFromProductionShape(): Promise<PGlite> {
  const pg = new PGlite();
  await apply(pg, tags.slice(0, index));
  // Rows as the previous release writes them: at most one active link per App,
  // never a target. Expiry never revoked a link, so an expired one is active.
  await pg.exec(`
    INSERT INTO users (id, email, name, password_hash)
      VALUES ('${USER}', 'fixture@example.test', 'Fixture', 'fixture-value-not-a-credential');
    INSERT INTO servers (id, name, slug, owner_id) VALUES
      ('${SOURCE}', 'Source', 'share-source', '${USER}'),
      ('${INSTALLED}', 'Installed', 'share-installed', '${USER}');
    INSERT INTO oauth_clients (id, server_id, client_id, client_secret_hash, name, created_by_user_id, app_type) VALUES
      ('${CLIENT}', '${SOURCE}', 'shared-app', 'fixture-hash', 'Shared App', '${USER}', 'third_party_global'),
      ('${OTHER_CLIENT}', '${SOURCE}', 'other-shared-app', 'fixture-hash-2', 'Other Shared App', '${USER}', 'third_party_global');
    INSERT INTO oauth_client_installs (id, server_id, client_id, installed_by_user_id, approved_scopes)
      VALUES ('${INSTALL}', '${INSTALLED}', '${CLIENT}', '${USER}', '["openid","profile"]');
    INSERT INTO oauth_client_share_links (id, client_id, token_hash, created_by_user_id, expires_at, revoked_at, last_used_at) VALUES
      ('${LINK_REVOKED}', '${CLIENT}', 'hash-revoked', '${USER}', now() + interval '30 days', '${REVOKED_AT}', now()),
      ('${LINK_ACTIVE}', '${CLIENT}', 'hash-active', '${USER}', now() + interval '30 days', NULL, now()),
      ('${LINK_EXPIRED}', '${OTHER_CLIENT}', 'hash-expired', '${USER}', now() - interval '1 day', NULL, NULL);
  `);
  await apply(pg, [TAG]);
  return pg;
}

test("every active link without a target is retired; revoked links keep their time; installations stay", async () => {
  const pg = await migratedFromProductionShape();
  const { rows } = await pg.query<{ id: string; revoked: boolean; revoked_at: string | null; consumed_at: string | null; target_server_id: string | null; target_server_slug: string | null }>(
    `SELECT id, revoked_at IS NOT NULL AS revoked, revoked_at::text, consumed_at::text, target_server_id, target_server_slug
       FROM oauth_client_share_links ORDER BY id`,
  );
  assert.deepEqual(rows.map((row) => [row.id, row.revoked, row.consumed_at, row.target_server_id, row.target_server_slug]), [
    [LINK_ACTIVE, true, null, null, null],
    [LINK_REVOKED, true, null, null, null],
    [LINK_EXPIRED, true, null, null, null],
  ]);
  const revokedAt = await pg.query<{ id: string; kept: boolean; at_deploy: boolean }>(
    `SELECT id, revoked_at = '${REVOKED_AT}'::timestamptz AS kept, revoked_at > now() - interval '1 hour' AS at_deploy
       FROM oauth_client_share_links ORDER BY id`,
  );
  assert.deepEqual(revokedAt.rows, [
    { id: LINK_ACTIVE, kept: false, at_deploy: true },
    { id: LINK_REVOKED, kept: true, at_deploy: false },
    { id: LINK_EXPIRED, kept: false, at_deploy: true },
  ], "active links (expired ones too) are retired at deploy; an earlier revocation keeps its time");

  const installs = await pg.query<{ id: string; server_id: string; status: string }>(
    `SELECT id, server_id, status FROM oauth_client_installs`,
  );
  assert.deepEqual(installs.rows, [{ id: INSTALL, server_id: INSTALLED, status: "active" }], "the installation the link made is untouched");
});

test("afterwards a link is active only with a target, and once per (App, target)", async () => {
  const pg = await migratedFromProductionShape();
  const insert = (id: string, slug: string | null, targetId: string | null) => pg.query(
    `INSERT INTO oauth_client_share_links (id, client_id, token_hash, created_by_user_id, target_server_id, target_server_slug)
       VALUES ($1, '${CLIENT}', $2, '${USER}', $3, $4)`,
    [id, `hash-${id}`, targetId, slug],
  );
  await assert.rejects(insert("00000000-0000-4000-8000-0000000000e1", null, null), /oauth_client_share_links_active_has_target/,
    "an older binary's unbound link can no longer be written active");
  await insert("00000000-0000-4000-8000-0000000000e2", "share-installed", INSTALLED);
  await insert("00000000-0000-4000-8000-0000000000e3", "nowhere", null);
  await insert("00000000-0000-4000-8000-0000000000e4", "nowhere-else", null);
  await assert.rejects(insert("00000000-0000-4000-8000-0000000000e5", "share-installed", INSTALLED), /idx_oauth_client_share_links_active_target/);
  await assert.rejects(insert("00000000-0000-4000-8000-0000000000e6", "renamed-installed", INSTALLED), /idx_oauth_client_share_links_active_target_server/);
  await assert.rejects(insert("00000000-0000-4000-8000-0000000000e7", "nowhere", null), /idx_oauth_client_share_links_active_target_slug/);

  // The foreign key was added NOT VALID and then validated: it is a full constraint.
  const fk = await pg.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = 'oauth_client_share_links_target_server_id_servers_id_fk'`,
  );
  assert.deepEqual(fk.rows, [{ convalidated: true }]);
  await assert.rejects(insert("00000000-0000-4000-8000-0000000000e8", "ghost", "00000000-0000-4000-8000-0000000000ff"),
    /oauth_client_share_links_target_server_id_servers_id_fk/, "a target must be a real Server");

  // Deleting the target Server deletes its links.
  await pg.exec(`DELETE FROM oauth_client_installs WHERE server_id = '${INSTALLED}'; DELETE FROM servers WHERE id = '${INSTALLED}';`);
  const { rows } = await pg.query<{ id: string }>(`SELECT id FROM oauth_client_share_links WHERE target_server_slug = 'share-installed'`);
  assert.deepEqual(rows, []);
});
