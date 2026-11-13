import assert from "node:assert/strict";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { dbTest } from "../../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../../test/integration/database";
import { getDb } from "../../db/index";
import { userBackupCodes, users } from "../../db/schema";
import {
  BACKUP_CODE_COUNT,
  consumeBackupCode,
  countUnusedBackupCodes,
  generateBackupCode,
  normalizeBackupCode,
  replaceBackupCodes,
} from "./backupCodes";

afterEach(async () => { await closeTestDatabase(); });

const NOW = new Date("2026-10-31T12:00:00Z");

async function seedUser(): Promise<string> {
  const [user] = await getDb().insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "test-only" }).returning();
  return user!.id;
}

test("codes read XXXXX-XXXXX and are typed back loosely", () => {
  const codes = new Set(Array.from({ length: 50 }, generateBackupCode));
  assert.equal(codes.size, 50);
  for (const code of codes) assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(normalizeBackupCode(" abcde-fgh23 "), "ABCDEFGH23");
  assert.equal(normalizeBackupCode("ABCDE FGH23"), "ABCDEFGH23");
  assert.equal(normalizeBackupCode("abcdefgh23"), "ABCDEFGH23");
  // Crockford aliases: I and L read as 1, O as 0.
  assert.equal(normalizeBackupCode("iLoO0-1abcd"), "110001ABCD");
  assert.equal(normalizeBackupCode("ABCDE-FGH2"), null);
  assert.equal(normalizeBackupCode("ABCDE-FGHU2"), null, "U is not Crockford");
});

dbTest("a set of 10 is stored only as hashes; each code works once; a new set replaces the old", async () => {
  await openTestDatabase("pglite://");
  const userId = await seedUser();
  const otherId = await seedUser();
  const codes = await replaceBackupCodes(userId);
  assert.equal(codes.length, BACKUP_CODE_COUNT);
  assert.equal(new Set(codes).size, BACKUP_CODE_COUNT);
  const stored = await getDb().select().from(userBackupCodes).where(eq(userBackupCodes.userId, userId));
  assert.equal(stored.length, BACKUP_CODE_COUNT);
  for (const row of stored) {
    assert.match(row.codeHash, /^\$argon2/);
    assert.ok(!codes.some((code) => row.codeHash.includes(code) || row.codeHash.includes(normalizeBackupCode(code)!)));
  }

  assert.deepEqual(await consumeBackupCode(getDb(), otherId, codes[0]!, NOW), { ok: false }, "another person's code");
  // Typed loosely: lower case, no hyphen, 1 and 0 as their aliases.
  const typed = codes[0]!.toLowerCase().replace("-", "").replace(/1/g, "l").replace(/0/g, "o");
  assert.deepEqual(await consumeBackupCode(getDb(), userId, typed, NOW), { ok: true, remaining: BACKUP_CODE_COUNT - 1 });
  assert.deepEqual(await consumeBackupCode(getDb(), userId, codes[0]!, NOW), { ok: false }, "used once already");
  assert.deepEqual(await consumeBackupCode(getDb(), userId, "AAAAA-AAAAA", NOW), { ok: false });
  assert.deepEqual(await consumeBackupCode(getDb(), userId, "not a code", NOW), { ok: false });
  assert.equal(await countUnusedBackupCodes(userId), BACKUP_CODE_COUNT - 1);

  const fresh = await replaceBackupCodes(userId);
  assert.equal(await countUnusedBackupCodes(userId), BACKUP_CODE_COUNT);
  assert.deepEqual(await consumeBackupCode(getDb(), userId, codes[1]!, NOW), { ok: false }, "the old set is gone");
  assert.deepEqual(await consumeBackupCode(getDb(), userId, fresh[1]!, NOW), { ok: true, remaining: BACKUP_CODE_COUNT - 1 });
});

dbTest("two uses of the same code at once: exactly one wins", async () => {
  await openTestDatabase("pglite://");
  const userId = await seedUser();
  const [code] = await replaceBackupCodes(userId);
  const results = await Promise.all([consumeBackupCode(getDb(), userId, code!, NOW), consumeBackupCode(getDb(), userId, code!, NOW), consumeBackupCode(getDb(), userId, code!, NOW)]);
  assert.deepEqual(results.filter((result) => result.ok), [{ ok: true, remaining: BACKUP_CODE_COUNT - 1 }]);
  assert.equal(await countUnusedBackupCodes(userId), BACKUP_CODE_COUNT - 1);
});

dbTest("replacing the codes hashes them one at a time: never more than one argon2 hash in flight (OOM on staging, #wg-rbac:#69)", async () => {
  await openTestDatabase("pglite://");
  const userId = await seedUser();
  const real = argon2.hash.bind(argon2);
  let inFlight = 0;
  let maxInFlight = 0;
  const spy = vi.spyOn(argon2, "hash").mockImplementation((async (...args: Parameters<typeof argon2.hash>) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await real(...args);
    } finally {
      inFlight -= 1;
    }
  }) as typeof argon2.hash);
  try {
    const codes = await replaceBackupCodes(userId, NOW);
    assert.equal(codes.length, BACKUP_CODE_COUNT);
    assert.equal(spy.mock.calls.length, BACKUP_CODE_COUNT);
    assert.equal(maxInFlight, 1);
  } finally {
    spy.mockRestore();
  }
});

dbTest("backup codes are hashed with argon2id at OWASP's minimum, and codes hashed with the old default still verify (#wg-rbac:#69)", async () => {
  await openTestDatabase("pglite://");
  const userId = await seedUser();
  const codes = await replaceBackupCodes(userId, NOW);
  const rows = await getDb().select({ codeHash: userBackupCodes.codeHash }).from(userBackupCodes).where(eq(userBackupCodes.userId, userId));
  assert.equal(rows.length, BACKUP_CODE_COUNT);
  for (const row of rows) assert.match(row.codeHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal((await consumeBackupCode(getDb(), userId, codes[0]!, NOW)).ok, true);

  // A code stored with argon2's default parameters (before this change) still works.
  const legacyUser = await seedUser();
  const legacyCode = generateBackupCode();
  await getDb().insert(userBackupCodes).values({ userId: legacyUser, codeHash: await argon2.hash(normalizeBackupCode(legacyCode)!), createdAt: NOW });
  assert.equal((await consumeBackupCode(getDb(), legacyUser, legacyCode, NOW)).ok, true);
});
