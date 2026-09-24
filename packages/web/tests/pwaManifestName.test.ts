import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  applyPwaAppName,
  getPwaAppName,
  RAFT_PWA_APP_NAME,
  RAFT_STAGING_PWA_APP_NAME,
} from "../scripts/pwaManifestName";

const repoRoot = resolve(import.meta.dirname, "..");

test("source PWA manifest remains production-named by default", () => {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "public/site.webmanifest"), "utf8"));

  assert.equal(manifest.name, RAFT_PWA_APP_NAME);
  assert.equal(manifest.short_name, RAFT_PWA_APP_NAME);
});

test("staging PWA builds use a staging-specific install name", () => {
  assert.equal(getPwaAppName("staging"), RAFT_STAGING_PWA_APP_NAME);
  assert.equal(getPwaAppName(" Staging "), RAFT_STAGING_PWA_APP_NAME);
  assert.equal(getPwaAppName("production"), RAFT_PWA_APP_NAME);
  assert.equal(getPwaAppName(undefined), RAFT_PWA_APP_NAME);

  assert.deepEqual(
    applyPwaAppName({ id: "/", name: "Raft", short_name: "Raft" }, "staging"),
    { id: "/", name: RAFT_STAGING_PWA_APP_NAME, short_name: RAFT_STAGING_PWA_APP_NAME },
  );
});
