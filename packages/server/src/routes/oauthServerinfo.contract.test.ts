import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

/**
 * Contract tooth (Cardy task #231): /serverinfo must consume the plan that
 * rides the SAME live bearer join (token.serverPlan) and must NOT issue its
 * own servers query or fallback (the restored "second query + ?? free"
 * implementation is the exact defect this pins). A deleted-before-request
 * API test cannot catch that defect — the bearer join 401s first — so the
 * tooth is structural.
 *
 * Mutation-sensitive: restoring the second-query/fallback implementation
 * makes every assertion here go RED (receipts in slock#6417 thread).
 */

const source = readFileSync(fileURLToPath(new URL("./oauth.ts", import.meta.url)), "utf8");

function serverinfoHandler(): string {
  const start = source.indexOf('oauthRouter.get("/serverinfo"');
  assert.notEqual(start, -1, "serverinfo route missing");
  const end = source.indexOf("\n});", start);
  assert.notEqual(end, -1, "serverinfo route not terminated");
  return source.slice(start, end);
}

test("serverinfo consumes only the bearer identity plan (no second query, no fallback)", () => {
  const handler = serverinfoHandler();

  // positive: projects from the token's same-snapshot plan via the shared authority
  assert.match(handler, /projectCoarseServerPlan\(/, "must use the shared projection authority");
  assert.match(handler, /token\.serverPlan/, "plan must come from the bearer identity (single live join)");

  // negative: no independent server lookup, no silent fallback
  assert.doesNotMatch(handler, /from\(servers\)/, "must not query the servers table itself");
  assert.doesNotMatch(handler, /getDb\(/, "must not acquire its own db handle");
  assert.doesNotMatch(handler, /\?\?\s*"free"/, 'must not fall back to "free" when a fact is missing');
});
