import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { getUser } from "../services/userService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// Deep links (1d): GET /api/auth/me says whether this account used Raft Desktop
// in the last 30 days. Raft Desktop's web client sends
// X-Raft-Client-Platform: desktop_app on every request, so its own profile
// load is the record; no desktop change is needed.

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedUser(email: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name: email.split("@")[0]!,
    displayName: email.split("@")[0]!,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return (await response.json() as { accessToken: string }).accessToken;
}

async function me(baseUrl: string, token: string, platform?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (platform) headers["X-Raft-Client-Platform"] = platform;
  const response = await fetch(`${baseUrl}/api/auth/me`, { headers });
  assert.equal(response.status, 200);
  return await response.json() as { id: string; usedDesktopAppRecently?: unknown };
}

async function seenAt(userId: string): Promise<Date | null> {
  const [row] = await getDb().select({ at: users.lastDesktopAppSeenAt }).from(users).where(eq(users.id, userId));
  return row?.at ?? null;
}

async function setSeenAt(userId: string, at: Date | null) {
  await getDb().update(users).set({ lastDesktopAppSeenAt: at }).where(eq(users.id, userId));
}

test("a browser-only account is not a desktop user; a Raft Desktop profile load makes it one", async ({ app }) => {
  const user = await seedUser("desktop-hint@slock.test");
  const token = await login(app.baseUrl, user.email);

  assert.equal((await me(app.baseUrl, token)).usedDesktopAppRecently, false);
  assert.equal((await me(app.baseUrl, token, "browser")).usedDesktopAppRecently, false);
  assert.equal((await me(app.baseUrl, token, "pwa")).usedDesktopAppRecently, false);
  assert.equal(await seenAt(user.id), null, "a browser never stamps the desktop record");

  assert.equal((await me(app.baseUrl, token, "desktop_app")).usedDesktopAppRecently, true);
  assert.notEqual(await seenAt(user.id), null);
  // The same account in a browser afterwards: the hint the banner reads.
  assert.equal((await me(app.baseUrl, token, "browser")).usedDesktopAppRecently, true);
});

test("the hint lapses after 30 days without Raft Desktop", async ({ app }) => {
  const user = await seedUser("desktop-hint-lapse@slock.test");
  const token = await login(app.baseUrl, user.email);

  await setSeenAt(user.id, new Date(Date.now() - 29 * DAY_MS));
  assert.equal((await me(app.baseUrl, token, "browser")).usedDesktopAppRecently, true);
  await setSeenAt(user.id, new Date(Date.now() - 31 * DAY_MS));
  assert.equal((await me(app.baseUrl, token, "browser")).usedDesktopAppRecently, false);
});

test("Raft Desktop stamps at most once a day, so the profile load stays a read", async ({ app }) => {
  const user = await seedUser("desktop-hint-throttle@slock.test");
  const token = await login(app.baseUrl, user.email);

  const recent = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await setSeenAt(user.id, recent);
  await me(app.baseUrl, token, "desktop_app");
  assert.equal((await seenAt(user.id))?.getTime(), recent.getTime(), "within a day: no write");

  const stale = new Date(Date.now() - 3 * DAY_MS);
  await setSeenAt(user.id, stale);
  await me(app.baseUrl, token, "desktop_app");
  const refreshed = await seenAt(user.id);
  assert.ok(refreshed && refreshed.getTime() > stale.getTime() + DAY_MS, "older than a day: stamped again");
});

test("only /me carries the hint: other reads of the profile leave it out", async ({ app }) => {
  const user = await seedUser("desktop-hint-scope@slock.test");
  const token = await login(app.baseUrl, user.email);
  await me(app.baseUrl, token, "desktop_app");
  const profile = await getUser(user.id);
  assert.equal(profile !== null && "usedDesktopAppRecently" in profile, false);
  assert.equal((await getUser(user.id, { withDesktopAppHint: true }))?.usedDesktopAppRecently, true);
});
