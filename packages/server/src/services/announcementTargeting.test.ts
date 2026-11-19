import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { asServerId, validateAnnouncementAudience, type AnnouncementClient, type AnnouncementRulePlatform } from "@botiverse/raft-shared";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import { users, servers, serverMembers, announcements, channels, machines } from "../db/schema";
import { seedBoundGuest } from "../test/guestFixture";
import { listUndismissedForUser, dismiss, resetAnnouncementComputerVersionsCacheForTest } from "./announcementService";
afterEach(closeTestDatabase);
test("targeting precedes FIFO; workspace membership and dismissal remain authoritative", async ({ db }) => {
  const [user, outsider] = await db.insert(users).values([
    { email: "target@test.invalid", name: "target", displayName: "Target", passwordHash: "test" },
    { email: "outside@test.invalid", name: "outside", displayName: "Outside", passwordHash: "test" },
  ]).returning();
  const [a, b] = await db.insert(servers).values([
    { name: "A", slug: "target-a", ownerId: user.id },
    { name: "B", slug: "target-b", ownerId: user.id },
  ]).returning();
  await db.insert(serverMembers).values([{ serverId: a.id, userId: user.id }, { serverId: b.id, userId: user.id }]);
  const [target, global] = await db.insert(announcements).values([
    { title: "A only", pages: [{ body: "A" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience({ type: "server_users", targets: [{ serverId: a.id, userIds: [user.id] }] }) },
    { title: "Global", pages: [{ body: "All" }], status: "published", startsAt: new Date("2026-02-01") },
  ]).returning();
  const load = (id: string, context?: string) => listUndismissedForUser(id, undefined, undefined, undefined, context ? asServerId(context) : undefined);
  assert.equal((await load(user.id, b.id))[0].id, global.id, "ineligible older row cannot block an eligible one");
  assert.equal((await load(user.id))[0].id, global.id, "older clients receive only account announcements");
  assert.equal((await load(outsider.id, a.id))[0].id, global.id, "spoofed server is not membership");
  const delivered = (await load(user.id, a.id))[0];
  assert.equal(delivered.id, target.id);
  assert.equal(delivered.deliveryVersion, 1);
  assert.deepEqual(delivered.deliveryScope, { type: "server", serverId: a.id });
  assert.equal("audience" in delivered, false, "recipient lists never enter user DTOs");
  assert.equal(await dismiss(user.id, target.id, undefined, asServerId(b.id)), false);
  assert.equal(await dismiss(outsider.id, target.id, undefined, asServerId(a.id)), false);
  assert.equal(await dismiss(user.id, target.id, undefined, asServerId(a.id)), true);
  assert.equal((await load(user.id, a.id))[0].id, global.id);
  await db.update(announcements).set({ audience: validateAnnouncementAudience({ type: "server_members", serverIds: [b.id] }) }).where(eq(announcements.id, global.id));
  assert.equal((await load(user.id, b.id))[0].id, global.id);
  await db.delete(serverMembers).where(eq(serverMembers.serverId, b.id));
  assert.deepEqual(await load(user.id, b.id), [], "departed members lose eligibility immediately");
  await db.update(announcements).set({ audience: validateAnnouncementAudience({ type: "users", userIds: [user.id] }) }).where(eq(announcements.id, global.id));
  assert.equal((await load(user.id, b.id))[0].id, global.id);
  assert.deepEqual(await load(outsider.id, a.id), []);
});

test("invalid targets do not block valid recipients and membership is checked at delivery time", async ({ db }) => {
  const [recipient, other] = await db.insert(users).values([
    { email: "mixed-target@test.invalid", name: "mixed-target", displayName: "Target", passwordHash: "test" },
    { email: "mixed-other@test.invalid", name: "mixed-other", displayName: "Other", passwordHash: "test" },
  ]).returning();
  const [active, deleted] = await db.insert(servers).values([
    { name: "Active", slug: "mixed-active", ownerId: recipient.id },
    { name: "Deleted", slug: "mixed-deleted", ownerId: recipient.id, deletedAt: new Date() },
  ]).returning();
  await db.insert(serverMembers).values([
    { serverId: active.id, userId: recipient.id },
    { serverId: deleted.id, userId: recipient.id },
  ]);
  const missingServer = crypto.randomUUID();
  const missingUser = crypto.randomUUID();
  const [announcement] = await db.insert(announcements).values({
    title: "Mixed validity", pages: [{ body: "Valid recipients still receive this" }],
    status: "published", startsAt: new Date("2026-01-01"),
    audience: validateAnnouncementAudience({ type: "server_users", targets: [
      { serverId: active.id, userIds: [recipient.id, other.id, missingUser] },
      { serverId: deleted.id, userIds: [recipient.id] },
      { serverId: missingServer, userIds: [recipient.id] },
    ] }),
  }).returning();
  const load = (userId: string, serverId: string) => listUndismissedForUser(userId, undefined, undefined, undefined, asServerId(serverId));
  assert.equal((await load(recipient.id, active.id))[0].id, announcement.id);
  assert.deepEqual(await load(recipient.id, deleted.id), [], "deleted Server is skipped");
  assert.deepEqual(await load(recipient.id, missingServer), [], "unknown Server is skipped");
  assert.deepEqual(await load(missingUser, active.id), [], "unknown account is skipped");
  assert.deepEqual(await load(other.id, active.id), [], "listed account without membership is skipped");
  await db.insert(serverMembers).values({ serverId: active.id, userId: other.id });
  assert.equal((await load(other.id, active.id))[0].id, announcement.id, "later membership is evaluated without republishing");
  await db.delete(serverMembers).where(eq(serverMembers.serverId, active.id));
  assert.deepEqual(await load(recipient.id, active.id), [], "membership loss takes effect without republishing");
});

test("Guest exclusion covers every audience and follows current Server role", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "guest@test.invalid", name: "guest", displayName: "Guest", passwordHash: "test" }).returning();
  const [a, b] = await db.insert(servers).values([{ name: "A", slug: "guest-a", ownerId: user.id }, { name: "B", slug: "guest-b", ownerId: user.id }]).returning();
  const home = await seedBoundGuest({ serverId: a.id, userId: user.id }, db);
  const load = (context?: string) => listUndismissedForUser(user.id, undefined, undefined, undefined, context ? asServerId(context) : undefined);
  for (const audience of [{ type: "all" }, { type: "users", userIds: [user.id] }, { type: "server_members", serverIds: [a.id] }, { type: "server_users", targets: [{ serverId: a.id, userIds: [user.id] }] }]) {
    const [row] = await db.insert(announcements).values({ title: "Guest excluded", pages: [{ body: "Test" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience(audience) }).returning();
    assert.deepEqual(await load(a.id), [], audience.type);
    assert.deepEqual(await load(), [], "context omission cannot bypass Guest-only exclusion");
    assert.deepEqual(await load(b.id), [], "spoofed context cannot bypass Guest-only exclusion");
    assert.equal(await dismiss(user.id, row.id, undefined, asServerId(a.id)), false);
    await db.delete(announcements).where(eq(announcements.id, row.id));
  }
  await db.insert(serverMembers).values({ serverId: b.id, userId: user.id });
  const [global] = await db.insert(announcements).values({ title: "Global", pages: [{ body: "Test" }], status: "published", startsAt: new Date("2026-01-01") }).returning();
  assert.deepEqual(await load(a.id), [], "membership elsewhere cannot override current Guest role");
  assert.equal((await load(b.id))[0].id, global.id);
  await db.update(serverMembers).set({ role: "member", guestChannelId: null }).where(eq(serverMembers.serverId, a.id));
  assert.equal((await load(a.id))[0].id, global.id, "promotion applies live");
  await seedBoundGuest({ serverId: a.id, userId: user.id, channelId: home }, db);
  assert.deepEqual(await load(a.id), [], "demotion applies live");
});


test("historical Guest roles on deleted or joint storage Servers do not suppress account announcements", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "historical-guest@test.invalid", name: "historical-guest", displayName: "Former Guest", passwordHash: "test" }).returning();
  const [deleted, joint] = await db.insert(servers).values([
    { name: "Deleted", slug: "guest-deleted", ownerId: user.id, deletedAt: new Date() },
    { name: "Joint", slug: "guest-joint", ownerId: user.id, kind: "joint_storage" },
  ]).returning();
  // Each Guest row bound to a channel of its server (#wg-rbac:#15).
  const [deletedHome, jointHome] = await db.insert(channels).values([
    { serverId: deleted.id, name: "guest-home", type: "private" },
    { serverId: joint.id, name: "guest-home", type: "private" },
  ]).returning();
  await db.insert(serverMembers).values([
    { serverId: deleted.id, userId: user.id, role: "guest", guestChannelId: deletedHome.id },
    { serverId: joint.id, userId: user.id, role: "guest", guestChannelId: jointHome.id },
  ]);
  for (const audience of [{ type: "all" }, { type: "users", userIds: [user.id] }]) {
    const [row] = await db.insert(announcements).values({ title: "Account", pages: [{ body: "Test" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience(audience) }).returning();
    for (const context of [undefined, deleted.id, joint.id]) {
      const delivered = await listUndismissedForUser(user.id, undefined, undefined, undefined, context ? asServerId(context) : undefined);
      assert.equal(delivered[0].id, row.id, "inactive Guest rows are not current roles");
    }
    await db.delete(announcements).where(eq(announcements.id, row.id));
  }
});

