import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type RuntimeLimitResetKind,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { computers, featureFlagRules, featureFlags, machines, serverMembers, servers as serversTable, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { runtimeAccountUsageCacheService } from "../services/runtimeAccountUsageCacheService";
import { RouteFailureError } from "../tracing/routeFailure";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

// Claude limit resets (docs/contracts/runtime-account-usage.md, "Limit resets
// (Claude)"): the redeem route by kind, the read route, the card's view field,
// behind claude_limit_reset: viewed by the attacher and owners/admins, spent
// (a use, or a read with consent) by the attacher only; on a Computer with the
// Claude driver; and results an older web bundle can read.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const KEY = "0f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f";

async function seedComputer(slug: string, options: { attached?: boolean; flag?: boolean } = {}) {
  const db = getDb();
  const seed = async (email: string) => {
    const [row] = await db.insert(users).values({
      email,
      name: email.split("@")[0],
      displayName: email.split("@")[0],
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    return row!;
  };
  const owner = await seed(`owner-${slug}@slock.test`);
  const admin = await seed(`admin-${slug}@slock.test`);
  const attacher = await seed(`attacher-${slug}@slock.test`);
  const bystander = await seed(`bystander-${slug}@slock.test`);
  const server = await createServer(`Claude reset ${slug}`, slug, owner.id);
  await db.update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: attacher.id, role: "member" },
    { serverId: server.id, userId: bystander.id, role: "member" },
  ]);
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: `${slug}-computer`,
    apiKeyHash: `unused-${slug}-machine-hash`,
    runtimes: ["claude", "codex"],
  }).returning();
  await db.insert(computers).values({
    serverId: server.id,
    machineId: machine!.id,
    name: `${slug}-computer`,
    apiKeyHash: `unused-${slug}-computer-hash`,
    apiKeyPrefix: `sk_computer_${slug.slice(0, 8)}`,
    attachedByUserId: options.attached === false ? null : attacher.id,
  });
  if (options.flag !== false) {
    await db.insert(featureFlags)
      .values({ key: CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
      .onConflictDoNothing();
    await db.insert(featureFlagRules).values({
      id: randomUUID(),
      flagKey: CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY,
      stage: "server",
      priority: 0,
      decision: "allow",
      values: [server.id],
    });
  }
  const tokens = {
    owner: await tokenForHuman(owner.email),
    admin: await tokenForHuman(admin.email),
    attacher: await tokenForHuman(attacher.email),
    bystander: await tokenForHuman(bystander.email),
  };
  return { server, machine: machine!, tokens };
}

function claudeUsage(fiveHour: "limit_reached" | "ok"): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "claude",
    collectedAt: "2026-11-11T10:00:00.000Z",
    staleAfter: "2099-11-11T10:30:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "c".repeat(64),
      maskedLabel: "tea****r@example.com",
      health: fiveHour === "limit_reached" ? "rate_limited" : "ok",
      windows: [
        { id: "session", label: "Current session", status: fiveHour, usedRatio: fiveHour === "limit_reached" ? 1 : 0.4 },
        { id: "week", label: "Current week (all models)", status: "ok", usedRatio: 0.2 },
      ],
    }],
  };
}

type Redeem = { machineId: string; provider: RuntimeAccountUsageProvider; idempotencyKey: string; kind?: RuntimeLimitResetKind };
type Read = { machineId: string; provider: RuntimeAccountUsageProvider; atFiveHourLimit: boolean; atFiveHourLimitConsent: boolean; includeFiveHour: boolean };

