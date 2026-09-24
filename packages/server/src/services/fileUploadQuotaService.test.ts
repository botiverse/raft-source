import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { jointChannels, jointChannelServers, servers, users } from "../db/schema.js";
import { createChannel } from "./channelService.js";
import { isChannelReadOnlyByBillingFeature } from "./planService.js";
import { createServer } from "./serverService.js";
import {
  FileUploadQuotaExceededError,
  buildFileUploadQuotaExceededResponse,
  getFileUploadQuotaSummary,
  withFileUploadQuota,
} from "./fileUploadQuotaService.js";


afterEach(async () => {
  await closeTestDatabase();
});

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  return user;
}

test("Free monthly upload quota allows exact 100 MiB boundary and rejects the next byte", async ({ db }) => {

  const owner = await seedUser("quota-free-owner");
  const server = await createServer("Quota Free", `quota-free-${randomUUID()}`, owner.id);
  const now = new Date("2026-06-23T12:00:00Z");

  await withFileUploadQuota(server.id, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, async () => "ok", now);
  const summary = await getFileUploadQuotaSummary(server.id, now);
  assert.equal(summary.usedBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
  assert.equal(summary.remainingBytes, 0);

  await assert.rejects(
    () => withFileUploadQuota(server.id, 1, async () => "blocked", now),
    FileUploadQuotaExceededError,
  );
});

test("failed upload work does not count against Free quota", async ({ db }) => {

  const owner = await seedUser("quota-fail-owner");
  const server = await createServer("Quota Failed", `quota-failed-${randomUUID()}`, owner.id);
  const now = new Date("2026-06-23T12:00:00Z");

  await assert.rejects(
    () => withFileUploadQuota(server.id, 42, async () => {
      throw new Error("storage failed");
    }, now),
    /storage failed/,
  );

  const summary = await getFileUploadQuotaSummary(server.id, now);
  assert.equal(summary.usedBytes, 0);
  assert.equal(summary.remainingBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
});

test("Free upload quota resets by billing month", async ({ db }) => {

  const owner = await seedUser("quota-month-owner");
  const server = await createServer("Quota Month", `quota-month-${randomUUID()}`, owner.id);

  await withFileUploadQuota(server.id, 100, async () => "ok", new Date("2026-06-30T23:59:00Z"));
  const julySummary = await getFileUploadQuotaSummary(server.id, new Date("2026-07-01T00:00:00Z"));
  assert.equal(julySummary.usedBytes, 0);
  assert.equal(julySummary.remainingBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
});

test("concurrent Free upload quota claims serialize and only one over-limit claimant counts", async ({ db }) => {

  const owner = await seedUser("quota-concurrent-owner");
  const server = await createServer("Quota Concurrent", `quota-concurrent-${randomUUID()}`, owner.id);
  const now = new Date("2026-06-23T12:00:00Z");
  const requestBytes = 60 * 1024 * 1024;

  const results = await Promise.allSettled([
    withFileUploadQuota(server.id, requestBytes, async () => "first", now),
    withFileUploadQuota(server.id, requestBytes, async () => "second", now),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const summary = await getFileUploadQuotaSummary(server.id, now);
  assert.equal(summary.usedBytes, requestBytes);
  assert.equal(summary.remainingBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES - requestBytes);
});

test("active full-featured trial accounts Free uploads but does not enforce the monthly quota", async ({ db }) => {

  const owner = await seedUser("quota-trial-owner");
  const server = await createServer("Quota Trial", `quota-trial-${randomUUID()}`, owner.id);
  const now = new Date("2026-06-14T12:00:00Z");

  await withFileUploadQuota(server.id, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES + 1, async () => "ok", now);
  const summary = await getFileUploadQuotaSummary(server.id, now);

  assert.equal(summary.limited, true);
  assert.equal(summary.enforced, false);
  assert.equal(summary.limitBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
  assert.equal(summary.remainingBytes, 0);
  assert.equal(summary.usedBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES + 1);
});

test("Free upload accounting from the trial is enforced after the trial ends", async ({ db }) => {

  const owner = await seedUser("quota-trial-carryover-owner");
  const server = await createServer("Quota Trial Carryover", `quota-trial-carryover-${randomUUID()}`, owner.id);

  await withFileUploadQuota(server.id, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES + 1, async () => "ok", new Date("2026-06-14T12:00:00Z"));
  const postTrialSummary = await getFileUploadQuotaSummary(server.id, new Date("2026-06-23T12:00:00Z"));

  assert.equal(postTrialSummary.limited, true);
  assert.equal(postTrialSummary.enforced, true);
  assert.equal(postTrialSummary.usedBytes, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES + 1);
  assert.equal(postTrialSummary.remainingBytes, 0);
  await assert.rejects(
    () => withFileUploadQuota(server.id, 1, async () => "blocked", new Date("2026-06-23T12:00:00Z")),
    FileUploadQuotaExceededError,
  );
});

test("Free upload quota exceeded response includes Billing URL and action hint", async () => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://app.example.test";
  try {
    await openTestDatabase("pglite://");
    const owner = await seedUser("quota-url-owner");
    const server = await createServer("Quota URL", `quota-url-${randomUUID()}`, owner.id);
    const now = new Date("2026-06-23T12:00:00Z");

    await withFileUploadQuota(server.id, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, async () => "ok", now);
    const err = await withFileUploadQuota(server.id, 1, async () => "blocked", now)
      .then(
        () => null,
        (caught) => caught,
      );
    assert.ok(err instanceof FileUploadQuotaExceededError);

    const body = await buildFileUploadQuotaExceededResponse(server.id, err);
    assert.equal(body.errorCode, "FILE_UPLOAD_QUOTA_EXCEEDED");
    assert.equal(body.billingUrl, `https://app.example.test/s/${server.slug}/settings/billing`);
    assert.match(body.suggestedNextAction, /Settings > Billing/);
    assert.match(body.suggestedNextAction, new RegExp(`/s/${server.slug}/settings/billing`));
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test("Pro and internal plan uploads are unrestricted by Free monthly quota", async ({ db }) => {

  const owner = await seedUser("quota-paid-owner");
  const proServer = await createServer("Quota Pro", `quota-pro-${randomUUID()}`, owner.id);
  const founderServer = await createServer("Quota Founder", `quota-founder-${randomUUID()}`, owner.id);
  const partnerServer = await createServer("Quota Partner", `quota-partner-${randomUUID()}`, owner.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, proServer.id));
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, founderServer.id));
  await getDb().update(servers).set({ plan: "partner" }).where(eq(servers.id, partnerServer.id));

  for (const server of [proServer, founderServer, partnerServer]) {
    await withFileUploadQuota(server.id, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES + 1, async () => "ok");
    const summary = await getFileUploadQuotaSummary(server.id);
    assert.equal(summary.limited, false);
    assert.equal(summary.enforced, false);
    assert.equal(summary.limitBytes, -1);
    assert.equal(summary.remainingBytes, -1);
    assert.equal(summary.usedBytes, 0);
  }
});

test("Joint Channel Pro access does not lift the Free participant upload quota", async ({ db: database }) => {

  const db = getDb();
  const proOwner = await seedUser("quota-joint-pro-owner");
  const freeOwner = await seedUser("quota-joint-free-owner");
  const proServer = await createServer("Quota Joint Pro", `quota-joint-pro-${randomUUID()}`, proOwner.id);
  const freeServer = await createServer("Quota Joint Free", `quota-joint-free-${randomUUID()}`, freeOwner.id);
  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, proServer.id));

  const canonical = await createChannel(proServer.id, `quota-joint-canonical-${randomUUID()}`);
  const proProjection = await createChannel(proServer.id, `quota-joint-pro-local-${randomUUID()}`, undefined, "joint");
  const freeProjection = await createChannel(freeServer.id, `quota-joint-free-local-${randomUUID()}`, undefined, "joint");
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: proServer.id,
    createdByUserId: proOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: proServer.id,
      localChannelId: proProjection.id,
      role: "host",
      joinedByUserId: proOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: freeServer.id,
      localChannelId: freeProjection.id,
      role: "participant",
      joinedByUserId: freeOwner.id,
    },
  ]);

  const now = new Date("2026-06-23T12:00:00Z");
  assert.equal(await isChannelReadOnlyByBillingFeature(freeProjection.id, freeServer.id, now), false);

  await withFileUploadQuota(freeServer.id, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, async () => "free-boundary", now);
  await assert.rejects(
    () => withFileUploadQuota(freeServer.id, 1, async () => "free-over-limit", now),
    FileUploadQuotaExceededError,
  );

  await withFileUploadQuota(proServer.id, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES + 1, async () => "pro-unrestricted", now);
  const freeSummary = await getFileUploadQuotaSummary(freeServer.id, now);
  const proSummary = await getFileUploadQuotaSummary(proServer.id, now);
  assert.equal(freeSummary.plan, "free");
  assert.equal(freeSummary.limited, true);
  assert.equal(freeSummary.enforced, true);
  assert.equal(freeSummary.remainingBytes, 0);
  assert.equal(proSummary.plan, "pro");
  assert.equal(proSummary.limited, false);
  assert.equal(proSummary.enforced, false);
  assert.equal(proSummary.limitBytes, -1);
});
