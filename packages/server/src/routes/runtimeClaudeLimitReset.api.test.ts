import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import {
  CLAUDE_LIMIT_RESET_FEATURE_FLAG_KEY,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type RuntimeLimitResetKind,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { computers, featureFlagRules, featureFlags, integrationAuditEvents, machines, serverMembers, servers as serversTable, users } from "../db/schema";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { CLAUDE_LIMIT_RESET_READ_SPENT_TTL_SECONDS, claudeLimitResetReadSpentGuard } from "../services/claudeLimitResetReadSpentGuard";
import { CLAUDE_LIMIT_RESET_REQUEST_LIMIT } from "../services/runtimeAuthService";
import { createServer } from "../services/serverService";
import { runtimeAccountUsageCacheService } from "../services/runtimeAccountUsageCacheService";
import { RouteFailureError } from "../tracing/routeFailure";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

// Claude limit resets (docs/contracts/runtime-account-usage.md, "Limit resets
// (Claude)"): the redeem route by kind, the read route, the card's view field,
// behind claude_limit_reset_v2: viewed and spent (a use, or a read with consent)
// by the attacher and owners/admins, as Codex resets; a reset an owner/admin
// uses on someone else's Computer is audited and emailed to the attacher; on a
// Computer with the Claude driver; and results an older web bundle can read.

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
  return { server, machine: machine!, tokens, people: { owner, admin, attacher, bystander } };
}

/** Emails sent while a test runs (fake delivery); stop() before the test ends. */
function watchEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

/** The notice email is sent after the answer, unawaited: wait for it, briefly. */
async function settle(done: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 25 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function usedByOtherEvents(serverId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, "computer.limit_reset_used_by_other")));
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

