import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
// External-agent credential security:
//   1. a revoked credential / deleted agent loses its open wake-hint stream —
//      at the next heartbeat re-validation, and promptly via the revocation
//      broadcast; the seen-touch never refreshes a revoked credential;
//   2. human-facing mint paths refuse managed agents (`agent_not_external`);
//   3. the default scope set is least-privilege and re-login rotates the
//      profile's previous credential.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentCredentials, agents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  __setAgentCredentialUseThrottleMsForTests,
  DEFAULT_EXTERNAL_AGENT_CAPABILITIES,
  mintAgentCredential,
  recordAgentCredentialUse,
} from "../services/agentCredentialService";
import { recordAgentApiSeen } from "../services/externalAgentPresence";
import { subscribeAgentCredentialRevocation } from "../services/agentCredentialRevocationBus";
import { handleReplicaMessage } from "../replicaRouter";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { __setExternalAgentInboxChainSelectorForTests } from "../services/messageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const MINT_GATES = {
  SLOCK_DEVICE_LOGIN_ENABLED: "true",
  SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED: "true",
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "test-pepper-test-pepper-test-pepper-0000",
};

async function seedFixture() {
  const suffix = randomUUID();
  const email = `cred-sec-${suffix}@slock.test`;
  const [owner] = await getDb().insert(users).values({
    email,
    name: `cred-sec-${suffix}`,
    displayName: "Credential Security Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Credential Security", `cred-sec-${suffix}`, owner!.id);
  const external = await createAgent(server.id, "CredSecExt", { runtime: "external", model: "external" });
  const managed = await createAgent(server.id, "CredSecManaged", { runtime: "codex" });
  return { ownerId: owner!.id, ownerToken: await tokenForHuman(email), serverId: server.id, externalId: external.id, managedId: managed.id };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function mintExternal(f: Fixture) {
  return mintAgentCredential({ agentId: f.externalId, scopes: ["read", "send"], issuedVia: "human", createdByUserId: f.ownerId, name: "stream" });
}

async function openStream(baseUrl: string, apiKey: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/wake-hints/stream`, { headers: { Authorization: `Bearer ${apiKey}` } });
  assert.equal(res.status, 200);
  return res;
}

/**
 * Incremental SSE reader: `read(ms)` collects until the server ends the
 * stream or `ms` passes; a read still pending at timeout is reused by the
 * next call, so no bytes are lost between phases.
 */
function streamReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending: Promise<ReadableStreamReadResult<Uint8Array> | { done: true; value: undefined }> | null = null;
  let ended = false;
  return {
    async read(timeoutMs: number): Promise<{ ended: boolean; raw: string; elapsedMs: number }> {
      const started = Date.now();
      const deadline = started + timeoutMs;
      let raw = "";
      while (!ended && Date.now() < deadline) {
        pending ??= reader.read().catch(() => ({ done: true as const, value: undefined }));
        const next = await Promise.race([
          pending,
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(10, deadline - Date.now()))),
        ]);
        if (next === "timeout") break;
        pending = null;
        if (next.done) ended = true;
        else raw += decoder.decode(next.value, { stream: true });
      }
      return { ended, raw, elapsedMs: Date.now() - started };
    },
    cancel(): void {
      void reader.cancel().catch(() => {});
    },
  };
}

/** Read until the server ends the stream or the timeout passes, then let go. */
async function readUntilEnd(body: ReadableStream<Uint8Array>, timeoutMs: number) {
  const stream = streamReader(body);
  const result = await stream.read(timeoutMs);
  stream.cancel();
  return result;
}

async function revokeDirectly(credentialId: string): Promise<void> {
  await getDb().update(agentCredentials).set({ revokedAt: new Date(), revokedReason: "test" }).where(eq(agentCredentials.id, credentialId));
}

// ── 1(a) heartbeat re-validation ────────────────────────────────────────────

test("a revoked credential's open stream ends at the next heartbeat (no broadcast involved)", async ({ app }) => {
  await withEnv({ SLOCK_WAKE_STREAM_HEARTBEAT_MS: "300" }, async () => {
    const f = await seedFixture();
    app.app.set("agentOrchestrator", new AgentOrchestrator());
    const credential = await mintExternal(f);
    const res = await openStream(app.baseUrl, credential.apiKey);

    // Still open across several valid heartbeats.
    const stream = streamReader(res.body!);
    const warm = await stream.read(800);
    assert.equal(warm.ended, false, "a valid credential keeps its stream");
    assert.match(warm.raw, /: ka/, "valid ticks keep sending keepalives");

    // Revoke in the database only: no route, no broadcast.
    await revokeDirectly(credential.credentialId);
    const after = await stream.read(3000);
    stream.cancel();
    assert.equal(after.ended, true, `stream must end after revocation: ${after.raw.slice(-200)}`);
    assert.match(after.raw, /event: credential-revoked/);
  });
});

test("an expired credential's open stream ends at the next heartbeat, as expired (#wg-rbac:#27)", async ({ app }) => {
  await withEnv({ SLOCK_WAKE_STREAM_HEARTBEAT_MS: "300" }, async () => {
    const f = await seedFixture();
    app.app.set("agentOrchestrator", new AgentOrchestrator());
    const credential = await mintExternal(f);
    const res = await openStream(app.baseUrl, credential.apiKey);
    const stream = streamReader(res.body!);
    const warm = await stream.read(800);
    assert.equal(warm.ended, false, "an unexpired credential keeps its stream");

    await getDb().update(agentCredentials).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(agentCredentials.id, credential.credentialId));
    const after = await stream.read(3000);
    stream.cancel();
    assert.equal(after.ended, true, `stream must end after expiry: ${after.raw.slice(-200)}`);
    assert.match(after.raw, /event: credential-expired\ndata: \{"code":"agent_credential_expired"\}/);
    assert.doesNotMatch(after.raw, /credential-revoked/);
  });
});

test("a deleted agent's open stream ends at the next heartbeat", async ({ app }) => {
  await withEnv({ SLOCK_WAKE_STREAM_HEARTBEAT_MS: "300" }, async () => {
    const f = await seedFixture();
    app.app.set("agentOrchestrator", new AgentOrchestrator());
    const credential = await mintExternal(f);
    const res = await openStream(app.baseUrl, credential.apiKey);
    const { deleteAgent } = await import("../services/agentService");
    await deleteAgent(f.externalId);
    const after = await readUntilEnd(res.body!, 3000);
    assert.equal(after.ended, true, "deleted agent loses the stream");
  });
});

test("deleting an agent revokes every live credential of it in the same transaction (#wg-rbac:#27)", async ({ app: _app }) => {
  const f = await seedFixture();
  const [a, b] = [await mintExternal(f), await mintExternal(f)];
  const { deleteAgent } = await import("../services/agentService");
  await deleteAgent(f.externalId);
  const rows = await getDb().select({ id: agentCredentials.id, revokedAt: agentCredentials.revokedAt, reason: agentCredentials.revokedReason })
    .from(agentCredentials).where(eq(agentCredentials.agentId, f.externalId));
  for (const id of [a.credentialId, b.credentialId]) {
    const row = rows.find((r) => r.id === id);
    assert.ok(row?.revokedAt, `${id} revoked`);
    assert.equal(row?.reason, "agent_deleted");
  }
  assert.equal(rows.filter((r) => r.revokedAt === null).length, 0, "no live credential of a deleted agent");
});

test("a key minted while its agent is being deleted is refused, not left live (#wg-rbac:#27)", async ({ app: _app }) => {
  const f = await seedFixture();
  const { deleteAgent } = await import("../services/agentService");
  const { __setMintBeforeLockHookForTests } = await import("../services/agentCredentialService");
  // The deletion lands after the agent check and the slow hash, before the insert.
  __setMintBeforeLockHookForTests(async (agentId) => { await deleteAgent(agentId); });
  try {
    await assert.rejects(mintExternal(f), /agent_missing/);
  } finally {
    __setMintBeforeLockHookForTests(null);
  }
  const live = await getDb().select({ id: agentCredentials.id }).from(agentCredentials)
    .where(eq(agentCredentials.agentId, f.externalId));
  assert.equal(live.filter(Boolean).length, 0, "no credential row was written for the deleted agent");
});

// ── 1(b) prompt close via the revocation broadcast ──────────────────────────

test("revoking through the API closes the open stream promptly, long before a heartbeat", async ({ app }) => {
  await withEnv({ SLOCK_WAKE_STREAM_HEARTBEAT_MS: "60000" }, async () => {
    const f = await seedFixture();
    app.app.set("agentOrchestrator", new AgentOrchestrator());
    const credential = await mintExternal(f);
    const other = await mintExternal(f);
    const res = await openStream(app.baseUrl, credential.apiKey);
    const otherRes = await openStream(app.baseUrl, other.apiKey);
    const reading = readUntilEnd(res.body!, 5000);
    const otherReading = readUntilEnd(otherRes.body!, 1500);

    const revoke = await fetch(`${app.baseUrl}/api/agents/${f.externalId}/credentials/${credential.credentialId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    assert.equal(revoke.status, 204);
    const result = await reading;
    assert.equal(result.ended, true, "revoked stream must close");
    assert.ok(result.elapsedMs < 5000);
    assert.match(result.raw, /event: credential-revoked/);
    const otherResult = await otherReading;
    assert.equal(otherResult.ended, false, "the agent's other (unrevoked) credential keeps its stream");
  });
});

