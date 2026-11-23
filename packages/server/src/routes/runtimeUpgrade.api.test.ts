import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { RUNTIME_UPGRADE_FEATURE_FLAG_KEY, type RuntimeAuthRuntime, type RuntimeUpgradeResult } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { computers, featureFlagRules, featureFlags, machines, serverMembers, servers as serversTable, users } from "../db/schema";
import { createServer } from "../services/serverService";
import * as channelService from "../services/channelService";
import { runtimeAuthService } from "../services/runtimeAuthService";
import { RouteFailureError } from "../tracing/routeFailure";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

// Upgrade on the web (docs/contracts/runtime-auth.md, "Upgrade"): behind
// runtime_upgrade_button, the same people as a sign-in (the attaching human or
// a server owner/admin), only on a Computer whose daemon runs a runtime's
// updater; the outcome comes back as the Computer answered it, and the card's
// view says when Upgrade is offered.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedComputer(slug: string, options: { flag?: boolean } = {}) {
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
  const guest = await seed(`guest-${slug}@slock.test`);
  const server = await createServer(`Runtime upgrade ${slug}`, slug, owner.id);
  await db.update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  const channel = await channelService.createChannel(server.id, `rtu-${randomUUID().slice(0, 6)}`);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: attacher.id, role: "member" },
    { serverId: server.id, userId: bystander.id, role: "member" },
    { serverId: server.id, userId: guest.id, role: "guest", guestChannelId: channel.id },
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
    attachedByUserId: attacher.id,
  });
  if (options.flag !== false) {
    await db.insert(featureFlags)
      .values({ key: RUNTIME_UPGRADE_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
      .onConflictDoNothing();
    await db.insert(featureFlagRules).values({
      id: randomUUID(),
      flagKey: RUNTIME_UPGRADE_FEATURE_FLAG_KEY,
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
    guest: await tokenForHuman(guest.email),
  };
  return { server, machine: machine!, tokens };
}

function fakeOrchestrator(options: {
  availability?: "ok" | "computer_offline" | "computer_upgrade_required";
  /** What the Computer answers, as sent (the route checks it). */
  upgrade?: () => Promise<RuntimeUpgradeResult | Record<string, unknown>>;
} = {}) {
  const upgrades: Array<{ machineId: string; runtime: RuntimeAuthRuntime }> = [];
  return {
    upgrades,
    orchestrator: {
      runtimeAuthAvailability: async () => ({ state: "ok", connectionEpochId: null, runtimes: ["claude", "codex"], logoutRuntimes: ["claude", "codex"] }),
      runtimeUpgradeAvailability: async () => options.availability ?? "ok",
      upgradeRuntime: async (machineId: string, runtime: RuntimeAuthRuntime) => {
        upgrades.push({ machineId, runtime });
        return options.upgrade ? options.upgrade() : { kind: "upgraded", from: "2.0.1", to: "2.0.5" };
      },
    },
  };
}

function routes(baseUrl: string, serverId: string, machineId: string) {
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });
  const base = `${baseUrl}/api/servers/${serverId}/machines/${machineId}`;
  return {
    upgrade: (token: string, runtime = "claude", body: unknown = {}) =>
      fetch(`${base}/runtimes/${runtime}/upgrade`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }),
    view: (token: string) => fetch(`${base}/runtime-auth`, { headers: headers(token) }),
  };
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

test("runtime_upgrade_button off: no Upgrade in the view, and the route refuses before reaching the Computer", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rtu-off", { flag: false });
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const view = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal("runtimeUpgrade" in view, false);
  const refused = await api.upgrade(tokens.attacher);
  assert.equal(refused.status, 404);
  assert.equal(await codeOf(refused), "runtime_upgrade_disabled");
  assert.equal(fake.upgrades.length, 0);
});

test("the attaching human, an owner and an admin may upgrade; a plain member and a guest are refused; the outcome is the Computer's", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rtu-who");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  assert.equal((await api.upgrade(tokens.bystander)).status, 403, "a plain member who did not connect it");
  assert.equal((await api.view(tokens.bystander)).status, 403, "and sees none of its runtime accounts");
  const guest = await api.upgrade(tokens.guest);
  assert.ok(guest.status === 403 || guest.status === 404, `a guest is refused (${guest.status})`);
  assert.equal((await api.upgrade(tokens.attacher, "not-a-runtime")).status, 404);
  assert.equal(fake.upgrades.length, 0);

  const ok = await api.upgrade(tokens.attacher);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await ok.json(), { result: { kind: "upgraded", from: "2.0.1", to: "2.0.5" } });
  assert.equal((await api.upgrade(tokens.owner, "codex")).status, 200);
  assert.equal((await api.upgrade(tokens.admin, "grok")).status, 200, "an admin who is not the owner");
  assert.deepEqual(fake.upgrades.map((call) => call.runtime), ["claude", "codex", "grok"]);
  assert.ok(fake.upgrades.every((call) => call.machineId === machine.id));
});

