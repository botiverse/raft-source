import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { eq, gt } from "drizzle-orm";
import { getDb } from "../db/index";
import { emailVerifications, passwordResets, users } from "../db/schema";
import { requestPasswordReset, resendVerificationEmail } from "./userService";

// The hourly limits count the token rows created in the last hour. Each new
// email used to delete the older rows first, so the count never passed 1 and
// only the 60-second resend cooldown ever applied.

afterEach(async () => {
  await closeTestDatabase();
});

const USER_ID = "22222222-2222-2222-2222-222222222222";

async function insertUser(emailVerified: boolean) {
  const db = getDb();
  await db.insert(users).values({
    id: USER_ID,
    email: "limit@example.com",
    name: "limit",
    displayName: "limit",
    passwordHash: "hash",
    emailVerified,
  });
}

/** Move every token past the 60-second cooldown while keeping it inside the hour. */
async function ageVerificationTokens() {
  await getDb().update(emailVerifications)
    .set({ createdAt: new Date(Date.now() - 2 * 60 * 1000) })
    .where(eq(emailVerifications.userId, USER_ID));
}

test("verification resends stop at five per hour, and only the newest link stays valid", async ({ db: _database }) => {
  await insertUser(false);
  const db = getDb();

  for (let i = 0; i < 5; i++) {
    await resendVerificationEmail(USER_ID);
    await ageVerificationTokens();
  }
  await assert.rejects(resendVerificationEmail(USER_ID), /Too many verification emails/);

  const rows = await db.select().from(emailVerifications).where(eq(emailVerifications.userId, USER_ID));
  assert.equal(rows.length, 5);
  const live = await db.select().from(emailVerifications)
    .where(gt(emailVerifications.expiresAt, new Date()));
  assert.equal(live.length, 1);
});

test("password reset requests stop at five per hour, and only the newest link stays valid", async ({ db: _database }) => {
  await insertUser(true);
  const db = getDb();

  for (let i = 0; i < 6; i++) await requestPasswordReset("limit@example.com");

  const rows = await db.select().from(passwordResets).where(eq(passwordResets.userId, USER_ID));
  assert.equal(rows.length, 5);
  const live = await db.select().from(passwordResets)
    .where(gt(passwordResets.expiresAt, new Date()));
  assert.equal(live.length, 1);
});
