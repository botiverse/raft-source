import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { validateAnnouncementAudience } from "@botiverse/raft-shared";

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { announcements, oauthAccessTokens, users } from "../db/schema";
import { verifyToken } from "../middleware/auth";
import * as announcementService from "../services/announcementService";
import { createOAuthClient } from "../services/oauthService";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}



async function createVerifiedUser(email: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name: email.split("@")[0],
    displayName: email.split("@")[0],
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
    firstOnboardingCompletedAt: new Date(Date.now() - 60_000),
  }).returning();
  return user;
}

async function getActive(baseUrl: string, token: string) {
  const res = await fetch(`${baseUrl}/api/announcements/active`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  return res.json() as Promise<{ announcements: Array<{ id: string; title: string; pages: unknown[] }> }>;
}

function localizedInput(
  englishTitle: string,
  englishBody: string,
  options: {
    chineseTitle?: string;
    chineseBody?: string;
    defaultLocale?: "en" | "zh-cn";
    startsAt?: string | null;
    endsAt?: string | null;
  } = {},
) {
  return {
    defaultLocale: options.defaultLocale ?? "en",
    content: {
      en: { title: englishTitle, pages: [{ body: englishBody }] },
      ...(options.chineseTitle && options.chineseBody
        ? { "zh-cn": { title: options.chineseTitle, pages: [{ body: options.chineseBody }] } }
        : {}),
    },
    startsAt: options.startsAt ?? null,
    endsAt: options.endsAt ?? null,
  };
}

// ⚠️ INVERTED ON PURPOSE 2026-08-07. This test used to assert "only the latest row is
// surfaced; older rows are not". @cindyz replaced that invariant: a user now works
// through every live announcement they have not read, OLDEST first. If you are here
// because git history shows the old assertion, that is not a regression to restore —
// see listUndismissedForUser's doc comment.
test("GET /active returns the OLDEST unread announcement, not the newest", async ({ app }) => {
  const user = await createVerifiedUser("ann-latest@slock.test");

  const first = await announcementService.publish({ title: "First", pages: [{ body: "page one" }] });
  const second = await announcementService.publish({
    title: "Second",
    pages: [{ title: "p1", body: "body1" }, { body: "body2" }],
    startsAt: new Date(new Date(first.startsAt).getTime() + 1),
  });

  const token = await tokenForHuman(user.email);
  const res = await fetch(`${app.baseUrl}/api/announcements/active`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const data = await res.json() as { announcements: Array<{ id: string; title: string; pages: unknown[] }> };
  assert.equal(data.announcements.length, 1, "still at most one announcement at a time");
  assert.equal(data.announcements[0].id, first.id, "oldest-first: the earlier unread row wins");
  assert.equal(data.announcements[0].pages.length, 1, "pages payload survives round-trip");
});

test("GET /active advances after a failed-write frontier before applying the oldest-first limit", async ({ app }) => {
  const user = await createVerifiedUser("ann-exclude-failed@slock.test");
  const first = await announcementService.publish({ title: "First", pages: [{ body: "one" }] });
  const second = await announcementService.publish({
    title: "Second",
    pages: [{ body: "two" }],
    startsAt: new Date(new Date(first.startsAt).getTime() + 1),
  });
  const token = await tokenForHuman(user.email);
  const authHeader = { Authorization: `Bearer ${token}` };

  const advanced = await fetch(
    `${app.baseUrl}/api/announcements/active?after=${encodeURIComponent(first.id)}`,
    { headers: authHeader },
  );
  assert.equal(advanced.status, 200);
  assert.deepEqual(
    ((await advanced.json()) as { announcements: Array<{ id: string }> }).announcements.map((row) => row.id),
    [second.id],
    "the queue must advance beyond the failed oldest row before LIMIT 1",
  );

  const unchanged = await fetch(`${app.baseUrl}/api/announcements/active`, { headers: authHeader });
  assert.deepEqual(
    ((await unchanged.json()) as { announcements: Array<{ id: string }> }).announcements.map((row) => row.id),
    [first.id],
    "the request frontier must not persist a dismissal",
  );
});

test("GET /active rejects malformed failed-write frontiers", async ({ app }) => {
  const user = await createVerifiedUser("ann-exclude-invalid@slock.test");
  const token = await tokenForHuman(user.email);
  const headers = { Authorization: `Bearer ${token}` };

  const malformed = await fetch(`${app.baseUrl}/api/announcements/active?after=not-a-uuid`, { headers });
  assert.equal(malformed.status, 400);
});

test("GET /active accepts sidebar_limit 1-5 and rejects anything else", async ({ app }) => {
  const user = await createVerifiedUser("ann-sidebar-limit@slock.test");
  const headers = { Authorization: `Bearer ${await tokenForHuman(user.email)}` };
  for (const value of ["0", "6", "2.5", "x"]) {
    const res = await fetch(`${app.baseUrl}/api/announcements/active?sidebar_limit=${value}`, { headers });
    assert.equal(res.status, 400, `sidebar_limit=${value}`);
  }
  const ok = await fetch(`${app.baseUrl}/api/announcements/active?sidebar_limit=5`, { headers });
  assert.equal(ok.status, 200);
});

test("dismissed latest announcement disappears for that user; re-publishing surfaces a new row", async ({ app }) => {
  const user = await createVerifiedUser("ann-dismiss@slock.test");

  const first = await announcementService.publish({ title: "First", pages: [{ body: "a" }] });

  const token = await tokenForHuman(user.email);
  const authHeader = { Authorization: `Bearer ${token}` };

  // Dismiss it.
  const dismissRes = await fetch(`${app.baseUrl}/api/announcements/${first.id}/dismiss`, {
    method: "POST",
    headers: authHeader,
  });
  assert.equal(dismissRes.status, 200);

  // Now /active is empty for this user.
  const afterDismiss = await fetch(`${app.baseUrl}/api/announcements/active`, { headers: authHeader });
  const afterData = await afterDismiss.json() as { announcements: Array<{ id: string }> };
  assert.deepEqual(afterData.announcements, [], "dismissed latest no longer surfaces");

  // Publishing a new row replaces the latest — user sees the new one.
  const second = await announcementService.publish({ title: "Second", pages: [{ body: "b" }] });
  const afterRepublish = await fetch(`${app.baseUrl}/api/announcements/active`, { headers: authHeader });
  const republishData = await afterRepublish.json() as { announcements: Array<{ id: string }> };
  assert.deepEqual(republishData.announcements.map((x) => x.id), [second.id]);

  // Double-dismissing is idempotent (no 500).
  const dismissAgain = await fetch(`${app.baseUrl}/api/announcements/${first.id}/dismiss`, {
    method: "POST",
    headers: authHeader,
  });
  assert.equal(dismissAgain.status, 200);
});

test("a user's dismissal does not affect other users (account-scoped, per-user)", async ({ app }) => {
  const alice = await createVerifiedUser("ann-alice@slock.test");
  const bob = await createVerifiedUser("ann-bob@slock.test");

  const a = await announcementService.publish({ title: "Global notice", pages: [{ body: "hi" }] });

  const aliceToken = await tokenForHuman(alice.email);
  const bobToken = await tokenForHuman(bob.email);

  await fetch(`${app.baseUrl}/api/announcements/${a.id}/dismiss`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceToken}` },
  });

  // Alice should no longer see it.
  const aliceRes = await fetch(`${app.baseUrl}/api/announcements/active`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.deepEqual(
    (await aliceRes.json() as { announcements: Array<{ id: string }> }).announcements,
    [],
  );

  // Bob still sees it — dismissal is per-user, not global.
  const bobRes = await fetch(`${app.baseUrl}/api/announcements/active`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  });
  const bobData = await bobRes.json() as { announcements: Array<{ id: string }> };
  assert.deepEqual(bobData.announcements.map((x) => x.id), [a.id]);
});

test("dismissing a nonexistent announcement returns 404", async ({ app }) => {
  const user = await createVerifiedUser("ann-404@slock.test");
  const token = await tokenForHuman(user.email);

  const res = await fetch(`${app.baseUrl}/api/announcements/00000000-0000-0000-0000-000000000000/dismiss`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
});

test("GET /active requires authentication", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/announcements/active`);
  assert.equal(res.status, 401);
});

test("POST / (publish) is not exposed — campaigns are created via DB INSERT only", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/announcements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "X", pages: [{ body: "x" }] }),
  });
  // Express returns 404 for an unmounted POST handler.
  assert.equal(res.status, 404, "no public publish endpoint should exist");
});