test("deleting the agent through the API closes its open stream promptly", async ({ app }) => {
  await withEnv({ SLOCK_WAKE_STREAM_HEARTBEAT_MS: "60000" }, async () => {
    const f = await seedFixture();
    app.app.set("agentOrchestrator", new AgentOrchestrator());
    const credential = await mintExternal(f);
    const res = await openStream(app.baseUrl, credential.apiKey);
    const reading = readUntilEnd(res.body!, 5000);
    const del = await fetch(`${app.baseUrl}/api/agents/${f.externalId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${f.ownerToken}`, "X-Server-Id": f.serverId },
    });
    assert.equal(del.status, 200);
    const result = await reading;
    assert.equal(result.ended, true, "deleted agent's stream must close");
  });
});

test("a revocation signal from another replica reaches local listeners; our own echo is skipped", () => {
  const agentId = randomUUID();
  let calls = 0;
  const unsubscribe = subscribeAgentCredentialRevocation(agentId, () => { calls += 1; });
  try {
    handleReplicaMessage("slock:replica:agent-credential-revocation", JSON.stringify({ agentId, from: "some-other-replica" }));
    assert.equal(calls, 1);
    handleReplicaMessage("slock:replica:agent-credential-revocation", JSON.stringify({ agentId: randomUUID(), from: "some-other-replica" }));
    assert.equal(calls, 1, "other agents' signals are not delivered");
  } finally {
    unsubscribe();
  }
});