function fakeOrchestrator(options: {
  claude?: "ok" | "computer_offline" | "computer_upgrade_required";
  codex?: "ok" | "computer_offline" | "computer_upgrade_required";
  redeem?: (call: Redeem) => Promise<unknown>;
  read?: (call: Read) => Promise<unknown>;
} = {}) {
  const redeems: Redeem[] = [];
  const reads: Read[] = [];
  return {
    redeems,
    reads,
    orchestrator: {
      runtimeAuthAvailability: async () => ({ state: "ok", connectionEpochId: null, runtimes: ["claude", "codex"], logoutRuntimes: ["claude", "codex"] }),
      runtimeLimitResetAvailability: async () => options.codex ?? "ok",
      claudeLimitResetAvailability: async () => options.claude ?? "ok",
      redeemRuntimeLimitReset: async (machineId: string, provider: RuntimeAccountUsageProvider, idempotencyKey: string, kind?: RuntimeLimitResetKind) => {
        const call = { machineId, provider, idempotencyKey, ...(kind ? { kind } : {}) };
        redeems.push(call);
        if (options.redeem) return options.redeem(call);
        return { type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result: { kind: "reset" } };
      },
      readRuntimeLimitResets: async (machineId: string, provider: RuntimeAccountUsageProvider, input: Omit<Read, "machineId" | "provider">) => {
        const call = { machineId, provider, ...input };
        reads.push(call);
        if (options.read) return options.read(call);
        return {
          type: "machine:runtime_account_usage:limit_resets:read:result",
          requestId: "r",
          result: { kind: "read", resets: [
            { kind: "five_hour", state: "none" },
            { kind: "weekly", state: "available", resetsLeft: 1, expiresText: "Nov 16, 4:59pm" },
            { kind: "fable", state: "none" },
            { kind: "full", state: "none" },
          ] },
        };
      },
    },
  };
}

function routes(baseUrl: string, serverId: string, machineId: string) {
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });
  const base = `${baseUrl}/api/servers/${serverId}/machines/${machineId}`;
  return {
    redeem: (token: string, body: unknown, provider = "claude") =>
      fetch(`${base}/runtime-account-usage/${provider}/limit-reset`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }),
    read: (token: string, body: unknown = {}, provider = "claude") =>
      fetch(`${base}/runtime-account-usage/${provider}/limit-resets/read`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }),
    view: (token: string) => fetch(`${base}/runtime-auth`, { headers: headers(token) }),
  };
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

test("claude_limit_reset off: no Claude reset on the card, both routes refuse Claude, Codex is unchanged", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-off", { flag: false });
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const view = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal("claudeLimitResets" in view, false, "the card shows nothing new");

  const redeem = await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly" });
  assert.equal(redeem.status, 404);
  assert.equal(await codeOf(redeem), "claude_limit_reset_disabled");
  const read = await api.read(tokens.attacher);
  assert.equal(read.status, 404);
  assert.equal(await codeOf(read), "claude_limit_reset_disabled");
  assert.equal(fake.redeems.length + fake.reads.length, 0, "nothing reaches the Computer");

  const codex = await api.redeem(tokens.attacher, { idempotencyKey: KEY }, "codex");
  assert.equal(codex.status, 200, "Codex resets are not behind the flag");
  assert.deepEqual(fake.redeems, [{ machineId: machine.id, provider: "codex", idempotencyKey: KEY }]);
});

test("Claude resets: viewed by the attacher and server owners/admins, used by the attacher only; a kind is required and passed through; the card says it is offered", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-who");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  assert.equal((await api.redeem(tokens.bystander, { idempotencyKey: KEY, kind: "weekly" })).status, 403);
  assert.equal((await api.read(tokens.bystander)).status, 403);
  const bystanderView = await api.view(tokens.bystander);
  if (bystanderView.status === 200) {
    assert.equal("claudeLimitResets" in (await bystanderView.json() as Record<string, unknown>), false, "only for a person who may act");
  }
  assert.equal(fake.redeems.length + fake.reads.length, 0);

  const noKind = await api.redeem(tokens.attacher, { idempotencyKey: KEY });
  assert.equal(noKind.status, 400);
  assert.equal(await codeOf(noKind), "kind_required", "the Computer never picks a kind");
  const badKind = await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "5-hour" });
  assert.equal(badKind.status, 400);
  assert.equal(await codeOf(badKind), "invalid_kind");
  const codexKind = await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly" }, "codex");
  assert.equal(codexKind.status, 400, "Codex has no kinds");
  assert.equal((await api.read(tokens.attacher, {}, "codex")).status, 404, "only Claude's resets are read");
  assert.equal((await api.read(tokens.attacher, { consent: "yes" })).status, 400);
  assert.equal(fake.redeems.length + fake.reads.length, 0);

  const ok = await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly" });
  assert.equal(ok.status, 200, "the person who connected the Computer may use its Claude resets");
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await ok.json(), { result: { kind: "reset" }, snapshot: null });
  assert.deepEqual(fake.redeems.map((call) => [call.provider, call.kind, call.idempotencyKey]), [["claude", "weekly", KEY]]);

  const view = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal(view.claudeLimitResets, "ok");
  assert.deepEqual(view.claudeLimitResetAccess, { canUse: true, canConsent: true });
});