test("sidebar mode survives publication content selection and cannot vary by locale", async ({ db }) => {
  const { validateLocalizedContent } = await import("./announcementService");
  const localized = { title: "Quiet update", displayMode: "sidebar" as const, pages: [{ body: "Read this later" }] };
  assert.throws(() => validateLocalizedContent("en", { en: localized, "zh-cn": { ...localized, displayMode: "modal" } }), /same display mode/);
  const content = validateLocalizedContent("en", { en: localized, "zh-cn": localized });
  const [user] = await db.insert(users).values({ email: "mode@test.invalid", name: "mode", displayName: "Mode", passwordHash: "test", displayLanguage: "zh-cn" }).returning();
  await db.insert(announcements).values({ title: localized.title, pages: localized.pages, localizedContent: content, defaultLocale: "en", status: "published", startsAt: new Date("2026-01-01") });
  const active = await listUndismissedForUser(user.id);
  assert.equal(active.length, 1); assert.equal(active[0].displayMode, "sidebar");
});

test("client targets apply before FIFO and exclude requests that do not state a constrained value", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "client-target@test.invalid", name: "client-target", displayName: "Client", passwordHash: "test" }).returning();
  const [stuck, minOnly, global] = await db.insert(announcements).values([
    { title: "Stuck Play", pages: [{ body: "Update" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience({ type: "all", clients: [{ platform: "android", buildTypes: ["play"], maxBuild: 11400009 }] }) },
    { title: "iOS 5+", pages: [{ body: "iOS" }], status: "published", startsAt: new Date("2026-01-02"), audience: validateAnnouncementAudience({ type: "users", userIds: [user.id], clients: [{ platform: "ios", minBuild: 5 }] }) },
    { title: "Global", pages: [{ body: "All" }], status: "published", startsAt: new Date("2026-02-01") },
  ]).returning();
  const load = (client?: AnnouncementClient) => listUndismissedForUser(user.id, undefined, undefined, undefined, undefined, client);
  assert.equal((await load({ platform: "android", buildNumber: 11400009, buildType: "play" }))[0].id, stuck.id);
  assert.equal((await load({ platform: "android", buildNumber: 11400010, buildType: "play" }))[0].id, global.id, "above maxBuild");
  assert.equal((await load({ platform: "android", buildNumber: 11400009, buildType: "release" }))[0].id, global.id, "other build type");
  assert.equal((await load({ platform: "android", buildType: "play" }))[0].id, global.id, "no build number");
  assert.equal((await load({ platform: "android", buildNumber: 11400009 }))[0].id, global.id, "no build type");
  assert.equal((await load())[0].id, global.id, "web and desktop never match a client filter");
  assert.equal((await load({ platform: "ios", buildNumber: 4 }))[0].id, global.id);
  assert.equal((await load({ platform: "ios", buildNumber: 5 }))[0].id, minOnly.id);
  assert.equal(await dismiss(user.id, stuck.id, undefined, undefined, { platform: "android", buildNumber: 11501001, buildType: "play" }), false);
  assert.equal(await dismiss(user.id, stuck.id), false);
  assert.equal(await dismiss(user.id, stuck.id, undefined, undefined, { platform: "android", buildNumber: 11400009, buildType: "play" }), true);
  assert.equal((await load({ platform: "android", buildNumber: 11400009, buildType: "play" }))[0].id, global.id);
});

