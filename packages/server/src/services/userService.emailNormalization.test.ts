import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { passwordResets, users } from "../db/schema.js";
import { requestPasswordReset } from "./userService.js";


afterEach(async () => {
  await closeTestDatabase();
});

test("forgot-password lookup normalizes input before lookup", async ({ db: database }) => {

  const db = getDb();

  const [user] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "owner@example.com",
    name: "owner",
    displayName: "owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  await requestPasswordReset("Owner@Example.COM");

  const rows = await db.select().from(passwordResets);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, user.id);
});
