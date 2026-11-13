// #proj-assistant:#21: whether the assistant's otter shows over every page,
// and the shortcut that hides it for a while, stored on the person's account
// through PATCH /api/auth/me (shared assistantOtterShortcut.ts).
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";

const test = createApiTest();

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

type OtterPrefs = { assistantOtterVisible: boolean; assistantOtterShortcut: string | null };

test("the otter's switch and shortcut: shown with the default until changed, saved on the account, bad values refused", async ({ app }) => {
  const user = await seedUser("otter-prefs@slock.test", "otter-prefs");
  const token = await tokenForHuman(user.email);
  const patch = (body: unknown) => fetch(`${app.baseUrl}/api/auth/me`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const me = async () => {
    const body = await (await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json() as OtterPrefs;
    return { assistantOtterVisible: body.assistantOtterVisible, assistantOtterShortcut: body.assistantOtterShortcut };
  };

  assert.deepEqual(await me(), { assistantOtterVisible: true, assistantOtterShortcut: null }, "shown, with the default shortcut (null)");

  const hidden = await patch({ assistantOtterVisible: false });
  assert.equal(hidden.status, 200);
  assert.equal((await hidden.json() as OtterPrefs).assistantOtterVisible, false);

  const chosen = await patch({ assistantOtterShortcut: "Mod+Shift+Quote" });
  assert.equal(chosen.status, 200);
  assert.deepEqual(await me(), { assistantOtterVisible: false, assistantOtterShortcut: "Mod+Shift+Quote" });
  const [row] = await getDb().select({ visible: users.assistantOtterVisible, shortcut: users.assistantOtterShortcut }).from(users).where(eq(users.id, user.id));
  assert.deepEqual(row, { visible: false, shortcut: "Mod+Shift+Quote" });

  const invalid: Array<[unknown, RegExp]> = [
    [{ assistantOtterVisible: "no" }, /must be a boolean/],
    [{ assistantOtterVisible: null }, /must be a boolean/],
    [{ assistantOtterShortcut: "Mod+Shift+KeyT" }, /reserved/],
    [{ assistantOtterShortcut: "Mod+Alt+KeyO" }, /alt_gr/],
    [{ assistantOtterShortcut: "Shift+Period" }, /needs_mod/],
    [{ assistantOtterShortcut: "Ctrl+Space" }, /must be a shortcut/],
    [{ assistantOtterShortcut: 7 }, /must be a shortcut/],
  ];
  for (const [body, error] of invalid) {
    const res = await patch(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json() as { error: string }).error, error);
  }
  assert.deepEqual(await me(), { assistantOtterVisible: false, assistantOtterShortcut: "Mod+Shift+Quote" }, "a refused value leaves the saved ones");

  assert.equal((await patch({ assistantOtterShortcut: "off" })).status, 200);
  assert.equal((await me()).assistantOtterShortcut, "off");
  assert.equal((await patch({ assistantOtterShortcut: null, assistantOtterVisible: true })).status, 200);
  assert.deepEqual(await me(), { assistantOtterVisible: true, assistantOtterShortcut: null }, "null goes back to the default");
});