test("Claude resets are the attacher's to spend: an owner or admin who did not connect the Computer may view them but not use one or consent to a read", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-owner-only");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  await runtimeAccountUsageCacheService.write(machine.id, claudeUsage("limit_reached"));

  for (const token of [tokens.owner, tokens.admin]) {
    const redeem = await api.redeem(token, { idempotencyKey: KEY, kind: "five_hour" });
    assert.equal(redeem.status, 403, "an owner or admin never spends another person's Claude reset");
    assert.equal(await codeOf(redeem), "claude_limit_reset_owner_only");
    const consentRead = await api.read(token, { consent: true });
    assert.equal(consentRead.status, 403, "a read with consent can spend the 5-hour reset");
    assert.equal(await codeOf(consentRead), "claude_limit_reset_owner_only");
  }
  assert.equal(fake.redeems.length + fake.reads.length, 0, "nothing reaches the Computer");

  // A plain read stays open to them (at the limit a real Computer answers consent_required to it).
  for (const token of [tokens.owner, tokens.admin]) {
    const read = await api.read(token);
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { result: { kind: string } }).result.kind, "read");
    const view = await (await api.view(token)).json() as Record<string, unknown>;
    assert.equal(view.claudeLimitResets, "ok", "they still see the resets");
    assert.deepEqual(view.claudeLimitResetAccess, { canUse: false, canConsent: false });
  }
  assert.deepEqual(fake.reads.map(({ atFiveHourLimitConsent }) => atFiveHourLimitConsent), [false, false], "never with consent");
  assert.equal(fake.redeems.length, 0);

  // Codex resets are unchanged: an owner or admin may still use one.
  for (const token of [tokens.owner, tokens.admin]) {
    assert.equal((await api.redeem(token, { idempotencyKey: KEY }, "codex")).status, 200);
  }
  assert.deepEqual(fake.redeems.map((call) => call.provider), ["codex", "codex"]);

  // The attacher may do both.
  assert.equal((await api.read(tokens.attacher, { consent: true })).status, 200);
  assert.equal((await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "five_hour" })).status, 200);
});

test("Claude resets need the Claude driver: an older Computer is told to upgrade and never sent a message; offline and unattached are refused", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-cap");
  const api = routes(app.baseUrl, server.id, machine.id);

  // The Codex reset capability alone is not enough for Claude.
  const old = fakeOrchestrator({ claude: "computer_upgrade_required", codex: "ok" });
  app.app.set("agentOrchestrator", old.orchestrator);
  const redeem = await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "fable" });
  assert.equal(redeem.status, 409);
  assert.equal(await codeOf(redeem), "computer_upgrade_required");
  const read = await api.read(tokens.attacher);
  assert.equal(read.status, 409);
  assert.equal(await codeOf(read), "computer_upgrade_required");
  assert.equal(old.redeems.length + old.reads.length, 0);
  assert.equal((await (await api.view(tokens.attacher)).json() as Record<string, unknown>).claudeLimitResets, "computer_upgrade_required");

  const offline = fakeOrchestrator({ claude: "computer_offline" });
  app.app.set("agentOrchestrator", offline.orchestrator);
  const gone = await api.read(tokens.attacher);
  assert.equal(gone.status, 409);
  assert.equal(await codeOf(gone), "computer_offline");
  assert.equal("claudeLimitResets" in (await (await api.view(tokens.attacher)).json() as Record<string, unknown>), false);

  const unattached = await seedComputer("clr-noattach", { attached: false });
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const noOwner = await routes(app.baseUrl, unattached.server.id, unattached.machine.id).read(unattached.tokens.owner);
  assert.equal(noOwner.status, 409);
  assert.equal(await codeOf(noOwner), "computer_not_attached");
  assert.equal(fake.reads.length, 0);
});

