import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  PRODUCTION_D1_ID,
  PRODUCTION_HYPERDRIVE_ID,
  PRODUCTION_SERVER_ID,
  renderStagingWrangler,
} from "./render-staging-wrangler.mjs";

const source = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const valid = {
  FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS: PRODUCTION_SERVER_ID,
  FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID: "11111111111111111111111111111111",
  FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
};

test("renders all staging identities without changing production bytes", () => {
  const rendered = renderStagingWrangler(source, valid);
  assert.equal(rendered.split("\n\n# Staging is rendered")[0], source.split("\n\n# Staging is rendered")[0]);
  assert.match(rendered, /name = "slock-feature-flag-admin-staging"/);
  const staging = rendered.slice(rendered.indexOf("[env.staging]"));
  assert.match(staging, /\[env\.staging\.observability\][\s\S]*enabled = true[\s\S]*head_sampling_rate = 1/);
  assert.match(staging, /\[env\.staging\.observability\.logs\][\s\S]*invocation_logs = true[\s\S]*persist = true/);
  assert.match(staging, /RAFT_ORIGIN = "https:\/\/app\.raft\.build"/);
  assert.match(staging, /RAFT_API_ORIGIN = "https:\/\/api\.raft\.build"/);
  assert.match(rendered, new RegExp(valid.FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS));
  assert.match(rendered, new RegExp(valid.FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID));
  assert.match(rendered, new RegExp(valid.FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID));
  assert.doesNotMatch(rendered, /__FEATURE_FLAG_ADMIN_STAGING_/);
});

for (const name of Object.keys(valid)) {
  test(`fails closed when ${name} is missing`, () => {
    assert.throws(() => renderStagingWrangler(source, { ...valid, [name]: "" }), new RegExp(`missing ${name}`));
  });
}

test("shares the online Botiverse login server while rejecting production data resources", () => {
  assert.doesNotThrow(
    () => renderStagingWrangler(source, { ...valid, FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS: PRODUCTION_SERVER_ID }),
  );
  assert.throws(
    () => renderStagingWrangler(source, {
      ...valid,
      FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS: "11111111-1111-4111-8111-111111111111",
    }),
    /must equal the online Botiverse server id/,
  );
  assert.throws(
    () => renderStagingWrangler(source, { ...valid, FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID: PRODUCTION_HYPERDRIVE_ID }),
    /must differ from production/,
  );
  assert.throws(
    () => renderStagingWrangler(source, { ...valid, FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID: PRODUCTION_D1_ID }),
    /must differ from production/,
  );
});

test("rejects malformed and duplicate identities", () => {
  assert.throws(
    () => renderStagingWrangler(source, { ...valid, FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS: "not-a-uuid" }),
    /comma-separated UUIDs/,
  );
  const repeated = `${valid.FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS},${valid.FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS}`;
  assert.throws(
    () => renderStagingWrangler(source, { ...valid, FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS: repeated }),
    /must be unique/,
  );
  assert.throws(
    () => renderStagingWrangler(source, { ...valid, FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID: "bad" }),
    /invalid staging Hyperdrive id/,
  );
});

test("production and staging target mutations fail for the right reason", () => {
  assert.throws(
    () => renderStagingWrangler(source.replace('RAFT_API_ORIGIN = "https://api.raft.build"', 'RAFT_API_ORIGIN = "https://wrong.example"'), valid),
    /production Wrangler configuration bytes changed/,
  );
  const stagingStart = source.indexOf("[env.staging]");
  const wrongStagingApiOrigin = `${source.slice(0, stagingStart)}${source.slice(stagingStart).replace(
    'RAFT_API_ORIGIN = "https://api.raft.build"',
    'RAFT_API_ORIGIN = "https://api-aws-staging.botiverse.dev"',
  )}`;
  assert.throws(
    () => renderStagingWrangler(wrongStagingApiOrigin, valid),
    /staging API origin contract drift/,
  );
  const wrongHyperdriveBinding = `${source.slice(0, stagingStart)}${source.slice(stagingStart).replace(
    'binding = "FEATURE_FLAG_PG"',
    'binding = "FEATURE_FLAG_PG_WRONG"',
  )}`;
  assert.throws(
    () => renderStagingWrangler(wrongHyperdriveBinding, valid),
    /staging Hyperdrive binding contract drift/,
  );
});