// ⚠️ INVERTED 2026-08-07 with the removal of isEligibleAfterOnboarding. The server no
// longer suppresses by login family; per-server suppression while onboarding is
// incomplete now lives entirely in the client (onboardingAnnouncementGateStore), and
// @cindyz accepted that the client's memory is lost on refresh. What this test now pins
// is the REMOVAL: the server must NOT re-introduce an account-global gate.
test("the server no longer gates announcements on onboarding login family", async ({ app }) => {
  const user = await createVerifiedUser("ann-onboarding@slock.test");
  // Session-family behavior requires real logins; a fixture token has no family.
  const login = async () => {
    const response = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: "password123" }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { accessToken: string }).accessToken;
  };
  const firstToken = await login();
  const firstFamilyId = verifyToken(firstToken).familyId;
  assert.ok(firstFamilyId);

  await getDb().update(users).set({
    firstOnboardingCompletedAt: new Date(),
    firstOnboardingCompletedSessionFamilyId: firstFamilyId,
  }).where(eq(users.id, user.id));
  await announcementService.publish({ title: "After setup", pages: [{ body: "hello" }] });

  assert.equal(
    (await getActive(app.baseUrl, firstToken)).announcements[0]?.title,
    "After setup",
    "the onboarding login family is no longer suppressed server-side (client owns this now)",
  );

  const nextToken = await login();
  assert.notEqual(verifyToken(nextToken).familyId, firstFamilyId, "a fresh login creates a new session family");
  assert.equal(
    (await getActive(app.baseUrl, nextToken)).announcements[0]?.title,
    "After setup",
    "the next auth session can receive the announcement",
  );
});

