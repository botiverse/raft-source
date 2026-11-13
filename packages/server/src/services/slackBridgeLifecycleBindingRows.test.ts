import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { Database } from "../db/index";
import { loadSlackBridgeLifecycleBindingRows } from "./slackBridgeLifecycleBindingRows";

const installId = "00000000-0000-4000-8000-000000000001";
const bindingId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("lifecycle loads one current-epoch snapshot per active binding and preserves private revision pins", async () => {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE external_app_installs (id uuid PRIMARY KEY, state text NOT NULL);
      CREATE TABLE external_app_credentials (install_id uuid, state text NOT NULL);
      CREATE TABLE external_channel_bindings (
        id uuid PRIMARY KEY, install_id uuid, state text NOT NULL,
        binding_epoch integer NOT NULL, audience_revision integer, privacy_class text NOT NULL
      );
      CREATE TABLE external_binding_audience_snapshots (
        binding_id uuid, binding_epoch integer, audience_revision integer, status text NOT NULL
      );
      CREATE UNIQUE INDEX idx_external_binding_audience_revision
        ON external_binding_audience_snapshots (binding_id, binding_epoch, audience_revision);
      INSERT INTO external_app_installs VALUES ('${installId}', 'active');
      INSERT INTO external_app_credentials VALUES ('${installId}', 'active');
      INSERT INTO external_channel_bindings VALUES
        ('${bindingId(2)}', '${installId}', 'active', 2, 1, 'public'),
        ('${bindingId(3)}', '${installId}', 'active', 2, 2, 'private'),
        ('${bindingId(4)}', '${installId}', 'active', 2, 3, 'private'),
        ('${bindingId(5)}', '${installId}', 'active', 2, NULL, 'public'),
        ('${bindingId(6)}', '${installId}', 'paused', 2, 1, 'public');
      INSERT INTO external_binding_audience_snapshots
        SELECT '${bindingId(2)}', 1, revision, 'mismatch' FROM generate_series(1, 5000) revision;
      INSERT INTO external_binding_audience_snapshots VALUES
        ('${bindingId(2)}', 2, 1, 'mismatch'),
        ('${bindingId(2)}', 2, 2, 'matched'),
        ('${bindingId(3)}', 1, 2, 'matched'),
        ('${bindingId(3)}', 2, 1, 'matched'),
        ('${bindingId(3)}', 2, 2, 'mismatch'),
        ('${bindingId(3)}', 2, 4, 'matched'),
        ('${bindingId(4)}', 1, 3, 'matched'),
        ('${bindingId(4)}', 2, 4, 'matched'),
        ('${bindingId(6)}', 2, 1, 'matched');
    `);
    // The fixture implements only the storage boundary touched by this query.
    const db = drizzle(client) as unknown as Database;
    const rows = await loadSlackBridgeLifecycleBindingRows(db);
    assert.equal(rows.length, 4, "history cardinality must not grow the result or include paused bindings");
    const byId = new Map(rows.map((row) => [row.bindingId, row]));
    assert.equal(byId.get(bindingId(2))?.audienceStatus, "matched", "latest public snapshot belongs to current epoch");
    assert.equal(byId.get(bindingId(3))?.audienceStatus, "mismatch", "newer private snapshot cannot replace pinned revision");
    assert.equal(byId.get(bindingId(4))?.audienceStatus, null, "missing pin cannot fall back to old epoch or another revision");
    assert.equal(byId.get(bindingId(5))?.audienceStatus, null, "missing snapshot preserves the active binding for unavailable health");
    await client.exec("DELETE FROM external_app_credentials;");
    const withoutCredential = await loadSlackBridgeLifecycleBindingRows(db);
    assert.equal(withoutCredential.length, 4);
    assert.ok(withoutCredential.every((row) => row.credentialState === null));
  } finally {
    await client.close();
  }
});
