import assert from "node:assert/strict";
import { test } from "vitest";

import { isWebClientTooOldForSecondFactor } from "./oldWebClient";

const headers = (values: Record<string, string>) => (name: string) => values[name];

test("a web page that names a version below the floor is too old; one at or above it, or a staging build of it, is not", () => {
  for (const platform of ["browser", "pwa", "desktop_app"]) {
    assert.equal(isWebClientTooOldForSecondFactor(headers({ "X-Raft-Client-Platform": platform, "X-Raft-Client-Version": "1.21.42" })), true, platform);
  }
  assert.equal(isWebClientTooOldForSecondFactor(headers({ "X-Raft-Client-Platform": "browser", "X-Raft-Client-Version": "1.21.44" })), false);
  assert.equal(isWebClientTooOldForSecondFactor(headers({ "X-Raft-Client-Platform": "browser", "X-Raft-Client-Version": "1.21.44-staging.20261101.sha.abc" })), false);
  assert.equal(isWebClientTooOldForSecondFactor(headers({ "X-Raft-Client-Platform": "browser", "X-Raft-Client-Version": "1.22.0" })), false);
});

test("a sign-in that doesn't say it is an old web page gets the challenge as before", () => {
  assert.equal(isWebClientTooOldForSecondFactor(headers({})), false, "no headers (most sign-ins)");
  assert.equal(isWebClientTooOldForSecondFactor(headers({ "X-Raft-Client-Platform": "browser" })), false, "no version");
  assert.equal(isWebClientTooOldForSecondFactor(headers({ "X-Raft-Client-Version": "1.21.42" })), false, "no platform");
  assert.equal(isWebClientTooOldForSecondFactor(headers({ "X-Raft-Client-Platform": "browser", "X-Raft-Client-Version": "dev" })), false, "not a version");
  assert.equal(isWebClientTooOldForSecondFactor(headers({ "X-Raft-Client-Platform": "ios", "X-Raft-Client-Version": "1.14.2" })), false, "an app, not a web page");
});