// ⚠️ SECOND HALF INVERTED ON PURPOSE 2026-08-07 (same decision as the oldest-first test
// above). Expiring the newest campaign used to suppress everything behind it; under
// oldest-first an older UNREAD row is exactly what should now surface. The draft half of
// this test is unchanged — drafts still never reach the live surface.
test("drafts do not supersede live content; expiring the newest DOES surface an older unread one", async ({ app }) => {
  const user = await createVerifiedUser("ann-lifecycle@slock.test");
  const token = await tokenForHuman(user.email);
  const published = await announcementService.publish({
    title: "Published",
    pages: [{ body: "live" }],
  });
  const draft = await announcementService.createDraft(user.id, {
    defaultLocale: "en",
    content: { en: { title: "Draft", pages: [{ body: "not live" }] } },
  });
  assert.equal(draft.publishedAt, null, "a v2 draft explicitly bypasses the retained legacy DB default");

  assert.deepEqual(
    (await getActive(app.baseUrl, token)).announcements.map((item) => item.id),
    [published.id],
    "a newer draft does not alter the live surface",
  );

  const latest = await announcementService.publish({
    title: "Latest",
    pages: [{ body: "latest" }],
  });
  const expired = await announcementService.expireAnnouncement(user.id, latest.id);
  assert.equal(expired?.status, "expired");
  assert.deepEqual(
    (await getActive(app.baseUrl, token)).announcements.map((item) => item.id),
    [published.id],
    "oldest-first: expiring the newest no longer buries an older unread campaign",
  );
});