test("devices: desktop-only and mobile-only rows reach only their platforms; absent = both", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "devices@test.invalid", name: "devices", displayName: "Devices", passwordHash: "test" }).returning();
  const [desktopOnly, mobileOnly, both] = await db.insert(announcements).values([
    { title: "Desktop", pages: [{ body: "D" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience({ type: "all", devices: ["desktop"] }) },
    { title: "Mobile", pages: [{ body: "M" }], status: "published", startsAt: new Date("2026-01-02"), audience: validateAnnouncementAudience({ type: "all", devices: ["mobile"] }) },
    { title: "Legacy", pages: [{ body: "L" }], status: "published", startsAt: new Date("2026-01-03") },
  ]).returning();
  const head = async (platform: AnnouncementRulePlatform | null) => (await listUndismissedForUser(user.id, undefined, undefined, undefined, undefined, undefined, 1, platform))[0]?.id;
  assert.equal(await head("web"), desktopOnly.id);
  assert.equal(await head("desktop"), desktopOnly.id);
  for (const platform of ["mobile_web", "ios", "android", "harmonyos"] as const) assert.equal(await head(platform), mobileOnly.id, platform);
  assert.equal(await head(null), desktopOnly.id, "an unknown platform is not hidden from");
  assert.equal(await dismiss(user.id, mobileOnly.id, undefined, undefined, undefined, "web"), false, "a desktop request cannot dismiss a mobile-only row");
  assert.equal(await dismiss(user.id, desktopOnly.id, undefined, undefined, undefined, "web"), true);
  assert.equal(await head("web"), both.id, "after the desktop row, desktop gets the legacy row, never the mobile one");
});

