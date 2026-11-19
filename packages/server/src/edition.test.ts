import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, vi } from "vitest";

// Server tests run against a mocked edition.ts (src/test/setup/edition.ts), which
// would hide a change to the real functions' defaults. These read the real module.

test("the real edition functions default to this build's RAFT_EDITION", async () => {
  // Called with no argument, each answers for the build's own edition line (the
  // one the source-available export rewrites), in this tree and in the snapshot.
  const real = await vi.importActual<typeof import("./edition")>("./edition");
  assert.equal(real.humanUserLimit(), real.humanUserLimit(real.RAFT_EDITION));
  assert.equal(real.socialLoginAllowed(), real.socialLoginAllowed(real.RAFT_EDITION));
  assert.equal(real.enterpriseSsoAllowed(), real.enterpriseSsoAllowed(real.RAFT_EDITION));
  assert.equal(real.humanUserLimit("source-available"), real.HUMAN_USER_LIMIT);
  assert.equal(real.HUMAN_USER_LIMIT, 5);
});

test("each edition function's default is RAFT_EDITION itself, not a literal", () => {
  // In the cloud tree a default of "cloud" answers the same as RAFT_EDITION, so the
  // check above cannot see it there; the snapshot would then lose its limits.
  const source = readFileSync(new URL("./edition.ts", import.meta.url), "utf8");
  for (const name of ["socialLoginAllowed", "enterpriseSsoAllowed", "humanUserLimit"]) {
    assert.match(source, new RegExp(`export function ${name}\\(edition: string = RAFT_EDITION\\)`), name);
  }
});
