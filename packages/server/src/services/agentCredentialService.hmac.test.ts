// `sk_agent_*` verification: rows carrying `api_key_hmac` verify by HMAC
// without argon2; legacy rows (or an unset secret) verify by argon2 and the
// legacy row is backfilled; wrong and revoked keys fail on both paths.
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { getDb } from "../db/index";
import { agentCredentials, users } from "../db/schema";
import { createServer } from "./serverService";
import { createAgent } from "./agentService";
import {
  AGENT_API_KEY_HMAC_SECRET_ENV,
  findAgentCredentialByApiKey,
  mintAgentCredential,
  revokeAgentCredential,
} from "./agentCredentialService";

const SECRET = "agent-api-key-hmac-test-secret-0123456789";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeTestDatabase();
});

async function seedExternalAgent() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `key-hmac-${suffix}@slock.test`,
    name: `key-hmac-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Key HMAC", `key-hmac-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "KeyHmacExt", { runtime: "external", model: "external" });
  return { ownerId: owner!.id, agentId: agent.id };
}

async function mint(agentId: string) {
  return mintAgentCredential({ agentId, scopes: ["read"], issuedVia: "computer", createdByUserId: null });
}

async function storedHmac(credentialId: string): Promise<Buffer | null> {
  const [row] = await getDb()
    .select({ apiKeyHmac: agentCredentials.apiKeyHmac })
    .from(agentCredentials)
    .where(eq(agentCredentials.id, credentialId));
  return row!.apiKeyHmac ? Buffer.from(row!.apiKeyHmac) : null;
}

// Changing one character after the prefix keeps the prefix lookup hitting the
// row, so the verifier (not the lookup) is what must reject it.
function wrongKeySamePrefix(apiKey: string): string {
  const last = apiKey.at(-1) === "0" ? "1" : "0";
  return apiKey.slice(0, -1) + last;
}

test("a minted key stores its HMAC and verifies without argon2", async ({ db }) => {
  void db;
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const { agentId } = await seedExternalAgent();
  const minted = await mint(agentId);
  assert.ok(await storedHmac(minted.credentialId), "mint must persist api_key_hmac");

  const verify = vi.spyOn(argon2, "verify");
  const found = await findAgentCredentialByApiKey(minted.apiKey);
  assert.equal(found?.credentialId, minted.credentialId);
  assert.equal(verify.mock.calls.length, 0, "HMAC path must not call argon2");
  // A mismatch falls back to argon2 (it could be an HMAC from an older
  // secret), so a wrong key costs one argon2 and is still rejected.
  assert.equal(await findAgentCredentialByApiKey(wrongKeySamePrefix(minted.apiKey)), null);
  assert.equal(verify.mock.calls.length, 1);
});

test("a legacy row verifies with argon2, is backfilled, then takes the HMAC path", async ({ db }) => {
  void db;
  const { agentId } = await seedExternalAgent();
  // Minted while the secret was unset: the row has no HMAC.
  const minted = await mint(agentId);
  assert.equal(await storedHmac(minted.credentialId), null);

  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const verify = vi.spyOn(argon2, "verify");
  assert.equal(await findAgentCredentialByApiKey(wrongKeySamePrefix(minted.apiKey)), null);
  assert.equal(await storedHmac(minted.credentialId), null, "a failed verify must not backfill");

  assert.equal((await findAgentCredentialByApiKey(minted.apiKey))?.credentialId, minted.credentialId);
  assert.equal(verify.mock.calls.length, 2);
  assert.ok(await storedHmac(minted.credentialId), "argon2 success must backfill api_key_hmac");

  assert.equal((await findAgentCredentialByApiKey(minted.apiKey))?.credentialId, minted.credentialId);
  assert.equal(verify.mock.calls.length, 2, "backfilled row must verify without argon2");
});

test("without the secret, rows verify with argon2 even when they carry an HMAC", async ({ db }) => {
  void db;
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const { agentId } = await seedExternalAgent();
  const minted = await mint(agentId);
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "");

  const verify = vi.spyOn(argon2, "verify");
  assert.equal((await findAgentCredentialByApiKey(minted.apiKey))?.credentialId, minted.credentialId);
  assert.equal(await findAgentCredentialByApiKey(wrongKeySamePrefix(minted.apiKey)), null);
  assert.equal(verify.mock.calls.length, 2);
});

test("a revoked key fails on both the HMAC and the argon2 path", async ({ db }) => {
  void db;
  const { ownerId, agentId } = await seedExternalAgent();
  const legacy = await mint(agentId);
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const fresh = await mint(agentId);
  assert.equal(await storedHmac(legacy.credentialId), null);
  assert.ok(await storedHmac(fresh.credentialId));

  for (const cred of [legacy, fresh]) {
    await revokeAgentCredential({ agentId, credentialId: cred.credentialId, revokedByUserId: ownerId, reason: "test" });
    assert.equal(await findAgentCredentialByApiKey(cred.apiKey), null);
  }
});

test("an HMAC from an older secret falls back to argon2, is rewritten, then takes the HMAC path", async ({ db }) => {
  void db;
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "agent-api-key-hmac-older-secret-9876543210");
  const { agentId } = await seedExternalAgent();
  const minted = await mint(agentId);
  const old = await storedHmac(minted.credentialId);
  assert.ok(old);

  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET); // the secret changed
  const verify = vi.spyOn(argon2, "verify");
  assert.equal(await findAgentCredentialByApiKey(wrongKeySamePrefix(minted.apiKey)), null);
  assert.deepEqual(await storedHmac(minted.credentialId), old, "a wrong key must not rewrite the HMAC");
  assert.equal((await findAgentCredentialByApiKey(minted.apiKey))?.credentialId, minted.credentialId, "a changed secret must not lock the key out");
  assert.equal(verify.mock.calls.length, 2);
  const rewritten = await storedHmac(minted.credentialId);
  assert.ok(rewritten && !rewritten.equals(old), "the stale HMAC is replaced");
  assert.equal((await findAgentCredentialByApiKey(minted.apiKey))?.credentialId, minted.credentialId);
  assert.equal(verify.mock.calls.length, 2, "after the rewrite the key verifies without argon2");
});
