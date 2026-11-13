import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PRO_PREPAID_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import { seedPrepaidPurchase } from "../test/prepaidProFixture";
import { getDb } from "../db/index";
import { featureFlags, prepaidProPurchases, prepaidProReminders, serverMembers, servers, users } from "../db/schema";
import { renderPrepaidProReminderEmail, type PrepaidProReminderEmail } from "./emailService";
import { PREPAID_REMINDER_RETRY_AFTER_MS, __resetPrepaidReminderFailuresForTests, prepaidReminderKind, sendPrepaidProReminders } from "./prepaidProReminders";

afterEach(async () => {
  __resetPrepaidReminderFailuresForTests();
  await closeTestDatabase();
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const later = (ms: number) => new Date(NOW.getTime() + ms);

type Sent = { to: string; name: string; input: PrepaidProReminderEmail; key: string };

function recorder(fail = false) {
  const sent: Sent[] = [];
  const send = async (to: string, name: string, input: PrepaidProReminderEmail, key: string) => {
    sent.push({ to, name, input, key });
    if (fail) throw new Error("provider down");
    return `email_${sent.length}`;
  };
  return { sent, send };
}

async function setPrepaidFlag(enabled: boolean) {
  await getDb().insert(featureFlags)
    .values({ key: PRO_PREPAID_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: true, enabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled, defaultEnabled: true, killSwitch: false } });
}

/** A Pro Server on prepaid time ending `endsIn` from NOW (bought a month before that). */
async function seedPrepaidServer(label: string, endsIn: number, input: { plan?: "pro" | "founder"; email?: string; displayLanguage?: string | null } = {}) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: input.email ?? `${label}-${randomUUID()}@slock.test`, name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label,
    passwordHash: "hash", emailVerified: true, displayLanguage: input.displayLanguage ?? null,
  }).returning();
  const [server] = await db.insert(servers).values({ name: `Acme ${label}`, slug: `${label}-${randomUUID()}`, ownerId: owner.id, plan: input.plan ?? "pro" }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const endsAt = later(endsIn);
  const purchaseId = await seedPrepaidPurchase(db, { serverId: server.id, startsAt: new Date(endsAt.getTime() - 30 * DAY), endsAt, userId: owner.id });
  return { owner, server, endsAt, purchaseId };
}

const reminders = (purchaseId: string) => getDb().select().from(prepaidProReminders).where(eq(prepaidProReminders.purchaseId, purchaseId));

test("which reminder is due: a week, a day, or ended", () => {
  assert.equal(prepaidReminderKind(later(8 * DAY), NOW), null);
  assert.equal(prepaidReminderKind(later(7 * DAY), NOW), "ends_in_7_days");
  assert.equal(prepaidReminderKind(later(DAY + 1), NOW), "ends_in_7_days");
  assert.equal(prepaidReminderKind(later(DAY), NOW), "ends_in_1_day");
  assert.equal(prepaidReminderKind(later(1), NOW), "ends_in_1_day");
  assert.equal(prepaidReminderKind(NOW, NOW), "ended");
});

