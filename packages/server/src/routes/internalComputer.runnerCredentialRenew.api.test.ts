// #wg-rbac:#27 runner credential expiry and renewal, end to end over HTTP:
//   - the mint gives a renewing daemon's runner key a 7-day expiry, others none;
//   - /internal/agent-api answers an expired key 401 agent_credential_expired
//     (HMAC and argon2 rows alike, and a key that worked a moment ago), a
//     revoked key the plain invalid 401, and an expired send writes nothing;
//   - POST /internal/computer/runners/:agentId/credentials/renew, with the
//     Computer's own key: the new key works, the old one for at most 5 more
//     minutes; every refusal issues nothing; a second or concurrent renewal
//     issues exactly one; the per-Machine rate limit.
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RENEW_V1 } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentCredentials, agents, computers, integrationAuditEvents, messages, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { addAgent, createChannel } from "../services/channelService";
import {
  AGENT_API_KEY_HMAC_SECRET_ENV,
  mintAgentCredential,
  revokeAgentCredential,
  revokeRunnerCredentialsNotHeld,
  RUNNER_CREDENTIAL_RECONCILE_GRACE_MS,
  RUNNER_CREDENTIAL_RENEW_OVERLAP_MS,
  RUNNER_CREDENTIAL_TTL_MS,
  __setRenewBeforeLockHookForTests,
  type AgentCredentialIssuance,
} from "../services/agentCredentialService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import { __setRunnerCredentialRenewRateLimitForTests } from "./internalComputer";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const SECRET = "agent-api-key-hmac-test-secret-0123456789";
const DAY = 24 * 60 * 60_000;

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, SECRET);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __setRunnerCredentialRenewRateLimitForTests(null);
});

type TestApp = { baseUrl: string; app: { get: (key: string) => unknown } };

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/** The test orchestrator answers whether a Machine's daemon declared renewal from this set. */
function declareRenew(app: TestApp, machineIds: readonly string[]): void {
  const declared = new Set(machineIds);
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  orchestrator.machineAdvertisesCapability = async (machineId: string, capability: string) =>
    capability === DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RENEW_V1 && declared.has(machineId);
}

async function seed() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `renew-${suffix}@slock.test`,
    name: `renew-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Renew Test", `renew-${suffix}`, owner!.id);
  const { machine } = await registerMachine(server.id, owner!.id, "renew-machine");
  const { machine: otherMachine } = await registerMachine(server.id, owner!.id, "renew-other-machine");
  const agent = await createAgent(server.id, "RenewBot", { runtime: "claude", model: "sonnet", machineId: machine.id });
  const channel = await createChannel(server.id, "renew-room");
  await addAgent(channel.id, agent.id);
  const computer = await generateComputerApiKeyMaterial();
  await db.insert(computers).values({
    serverId: server.id,
    name: "renew-computer",
    apiKeyHash: computer.apiKeyHash,
    apiKeyPrefix: computer.apiKeyPrefix,
    attachedByUserId: owner!.id,
    machineId: machine.id,
  });
  return {
    ownerId: owner!.id,
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    otherMachineId: otherMachine.id,
    channelId: channel.id,
    channelName: channel.name,
    computerApiKey: computer.apiKey,
  };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

async function mintViaRoute(app: TestApp, f: Fixture) {
  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials`, {
    method: "POST",
    headers: headers(f.computerApiKey),
    body: JSON.stringify({ name: `runner:claude:${f.agentId.slice(0, 8)}` }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return await res.json() as { credentialId: string; apiKey: string; expiresAt: string | null };
}

function renew(app: TestApp, f: Fixture, credentialId: string, computerApiKey = f.computerApiKey) {
  return fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials/renew`, {
    method: "POST",
    headers: headers(computerApiKey),
    body: JSON.stringify({ credentialId }),
  });
}

async function probe(app: TestApp, apiKey: string) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api`, { headers: headers(apiKey) });
  return { status: res.status, body: await res.json() as { code?: string; error?: string } };
}

async function credentialRow(credentialId: string) {
  const [row] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, credentialId));
  return row!;
}

async function credentialCount(agentId: string) {
  return (await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.agentId, agentId))).length;
}

function assertAbout(actual: Date | string | null | undefined, expectedMs: number, label: string) {
  assert.ok(actual, `${label}: set`);
  const ms = new Date(actual).getTime();
  assert.ok(Math.abs(ms - expectedMs) < 60_000, `${label}: ${new Date(ms).toISOString()} vs ${new Date(expectedMs).toISOString()}`);
}

// ---- mint ----