type Redeem = { machineId: string; provider: RuntimeAccountUsageProvider; idempotencyKey: string; kind?: RuntimeLimitResetKind; onboardingRequiredReason?: boolean };
type Read = { machineId: string; provider: RuntimeAccountUsageProvider; atFiveHourLimit: boolean; atFiveHourLimitConsent: boolean; includeFiveHour: boolean; onboardingRequiredReason?: boolean };

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
      redeemRuntimeLimitReset: async (machineId: string, provider: RuntimeAccountUsageProvider, idempotencyKey: string, kind?: RuntimeLimitResetKind, onboardingRequiredReason?: boolean) => {
        const call = { machineId, provider, idempotencyKey, ...(kind ? { kind } : {}), ...(onboardingRequiredReason ? { onboardingRequiredReason } : {}) };
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

test("claude_limit_reset_v2 off: no Claude reset on the card, both routes refuse Claude, Codex is unchanged", async ({ app }) => {
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

test("Claude resets: viewed and used by the attacher and server owners/admins, not other members; a kind is required and passed through; the card says it is offered", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-who");
  const emails = watchEmails();
  try {
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
    assert.equal("onboardingRequiredReason" in fake.redeems[0]!, false, "a page that did not say it reads onboarding_required never gets it");

    // A page that reads `unsupported: onboarding_required` says so; only then may the Computer answer it.
    const current = await api.redeem(tokens.attacher, { idempotencyKey: "2f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f", kind: "weekly", onboardingRequiredReason: true });
    assert.equal(current.status, 200);
    assert.equal(fake.redeems[1]?.onboardingRequiredReason, true);
    const currentRead = await api.read(tokens.attacher, { onboardingRequiredReason: true });
    assert.equal(currentRead.status, 200);
    const olderRead = await api.read(tokens.attacher);
    assert.equal(olderRead.status, 200);
    assert.deepEqual(fake.reads.map((call) => call.onboardingRequiredReason), [true, false]);

    const view = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
    assert.equal(view.claudeLimitResets, "ok");
    assert.deepEqual(view.claudeLimitResetAccess, { canUse: true, canConsent: true });

    // The attacher's own use is neither audited as another person's nor told to them.
    await settle();
    assert.deepEqual(await usedByOtherEvents(server.id), []);
    assert.equal(emails.deliveries.length, 0);
  } finally {
    emails.stop();
  }
});

test("an owner or admin who did not connect the Computer may use its Claude resets and consent to a read; each use is audited and emailed to the person who connected it", async ({ app }) => {
  const { server, machine, tokens, people } = await seedComputer("clr-admin-use");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  await runtimeAccountUsageCacheService.write(machine.id, claudeUsage("limit_reached"));
  const emails = watchEmails();
  try {
    for (const token of [tokens.owner, tokens.admin]) {
      const view = await (await api.view(token)).json() as Record<string, unknown>;
      assert.equal(view.claudeLimitResets, "ok");
      assert.deepEqual(view.claudeLimitResetAccess, { canUse: true, canConsent: true }, "an older web bundle reads canUse: no longer view-only");
      const consentRead = await api.read(token, { consent: true });
      assert.equal(consentRead.status, 200, "a read with consent, as the person who connected it may");
      assert.equal(((await consentRead.json()) as { result: { kind: string } }).result.kind, "read");
    }
    assert.deepEqual(fake.reads.map(({ atFiveHourLimitConsent }) => atFiveHourLimitConsent), [true, true], "the consent reaches the Computer");
    assert.deepEqual(await usedByOtherEvents(server.id), [], "a read that spends nothing is not a use");

    const byOwner = await api.redeem(tokens.owner, { idempotencyKey: KEY, kind: "five_hour" });
    assert.equal(byOwner.status, 200);
    assert.deepEqual(await byOwner.json(), { result: { kind: "reset" }, snapshot: null });
    const byAdmin = await api.redeem(tokens.admin, { idempotencyKey: "1f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f", kind: "weekly" });
    assert.equal(byAdmin.status, 200);
    assert.deepEqual(fake.redeems.map((call) => [call.provider, call.kind]), [["claude", "five_hour"], ["claude", "weekly"]]);

    const events = await usedByOtherEvents(server.id);
    assert.equal(events.length, 2, "one audit event per use");
    const ofActor = (userId: string) => events.find((event) => event.actorId === userId);
    for (const [user, role, resetKind] of [[people.owner, "owner", "five_hour"], [people.admin, "admin", "weekly"]] as const) {
      const event = ofActor(user.id);
      assert.ok(event, `${role}'s use is audited`);
      assert.equal(event.outcome, "success");
      assert.equal(event.source, "web");
      assert.equal(event.eventCategory, "computer", "on the server audit owners and admins read");
      assert.equal(event.actorType, "human");
      assert.equal(event.subjectType, "human");
      assert.equal(event.subjectId, people.attacher.id, "the person who connected the Computer");
      assert.equal(event.targetType, "machine");
      assert.equal(event.targetId, machine.id);
      assert.ok(event.createdAt instanceof Date);
      assert.deepEqual(event.metadata, { machineId: machine.id, machineName: machine.name, provider: "claude", resetKind, via: "redeem", answer: "reset", actorRole: role });
      assert.ok(!JSON.stringify(event).includes(KEY), "never the idempotency key");
    }

    await settle(() => emails.deliveries.length >= 2);
    const toAttacher = emails.deliveries.filter((delivery) => delivery.to === people.attacher.email);
    assert.equal(toAttacher.length, 2, "the person who connected the Computer is told of each use");
    assert.deepEqual(toAttacher.map((delivery) => delivery.subject).sort(), [
      `${people.admin.displayName} used a Claude Code limit reset on your Computer ${machine.name}`,
      `${people.owner.displayName} used a Claude Code limit reset on your Computer ${machine.name}`,
    ]);
    assert.ok(toAttacher.every((delivery) => delivery.text?.includes(`/s/${server.slug}/computers`)));
    assert.equal(emails.deliveries.length, 2, "nobody else is emailed");

    // The attacher's own use after theirs: no new event, no email.
    assert.equal((await api.redeem(tokens.attacher, { idempotencyKey: "2f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f", kind: "full" })).status, 200);
    await settle();
    assert.equal((await usedByOtherEvents(server.id)).length, 2);
    assert.equal(emails.deliveries.length, 2);
  } finally {
    emails.stop();
  }
});

test("the use notice is in the connecting person's display language", async ({ app }) => {
  const { server, machine, tokens, people } = await seedComputer("clr-admin-locale");
  await getDb().update(users).set({ displayLanguage: "zh-CN" }).where(eq(users.id, people.attacher.id));
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  const emails = watchEmails();
  try {
    assert.equal((await routes(app.baseUrl, server.id, machine.id).redeem(tokens.admin, { idempotencyKey: KEY, kind: "weekly" })).status, 200);
    await settle(() => emails.deliveries.length >= 1);
    assert.deepEqual(emails.deliveries.map((delivery) => [delivery.to, delivery.subject]), [
      [people.attacher.email, `${people.admin.displayName} 在你的 Computer ${machine.name} 上使用了一次 Claude Code 额度重置`],
    ]);
  } finally {
    emails.stop();
  }
});

test("an owner's or admin's Claude reset that was refused, limited, timed out or spent nothing is neither audited nor told", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-admin-refused");
  const api = routes(app.baseUrl, server.id, machine.id);
  const emails = watchEmails();
  try {
    // Refused before the Computer: a member who may not act, a missing kind, an old Computer.
    app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
    assert.equal((await api.redeem(tokens.bystander, { idempotencyKey: KEY, kind: "weekly" })).status, 403);
    assert.equal((await api.redeem(tokens.admin, { idempotencyKey: KEY })).status, 400);
    app.app.set("agentOrchestrator", fakeOrchestrator({ claude: "computer_upgrade_required" }).orchestrator);
    assert.equal((await api.redeem(tokens.admin, { idempotencyKey: KEY, kind: "weekly" })).status, 409);

    // Every answer from the Computer that does not say a reset was spent.
    const spentNothing = [
      { kind: "nothing_to_reset" },
      { kind: "no_reset" },
      { kind: "reauth_required", reason: "not_authenticated" },
      { kind: "unsupported", reason: "not_attempted" },
      { kind: "unknown" },
      { kind: "something_new" },
    ];
    for (const result of spentNothing) {
      app.app.set("agentOrchestrator", fakeOrchestrator({
        redeem: async () => ({ type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result }),
      }).orchestrator);
      assert.equal((await api.redeem(tokens.admin, { idempotencyKey: KEY, kind: "weekly" })).status, 200, JSON.stringify(result));
    }

    // No answer at all.
    app.app.set("agentOrchestrator", fakeOrchestrator({ redeem: async () => { throw new RouteFailureError("daemon_timeout", "timed out"); } }).orchestrator);
    assert.equal((await api.redeem(tokens.owner, { idempotencyKey: KEY, kind: "weekly" })).status, 504);
    app.app.set("agentOrchestrator", fakeOrchestrator({ redeem: async () => { throw new RouteFailureError("daemon_offline", "gone"); } }).orchestrator);
    assert.equal((await api.redeem(tokens.owner, { idempotencyKey: KEY, kind: "weekly" })).status, 409);

    // Over the rate limit, with a Computer that would answer `reset`: the admin has one counted per
    // answer above (the refusals before the Computer are not); the rest fill CLAUDE_LIMIT_RESET_REQUEST_LIMIT.
    app.app.set("agentOrchestrator", fakeOrchestrator({
      redeem: async () => ({ type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result: { kind: "nothing_to_reset" } }),
    }).orchestrator);
    for (let i = spentNothing.length; i < CLAUDE_LIMIT_RESET_REQUEST_LIMIT; i += 1) {
      assert.equal((await api.redeem(tokens.admin, { idempotencyKey: KEY, kind: "weekly" })).status, 200);
    }
    const resetting = fakeOrchestrator();
    app.app.set("agentOrchestrator", resetting.orchestrator);
    const limited = await api.redeem(tokens.admin, { idempotencyKey: KEY, kind: "weekly" });
    assert.equal(limited.status, 429);
    assert.equal(await codeOf(limited), "rate_limited");
    assert.equal(resetting.redeems.length, 0);

    await settle();
    assert.deepEqual(await usedByOtherEvents(server.id), []);
    assert.equal(emails.deliveries.length, 0);
  } finally {
    emails.stop();
  }
});

test("an owner's or admin's Claude reset that was spent all the same is audited and told: a retried redeem already through, the 5-hour reset spent instead, or on opening the list", async ({ app }) => {
  const { server, machine, tokens, people } = await seedComputer("clr-admin-spent");
  const api = routes(app.baseUrl, server.id, machine.id);
  await runtimeAccountUsageCacheService.write(machine.id, claudeUsage("limit_reached"));
  const answering = (result: unknown) => fakeOrchestrator({
    redeem: async () => ({ type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result }),
    read: async () => ({ type: "machine:runtime_account_usage:limit_resets:read:result", requestId: "r", result }),
  }).orchestrator;
  const emails = watchEmails();
  try {
    // The attacher's own: nothing, whatever was spent.
    app.app.set("agentOrchestrator", answering({ kind: "unknown", fiveHourSpent: true }));
    assert.equal((await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly" })).status, 200);
    app.app.set("agentOrchestrator", answering({ kind: "read", program: "legacy", fiveHourSpent: true, resets: [{ kind: "five_hour", state: "unknown" }] }));
    assert.equal((await api.read(tokens.attacher, { consent: true })).status, 200);
    await settle();
    assert.deepEqual(await usedByOtherEvents(server.id), []);
    assert.equal(emails.deliveries.length, 0);

    // A redeem of the weekly reset on which the older program spent the 5-hour one.
    app.app.set("agentOrchestrator", answering({ kind: "unknown", fiveHourSpent: true }));
    assert.deepEqual(await (await api.redeem(tokens.admin, { idempotencyKey: KEY, kind: "weekly" })).json(), { result: { kind: "unknown", fiveHourSpent: true }, snapshot: null });
    // A retry, with the same key, of a redeem that went through.
    app.app.set("agentOrchestrator", answering({ kind: "already_redeemed" }));
    assert.equal((await api.redeem(tokens.owner, { idempotencyKey: KEY, kind: "fable" })).status, 200);
    // A read with consent on which opening the list spent the 5-hour reset.
    app.app.set("agentOrchestrator", answering({ kind: "read", program: "legacy", fiveHourSpent: true, resets: [{ kind: "five_hour", state: "unknown" }] }));
    assert.equal((await api.read(tokens.admin, { consent: true })).status, 200);
    // A read that spent nothing: still nothing.
    app.app.set("agentOrchestrator", answering({ kind: "read", resets: [{ kind: "weekly", state: "available" }] }));
    assert.equal((await api.read(tokens.owner, { consent: true })).status, 200);

    const events = await usedByOtherEvents(server.id);
    const base = { machineId: machine.id, machineName: machine.name, provider: "claude" };
    // Keyed by who and how (jsonb does not keep the metadata's key order).
    const key = (actorId: string | null, metadata: Record<string, unknown>) => `${actorId}|${String(metadata.via)}|${String(metadata.answer)}`;
    const byKey = new Map(events.map((event) => [key(event.actorId, event.metadata), event]));
    assert.equal(events.length, 3, "one event per spend, none for the read that spent nothing");
    for (const [user, role, metadata] of [
      [people.admin, "admin", { ...base, resetKind: "five_hour", requestedKind: "weekly", via: "redeem", answer: "five_hour_spent" }],
      [people.admin, "admin", { ...base, resetKind: "five_hour", via: "read", answer: "five_hour_spent" }],
      [people.owner, "owner", { ...base, resetKind: "fable", via: "redeem", answer: "already_redeemed" }],
    ] as const) {
      const event = byKey.get(key(user.id, metadata));
      assert.ok(event, `${role} ${metadata.via} ${metadata.answer}`);
      assert.equal(event.subjectId, people.attacher.id);
      assert.equal(event.outcome, "success");
      assert.deepEqual(event.metadata, { ...metadata, actorRole: role });
    }

    await settle(() => emails.deliveries.length >= 3);
    assert.equal(emails.deliveries.length, 3, "one email per spend");
    assert.ok(emails.deliveries.every((delivery) => delivery.to === people.attacher.email && delivery.subject.includes("used a Claude Code limit reset on your Computer")));
  } finally {
    emails.stop();
  }
});

test("a person who connected the Computer and is also an admin spends their own resets: nothing is audited or told", async ({ app }) => {
  const { server, machine, tokens, people } = await seedComputer("clr-admin-connector");
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, people.attacher.id)));
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  const emails = watchEmails();
  try {
    assert.equal((await routes(app.baseUrl, server.id, machine.id).redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly" })).status, 200);
    await settle();
    assert.deepEqual(await usedByOtherEvents(server.id), []);
    assert.equal(emails.deliveries.length, 0);
  } finally {
    emails.stop();
  }
});

test("a reset spent on a Computer whose connector has left the server is audited, but nobody is emailed", async ({ app }) => {
  const { server, machine, tokens, people } = await seedComputer("clr-admin-departed");
  // The Computer still names them (its revoke on departure is another path); they are no longer a member.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, people.attacher.id)));
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  const emails = watchEmails();
  try {
    assert.equal((await routes(app.baseUrl, server.id, machine.id).redeem(tokens.admin, { idempotencyKey: KEY, kind: "weekly" })).status, 200);
    const events = await usedByOtherEvents(server.id);
    assert.equal(events.length, 1, "the use is still the record");
    assert.equal(events[0]!.subjectId, people.attacher.id);
    await settle();
    assert.deepEqual(emails.deliveries, [], "a person who left is not emailed");
  } finally {
    emails.stop();
  }
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

// #otter-lounge:#1: CloudFront closes a request that sends nothing for 30 s;
// a Claude read took ~34 s. With `respondAsync` the route answers 202 at once
// and the answer it would have had is read from GET …/machine-operations/:id.
test("respondAsync: read and redeem answer 202 at once; the operation gives the same status and body, to the starter only", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-async");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fake = fakeOrchestrator({
    read: async () => {
      await held;
      return { type: "machine:runtime_account_usage:limit_resets:read:result", requestId: "r", result: { kind: "unsupported", reason: "consent_required" } };
    },
  });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": server.id });
  const operation = (token: string, id: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/machine-operations/${id}`, { headers: headers(token) });

  const started = await api.read(tokens.attacher, { respondAsync: true });
  assert.equal(started.status, 202, "answered while the Computer is still reading");
  const { operationId } = await started.json() as { operationId: string };
  assert.deepEqual(await (await operation(tokens.attacher, operationId)).json(), { state: "pending" });
  assert.equal((await operation(tokens.owner, operationId)).status, 404, "only the person who started it");
  assert.equal((await operation(tokens.attacher, "00000000-0000-4000-8000-000000000000")).status, 404);

  release();
  let view: { state: string; status?: number; body?: unknown } = { state: "pending" };
  for (let i = 0; i < 50 && view.state === "pending"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    view = await (await operation(tokens.attacher, operationId)).json() as typeof view;
  }
  assert.deepEqual(view, { state: "done", status: 200, body: { result: { kind: "unsupported", reason: "consent_required" } } });

  // A redeem's timeout is kept as the 504 the direct request answers.
  app.app.set("agentOrchestrator", fakeOrchestrator({ redeem: async () => { throw new RouteFailureError("daemon_timeout", "timed out"); } }).orchestrator);
  const redeem = await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly", respondAsync: true });
  assert.equal(redeem.status, 202);
  const redeemId = (await redeem.json() as { operationId: string }).operationId;
  let done: { state: string; status?: number; body?: { code?: string } } = { state: "pending" };
  for (let i = 0; i < 50 && done.state === "pending"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    done = await (await operation(tokens.attacher, redeemId)).json() as typeof done;
  }
  assert.equal(done.status, 504);
  assert.equal(done.body?.code, "computer_timeout");

  // A request's own refusals still answer at once, never as an operation.
  const refused = await api.redeem(tokens.attacher, { idempotencyKey: KEY, respondAsync: true });
  assert.equal(refused.status, 400);
  assert.equal(await codeOf(refused), "kind_required");
});

test("a completed machine operation stays bound to its original Server after the starter leaves", async ({ app }) => {
  const slug = `operation-tenant-${randomUUID().slice(0, 8)}`;
  const { server, machine, tokens } = await seedComputer(slug);
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  const started = await api.read(tokens.attacher, { respondAsync: true });
  assert.equal(started.status, 202);
  const { operationId } = await started.json() as { operationId: string };
  const read = (serverId: string) => fetch(`${app.baseUrl}/api/servers/${serverId}/machine-operations/${operationId}`, {
    headers: { Authorization: `Bearer ${tokens.attacher}`, "X-Server-Id": serverId },
  });
  let view: { state?: string; status?: number } = {};
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const own = await read(server.id);
    assert.equal(own.status, 200, "the authorized starter can read the originating operation");
    view = await own.json() as typeof view;
    if (view.state === "done") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(view.state, "done");
  assert.equal(view.status, 200);
  assert.equal((await read(server.id.toUpperCase())).status, 200, "the same Server UUID may use another letter case");
  const [starter] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, `attacher-${slug}@slock.test`));
  const other = await createServer("Another Server", `${slug}-other`, starter!.id);
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, starter!.id)));
  assert.equal((await read(server.id)).status, 403, "the original Server's membership gate now rejects this person");
  const throughOther = await read(other.id);
  assert.equal(throughOther.status, 404, "another Server must not recover the original Server's private operation result");
  assert.equal((await throughOther.json() as { code: string }).code, "operation_not_found");
});

// "Read spent the 5-hour reset" (claudeLimitResetReadSpentGuard): after a read on Claude's older program
// spent the 5-hour reset, a later 5-hour use with a new key is answered nothing_to_reset by the server.
const LEGACY_READ_SPENT = { type: "machine:runtime_account_usage:limit_resets:read:result", requestId: "r", result: { kind: "read", program: "legacy", fiveHourSpent: true, resets: [{ kind: "five_hour", state: "unknown" }] } };
const NEW_KEY = "11111111-2222-4333-8444-555555555555";

function claudeUsageOf(accountKey: string, fiveHour: "limit_reached" | "ok"): RuntimeAccountUsageSnapshot {
  const usage = claudeUsage(fiveHour);
  return { ...usage, accounts: [{ ...usage.accounts[0]!, accountKey }] };
}

async function operationAnswer(baseUrl: string, serverId: string, token: string, started: Response): Promise<{ status: number; body: unknown }> {
  assert.equal(started.status, 202);
  const { operationId } = await started.json() as { operationId: string };
  for (let i = 0; i < 100; i += 1) {
    const view = await (await fetch(`${baseUrl}/api/servers/${serverId}/machine-operations/${operationId}`, { headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId } })).json() as { state: string; status?: number; body?: unknown };
    if (view.state === "done") return { status: view.status!, body: view.body };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("operation never finished");
}

test("a read that spent the 5-hour reset: a later 5-hour use with a new key is nothing_to_reset and never reaches the Computer, sync and respondAsync", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-guard");
  await runtimeAccountUsageCacheService.write(machine.id, claudeUsage("limit_reached"));
  const fake = fakeOrchestrator({ read: async () => LEGACY_READ_SPENT });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  // The read finishes as a machine operation (mobile 1.26 and the current web send respondAsync).
  const read = await operationAnswer(app.baseUrl, server.id, tokens.attacher, await api.read(tokens.attacher, { consent: true, respondAsync: true }));
  assert.equal((read.body as { result: { fiveHourSpent?: boolean } }).result.fiveHourSpent, true);

  const asyncUse = await operationAnswer(app.baseUrl, server.id, tokens.attacher, await api.redeem(tokens.attacher, { idempotencyKey: NEW_KEY, kind: "five_hour", respondAsync: true }));
  assert.deepEqual(asyncUse, { status: 200, body: { result: { kind: "nothing_to_reset" }, snapshot: null } });
  const syncUse = await api.redeem(tokens.owner, { idempotencyKey: KEY, kind: "five_hour" });
  assert.equal(syncUse.status, 200);
  assert.deepEqual(await syncUse.json(), { result: { kind: "nothing_to_reset" }, snapshot: null });
  assert.equal(fake.redeems.length, 0, "the Computer is never asked");

  // Other kinds are forwarded as before.
  assert.deepEqual(await (await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "weekly" })).json(), { result: { kind: "reset" }, snapshot: null });
  assert.deepEqual(fake.redeems.map((redeem) => redeem.kind), ["weekly"]);
});

test("the read-spent record is per Claude account and needs fiveHourSpent; a refreshed usage clear of the limit or its TTL ends it", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("clr-guard-scope");
  const api = routes(app.baseUrl, server.id, machine.id);
  const accountA = "a".repeat(64);
  const accountB = "b".repeat(64);

  // A read that spent nothing: no record.
  await runtimeAccountUsageCacheService.write(machine.id, claudeUsageOf(accountA, "limit_reached"));
  const plain = fakeOrchestrator({ read: async () => ({ ...LEGACY_READ_SPENT, result: { kind: "read", program: "legacy", resets: [{ kind: "five_hour", state: "available" }] } }) });
  app.app.set("agentOrchestrator", plain.orchestrator);
  assert.equal((await api.read(tokens.attacher, { consent: true })).status, 200);
  await api.redeem(tokens.attacher, { idempotencyKey: KEY, kind: "five_hour" });
  assert.equal(plain.redeems.length, 1, "no fiveHourSpent: forwarded");

  // Spent by a read on account A; another account now signed in on the same Computer is forwarded.
  const fake = fakeOrchestrator({ read: async () => LEGACY_READ_SPENT });
  app.app.set("agentOrchestrator", fake.orchestrator);
  await api.read(tokens.attacher, { consent: true });
  await api.redeem(tokens.attacher, { idempotencyKey: NEW_KEY, kind: "five_hour" });
  assert.equal(fake.redeems.length, 0);
  await runtimeAccountUsageCacheService.write(machine.id, claudeUsageOf(accountB, "limit_reached"));
  await api.redeem(tokens.attacher, { idempotencyKey: NEW_KEY, kind: "five_hour" });
  assert.equal(fake.redeems.length, 1, "account B is not the account whose reset the read spent");

  // Back on A: still guarded, also once a refresh lands showing A clear of the 5-hour limit, which is
  // exactly what the read's spend makes it show while a card may still offer the use (Tenny, #115).
  await runtimeAccountUsageCacheService.write(machine.id, claudeUsageOf(accountA, "limit_reached"));
  await api.redeem(tokens.attacher, { idempotencyKey: NEW_KEY, kind: "five_hour" });
  assert.equal(fake.redeems.length, 1);
  // A usage snapshot through the orchestrator's cache boundary (as the Computer's refresh lands).
  const { AgentOrchestrator } = await import("../services/agentOrchestrator");
  const writeSnapshot = (AgentOrchestrator.prototype as unknown as { writeRuntimeAccountUsageSnapshot(machineId: string, snapshot: unknown): Promise<void> }).writeRuntimeAccountUsageSnapshot;
  await writeSnapshot.call({}, machine.id, claudeUsageOf(accountA, "ok"));
  await api.redeem(tokens.attacher, { idempotencyKey: NEW_KEY, kind: "five_hour" });
  assert.equal(fake.redeems.length, 1, "a refresh showing the limit cleared does not end the record");
  const realNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + (CLAUDE_LIMIT_RESET_READ_SPENT_TTL_SECONDS + 1) * 1_000);
  try {
    // Without Redis the record lives in this process's map, which expires by the clock.
    assert.equal(await claudeLimitResetReadSpentGuard.readSpent(machine.id), false);
  } finally {
    clock.mockRestore();
  }
  assert.equal(await claudeLimitResetReadSpentGuard.readSpent(machine.id), false, "the expired record was dropped");
  await api.redeem(tokens.attacher, { idempotencyKey: NEW_KEY, kind: "five_hour" });
  assert.equal(fake.redeems.length, 2, "forwarded after the TTL");
});
