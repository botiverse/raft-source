/**
 * Task 7: visible brand findings leave the baseline via catalog IDs (labels /
 * aria) or a typed domain constant (URL fragment) — not broad lint exemptions.
 *
 * Brand product names may intentionally match across locales (en === zh-cn).
 */
import assert from "node:assert/strict";

import { RAFT_APP_SERVER_PATH_PREFIX } from "../src/brand/constants";

test("protocol/domain fragment app.raft.build/s/ is one typed constant", () => {
  assert.equal(RAFT_APP_SERVER_PATH_PREFIX, "app.raft.build/s/");
});
