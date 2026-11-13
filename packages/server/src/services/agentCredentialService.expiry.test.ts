// #wg-rbac:#27 runner credential expiry, at the credential lookup: a key whose
// `expires_at` has passed is refused as `expired` (not `invalid`) on the HMAC
// path and on the argon2 path, from the first lookup after it passes (there is
// no auth cache to outlive it), and only once the key itself verified and
// nothing else refuses it. The wake-hint stream's re-check says the same.
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { getDb } from "../db/index";
import { agentCredentials, agents, users } from "../db/schema";
import { createServer } from "./serverService";
import { createAgent } from "./agentService";
import { registerMachine } from "./machineService";
import {
  AGENT_API_KEY_HMAC_SECRET_ENV,
  agentCredentialStreamState,
  authenticateAgentApiKey,
  findAgentCredentialByApiKey,
  mintAgentCredential,
  revokeAgentCredential,
  runnerCredentialExpiresAt,
  RUNNER_CREDENTIAL_TTL_MS,
} from "./agentCredentialService";

const SECRET = "agent-api-key-hmac-test-secret-0123456789";
const HOUR = 60 * 60_000;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeTestDatabase();
});

async function seedRunner() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `key-expiry-${suffix}@slock.test`,
    name: `key-expiry-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Key Expiry", `key-expiry-${suffix}`, owner!.id);
  const { machine } = await registerMachine(server.id, owner!.id, "key-expiry-machine");
  const agent = await createAgent(server.id, "KeyExpiryBot", { runtime: "claude", model: "sonnet", machineId: machine.id });
  return { ownerId: owner!.id, agentId: agent.id, machineId: machine.id };
}

async function mintRunner(agentId: string, machineId: string, expiresAt: Date | null) {
  return mintAgentCredential({
    agentId,
    scopes: ["read"],
    name: "runner:test",
    issuedVia: "computer",
    issuedByMachineId: machineId,
    createdByUserId: null,
    expiresAt,
  });
}

async function setExpiresAt(credentialId: string, expiresAt: Date | null) {
  await getDb().update(agentCredentials).set({ expiresAt }).where(eq(agentCredentials.id, credentialId));
}

function wrongKeySamePrefix(apiKey: string): string {
  return apiKey.slice(0, -1) + (apiKey.at(-1) === "0" ? "1" : "0");
}

test("HMAC path: an expired key is refused as expired, without argon2; an unexpired one authenticates", async ({ db }) => {
  void db;
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const { agentId, machineId } = await seedRunner();
  const live = await mintRunner(agentId, machineId, new Date(Date.now() + HOUR));
  const expired = await mintRunner(agentId, machineId, new Date(Date.now() - 1000));
  const verify = vi.spyOn(argon2, "verify");

  assert.equal((await authenticateAgentApiKey(live.apiKey)).ok, true);
  assert.deepEqual(await authenticateAgentApiKey(expired.apiKey), { ok: false, reason: "expired" });
  assert.equal(await findAgentCredentialByApiKey(expired.apiKey), null, "the null-returning lookup refuses it too");
  assert.equal(verify.mock.calls.length, 0, "both took the HMAC path");
  // A key that does not verify says nothing about expiry.
  assert.deepEqual(await authenticateAgentApiKey(wrongKeySamePrefix(expired.apiKey)), { ok: false, reason: "invalid" });
});

test("argon2 path: an expired credential without an HMAC is refused as expired", async ({ db }) => {
  void db;
  const { agentId, machineId } = await seedRunner();
  // Minted while the secret was unset: the row has no HMAC, so argon2 verifies it.
  const minted = await mintRunner(agentId, machineId, new Date(Date.now() - 1000));
  const [row] = await getDb().select({ hmac: agentCredentials.apiKeyHmac }).from(agentCredentials).where(eq(agentCredentials.id, minted.credentialId));
  assert.equal(row?.hmac, null);
  const verify = vi.spyOn(argon2, "verify");

  assert.deepEqual(await authenticateAgentApiKey(minted.apiKey), { ok: false, reason: "expired" });
  assert.equal(verify.mock.calls.length, 1, "verified by argon2");
  assert.deepEqual(await authenticateAgentApiKey(wrongKeySamePrefix(minted.apiKey)), { ok: false, reason: "invalid" });
});

test("no cached result outlives expires_at: the same key is refused from the first lookup after it passes", async ({ db }) => {
  void db;
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const { agentId, machineId } = await seedRunner();
  const minted = await mintRunner(agentId, machineId, new Date(Date.now() + HOUR));
  assert.equal((await authenticateAgentApiKey(minted.apiKey)).ok, true);
  assert.equal(await agentCredentialStreamState(minted.credentialId), "active");

  // Time moves past expires_at.
  const realNow = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(realNow + 2 * HOUR);
  assert.deepEqual(await authenticateAgentApiKey(minted.apiKey), { ok: false, reason: "expired" });
  assert.equal(await agentCredentialStreamState(minted.credentialId), "expired", "an open stream ends as expired");
  vi.restoreAllMocks();

  // expires_at moves before now.
  assert.equal((await authenticateAgentApiKey(minted.apiKey)).ok, true);
  await setExpiresAt(minted.credentialId, new Date(Date.now() - 1));
  assert.deepEqual(await authenticateAgentApiKey(minted.apiKey), { ok: false, reason: "expired" });
});

test("a revoked, expired key is refused as invalid, not expired (revocation is never renewed)", async ({ db }) => {
  void db;
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const { ownerId, agentId, machineId } = await seedRunner();
  const minted = await mintRunner(agentId, machineId, new Date(Date.now() - 1000));
  await revokeAgentCredential({ agentId, credentialId: minted.credentialId, revokedByUserId: ownerId, reason: "test" });
  assert.deepEqual(await authenticateAgentApiKey(minted.apiKey), { ok: false, reason: "invalid" });
  assert.equal(await agentCredentialStreamState(minted.credentialId), "invalid");
});

test("an expired key whose agent left its Machine, or was deleted, is refused as invalid", async ({ db }) => {
  void db;
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const { agentId, machineId } = await seedRunner();
  const minted = await mintRunner(agentId, machineId, new Date(Date.now() - 1000));
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, agentId));
  assert.deepEqual(await authenticateAgentApiKey(minted.apiKey), { ok: false, reason: "invalid" });
  await getDb().update(agents).set({ machineId, deletedAt: new Date() }).where(eq(agents.id, agentId));
  assert.deepEqual(await authenticateAgentApiKey(minted.apiKey), { ok: false, reason: "invalid" });
});

test("a credential with no expires_at never expires", async ({ db }) => {
  void db;
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
  const { agentId, machineId } = await seedRunner();
  const minted = await mintRunner(agentId, machineId, null);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 365 * 24 * HOUR);
  assert.equal((await authenticateAgentApiKey(minted.apiKey)).ok, true);
});

test("runnerCredentialExpiresAt: 7 days out for a renewing daemon, never otherwise", () => {
  const now = new Date("2026-11-06T00:00:00Z");
  assert.equal(runnerCredentialExpiresAt(true, now)?.getTime(), now.getTime() + RUNNER_CREDENTIAL_TTL_MS);
  assert.equal(RUNNER_CREDENTIAL_TTL_MS, 7 * 24 * HOUR);
  assert.equal(runnerCredentialExpiresAt(false, now), null);
});
