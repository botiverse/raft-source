import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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

function observe(baseUrl: string, token: string, body: unknown) {
  return fetch(`${baseUrl}/api/auth/me/timezone-observation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("POST /api/auth/me/timezone-observation requires authentication", async ({ app }) => {
  const response = await fetch(`${app.baseUrl}/api/auth/me/timezone-observation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timezone: "Asia/Shanghai" }),
  });
  assert.equal(response.status, 401);
});

test("timezone observation keeps the first browser value and updates the last browser value", async ({ app }) => {
  const user = await seedUser("timezone-observation@slock.test");
  const token = await login(app.baseUrl, user.email);

  const invalidBodies = [
    {},
    { timezone: null },
    { timezone: 480 },
    { timezone: "" },
    { timezone: "Not/A_Timezone" },
    { timezone: "PST" },
    { timezone: "+08:00" },
    { timezone: "A".repeat(129) },
    { timezone: "UTC", source: "client-controlled" },
  ];
  for (const body of invalidBodies) {
    const response = await observe(app.baseUrl, token, body);
    assert.equal(response.status, 400, `expected invalid body: ${JSON.stringify(body)}`);
  }

  const firstResponse = await observe(app.baseUrl, token, { timezone: "  Asia/Shanghai  " });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as {
    firstObservedTimezone: string;
    firstObservedTimezoneAt: string;
    lastObservedTimezone: string;
    lastObservedTimezoneAt: string;
  };
  assert.equal(first.firstObservedTimezone, "Asia/Shanghai");
  assert.ok(Number.isFinite(Date.parse(first.firstObservedTimezoneAt)));
  assert.equal(first.lastObservedTimezone, "Asia/Shanghai");
  assert.equal(first.lastObservedTimezoneAt, first.firstObservedTimezoneAt);

  const secondResponse = await observe(app.baseUrl, token, { timezone: "America/New_York" });
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as typeof first;
  assert.equal(second.firstObservedTimezone, first.firstObservedTimezone);
  assert.equal(second.firstObservedTimezoneAt, first.firstObservedTimezoneAt);
  assert.equal(second.lastObservedTimezone, "America/New_York");
  assert.ok(Date.parse(second.lastObservedTimezoneAt) >= Date.parse(first.lastObservedTimezoneAt));

  const meResponse = await fetch(`${app.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json() as {
    firstObservedTimezone: string;
    firstObservedTimezoneAt: string;
    lastObservedTimezone: string;
    lastObservedTimezoneAt: string;
  };
  assert.equal(me.firstObservedTimezone, first.firstObservedTimezone);
  assert.equal(me.firstObservedTimezoneAt, first.firstObservedTimezoneAt);
  assert.equal(me.lastObservedTimezone, second.lastObservedTimezone);
  assert.equal(me.lastObservedTimezoneAt, second.lastObservedTimezoneAt);

  const [stored] = await getDb().select({
    firstObservedTimezone: users.firstObservedTimezone,
    firstObservedTimezoneAt: users.firstObservedTimezoneAt,
    lastObservedTimezone: users.lastObservedTimezone,
    lastObservedTimezoneAt: users.lastObservedTimezoneAt,
    updatedAt: users.updatedAt,
  }).from(users).where(eq(users.id, user.id));
  assert.equal(stored?.firstObservedTimezone, "Asia/Shanghai");
  assert.equal(stored?.firstObservedTimezoneAt?.toISOString(), first.firstObservedTimezoneAt);
  assert.equal(stored?.lastObservedTimezone, "America/New_York");
  assert.equal(stored?.lastObservedTimezoneAt?.toISOString(), second.lastObservedTimezoneAt);
  assert.equal(stored?.updatedAt.toISOString(), user.updatedAt.toISOString(), "analytics observation must not mutate profile updated_at");
});

test("GET /api/auth/me falls back to the first pair after a rolling-deploy legacy write", async ({ app }) => {
  const user = await seedUser("timezone-legacy-writer@slock.test");
  const token = await login(app.baseUrl, user.email);
  const observedAt = new Date("2026-07-21T12:00:00.000Z");

  // This is the state an old server can commit after migration 0187 lands:
  // it knows only the immutable first-observation columns.
  await getDb().update(users).set({
    firstObservedTimezone: "Asia/Shanghai",
    firstObservedTimezoneAt: observedAt,
  }).where(eq(users.id, user.id));

  const response = await fetch(`${app.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const me = await response.json() as {
    firstObservedTimezone: string;
    firstObservedTimezoneAt: string;
    lastObservedTimezone: string;
    lastObservedTimezoneAt: string;
  };
  assert.equal(me.firstObservedTimezone, "Asia/Shanghai");
  assert.equal(me.firstObservedTimezoneAt, observedAt.toISOString());
  assert.equal(me.lastObservedTimezone, "Asia/Shanghai");
  assert.equal(me.lastObservedTimezoneAt, observedAt.toISOString());

  const [stored] = await getDb().select({
    lastObservedTimezone: users.lastObservedTimezone,
    lastObservedTimezoneAt: users.lastObservedTimezoneAt,
  }).from(users).where(eq(users.id, user.id));
  assert.equal(stored?.lastObservedTimezone, null, "the read fallback must not fabricate a persisted last value");
  assert.equal(stored?.lastObservedTimezoneAt, null);

  const observationResponse = await observe(app.baseUrl, token, { timezone: "Europe/London" });
  assert.equal(observationResponse.status, 200);
  const observation = await observationResponse.json() as {
    firstObservedTimezone: string;
    firstObservedTimezoneAt: string;
    lastObservedTimezone: string;
    lastObservedTimezoneAt: string;
  };
  assert.equal(observation.firstObservedTimezone, "Asia/Shanghai");
  assert.equal(observation.firstObservedTimezoneAt, observedAt.toISOString());
  assert.equal(observation.lastObservedTimezone, "Europe/London");
  assert.ok(Date.parse(observation.lastObservedTimezoneAt) > observedAt.getTime());

  const refreshedResponse = await fetch(`${app.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json() as typeof observation;
  assert.equal(refreshed.lastObservedTimezone, "Europe/London");
  assert.equal(refreshed.lastObservedTimezoneAt, observation.lastObservedTimezoneAt);
});

test("timezone observation stores the server-canonical IANA zone", async ({ app }) => {
  const user = await seedUser("timezone-canonical@slock.test");
  const token = await login(app.baseUrl, user.email);

  const response = await observe(app.baseUrl, token, { timezone: "US/Pacific" });
  assert.equal(response.status, 200);
  const observation = await response.json() as {
    firstObservedTimezone: string;
    lastObservedTimezone: string;
  };
  assert.equal(observation.firstObservedTimezone, "America/Los_Angeles");
  assert.equal(observation.lastObservedTimezone, "America/Los_Angeles");
});

test("timezone observation uses the database clock when the app host clock moves backwards", async ({ app }) => {

  const originalDateNow = Date.now;
  const realNow = originalDateNow();
  let skewedAppNow = realNow + 60_000;
  try {
    const user = await seedUser("timezone-skew@slock.test");
    const token = await login(app.baseUrl, user.email);

    // Skew only calls made from the application service. PGlite's PostgreSQL
    // statement clock keeps real time, matching a separate production DB host.
    Date.now = () => new Error().stack?.includes("userService.ts")
      ? skewedAppNow
      : originalDateNow();
    const firstResponse = await observe(app.baseUrl, token, { timezone: "Europe/London" });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as {
      lastObservedTimezone: string;
      lastObservedTimezoneAt: string;
    };

    skewedAppNow = realNow - 60_000;
    const secondResponse = await observe(app.baseUrl, token, { timezone: "Asia/Tokyo" });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json() as typeof first;

    assert.equal(second.lastObservedTimezone, "Asia/Tokyo");
    assert.ok(Date.parse(second.lastObservedTimezoneAt) >= Date.parse(first.lastObservedTimezoneAt));

    const [stored] = await getDb().select({
      lastObservedTimezone: users.lastObservedTimezone,
      lastObservedTimezoneAt: users.lastObservedTimezoneAt,
    }).from(users).where(eq(users.id, user.id));
    assert.equal(stored?.lastObservedTimezone, second.lastObservedTimezone);
    assert.equal(stored?.lastObservedTimezoneAt?.toISOString(), second.lastObservedTimezoneAt);
  } finally {
    Date.now = originalDateNow;
    await app.close();
  }
});

test("concurrent timezone observations preserve one first value and a consistent latest pair", async ({ app }) => {
  const user = await seedUser("timezone-race@slock.test");
  const token = await login(app.baseUrl, user.email);

  const responses = await Promise.all([
    observe(app.baseUrl, token, { timezone: "Europe/London" }),
    observe(app.baseUrl, token, { timezone: "Asia/Tokyo" }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const observations = await Promise.all(responses.map((response) => response.json())) as Array<{
    firstObservedTimezone: string;
    firstObservedTimezoneAt: string;
    lastObservedTimezone: string;
    lastObservedTimezoneAt: string;
  }>;
  assert.equal(observations[0]!.firstObservedTimezone, observations[1]!.firstObservedTimezone);
  assert.equal(observations[0]!.firstObservedTimezoneAt, observations[1]!.firstObservedTimezoneAt);
  assert.ok(["Europe/London", "Asia/Tokyo"].includes(observations[0]!.firstObservedTimezone));
  for (const observation of observations) {
    assert.ok(["Europe/London", "Asia/Tokyo"].includes(observation.lastObservedTimezone));
    assert.ok(Date.parse(observation.lastObservedTimezoneAt) >= Date.parse(observation.firstObservedTimezoneAt));
  }

  const [stored] = await getDb().select({
    firstObservedTimezone: users.firstObservedTimezone,
    firstObservedTimezoneAt: users.firstObservedTimezoneAt,
    lastObservedTimezone: users.lastObservedTimezone,
    lastObservedTimezoneAt: users.lastObservedTimezoneAt,
  }).from(users).where(eq(users.id, user.id));
  assert.equal(stored?.firstObservedTimezone, observations[0]!.firstObservedTimezone);
  assert.equal(stored?.firstObservedTimezoneAt?.toISOString(), observations[0]!.firstObservedTimezoneAt);
  assert.ok(stored!.lastObservedTimezoneAt!.getTime() >= stored!.firstObservedTimezoneAt!.getTime());
  const storedLatestPair = `${stored!.lastObservedTimezone}|${stored!.lastObservedTimezoneAt!.toISOString()}`;
  const returnedLatestPairs = observations.map(
    (observation) => `${observation.lastObservedTimezone}|${observation.lastObservedTimezoneAt}`
  );
  assert.ok(
    returnedLatestPairs.includes(storedLatestPair),
    `stored latest pair ${storedLatestPair} must exactly match one committed response pair`
  );
});
