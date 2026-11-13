import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const serverRoot = new URL("../../", import.meta.url);
const repositoryRoot = new URL("../../", serverRoot);
// Reads private deploy workflows that the source-available snapshot does not carry;
// skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("RELEASE_SOURCE", repositoryRoot));

test("workspace-install server grants backfill authority without copying credentials", async () => {
  const sql = await readFile(
    new URL("drizzle/0288_external_install_server_grants.sql", serverRoot),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "external_app_install_server_grants"/u);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "idx_external_app_install_server_grant_scope"[^;]+\("install_id","server_id"\)/u,
  );
  assert.match(
    sql,
    /SELECT gen_random_uuid\(\), install\.id, install\.server_id, install\.registration_id,[\s\S]+install\.server_grant_id, install\.grant_epoch, 'active', asg\.granted_by_type, asg\.granted_by_id/u,
  );
  assert.match(sql, /JOIN "external_app_server_grants" asg[\s\S]+asg\.id = install\.server_grant_id/u);
  assert.match(sql, /WHERE install\.state <> 'revoked'/u);
  assert.match(
    sql,
    /external_app_installs_server_id_servers_id_fk[^;]+ON DELETE restrict/u,
    "deleting the credential-custody server must not cascade-delete a workspace shared by other servers",
  );
  assert.doesNotMatch(sql, /encrypted_material|access_token|credential_revision/u);
});

// The deploy runs every migration the journal lists (scripts/deploy/
// aws-run-server-migrations.sh reads drizzle/meta/_journal.json); the deploy
// workflows no longer carry a tag list, so the journal entry is the contract.
test.skipIf(inSourceSnapshot)("the migration tag is present in the journal, which the deploy runs", async () => {
  const tag = "0288_external_install_server_grants";
  const journal = await readFile(new URL("drizzle/meta/_journal.json", serverRoot), "utf8");
  assert.equal(
    JSON.parse(journal).entries.filter((entry: { tag?: unknown }) => entry.tag === tag).length,
    1,
  );
});