// ── 1(c) seen-touch ignores revoked credentials ─────────────────────────────

test("the seen-touch never updates a revoked credential and emits no agent:seen for it", async ({ app }) => {
  __setAgentCredentialUseThrottleMsForTests(0);
  try {
    const f = await seedFixture();
    const credential = await mintExternal(f);
    await revokeDirectly(credential.credentialId);

    assert.equal(await recordAgentCredentialUse({ credentialId: credential.credentialId, ip: null, userAgent: null }), null);
    const [row] = await getDb().select({ lastUsedAt: agentCredentials.lastUsedAt }).from(agentCredentials)
      .where(eq(agentCredentials.id, credential.credentialId));
    assert.equal(row!.lastUsedAt, null, "revoked credential's last_used_at must stay untouched");

    const emitted: string[] = [];
    const fakeReq = {
      agentCredentialId: credential.credentialId,
      actingAgentId: f.externalId,
      serverId: f.serverId,
      actingAgentIsExternal: true,
      ip: "127.0.0.1",
      headers: {},
      app: { get: () => ({ to: () => ({ emit: (event: string) => { emitted.push(event); return true; } }) }) },
    };
    recordAgentApiSeen(fakeReq as never);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(emitted, [], "no agent:seen for a revoked credential");
    void app;
  } finally {
    __setAgentCredentialUseThrottleMsForTests(null);
  }
});

// ── 2. managed agents are refused ───────────────────────────────────────────

