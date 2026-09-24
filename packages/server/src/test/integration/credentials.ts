import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { signAccessToken } from "../../middleware/auth.js";

const passwordHashes = new Map<string, Promise<string>>();

/** Reuse immutable fixture hashes; password/authentication tests use argon2 directly. */
export function fixturePasswordHash(password: string): Promise<string> {
  let hash = passwordHashes.get(password);
  if (!hash) {
    hash = argon2.hash(password);
    passwordHashes.set(password, hash);
    void hash.catch(() => passwordHashes.delete(password));
  }
  return hash;
}

/** A real token for an existing human; every request still passes production auth. */
export async function tokenForHuman(email: string): Promise<string> {
  const [human] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!human) throw new Error(`Cannot issue fixture credentials for missing human: ${email}`);
  process.env.JWT_SECRET ||= "test-jwt-secret";
  return signAccessToken(human.id);
}