test("audience rules apply in queue order, follow live facts, and gate dismissal", async ({ db }) => {
  const now = new Date("2026-11-03T12:00:00Z");
  const [user] = await db.insert(users).values({ email: "rules@test.invalid", name: "rules", displayName: "Rules", passwordHash: "test", displayLanguage: "zh-cn", createdAt: new Date("2026-11-01T00:00:00Z") }).returning();
  const [server] = await db.insert(servers).values({ name: "R", slug: "rules-r", ownerId: user.id, plan: "free", createdAt: new Date("2026-09-01T00:00:00Z") }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: user.id, role: "member" });
  const adminsOnly = { match: "all", groups: [{ match: "all", conditions: [{ field: "server_role", values: ["owner", "admin"] }] }] };
  const newChineseOnDesktop = { match: "all", groups: [
    { match: "all", conditions: [{ field: "account_created", op: "within_days", days: 7 }, { field: "platform", values: ["desktop"] }] },
    { match: "any", conditions: [{ field: "locale", values: ["zh-cn"] }, { field: "locale", values: ["zh-tw"] }] },
  ] };
  const [admins, desktop, global] = await db.insert(announcements).values([
    { title: "Admins", pages: [{ body: "A" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience({ type: "all", rules: adminsOnly }) },
    { title: "Desktop", pages: [{ body: "D" }], status: "published", startsAt: new Date("2026-02-01"), audience: validateAnnouncementAudience({ type: "all", rules: newChineseOnDesktop }) },
    { title: "Global", pages: [{ body: "G" }], status: "published", startsAt: new Date("2026-03-01") },
  ]).returning();
  const load = (platform: "desktop" | "web" | null, context: string | null = server.id) =>
    listUndismissedForUser(user.id, undefined, now, undefined, context ? asServerId(context) : undefined, null, 1, platform);
  assert.equal((await load("desktop"))[0].id, desktop.id, "a member skips the admins-only row; a matching newer row is the head");
  assert.equal((await load("web"))[0].id, global.id, "platform is judged per request");
  assert.equal((await load(null))[0].id, global.id, "an unknown platform never matches a platform condition");
  await db.update(serverMembers).set({ role: "admin" }).where(eq(serverMembers.userId, user.id));
  assert.equal((await load("web"))[0].id, admins.id, "a role change applies on the next load");
  assert.equal((await load("web", null))[0].id, global.id, "outside a Server, a Server condition does not match");
  assert.equal(await dismiss(user.id, desktop.id, now, asServerId(server.id), null, "web"), false, "dismissal is gated by the same rules");
  assert.equal(await dismiss(user.id, desktop.id, now, asServerId(server.id), null, "desktop"), true);
  const stacked = await listUndismissedForUser(user.id, undefined, new Date("2026-12-01T00:00:00Z"), undefined, asServerId(server.id), null, 1, "desktop");
  assert.equal(stacked[0].id, admins.id, "account age is measured at load time");
});

test("computer_version: the open Server's Computers in use (30 days) below the version, or unreported; cached per Server (task #39)", async ({ db }) => {
  resetAnnouncementComputerVersionsCacheForTest();
  const now = new Date("2026-11-14T00:00:00Z");
  const day = 24 * 60 * 60_000;
  const [user] = await db.insert(users).values({ email: "cv@test.invalid", name: "cv", displayName: "CV", passwordHash: "test" }).returning();
  const [oldOne, upgraded, idle, unknown] = await db.insert(servers).values([
    { name: "Old", slug: "cv-old", ownerId: user.id },
    { name: "Upgraded", slug: "cv-up", ownerId: user.id },
    { name: "Idle", slug: "cv-idle", ownerId: user.id },
    { name: "Unknown", slug: "cv-unknown", ownerId: user.id },
  ]).returning();
  await db.insert(serverMembers).values([oldOne, upgraded, idle, unknown].map((server) => ({ serverId: server.id, userId: user.id, role: "owner" as const })));
  const computer = (serverId: string, computerVersion: string | null, lastHeartbeat: Date | null, n: number) =>
    ({ serverId, userId: user.id, name: `c${n}`, apiKeyHash: `h-${serverId}-${n}`, computerVersion, lastHeartbeat });
  const [oldComputer] = await db.insert(machines).values([
    computer(oldOne.id, "1.0.52", new Date(now.getTime() - 2 * day), 1),
    computer(oldOne.id, "1.0.60", new Date(now.getTime() - 2 * day), 2),
    computer(upgraded.id, "1.0.53", new Date(now.getTime() - day), 1),
    computer(upgraded.id, "1.0.53-rc.2", new Date(now.getTime() - 40 * day), 2), // stale: not in use
    computer(idle.id, null, null, 1), // never connected
    computer(unknown.id, null, new Date(now.getTime() - 29 * day), 1),
  ]).returning();
  const rules = { match: "all", groups: [{ match: "all", conditions: [{ field: "computer_version", below: "1.0.53" }] }] };
  const [nudge, global] = await db.insert(announcements).values([
    { title: "Upgrade", pages: [{ body: "U" }], status: "published", startsAt: new Date("2026-01-01"), audience: validateAnnouncementAudience({ type: "all", rules }) },
    { title: "Global", pages: [{ body: "G" }], status: "published", startsAt: new Date("2026-02-01") },
  ]).returning();
  const head = async (serverId: string | null, at = now) =>
    (await listUndismissedForUser(user.id, undefined, at, undefined, serverId ? asServerId(serverId) : undefined, null, 1, "web"))[0]?.id;
  assert.equal(await head(oldOne.id), nudge.id, "one Computer in use below the version is enough");
  assert.equal(await head(unknown.id), nudge.id, "a Computer in use that never reported a version counts as older");
  assert.equal(await head(upgraded.id), global.id, "a stale older Computer does not count");
  assert.equal(await head(idle.id), global.id, "a never-connected Computer does not count");
  assert.equal(await head(null), global.id, "with no Server open the condition does not match");
  // An upgrade is seen once the per-Server cache (5 minutes) has expired.
  await db.update(machines).set({ computerVersion: "1.0.53" }).where(eq(machines.id, oldComputer.id));
  assert.equal(await head(oldOne.id, new Date(now.getTime() + 60_000)), nudge.id, "cached within 5 minutes");
  assert.equal(await head(oldOne.id, new Date(now.getTime() + 6 * 60_000)), global.id, "re-read after the cache expires");
});