test("minting an sk_agent_* for a managed agent returns 400 agent_not_external (web mint + bootstrap token)", async ({ app }) => {
  await withEnv(MINT_GATES, async () => {
    const f = await seedFixture();
    const mint = await fetch(`${app.baseUrl}/api/agents/${f.managedId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(mint.status, 400);
    assert.equal((await mint.json()).code, "agent_not_external");

    const bootstrap = await fetch(`${app.baseUrl}/api/agents/${f.managedId}/bootstrap-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerToken}`, "X-Server-Id": f.serverId },
      body: JSON.stringify({}),
    });
    assert.equal(bootstrap.status, 400);
    assert.equal((await bootstrap.json()).code, "agent_not_external");

    const rows = await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.agentId, f.managedId));
    assert.equal(rows.length, 0, "nothing was minted for the managed agent");

    // The same request for the external agent succeeds.
    const ok = await fetch(`${app.baseUrl}/api/agents/${f.externalId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(ok.status, 201);
  });
});

test("the service-level guard refuses managed agents when requested and still serves the Computer path", async ({ db }) => {
  void db;
  const f = await seedFixture();
  await assert.rejects(
    mintAgentCredential({ agentId: f.managedId, scopes: ["read"], issuedVia: "human", createdByUserId: f.ownerId, requireExternalRuntime: true }),
    /agent_not_external/,
  );
  // The Computer runner path does not set the flag and keeps working.
  const runner = await mintAgentCredential({ agentId: f.managedId, scopes: ["read"], issuedVia: "computer", createdByUserId: null });
  assert.ok(runner.apiKey.startsWith("sk_agent_"));
});

// ── 3. least-privilege default + rotation ───────────────────────────────────

test("default scopes are the least-privilege external-agent set; elevated scopes need an explicit request", async ({ app }) => {
  await withEnv(MINT_GATES, async () => {
    const f = await seedFixture();
    assert.deepEqual([...DEFAULT_EXTERNAL_AGENT_CAPABILITIES], ["channels", "knowledge", "mentions", "reactions", "read", "send", "tasks"]);

    const mint = await fetch(`${app.baseUrl}/api/agents/${f.externalId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(mint.status, 201);
    const minted = await mint.json() as { apiKey: string; scopes: string[] };
    assert.deepEqual(minted.scopes, ["channels", "knowledge", "mentions", "reactions", "read", "send", "tasks"]);
    assert.ok(!minted.scopes.includes("server") && !minted.scopes.includes("mcp"));

    // Server info is a read: default credentials can use it (channel/user CLI commands depend on it)…
    const info = await fetch(`${app.baseUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${minted.apiKey}` } });
    assert.equal(info.status, 200);
    // …but server mutation stays behind the elevated `server` capability.
    const update = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${minted.apiKey}` },
      body: JSON.stringify({ name: "renamed" }),
    });
    assert.equal(update.status, 403);
    assert.equal((await update.json()).requiredCapability, "server");
    // Own profile is the agent's outward presence (`send`), same as a managed agent;
    // the route acts only on the credential's bound agent.
    const profile = await fetch(`${app.baseUrl}/internal/agent-api/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${minted.apiKey}` },
      body: JSON.stringify({ displayName: "Renamed External" }),
    });
    assert.equal(profile.status, 200, await profile.clone().text());
    const [self] = await getDb().select({ displayName: agents.displayName }).from(agents).where(eq(agents.id, f.externalId));
    assert.equal(self!.displayName, "Renamed External");
    const [other] = await getDb().select({ displayName: agents.displayName }).from(agents).where(eq(agents.id, f.managedId));
    assert.notEqual(other!.displayName, "Renamed External");
    // Refusal slice 8: the profile checks answer through refuse() (agentRouteRefusals.agentProfileUpdateFields).
    const profileRefused = async (path: string, init: RequestInit) => {
      const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, { method: "POST", ...init, headers: { ...init.headers, Authorization: `Bearer ${minted.apiKey}` } });
      const body = await res.json() as { code?: string; errorCode?: string; error?: string };
      return [res.status, body.code, body.errorCode];
    };
    const json = (body: unknown): RequestInit => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.deepEqual(await profileRefused("/profile", json({})), [400, "PROFILE_UPDATE_NO_FIELDS", "PROFILE_UPDATE_NO_FIELDS"]);
    assert.deepEqual(await profileRefused("/profile", json({ avatarUrl: "https://x.example/a.png" })), [400, "PROFILE_AVATAR_URL_BAD_FORMAT", "PROFILE_AVATAR_URL_BAD_FORMAT"]);
    assert.deepEqual(await profileRefused("/profile", json({ displayName: "x".repeat(81) })), [400, "profile_display_name_invalid", "profile_display_name_invalid"]);
    assert.deepEqual(await profileRefused("/profile/avatar", {}), [400, "avatar_file_required", "avatar_file_required"]);
    // The SERVER avatar stays behind `server`.
    const serverAvatar = await fetch(`${app.baseUrl}/internal/agent-api/server/avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${minted.apiKey}` },
    });
    assert.equal(serverAvatar.status, 403);
    assert.equal((await serverAvatar.json()).requiredCapability, "server");

    const elevated = await fetch(`${app.baseUrl}/api/agents/${f.externalId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerToken}` },
      body: JSON.stringify({ scopes: ["read", "server", "mcp"] }),
    });
    assert.equal(elevated.status, 201);
    assert.deepEqual((await elevated.json()).scopes, ["mcp", "read", "server"]);

    const bootstrap = await fetch(`${app.baseUrl}/api/agents/${f.externalId}/bootstrap-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerToken}`, "X-Server-Id": f.serverId },
      body: JSON.stringify({}),
    });
    assert.equal(bootstrap.status, 201);
    assert.deepEqual((await bootstrap.json()).scopes, [...DEFAULT_EXTERNAL_AGENT_CAPABILITIES]);
  });
});