test("a week ahead the owner gets one email in their language, recorded once; the next run sends nothing", async ({ db: _db }) => {
  await setPrepaidFlag(true);
  const { owner, server, endsAt, purchaseId } = await seedPrepaidServer("week", 5 * DAY, { displayLanguage: "zh-CN" });
  const { sent, send } = recorder();
  assert.deepEqual(await sendPrepaidProReminders(() => NOW, send), { sent: 1, failed: 0, consecutiveFailedRuns: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, owner.email);
  assert.equal(sent[0].input.kind, "ends_in_7_days");
  assert.equal(sent[0].input.server.slug, server.slug);
  assert.equal(sent[0].input.endsAt.toISOString(), endsAt.toISOString());
  assert.equal(sent[0].input.locale, "zh-CN");
  assert.equal(sent[0].key, `prepaid-pro-reminder:${purchaseId}:ends_in_7_days:${owner.id}`);
  const [row] = await reminders(purchaseId);
  assert.equal(row.emailId, "email_1");
  assert.ok(row.sentAt);
  assert.equal(row.recipientUserId, owner.id);

  assert.deepEqual(await sendPrepaidProReminders(() => later(60 * 60 * 1000), send), { sent: 0, failed: 0, consecutiveFailedRuns: 0 });
  assert.equal(sent.length, 1, "once per purchase and kind");
});

test("the last day, then the grace days, each get their own email; nothing after grace", async ({ db: _db }) => {
  await setPrepaidFlag(true);
  const { purchaseId } = await seedPrepaidServer("day", 12 * 60 * 60 * 1000);
  const { sent, send } = recorder();
  await sendPrepaidProReminders(() => NOW, send);
  assert.deepEqual(sent.map(s => s.input.kind), ["ends_in_1_day"], "the missed week-ahead email is not caught up");
  await sendPrepaidProReminders(() => later(DAY), send);
  assert.deepEqual(sent.map(s => s.input.kind), ["ends_in_1_day", "ended"]);
  assert.equal(sent[1].input.graceEndsAt.getTime() - sent[1].input.endsAt.getTime(), 3 * DAY);
  await sendPrepaidProReminders(() => later(5 * DAY), send);
  assert.equal(sent.length, 2, "after the grace days the Server is Free: no email");
  assert.equal((await reminders(purchaseId)).length, 2);
});

test("a renewal moves the end: no reminder for the old one, and the new last purchase gets its own", async ({ db: _db }) => {
  await setPrepaidFlag(true);
  const { server, endsAt, owner, purchaseId: first } = await seedPrepaidServer("renewed", 3 * DAY);
  const { sent, send } = recorder();
  await sendPrepaidProReminders(() => NOW, send);
  assert.deepEqual(sent.map(s => s.key), [`prepaid-pro-reminder:${first}:ends_in_7_days:${owner.id}`]);
  const renewedEnd = new Date(endsAt.getTime() + 30 * DAY);
  const second = await seedPrepaidPurchase(getDb(), { serverId: server.id, startsAt: endsAt, endsAt: renewedEnd, userId: owner.id });
  // Seats added to the current time, and a refunded renewal beyond it, never become "the last purchase".
  await seedPrepaidPurchase(getDb(), { serverId: server.id, kind: "seats", startsAt: NOW, endsAt: renewedEnd, userId: owner.id });
  await seedPrepaidPurchase(getDb(), { serverId: server.id, startsAt: renewedEnd, endsAt: new Date(renewedEnd.getTime() + 30 * DAY), status: "refunded", userId: owner.id });
  await sendPrepaidProReminders(() => later(DAY), send);
  assert.equal(sent.length, 1, "the renewed end is a month away");
  await sendPrepaidProReminders(() => new Date(renewedEnd.getTime() - 2 * DAY), send);
  assert.deepEqual(sent.map(s => s.key), [`prepaid-pro-reminder:${first}:ends_in_7_days:${owner.id}`, `prepaid-pro-reminder:${second}:ends_in_7_days:${owner.id}`]);
  assert.equal(sent[1].input.endsAt.toISOString(), renewedEnd.toISOString());
});

test("every owner now gets their own email, in their language; the creator who is no longer an owner does not (review v1.21.52 L3)", async ({ db: _db }) => {
  await setPrepaidFlag(true);
  const db = getDb();
  const { owner: creator, server, purchaseId } = await seedPrepaidServer("owners", 5 * DAY);
  const [second, third] = await db.insert(users).values(["second", "third"].map(label => ({
    email: `${label}-${randomUUID()}@slock.test`, name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label, passwordHash: "hash", emailVerified: true,
    displayLanguage: label === "second" ? "zh-CN" : null,
  }))).returning();
  await db.insert(serverMembers).values([{ serverId: server.id, userId: second.id, role: "owner" }, { serverId: server.id, userId: third.id, role: "admin" }]);
  // The creator handed ownership on: still `servers.owner_id`, an admin now.
  await db.update(serverMembers).set({ role: "admin" }).where(eq(serverMembers.userId, creator.id));
  const { sent, send } = recorder();
  await sendPrepaidProReminders(() => NOW, send);
  assert.deepEqual(sent.map(s => s.to), [second.email], "owners only, each on their own email");
  assert.equal(sent[0].input.locale, "zh-CN");
  assert.equal(sent[0].key, `prepaid-pro-reminder:${purchaseId}:ends_in_7_days:${second.id}`);
  const [row] = await reminders(purchaseId);
  assert.equal(row.recipientUserId, second.id);

  // Two owners: two emails, one reminder row.
  await db.update(serverMembers).set({ role: "owner" }).where(eq(serverMembers.userId, creator.id));
  const other = await seedPrepaidServer("two-owners", 5 * DAY);
  await db.insert(serverMembers).values({ serverId: other.server.id, userId: second.id, role: "owner" });
  const two = recorder();
  await sendPrepaidProReminders(() => NOW, two.send);
  assert.deepEqual(new Set(two.sent.map(s => s.to)), new Set([other.owner.email, second.email]));
  assert.equal((await reminders(other.purchaseId)).length, 1);
});

test("two runs at once (two replicas) send one email", async ({ db: _db }) => {
  await setPrepaidFlag(true);
  const { purchaseId } = await seedPrepaidServer("race", 5 * DAY);
  const { sent, send } = recorder();
  const results = await Promise.all([sendPrepaidProReminders(() => NOW, send), sendPrepaidProReminders(() => NOW, send)]);
  assert.equal(results[0].sent + results[1].sent, 1);
  assert.equal(sent.length, 1);
  assert.equal((await reminders(purchaseId)).length, 1);
});

test("a failed send keeps its claim: not resent within 15 minutes, resent after with the same key", async ({ db: _db }) => {
  await setPrepaidFlag(true);
  const { purchaseId } = await seedPrepaidServer("retry", 5 * DAY);
  const failing = recorder(true);
  assert.deepEqual(await sendPrepaidProReminders(() => NOW, failing.send), { sent: 0, failed: 1, consecutiveFailedRuns: 1 });
  let [row] = await reminders(purchaseId);
  assert.equal(row.sentAt, null, "the claim stays, unsent");

  const working = recorder();
  await sendPrepaidProReminders(() => later(PREPAID_REMINDER_RETRY_AFTER_MS - 60_000), working.send);
  assert.equal(working.sent.length, 0, "a fresh claim may still be in flight elsewhere");
  await sendPrepaidProReminders(() => later(PREPAID_REMINDER_RETRY_AFTER_MS + 60_000), working.send);
  assert.equal(working.sent.length, 1);
  assert.equal(working.sent[0].key, failing.sent[0].key, "the provider drops it if the first send went out");
  [row] = await reminders(purchaseId);
  assert.ok(row.sentAt);
  assert.equal((await reminders(purchaseId)).length, 1);
});

test("nothing is sent with pro_prepaid off, for a refunded purchase, a founder, a deleted Server, or an owner with no usable address", async ({ db: _db }) => {
  const db = getDb();
  await setPrepaidFlag(false);
  const flagOff = await seedPrepaidServer("flag-off", 5 * DAY);
  const { sent, send } = recorder();
  await sendPrepaidProReminders(() => NOW, send);
  assert.equal(sent.length, 0);
  assert.equal((await reminders(flagOff.purchaseId)).length, 0, "no claim either: turning the flag on sends it");

  await setPrepaidFlag(true);
  await db.delete(prepaidProPurchases).where(eq(prepaidProPurchases.id, flagOff.purchaseId));
  const refunded = await seedPrepaidServer("refunded", 5 * DAY);
  await db.update(prepaidProPurchases).set({ status: "refunded" }).where(eq(prepaidProPurchases.id, refunded.purchaseId));
  await seedPrepaidServer("founder", 5 * DAY, { plan: "founder" });
  const deleted = await seedPrepaidServer("deleted", 5 * DAY);
  await db.update(servers).set({ deletedAt: NOW }).where(eq(servers.id, deleted.server.id));
  const gone = await seedPrepaidServer("gone", 5 * DAY, { email: `deleted+${randomUUID()}@invalid` });
  await sendPrepaidProReminders(() => NOW, send);
  assert.equal(sent.length, 0);
  assert.equal((await reminders(gone.purchaseId)).length, 0, "no claim without an address, so a fixed address still gets it");
});

test("the email: English or Chinese, the dates in UTC, and Renew Pro opens Plan & Billing", () => {
  const input: PrepaidProReminderEmail = {
    kind: "ends_in_7_days",
    server: { name: "Acme", slug: "acme" },
    endsAt: new Date("2026-12-04T10:00:00Z"),
    graceEndsAt: new Date("2026-12-07T10:00:00Z"),
  };
  const en = renderPrepaidProReminderEmail("Ana", input);
  assert.equal(en.subject, "Pro for Acme ends on December 4, 2026 (UTC)");
  assert.ok(en.html.includes("/s/acme/settings/billing"));
  assert.ok(en.text.includes("Renew Pro: "));
  assert.equal(renderPrepaidProReminderEmail("Ana", { ...input, kind: "ends_in_1_day" }).subject, "Pro for Acme ends within a day");
  const ended = renderPrepaidProReminderEmail("Ana", { ...input, kind: "ended" });
  assert.equal(ended.subject, "Pro for Acme has ended");
  assert.ok(ended.text.includes("It stays on until December 7, 2026 (UTC)"), "a date, not a day count: it may go out late in the grace days");
  const zh = renderPrepaidProReminderEmail("安娜", { ...input, locale: "zh-CN" });
  assert.equal(zh.subject, "Acme 的 Pro 将于 2026年12月4日（UTC）到期");
  assert.ok(zh.text.includes("续费 Pro: "));
  assert.ok(renderPrepaidProReminderEmail("安娜", { ...input, kind: "ended", locale: "zh-CN" }).text.includes("可以继续用到 2026年12月7日（UTC）；之后服务器会降回免费版"));
  assert.equal(renderPrepaidProReminderEmail("安娜", { ...input, locale: "zh-TW" }).subject, "Acme 的 Pro 將於 2026年12月4日（UTC）到期");
  assert.equal(renderPrepaidProReminderEmail("Ana", { ...input, locale: "ja" }).subject, en.subject, "other languages get English");
});