test("mint: a daemon that declared runner-credential-renew:v1 gets a 7-day key; one that did not gets none", async ({ app }) => {
  const f = await seed();
  declareRenew(app, []);
  const legacy = await mintViaRoute(app, f);
  assert.equal(legacy.expiresAt, null);
  assert.equal((await credentialRow(legacy.credentialId)).expiresAt, null);

  declareRenew(app, [f.machineId]);
  const renewing = await mintViaRoute(app, f);
  assertAbout(renewing.expiresAt, Date.now() + RUNNER_CREDENTIAL_TTL_MS, "response");
  const row = await credentialRow(renewing.credentialId);
  assertAbout(row.expiresAt, Date.now() + RUNNER_CREDENTIAL_TTL_MS, "row");
  assert.ok(row.apiKeyHmac, "stored with its HMAC from the start");
  assert.equal((await probe(app, renewing.apiKey)).status, 200);
});

// ---- auth ----

test("agent-api: an expired key answers 401 agent_credential_expired on the HMAC and the argon2 path", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const hmacKey = await mintViaRoute(app, f);
  const argonKey = await mintViaRoute(app, f);
  await getDb().update(agentCredentials).set({ apiKeyHmac: null }).where(eq(agentCredentials.id, argonKey.credentialId));
  for (const key of [hmacKey, argonKey]) {
    await getDb().update(agentCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentCredentials.id, key.credentialId));
    const { status, body } = await probe(app, key.apiKey);
    assert.equal(status, 401);
    assert.equal(body.code, "agent_credential_expired");
  }
});

test("agent-api: a key that authenticated is refused as expired once its expires_at passes (no cached pass)", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const key = await mintViaRoute(app, f);
  assert.equal((await probe(app, key.apiKey)).status, 200);
  await getDb().update(agentCredentials).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(agentCredentials.id, key.credentialId));
  const after = await probe(app, key.apiKey);
  assert.equal(after.status, 401);
  assert.equal(after.body.code, "agent_credential_expired");
});

test("agent-api: a revoked key still answers the invalid-credential 401, never agent_credential_expired", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const key = await mintViaRoute(app, f);
  await getDb().update(agentCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentCredentials.id, key.credentialId));
  await revokeAgentCredential({ credentialId: key.credentialId, reason: "test" });
  const unknown = await probe(app, `sk_agent_${"0".repeat(64)}`);
  const revoked = await probe(app, key.apiKey);
  assert.equal(revoked.status, 401);
  assert.notEqual(revoked.body.code, "agent_credential_expired");
  assert.deepEqual(revoked, unknown, "refused exactly like an unknown key");
});

test("agent-api: a send with an expired key answers 401 agent_credential_expired and writes no message", async ({ app }) => {
  const f = await seed();
  const key = await mintAgentCredential({
    agentId: f.agentId, scopes: ["send", "read"], name: "runner:send", issuedVia: "computer",
    issuedByMachineId: f.machineId, createdByUserId: null, expiresAt: new Date(Date.now() - 1000),
  });
  const before = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, f.channelId));
  const res = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: headers(key.apiKey),
    body: JSON.stringify({ target: `#${f.channelName}`, content: "sent with an expired key" }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json() as { code?: string }).code, "agent_credential_expired");
  const after = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, f.channelId));
  assert.equal(after.length, before.length, "no message written");

  // The same send with the key unexpired is written: the refusal above was the expiry.
  await getDb().update(agentCredentials).set({ expiresAt: null }).where(eq(agentCredentials.id, key.credentialId));
  const ok = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: headers(key.apiKey),
    body: JSON.stringify({ target: `#${f.channelName}`, content: "sent with a live key" }),
  });
  assert.equal(ok.status, 200, await ok.text());
  const written = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, f.channelId));
  assert.equal(written.length, before.length + 1);
});

// ---- renew ----