test("the read offers Upgrade with the runtimes the Computer reported upgradable", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rtu-list");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const before = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal(before.runtimeUpgrade, true);
  assert.deepEqual(before.upgradableRuntimes, [], "nothing until the Computer says");

  await runtimeAuthService.recordUpgradable(machine.id, ["claude", "grok"]);
  const after = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.deepEqual(after.upgradableRuntimes, ["claude", "grok"]);
  assert.deepEqual(after.runtimeUpdates, {}, "no update checks until the Computer reports them");
});

test("the read carries the Computer's update checks for the runtimes Upgrade is offered for, and only theirs", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rtu-updates");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  const checkedAt = "2026-11-18T10:00:00.000Z";

  await runtimeAuthService.recordUpgradable(machine.id, ["claude", "grok"]);
  await runtimeAuthService.recordUpdates(machine.id, {
    claude: { kind: "ok", installed: "2.0.5", latest: "2.0.5", updateAvailable: false, checkedAt },
    grok: { kind: "unavailable", reason: "lookup_failed", checkedAt },
    // Not upgradable here (any more): not sent.
    codex: { kind: "ok", installed: "0.1.0", latest: "0.2.0", updateAvailable: true, checkedAt },
  });
  const view = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.deepEqual(view.runtimeUpdates, {
    claude: { kind: "ok", installed: "2.0.5", latest: "2.0.5", updateAvailable: false, checkedAt },
    grok: { kind: "unavailable", reason: "lookup_failed", checkedAt },
  });

  const offline = fakeOrchestrator({ availability: "computer_offline" });
  app.app.set("agentOrchestrator", offline.orchestrator);
  const none = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal("runtimeUpdates" in none, false, "no Upgrade offered: no update checks either");
});

test("an answer the server cannot read is an internal error, and nothing of it is passed on", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rtu-bad");
  const fake = fakeOrchestrator({ upgrade: async () => ({ kind: "upgraded", from: "/home/someone/.local/bin/claude", output: "token=abc123" }) });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const answer = await api.upgrade(tokens.attacher);
  assert.equal(answer.status, 200);
  const text = await answer.text();
  assert.deepEqual(JSON.parse(text), { result: { kind: "error", code: "internal" } });
  assert.ok(!text.includes("token=abc123") && !text.includes("/home/someone"));
});

test("upgrades are rate limited per person and Computer", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rtu-rate");
  const fake = fakeOrchestrator({ upgrade: async () => ({ kind: "current", version: "2.0.5" }) });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await api.upgrade(tokens.attacher)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(fake.upgrades.length, 5);
});

test("a Computer without the capability, or offline, answers 409 without a wait; a lost answer is 504", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rtu-avail");
  const api = routes(app.baseUrl, server.id, machine.id);

  const old = fakeOrchestrator({ availability: "computer_upgrade_required" });
  app.app.set("agentOrchestrator", old.orchestrator);
  const tooOld = await api.upgrade(tokens.attacher);
  assert.equal(tooOld.status, 409);
  assert.equal(await codeOf(tooOld), "computer_upgrade_required");
  const view = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal("runtimeUpgrade" in view, false, "no button on a Computer that would drop the request");

  const offline = fakeOrchestrator({ availability: "computer_offline" });
  app.app.set("agentOrchestrator", offline.orchestrator);
  assert.equal(await codeOf(await api.upgrade(tokens.attacher)), "computer_offline");
  assert.deepEqual([...old.upgrades, ...offline.upgrades], []);

  const late = fakeOrchestrator({ upgrade: async () => { throw new RouteFailureError("daemon_timeout", "late"); } });
  app.app.set("agentOrchestrator", late.orchestrator);
  const timedOut = await api.upgrade(tokens.attacher);
  assert.equal(timedOut.status, 504);
  assert.equal(await codeOf(timedOut), "computer_timeout");
});

test("respondAsync: 202 with an operation id, then the Computer's answer from the operation read", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rtu-async");
  const fake = fakeOrchestrator({ upgrade: async () => ({ kind: "unsupported", reason: "requires_terminal" }) });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const started = await api.upgrade(tokens.attacher, "claude", { respondAsync: true });
  assert.equal(started.status, 202);
  const { operationId } = await started.json() as { operationId: string };
  const headers = { Authorization: `Bearer ${tokens.attacher}`, "X-Server-Id": server.id };
  let view: { state: string; status?: number; body?: unknown } = { state: "pending" };
  for (let attempt = 0; attempt < 50 && view.state !== "done"; attempt += 1) {
    view = await (await fetch(`${app.baseUrl}/api/servers/${server.id}/machine-operations/${operationId}`, { headers })).json() as typeof view;
    if (view.state !== "done") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(view, { state: "done", status: 200, body: { result: { kind: "unsupported", reason: "requires_terminal" } } });
});