test("scheduled content is fixed, timing remains editable and overlapping windows queue", async ({ app }) => {
  const operator = await createVerifiedUser("ann-schedule@slock.test");
  await getDb()
    .update(users)
    .set({ displayLanguage: "zh-cn" })
    .where(eq(users.id, operator.id));

  const startsAt = new Date("2030-01-02T00:00:00.000Z");
  const endsAt = new Date("2030-01-03T00:00:00.000Z");
  const draft = await announcementService.createDraft(operator.id, {
    defaultLocale: "en",
    content: {
      en: { title: "Scheduled", pages: [{ body: "English body" }] },
      "zh-cn": { title: "定时公告", pages: [{ body: "中文正文" }] },
    },
    startsAt,
    endsAt,
  });
  const scheduled = await announcementService.publishDraft(
    operator.id,
    draft.id,
    new Date("2030-01-01T00:00:00.000Z"),
  );
  assert.equal(scheduled?.effectiveStatus, "scheduled");
  assert.equal(
    await announcementService.expireAnnouncement(
      operator.id,
      draft.id,
      new Date("2030-01-01T01:00:00.000Z"),
    ),
    null,
    "a future schedule must be cancelled rather than expired",
  );
  const updated = await announcementService.updateDraft(operator.id, draft.id, {
    defaultLocale: "en",
    content: {
      en: { title: "Scheduled", pages: [{ body: "English body" }] },
      "zh-cn": { title: "定时公告", pages: [{ body: "中文正文" }] },
    },
    startsAt,
    endsAt,
  });
  assert.equal(updated?.effectiveStatus, "scheduled", "published timing remains editable with fixed content");
  const cancelled = await announcementService.cancelScheduledAnnouncement(
    operator.id,
    draft.id,
    new Date("2030-01-01T06:00:00.000Z"),
  );
  assert.equal(cancelled?.status, "draft", "a future schedule returns to draft");
  const rescheduled = await announcementService.publishDraft(
    operator.id,
    draft.id,
    new Date("2030-01-01T07:00:00.000Z"),
  );
  assert.equal(rescheduled?.effectiveStatus, "scheduled");
  assert.deepEqual(
    await announcementService.listUndismissedForUser(
      operator.id,
      "next-session-family",
      new Date("2030-01-01T12:00:00.000Z"),
    ),
    [],
    "a future start does not surface early",
  );
  const active = await announcementService.listUndismissedForUser(
    operator.id,
    "next-session-family",
    new Date("2030-01-02T12:00:00.000Z"),
  );
  assert.equal(active[0]?.title, "定时公告");
  assert.equal(active[0]?.locale, "zh-cn");
  assert.deepEqual(
    [...(await announcementService.listAuditEvents(draft.id)).map((event) => event.action)].reverse(),
    [
      "created",
      "scheduled",
      "schedule_updated",
      "schedule_cancelled",
      "scheduled",
      "activated",
    ],
    "the timeline records scheduling, edits, cancellation, rescheduling, and lazy activation",
  );
  assert.deepEqual(
    await announcementService.listUndismissedForUser(
      operator.id,
      "next-session-family",
      new Date("2030-01-03T00:00:00.000Z"),
    ),
    [],
    "natural end is exclusive and never resurrects an older row",
  );

  const overlapping = await announcementService.createDraft(operator.id, {
    defaultLocale: "en",
    content: { en: { title: "Overlap", pages: [{ body: "Queues after the older announcement" }] } },
    startsAt: new Date("2030-01-02T12:00:00.000Z"),
    endsAt: new Date("2030-01-04T00:00:00.000Z"),
  });
  assert.ok(await announcementService.publishDraft(operator.id, overlapping.id, new Date("2030-01-01T00:00:00.000Z")));
  const queued = await announcementService.listUndismissedForUser(operator.id, undefined, new Date("2030-01-02T18:00:00.000Z"));
  assert.equal(queued[0]?.id, draft.id, "overlap retains oldest-first selection");
  await assert.rejects(announcementService.updateDraft(operator.id, draft.id, { defaultLocale: "en", content: { en: { title: "Changed", pages: [{ body: "Changed" }] } }, startsAt, endsAt }), /content and audience are fixed/);
});

