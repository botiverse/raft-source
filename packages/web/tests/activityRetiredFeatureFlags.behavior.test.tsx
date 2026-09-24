/**
 * task #19 — Activity v2 has been retired from the web inbox.
 *
 * The historic server-side flag rows may remain for rollback/history, but the
 * web client must not request either Activity v2 flag anymore. If these keys
 * re-enter the registered web flag list, an enabled stale server flag can put
 * users back on the retired slow inbox path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVITY_SYNC_CORE_FEATURE_FLAG_KEY,
  ACTIVITY_V2_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import {
  REGISTERED_SERVER_FEATURE_FLAG_KEYS,
} from "../src/store/serverFeatureFlags";

test("retired Activity v2 flags are not registered for web evaluation", () => {
  assert.equal(
    REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(ACTIVITY_V2_FEATURE_FLAG_KEY as never),
    false,
    "the legacy activity_v2 key must not be requested by the web client",
  );
  assert.equal(
    REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes(ACTIVITY_SYNC_CORE_FEATURE_FLAG_KEY as never),
    false,
    "the activity_sync_core key must not be requested by the web client",
  );
});