test("renew: the new key works for 7 days; the old one keeps working for at most 5 minutes, then is expired", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const old = await mintViaRoute(app, f);
  const res = await renew(app, f, old.credentialId);
  assert.equal(res.status, 201, await res.clone().text());
  const renewed = await res.json() as { credentialId: string; apiKey: string; expiresAt: string; replacedCredentialId: string; replacedExpiresAt: string; scopes: string[] };
  const renewedAt = Date.now();
  assert.notEqual(renewed.credentialId, old.credentialId);
  assert.equal(renewed.replacedCredentialId, old.credentialId);
  assertAbout(renewed.expiresAt, renewedAt + RUNNER_CREDENTIAL_TTL_MS, "new expiresAt");

  const oldRow = await credentialRow(old.credentialId);
  const newRow = await credentialRow(renewed.credentialId);
  assert.equal(oldRow.revokedAt, null, "the old key is not revoked");
  assert.equal(oldRow.replacedByCredentialId, renewed.credentialId);
  assert.ok(oldRow.expiresAt && oldRow.expiresAt.getTime() <= renewedAt + RUNNER_CREDENTIAL_RENEW_OVERLAP_MS, "old key's expiry pulled in to 5 minutes at most");
  assertAbout(oldRow.expiresAt, renewedAt + RUNNER_CREDENTIAL_RENEW_OVERLAP_MS, "old expiresAt");
  assert.equal(new Date(renewed.replacedExpiresAt).getTime(), oldRow.expiresAt!.getTime());
  assert.equal(newRow.agentId, f.agentId);
  assert.equal(newRow.issuedVia, "computer");
  assert.equal(newRow.issuedByMachineId, f.machineId);
  assert.equal(newRow.name, oldRow.name);
  assert.deepEqual([...newRow.scopes].sort(), [...oldRow.scopes].sort());
  assert.deepEqual([...renewed.scopes].sort(), [...oldRow.scopes].sort());
  assert.ok(newRow.apiKeyHmac, "the renewed key carries its HMAC from the start");
  assert.equal(newRow.createdByUserId, null);

  assert.equal((await probe(app, renewed.apiKey)).status, 200, "new key works");
  assert.equal((await probe(app, old.apiKey)).status, 200, "old key still works inside the overlap");

  const [audit] = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "agent_credential.issued"),
    eq(integrationAuditEvents.targetId, renewed.credentialId),
  ));
  assert.equal(audit?.metadata.replacedCredentialId, old.credentialId);
  assert.equal(audit?.metadata.via, "runner_renewed");
  assert.equal(audit?.metadata.machineId, f.machineId);

  // Reconcile at the next ready (daemon lists nothing yet): the fresh key is
  // inside the grace window and stays; reconcile reads no expires_at.
  await revokeRunnerCredentialsNotHeld({ machineId: f.machineId, heldIds: [], issuedBefore: new Date(Date.now() - RUNNER_CREDENTIAL_RECONCILE_GRACE_MS), now: new Date() });
  assert.equal((await credentialRow(renewed.credentialId)).revokedAt, null, "reconcile leaves a fresh renewal alone");

  // 6 minutes on: the old key is expired, the new one still works.
  vi.spyOn(Date, "now").mockReturnValue(renewedAt + 6 * 60_000);
  const oldLater = await probe(app, old.apiKey);
  assert.equal(oldLater.status, 401);
  assert.equal(oldLater.body.code, "agent_credential_expired");
  assert.equal((await probe(app, renewed.apiKey)).status, 200);
});

test("renew: an old key that already expired, within 7 days, is renewed and keeps its earlier expiry", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const old = await mintViaRoute(app, f);
  const expiredAt = new Date(Date.now() - DAY);
  await getDb().update(agentCredentials).set({ expiresAt: expiredAt }).where(eq(agentCredentials.id, old.credentialId));
  const res = await renew(app, f, old.credentialId);
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal((await credentialRow(old.credentialId)).expiresAt?.getTime(), expiredAt.getTime(), "never pushed out");
});

test("renew: a second renewal of the same key is 409 runner_credential_already_renewed and issues nothing", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const old = await mintViaRoute(app, f);
  assert.equal((await renew(app, f, old.credentialId)).status, 201);
  const count = await credentialCount(f.agentId);
  const again = await renew(app, f, old.credentialId);
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { code?: string }).code, "runner_credential_already_renewed");
  assert.equal(await credentialCount(f.agentId), count);
});

test("renew: two concurrent renewals of one key issue exactly one new credential", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const old = await mintViaRoute(app, f);
  const count = await credentialCount(f.agentId);
  const results = await Promise.all([renew(app, f, old.credentialId), renew(app, f, old.credentialId)]);
  const statuses = results.map((res) => res.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const conflict = results.find((res) => res.status === 409)!;
  assert.equal((await conflict.json() as { code?: string }).code, "runner_credential_already_renewed");
  assert.equal(await credentialCount(f.agentId), count + 1);
});