test("a read tells the Computer whether the cached usage shows the 5-hour limit, passes consent, and relays what it read", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-read");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  // Nothing cached: not known to be under the limit, so the Computer asks for consent.
  const first = await api.read(tokens.attacher);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.equal(((await first.json()) as { result: { kind: string } }).result.kind, "read");

  await runtimeAccountUsageCacheService.write(machine.id, claudeUsage("ok"));
  await api.read(tokens.attacher);
  await runtimeAccountUsageCacheService.write(machine.id, claudeUsage("limit_reached"));
  await api.read(tokens.attacher, { consent: true });
  assert.equal(fake.redeems.length, 0, "a read never sends a redeem message");
  assert.deepEqual(fake.reads.map(({ atFiveHourLimit, atFiveHourLimitConsent, includeFiveHour }) => ({ atFiveHourLimit, atFiveHourLimitConsent, includeFiveHour })), [
    { atFiveHourLimit: true, atFiveHourLimitConsent: false, includeFiveHour: true },
    { atFiveHourLimit: false, atFiveHourLimitConsent: false, includeFiveHour: true },
    { atFiveHourLimit: true, atFiveHourLimitConsent: true, includeFiveHour: true },
  ]);

  app.app.set("agentOrchestrator", fakeOrchestrator({
    read: async () => ({ type: "machine:runtime_account_usage:limit_resets:read:result", requestId: "r", result: { kind: "unsupported", reason: "consent_required" } }),
  }).orchestrator);
  assert.deepEqual(await (await api.read(tokens.attacher)).json(), { result: { kind: "unsupported", reason: "consent_required" } });

  app.app.set("agentOrchestrator", fakeOrchestrator({
    read: async () => ({ type: "machine:runtime_account_usage:limit_resets:read:result", requestId: "r", result: { kind: "read", program: "legacy", fiveHourSpent: true, resets: [{ kind: "five_hour", state: "unknown" }] } }),
  }).orchestrator);
  assert.deepEqual(await (await api.read(tokens.attacher, { consent: true })).json(), {
    result: { kind: "read", program: "legacy", fiveHourSpent: true, resets: [{ kind: "five_hour", state: "unknown" }] },
  }, "the older program spending its reset on opening is said, not hidden");

  app.app.set("agentOrchestrator", fakeOrchestrator({
    read: async () => ({ type: "machine:runtime_account_usage:limit_resets:read:result", requestId: "r", result: { kind: "read", resets: [{ kind: "monthly", state: "available" }] } }),
  }).orchestrator);
  assert.deepEqual(await (await api.read(tokens.attacher)).json(), { result: { kind: "unknown" } }, "an unreadable answer is unknown");

  app.app.set("agentOrchestrator", fakeOrchestrator({ read: async () => { throw new RouteFailureError("daemon_timeout", "timed out"); } }).orchestrator);
  const timeout = await api.read(tokens.attacher);
  assert.equal(timeout.status, 504);
  assert.equal(await codeOf(timeout), "computer_timeout");
});

test("a Claude redeem answers what the Computer said, every shape; a Codex redeem is relayed as before", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-shapes");
  const api = routes(app.baseUrl, server.id, machine.id);
  const answer = (result: unknown) => fakeOrchestrator({
    redeem: async () => ({ type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result }),
  }).orchestrator;
  for (const result of [
    { kind: "unknown", fiveHourSpent: true },
    { kind: "unsupported", reason: "not_attempted" },
    { kind: "unsupported", reason: "unsupported_version" },
    { kind: "nothing_to_reset" },
  ]) {
    app.app.set("agentOrchestrator", answer(result));
    assert.deepEqual(await (await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "fable" })).json(), { result, snapshot: null });
  }
  app.app.set("agentOrchestrator", answer({ kind: "already_redeemed" }));
  assert.deepEqual(await (await api.redeem(tokens.attacher, { idempotencyKey: KEY }, "codex")).json(), { result: { kind: "already_redeemed" }, snapshot: null });
});

test("Claude reads and redeems are rate-limited per person and Computer; over the limit nothing reaches the Computer", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-rate");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  for (let i = 0; i < 10; i += 1) assert.equal((await api.read(tokens.attacher)).status, 200, `read ${i + 1}`);
  const limited = await api.read(tokens.attacher);
  assert.equal(limited.status, 429);
  assert.equal(await codeOf(limited), "rate_limited");
  assert.equal(fake.reads.length, 10, "the refused read is never relayed");
  assert.equal(fake.redeems.length, 0, "a read never sends a redeem");
  assert.equal((await api.read(tokens.owner)).status, 200, "another person has their own budget");

  for (let i = 0; i < 10; i += 1) assert.equal((await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly" })).status, 200, `redeem ${i + 1}`);
  const redeemLimited = await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly" });
  assert.equal(redeemLimited.status, 429);
  assert.equal(await codeOf(redeemLimited), "rate_limited");
  assert.equal(fake.redeems.length, 10);
  assert.equal((await api.redeem(tokens.attacher, { idempotencyKey: KEY }, "codex")).status, 200, "Codex is not counted");
});
