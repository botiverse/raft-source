import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { dbTest } from "../../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../../test/integration/database";
import { getDb } from "../../db/index";
import { users, userTotp } from "../../db/schema";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  recordTotpStep,
  totpStepAt,
  totpUri,
  verifyTotp,
} from "./totp";
import { decryptTotpSecret, encryptTotpSecret, TOTP_SECRET_KEY_ENV } from "./totpSecretCrypto";

// RFC 6238 Appendix B (HMAC-SHA-1, 8 digits, seed "12345678901234567890").
const RFC_SEED = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET = base32Encode(RFC_SEED);
const RFC_VECTORS: Array<[seconds: number, code: string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

test("RFC 6238 SHA-1 test vectors", () => {
  for (const [seconds, code] of RFC_VECTORS) {
    const now = new Date(seconds * 1000);
    assert.equal(hotp(RFC_SEED, totpStepAt(now), 8), code, `T=${seconds}`);
    const result = verifyTotp({ secret: RFC_SECRET, code, now, digits: 8 });
    assert.deepEqual(result, { ok: true, step: Math.floor(seconds / 30) }, `T=${seconds}`);
  }
});

test("base32 round-trips and refuses characters outside the alphabet", () => {
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(base32Decode(RFC_SECRET.toLowerCase()), RFC_SEED);
  assert.equal(base32Decode("ABC1"), null);
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret)!.length, 20);
});

test("a code is accepted one step either side of now, not two", () => {
  const secret = generateTotpSecret();
  const key = base32Decode(secret)!;
  const now = new Date("2026-10-31T12:00:10Z");
  const step = totpStepAt(now);
  for (const offset of [-1, 0, 1]) {
    assert.deepEqual(verifyTotp({ secret, code: hotp(key, step + offset), now }), { ok: true, step: step + offset }, `offset ${offset}`);
  }
  for (const offset of [-2, 2]) {
    assert.deepEqual(verifyTotp({ secret, code: hotp(key, step + offset), now }), { ok: false, reason: "invalid" }, `offset ${offset}`);
  }
  assert.deepEqual(verifyTotp({ secret, code: "12345", now }), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyTotp({ secret, code: "abcdef", now }), { ok: false, reason: "malformed" });
  // Spaces as authenticator apps show them ("123 456") are fine.
  const spaced = hotp(key, step).replace(/^(\d{3})/, "$1 ");
  assert.deepEqual(verifyTotp({ secret, code: spaced, now }), { ok: true, step });
});

test("a code whose step is not above the last used step is a replay", () => {
  const secret = generateTotpSecret();
  const key = base32Decode(secret)!;
  const now = new Date("2026-10-31T12:00:10Z");
  const step = totpStepAt(now);
  const code = hotp(key, step);
  assert.deepEqual(verifyTotp({ secret, code, now, lastUsedStep: step }), { ok: false, reason: "replayed" });
  assert.deepEqual(verifyTotp({ secret, code, now, lastUsedStep: step + 1 }), { ok: false, reason: "replayed" });
  assert.deepEqual(verifyTotp({ secret, code, now, lastUsedStep: step - 1 }), { ok: true, step });
  // The next step's code (the window's +1) is still above an older step.
  assert.deepEqual(verifyTotp({ secret, code: hotp(key, step + 1), now, lastUsedStep: step }), { ok: true, step: step + 1 });
});

test("the otpauth URI carries the secret, issuer and parameters", () => {
  const raw = totpUri({ secret: RFC_SECRET, accountName: "ada@example.com", issuer: "Raft" });
  assert.ok(raw.startsWith("otpauth://totp/Raft:ada%40example.com?"), raw);
  const uri = new URL(raw);
  assert.equal(uri.searchParams.get("secret"), RFC_SECRET);
  assert.equal(uri.searchParams.get("issuer"), "Raft");
  assert.equal(uri.searchParams.get("digits"), "6");
  assert.equal(uri.searchParams.get("period"), "30");
  assert.equal(uri.searchParams.get("algorithm"), "SHA1");
});

test("a stored secret decrypts only for the person it was encrypted for, and only with the key", () => {
  const env = { [TOTP_SECRET_KEY_ENV]: Buffer.alloc(32, 7).toString("base64") };
  const secret = generateTotpSecret();
  const userId = randomUUID();
  const payload = encryptTotpSecret(secret, userId, env);
  assert.ok(!payload.includes(secret));
  assert.equal(decryptTotpSecret(payload, userId, env), secret);
  assert.throws(() => decryptTotpSecret(payload, randomUUID(), env), /cannot be decrypted/);
  assert.throws(() => decryptTotpSecret(payload, userId, { [TOTP_SECRET_KEY_ENV]: Buffer.alloc(32, 8).toString("base64") }), /cannot be decrypted/);
  assert.throws(() => decryptTotpSecret("v0:x:y:z", userId, env), /invalid/);
  assert.throws(() => encryptTotpSecret(secret, userId, {}), /must be configured/);
  assert.throws(() => encryptTotpSecret(secret, userId, { [TOTP_SECRET_KEY_ENV]: Buffer.alloc(16).toString("base64") }), /32-byte/);
});

dbTest("recording a step succeeds once per step and only upward", async () => {
  try {
    await openTestDatabase("pglite://");
    const db = getDb();
    const [user] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "test-only" }).returning();
    assert.equal(await recordTotpStep(db, user!.id, 100, "v1:test"), false, "no TOTP row yet");
    await db.insert(userTotp).values({ userId: user!.id, secretCiphertext: "v1:test" });
    // Two uses of the same code at once: exactly one records it.
    const raced = await Promise.all([recordTotpStep(db, user!.id, 100, "v1:test"), recordTotpStep(db, user!.id, 100, "v1:test")]);
    assert.deepEqual(raced.sort(), [false, true]);
    assert.equal(await recordTotpStep(db, user!.id, 99, "v1:test"), false);
    assert.equal(await recordTotpStep(db, user!.id, 101, "v1:test"), true);
    const [row] = await db.select({ step: userTotp.lastUsedStep }).from(userTotp).where(eq(userTotp.userId, user!.id));
    assert.equal(row!.step, 101);
  } finally {
    await closeTestDatabase();
  }
});
