import assert from "node:assert/strict";
import {
  applyPwaAppName,
  getPwaAppName,
  RAFT_PWA_APP_NAME,
  RAFT_STAGING_PWA_APP_NAME,
} from "../scripts/pwaManifestName";

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
