import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { PROFILE_SETUP_PLACEHOLDER_PREFIX } from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { signAccessToken } from "./auth";
import * as session from "../services/sessionService";
import { signInForTest } from "../test/integration/credentials";
import { users } from "../db/schema";

/**
 * Web perf (#proj-workspace:f07141a9): requireAuth reads the user row and the
 * session family once, and requireVerified / requireProfileSetupComplete use
 * that read instead of reading the row again. Every check still runs, in the
 * same order, with the same answers (Tenny).
 */
const test = createApiTest();

async function getServers(base: string, token: string) {
  return fetch(`${base}/api/servers`, { headers: { Authorization: `Bearer ${token}` } });
}

test("a live, verified, set-up account with a live session passes (and a token without a family is refused)", async ({ app, seed }) => {
  const human = await seed.human();
  const auth = await signInForTest(human.id);
  assert.equal((await getServers(app.baseUrl, signAccessToken(human.id, auth.familyId))).status, 200);
  const familyless = jwt.sign({ sub: human.id, type: "access" }, process.env.JWT_SECRET!, { expiresIn: "15m" });
  assert.equal((await getServers(app.baseUrl, familyless)).status, 401);
});

test("a retired account is refused as before (401 auth_required)", async ({ app, seed, db }) => {
  const human = await seed.human();
  const auth = await signInForTest(human.id);
  await db.update(users).set({ retiredAt: new Date() }).where(eq(users.id, human.id));
  const response = await getServers(app.baseUrl, signAccessToken(human.id, auth.familyId));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "auth_required");
});

test("a revoked session family, or another person's family, is refused as before (401)", async ({ app, seed }) => {
  const human = await seed.human();
  const other = await seed.human();
  const auth = await signInForTest(human.id);
  const otherAuth = await signInForTest(other.id);
  assert.equal((await getServers(app.baseUrl, signAccessToken(human.id, otherAuth.familyId))).status, 401);
  await session.revokeAllUserSessions(human.id);
  const response = await getServers(app.baseUrl, signAccessToken(human.id, auth.familyId));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "auth_required");
});

test("an unverified account is refused as before (403)", async ({ app, seed, db }) => {
  const human = await seed.human();
  const auth = await signInForTest(human.id);
  await db.update(users).set({ emailVerified: false }).where(eq(users.id, human.id));
  const response = await getServers(app.baseUrl, signAccessToken(human.id, auth.familyId));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Email verification required");
});

test("an account that hasn't finished profile setup is refused as before (403 PROFILE_SETUP_REQUIRED)", async ({ app, seed, db }) => {
  const human = await seed.human();
  const auth = await signInForTest(human.id);
  await db.update(users).set({ name: `${PROFILE_SETUP_PLACEHOLDER_PREFIX}oneread`, profileSetupCompletedAt: null }).where(eq(users.id, human.id));
  const response = await getServers(app.baseUrl, signAccessToken(human.id, auth.familyId));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "PROFILE_SETUP_REQUIRED");
});

test("the shared account fields are used only for the same user", async ({ app }) => {
  void app;
  const { requireVerified } = await import("./auth");
  // requireAuth's read says verified; the request's user changed since (a
  // future delegation): requireVerified must read that user's own row.
  const req = { userId: "00000000-0000-4000-8000-000000000001", authAccount: { userId: "someone-else", emailVerified: true, profileSetupCompletedAt: new Date(), name: "x" } } as never;
  let status = 0;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as never;
  let passed = false;
  await requireVerified(req, res, () => { passed = true; });
  assert.equal(passed, false, "did not pass on another user's fields");
  assert.equal(status, 401, "read the request user's own (missing) row");
});