test("authorized operator identity still gets 404 for every removed announcement admin route", async () => {
  const authorityEnv = "RAFT_ANNOUNCEMENT_OPERATOR_PRINCIPAL_IDS";
  const previousAuthority = process.env[authorityEnv];
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const operator = await createVerifiedUser(`removed-announcement-${randomUUID()}@slock.test`);
    process.env[authorityEnv] = operator.id;
    const server = await createServer("Removed Announcement Admin", `removed-ann-${randomUUID()}`, operator.id);
    const { client } = await createOAuthClient({
      serverId: server.id,
      createdByUserId: operator.id,
      clientId: "slock-feature-flag-admin",
      name: "Feature Flag Admin",
      allowedScopes: ["openid", "profile"],
    });
    const token = `removed-announcement-${randomUUID()}`;
    await getDb().insert(oauthAccessTokens).values({
      serverId: server.id,
      principalType: "human",
      userId: operator.id,
      clientId: client.id,
      tokenHash: hashSecret(token),
      scopes: ["openid", "profile"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const draft = await announcementService.createDraft(
      operator.id,
      {
        defaultLocale: "en",
        content: { en: { title: "Removed fixture", pages: [{ body: "Removed fixture" }] } },
        startsAt: null,
        endsAt: null,
      },
    );
    const cases: Array<[string, string, unknown?]> = [
      ["GET", "/api/oauth/operator/announcements"],
      ["POST", "/api/oauth/operator/announcements", localizedInput("Removed", "Removed")],
      ["PATCH", `/api/oauth/operator/announcements/${draft.id}`, localizedInput("Removed", "Removed")],
      ["POST", `/api/oauth/operator/announcements/${draft.id}/publish`],
      ["POST", `/api/oauth/operator/announcements/${draft.id}/expire`],
      ["POST", `/api/oauth/operator/announcements/${draft.id}/cancel`],
      ["GET", `/api/oauth/operator/announcements/${draft.id}/audit`],
    ];
    const statuses: Array<{ method: string; path: string; status: number }> = [];
    for (const [method, path, body] of cases) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      statuses.push({ method, path, status: response.status });
    }
    assert.deepEqual(
      statuses,
      cases.map(([method, path]) => ({ method, path, status: 404 })),
      "every announcement admin method/path must be route-absent; the shared fixture makes each B-side handler non-404",
    );
  } finally {
    if (previousAuthority === undefined) delete process.env[authorityEnv];
    else process.env[authorityEnv] = previousAuthority;
    await app.close();
  }
});


test("targeted API validates context, rejects spoofed membership and keeps recipient IDs private", async ({ app }) => {
  const member = await createVerifiedUser("ann-member@slock.test");
  const outsider = await createVerifiedUser("ann-outsider@slock.test");
  const server = await createServer("Announcement context", `ann-context-${randomUUID()}`, member.id);
  const [row] = await getDb().insert(announcements).values({ title: "Members only", pages: [{ body: "Target" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience({ type: "server_members", serverIds: [server.id] }) }).returning();
  const memberToken = await tokenForHuman(member.email);
  const outsiderToken = await tokenForHuman(outsider.email);
  const request = (token: string, query: string) => fetch(`${app.baseUrl}/api/announcements/active${query}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await request(memberToken, "?server_id=bad")).status, 400);
  assert.equal((await request(memberToken, `?server_id=${server.id}&server_id=${server.id}`)).status, 400);
  assert.deepEqual((await (await request(outsiderToken, `?server_id=${server.id}`)).json()).announcements, []);
  assert.deepEqual((await getActive(app.baseUrl, memberToken)).announcements, []);
  const data = await (await request(memberToken, `?server_id=${server.id}`)).json();
  assert.equal(data.announcements[0].id, row.id);
  assert.equal("audience" in data.announcements[0], false);
  const denied = await fetch(`${app.baseUrl}/api/announcements/${row.id}/dismiss?server_id=${server.id}`, { method: "POST", headers: { Authorization: `Bearer ${outsiderToken}` } });
  assert.equal(denied.status, 404);
});

test("client-targeted announcements follow the request User-Agent and never block unfiltered ones", async ({ app }) => {
  const user = await createVerifiedUser("ann-client@slock.test");
  const [stuck, global] = await getDb().insert(announcements).values([
    { title: "Update manually", pages: [{ body: "Stuck Play build" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience({ type: "all", clients: [{ platform: "android", buildTypes: ["play"], maxBuild: 11400009 }] }) },
    { title: "Everyone", pages: [{ body: "All" }], status: "published", startsAt: new Date("2026-02-01") },
  ]).returning();
  const token = await tokenForHuman(user.email);
  const active = async (userAgent: string) => {
    const res = await fetch(`${app.baseUrl}/api/announcements/active`, { headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent } });
    assert.equal(res.status, 200);
    return ((await res.json()) as { announcements: Array<{ id: string }> }).announcements.map((item) => item.id);
  };
  const stuckUa = "Raft/1.14.0+11400009 (Android 36; play)";
  assert.deepEqual(await active(stuckUa), [stuck.id]);
  assert.deepEqual(await active("Raft/1.16.1+11601001 (Android 36; release)"), [global.id], "an older filtered row does not block a newer one");
  assert.deepEqual(await active("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"), [global.id]);
  const dismiss = (userAgent: string) => fetch(`${app.baseUrl}/api/announcements/${stuck.id}/dismiss`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent } });
  assert.equal((await dismiss("Raft/1.16.1+11601001 (Android 36; release)")).status, 404);
  assert.equal((await dismiss(stuckUa)).status, 200);
  assert.deepEqual(await active(stuckUa), [global.id]);
});