// Each refusal: the code, and nothing issued, and the old key untouched.
const REFUSALS: Array<{
  name: string;
  status: number;
  code: string;
  setup: (app: TestApp, f: Fixture) => Promise<string>;
}> = [
  {
    name: "another Machine's runner credential",
    status: 403,
    code: "credential_not_issued_by_this_computer",
    setup: async (_app, f) => (await mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name: "runner:other", issuedVia: "computer", issuedByMachineId: f.otherMachineId, createdByUserId: null, expiresAt: new Date(Date.now() + DAY) })).credentialId,
  },
  ...([
    ["a person's credential", { issuedVia: "human" as const, createdByUserId: "" }, "runner:human"],
    ["a provision credential", { issuedVia: "provision" as const, createdByUserId: null }, "runner:provision"],
    ["a computer credential not named runner:*", { issuedVia: "computer" as const, createdByUserId: null }, "computer-other"],
  ] as const).map(([name, issuer, credentialName]) => ({
    name,
    status: 403,
    code: "credential_not_runner",
    setup: async (_app: TestApp, f: Fixture) => {
      const issuance = (issuer.issuedVia === "human"
        ? { issuedVia: "human", createdByUserId: f.ownerId }
        : issuer.issuedVia === "computer" ? { ...issuer, issuedByMachineId: f.machineId } : issuer) as AgentCredentialIssuance;
      return (await mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name: credentialName, ...issuance })).credentialId;
    },
  })),
  {
    name: "a revoked key",
    status: 409,
    code: "runner_credential_revoked",
    setup: async (app, f) => {
      const { credentialId } = await mintViaRoute(app, f);
      await revokeAgentCredential({ credentialId, reason: "test" });
      return credentialId;
    },
  },
  {
    name: "a key that expired more than 7 days ago",
    status: 409,
    code: "runner_credential_renew_window_passed",
    setup: async (app, f) => {
      const { credentialId } = await mintViaRoute(app, f);
      await getDb().update(agentCredentials).set({ expiresAt: new Date(Date.now() - 7 * DAY - 60_000) }).where(eq(agentCredentials.id, credentialId));
      return credentialId;
    },
  },
  {
    name: "a deleted agent",
    status: 404,
    code: "agent_missing",
    setup: async (app, f) => {
      const { credentialId } = await mintViaRoute(app, f);
      await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.agentId));
      return credentialId;
    },
  },
  {
    name: "a Machine whose daemon did not declare renewal",
    status: 403,
    code: "runner_credential_renew_not_declared",
    setup: async (app, f) => {
      const { credentialId } = await mintViaRoute(app, f);
      declareRenew(app, []);
      return credentialId;
    },
  },
  {
    name: "an unknown credential id",
    status: 404,
    code: "credential_missing",
    setup: async () => randomUUID(),
  },
];

for (const refusal of REFUSALS) {
  test(`renew refuses ${refusal.name}: ${refusal.status} ${refusal.code}, nothing issued`, async ({ app }) => {
    const f = await seed();
    declareRenew(app, [f.machineId]);
    const credentialId = await refusal.setup(app, f);
    const before = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, credentialId));
    const count = await credentialCount(f.agentId);
    const res = await renew(app, f, credentialId);
    assert.equal(res.status, refusal.status, await res.clone().text());
    assert.equal((await res.json() as { code?: string }).code, refusal.code);
    assert.equal(await credentialCount(f.agentId), count, "no credential issued");
    const after = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, credentialId));
    assert.deepEqual(after, before, "the old credential is untouched");
  });
}

test("renew: an agent deleted while the new key is hashed gets no new key (agent row locked FOR SHARE)", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const old = await mintViaRoute(app, f);
  const count = await credentialCount(f.agentId);
  const { deleteAgent } = await import("../services/agentService");
  __setRenewBeforeLockHookForTests(async () => { await deleteAgent(f.agentId); });
  try {
    const res = await renew(app, f, old.credentialId);
    assert.equal(res.status, 404, await res.clone().text());
    assert.equal((await res.json() as { code?: string }).code, "agent_missing");
  } finally {
    __setRenewBeforeLockHookForTests(null);
  }
  assert.equal(await credentialCount(f.agentId), count, "no credential row was written for the deleted agent");
  assert.ok((await credentialRow(old.credentialId)).revokedAt, "the deletion revoked the old key");
});

test("renew: the agent's old key is not the authentication; an sk_agent_* caller is refused upstream", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  const old = await mintViaRoute(app, f);
  const count = await credentialCount(f.agentId);
  const res = await renew(app, f, old.credentialId, old.apiKey);
  assert.equal(res.status, 401);
  assert.equal(await credentialCount(f.agentId), count);
});

test("renew: rate-limited per Machine (429 runner_credential_renew_rate_limited)", async ({ app }) => {
  const f = await seed();
  declareRenew(app, [f.machineId]);
  __setRunnerCredentialRenewRateLimitForTests(2);
  const keys = [await mintViaRoute(app, f), await mintViaRoute(app, f), await mintViaRoute(app, f)];
  assert.equal((await renew(app, f, keys[0]!.credentialId)).status, 201);
  assert.equal((await renew(app, f, keys[1]!.credentialId)).status, 201);
  const limited = await renew(app, f, keys[2]!.credentialId);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code?: string }).code, "runner_credential_renew_rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await credentialRow(keys[2]!.credentialId)).replacedByCredentialId, null, "the limited renewal issued nothing");

  // Another Machine's budget is its own.
  const g = await seed();
  declareRenew(app, [g.machineId]);
  const other = await mintViaRoute(app, g);
  assert.equal((await renew(app, g, other.credentialId)).status, 201);
});
