import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { emailVerifications, servers } from "../db/schema";
import { __setEmailDeliveryObserverForTests } from "../services/emailService";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function memoryProductEventSink() {
  const rows: ProductEventRow[] = [];
  return {
    rows,
    sink: {
      enqueue(batch: readonly ProductEventRow[]) {
        rows.push(...batch);
      },
      async flush() {},
    } satisfies ProductEventSink,
  };
}

const LEGAL = {
  acceptTerms: true,
  termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
  privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
};
const JOURNEY_EVENTS = new Set(["account_created", "email_verification_sent", "email_verified", "account_profile_completed", "server_created"]);
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** The events are written after the response: wait for `count` matching rows, then a little longer for strays. */
async function settle(rows: readonly ProductEventRow[], count: number, events: ReadonlySet<string> = JOURNEY_EVENTS): Promise<void> {
  const seen = () => rows.filter((row) => events.has(row.event)).length;
  for (let i = 0; i < 200 && seen() < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function register(baseUrl: string, email: string, headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email, password: "password123", ...LEGAL }),
  });
  assert.equal(response.status, 200);
  return await response.json() as { user: { id: string }; accessToken: string };
}

// #proj-onboarding:#2 (Ferry): the steps before a person has a server are recorded by the
// server, since the web sends no client events without one.
test("new-user journey: signup, resend and verification record the verification email's fate, without the email", async ({ app, db }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const signup = await register(app.baseUrl, "journey-verify@slock.test", { "X-Raft-Client-Platform": "desktop_app" });
  const resend = () => fetch(`${app.baseUrl}/api/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signup.accessToken}`, "X-Raft-Client-Platform": "desktop_app" },
    body: "{}",
  });

  assert.equal((await resend()).status, 429, "within the 60-second cooldown of the signup email");
  await db.update(emailVerifications)
    .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
    .where(eq(emailVerifications.userId, signup.user.id));
  assert.equal((await resend()).status, 200);

  await db.insert(emailVerifications).values({
    userId: signup.user.id,
    tokenHash: hashToken("journey-verify-token"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const verify = (token: string) => fetch(`${app.baseUrl}/api/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Raft-Client-Platform": "pwa" },
    body: JSON.stringify({ token }),
  });
  assert.equal((await verify("journey-verify-token")).status, 200);
  assert.equal((await verify("journey-verify-token")).status, 400, "a used token verifies nothing");
  await db.insert(emailVerifications).values({
    userId: signup.user.id,
    tokenHash: hashToken("journey-verify-token-late"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal((await verify("journey-verify-token-late")).status, 200, "an old link still lands");

  await settle(store.rows, 5);
  const journey = store.rows.filter((row) => JOURNEY_EVENTS.has(row.event));
  assert.deepEqual(journey.map((row) => [row.event, row.properties]), [
    ["account_created", { platform: "desktop_app", method: "email", invited: false }],
    ["email_verification_sent", { trigger: "signup", result: "sent", platform: "desktop_app" }],
    ["email_verification_sent", { trigger: "resend", result: "rate_limited", platform: "desktop_app" }],
    ["email_verification_sent", { trigger: "resend", result: "sent", platform: "desktop_app" }],
    ["email_verified", { platform: "pwa" }],
  ]);
  // The late link verified nothing new (the address already was): no second email_verified.
  const analyticsId = journey[0]!.analytics_id;
  assert.match(String(analyticsId), /^[0-9a-f-]{36}$/);
  for (const row of journey) {
    assert.equal(row.source, "server");
    assert.equal(row.server_id, null, "account-level facts");
    assert.equal(row.analytics_id, analyticsId, "one person's journey");
  }
  assert.equal(JSON.stringify(journey).includes("@slock.test"), false, "no email");
});

test("new-user journey: a verification email the provider refuses is recorded as failed", async ({ app }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  __setEmailDeliveryObserverForTests(() => {
    throw new Error("Failed to send email");
  });
  try {
    await register(app.baseUrl, "journey-refused@slock.test", { "X-Raft-Client-Platform": "browser" });
  } finally {
    __setEmailDeliveryObserverForTests(null);
  }
  await settle(store.rows, 2);
  assert.deepEqual(
    store.rows.filter((row) => row.event === "email_verification_sent").map((row) => row.properties),
    [{ trigger: "signup", result: "failed", platform: "web" }],
  );
});

test("new-user journey: identity setup recorded once (not on a replay), and whether a created server is its owner's first", async ({ app, http, seed, db }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const signup = await register(app.baseUrl, "journey-profile@slock.test", {});
  const completeProfile = () => fetch(`${app.baseUrl}/api/auth/me/complete-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signup.accessToken}`, "X-Raft-Client-Platform": "ios" },
    body: JSON.stringify({ name: "journey-profile", displayName: "Journey Profile" }),
  });
  assert.equal((await completeProfile()).status, 200);
  assert.equal((await completeProfile()).status, 200, "a same-payload replay answers like the first");

  const owner = await seed.human();
  const create = async (name: string, slug: string) => {
    const response = await http.as(owner).request("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Raft-Client-Platform": "browser" },
      body: JSON.stringify({ name, slug }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { id: string }).id;
  };
  const first = await create("Journey One", "journey-one");
  const second = await create("Journey Two", "journey-two");

  await settle(store.rows, 4);
  assert.deepEqual(
    store.rows.filter((row) => row.event === "account_profile_completed").map((row) => row.properties),
    [{ platform: "ios" }],
  );
  // Recorded after the response, in either order: first_server compares creation times, not recording order.
  const created = store.rows.filter((row) => row.event === "server_created");
  assert.deepEqual(new Map(created.map((row) => [row.server_id, row.properties])), new Map([
    [first, { first_server: true, platform: "web" }],
    [second, { first_server: false, platform: "web" }],
  ]));
  const names = (await db.select({ name: servers.name }).from(servers)).map((row) => row.name);
  assert.ok(names.includes("Journey One"));
  assert.equal(JSON.stringify(created).includes("Journey"), false, "no server name");
});
