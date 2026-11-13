// #proj-frontend:#37: the keyboard shortcuts a person changed, stored on their account through
// PATCH /api/auth/me (shared shortcutOverrides.ts).
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";

const test = createApiTest();

test("changed shortcuts: none until changed, saved whole on the account, bad maps refused, null resets", async ({ app }) => {
  const [user] = await getDb().insert(users).values({
    email: "shortcut-overrides@slock.test",
    name: "shortcut-overrides",
    displayName: "shortcut-overrides",
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
  type Me = { shortcutOverrides: unknown };
  const me = async () => (await (await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json() as Me).shortcutOverrides;

  assert.equal(await me(), null, "every default (null) until changed");

  const map = { search: [{ key: "J", mod: true }], sidebar: [] };
  const saved = await patch({ shortcutOverrides: map });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json() as Me).shortcutOverrides, map);
  assert.deepEqual(await me(), map);
  const [row] = await getDb().select({ shortcutOverrides: users.shortcutOverrides }).from(users).where(eq(users.id, user.id));
  assert.deepEqual(row.shortcutOverrides, map);

  for (const body of [{ shortcutOverrides: "search" }, { shortcutOverrides: { search: [{ key: "J", meta: true }] } }]) {
    const res = await patch(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json() as { error: string }).error, /shortcutOverrides must be/);
  }
  assert.deepEqual(await me(), map, "a refused map leaves the saved one");

  assert.equal((await patch({ displayName: "renamed" })).status, 200);
  assert.deepEqual(await me(), map, "another field's PATCH leaves it");

  assert.equal((await patch({ shortcutOverrides: {} })).status, 200);
  assert.equal(await me(), null, "{} goes back to every default (stored as null)");
});