test("re-login rotates: the profile's previous credential is revoked atomically, other devices are untouched", async ({ app }) => {
  await withEnv(MINT_GATES, async () => {
    const f = await seedFixture();
    const mintVia = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${f.externalId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerToken}` },
      body: JSON.stringify(body),
    });
    const whoami = (apiKey: string) => fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${apiKey}` } })
      .then(async (res) => { await res.arrayBuffer(); return res.status; });

    const first = await (await mintVia({})).json() as { credentialId: string; apiKey: string };
    const otherDevice = await (await mintVia({})).json() as { credentialId: string; apiKey: string };

    const relogin = await mintVia({ replacesCredentialId: first.credentialId });
    assert.equal(relogin.status, 201);
    const second = await relogin.json() as { credentialId: string; apiKey: string };

    assert.equal(await whoami(first.apiKey), 401, "the replaced credential is revoked");
    assert.equal(await whoami(second.apiKey), 200);
    assert.equal(await whoami(otherDevice.apiKey), 200, "another device's credential is untouched");
    const [row] = await getDb().select({ revokedReason: agentCredentials.revokedReason, revokedByUserId: agentCredentials.revokedByUserId })
      .from(agentCredentials).where(eq(agentCredentials.id, first.credentialId));
    assert.equal(row!.revokedReason, "rotated");
    assert.equal(row!.revokedByUserId, f.ownerId);

    // Rotating an already-revoked credential is a no-op, not an error.
    assert.equal((await mintVia({ replacesCredentialId: first.credentialId })).status, 201);

    // Another agent's credential cannot be named; nothing is minted or revoked.
    const foreignAgent = await createAgent(f.serverId, "CredSecForeign", { runtime: "external", model: "external" });
    const foreign = await mintAgentCredential({ agentId: foreignAgent.id, scopes: ["read"], issuedVia: "human", createdByUserId: f.ownerId });
    const before = await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.agentId, f.externalId));
    const rejected = await mintVia({ replacesCredentialId: foreign.credentialId });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, "replaces_credential_invalid");
    assert.equal(await whoami(foreign.apiKey), 200);
    const afterRows = await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.agentId, f.externalId));
    assert.equal(afterRows.length, before.length, "the failed rotation minted nothing");

    assert.equal((await mintVia({ replacesCredentialId: "not-a-uuid" })).status, 400);
  });
});

test("rotation closes the replaced credential's open stream promptly", async ({ app }) => {
  await withEnv({ ...MINT_GATES, SLOCK_WAKE_STREAM_HEARTBEAT_MS: "60000" }, async () => {
    const f = await seedFixture();
    app.app.set("agentOrchestrator", new AgentOrchestrator());
    const credential = await mintExternal(f);
    const res = await openStream(app.baseUrl, credential.apiKey);
    const reading = readUntilEnd(res.body!, 5000);
    const relogin = await fetch(`${app.baseUrl}/api/agents/${f.externalId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerToken}` },
      body: JSON.stringify({ replacesCredentialId: credential.credentialId }),
    });
    assert.equal(relogin.status, 201);
    assert.equal((await reading).ended, true);
  });
});
