// #triage:#210: how the message box sends, stored on the person's account
// through PATCH /api/auth/me (shared composerSendKey.ts).
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";

const test = createApiTest();

test("the message box's send key: the default until changed, saved on the account, bad values refused", async ({ app }) => {
  const [user] = await getDb().insert(users).values({
    email: "composer-send-key@slock.test",
    name: "composer-send-key",
    displayName: "composer-send-key",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const token = await tokenForHuman(user.email);
  const patch = (body: unknown) => fetch(`${app.baseUrl}/api/auth/me`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const me = async () => (await (await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json() as { composerSendKey: string | null }).composerSendKey;

  assert.equal(await me(), null, "Enter sends (null) until changed");

  const chosen = await patch({ composerSendKey: "mod_enter" });
  assert.equal(chosen.status, 200);
  assert.equal((await chosen.json() as { composerSendKey: string | null }).composerSendKey, "mod_enter");
  assert.equal(await me(), "mod_enter");
  const [row] = await getDb().select({ composerSendKey: users.composerSendKey }).from(users).where(eq(users.id, user.id));
  assert.equal(row.composerSendKey, "mod_enter");

  for (const body of [{ composerSendKey: "ctrl_enter" }, { composerSendKey: 1 }]) {
    const res = await patch(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json() as { error: string }).error, /composerSendKey must be/);
  }
  assert.equal(await me(), "mod_enter", "a refused value leaves the saved one");

  assert.equal((await patch({ composerSendKey: "enter" })).status, 200);
  assert.equal(await me(), null, "enter goes back to the default (stored as null)");
});
