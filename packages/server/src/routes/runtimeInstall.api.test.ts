import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { RUNTIME_INSTALL_FEATURE_FLAG_KEY, type RuntimeAuthRuntime, type RuntimeInstallPlan, type RuntimeInstallResult } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { computers, featureFlagRules, featureFlags, integrationAuditEvents, machines, serverMembers, servers as serversTable, users } from "../db/schema";
import { createServer } from "../services/serverService";
import * as channelService from "../services/channelService";
import { runtimeAuthService } from "../services/runtimeAuthService";
import { RouteFailureError } from "../tracing/routeFailure";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

// Install on the web (docs/contracts/runtime-auth.md §6e): behind
// runtime_install_button, exactly the people who may Upgrade (the attaching
// human or a server owner/admin: `resolveActors(...).canAct`), only on a
// Computer whose daemon runs a runtime's installer. The request names the
// runtime only; the plan and the outcome come back as the Computer answered
// them, checked; each install attempt is recorded (`computer.runtime_install`).

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
  const server = await createServer(`Runtime install ${slug}`, slug, owner.id);
  await db.update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  const channel = await channelService.createChannel(server.id, `rti-${randomUUID().slice(0, 6)}`);
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
      .values({ key: RUNTIME_INSTALL_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
      .onConflictDoNothing();
    await db.insert(featureFlagRules).values({
      id: randomUUID(),
      flagKey: RUNTIME_INSTALL_FEATURE_FLAG_KEY,
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
  return { server, machine: machine!, users: { owner, admin, attacher }, tokens };
}

const PLAN: RuntimeInstallPlan = {
  kind: "plan",
  steps: ["curl -fsSL https://x.ai/cli/install.sh | bash"],
  source: "https://docs.x.ai/docs/grok-build",
};

function fakeOrchestrator(options: {
  availability?: "ok" | "computer_offline" | "computer_upgrade_required";
  /** What the Computer answers, as sent (the route checks it). */
  plan?: () => Promise<RuntimeInstallPlan | Record<string, unknown>>;
  install?: () => Promise<RuntimeInstallResult | Record<string, unknown>>;
} = {}) {
  const plans: Array<{ machineId: string; runtime: RuntimeAuthRuntime }> = [];
  const installs: Array<{ machineId: string; runtime: RuntimeAuthRuntime }> = [];
  return {
    plans,
    installs,
    orchestrator: {
      runtimeAuthAvailability: async () => ({ state: "ok", connectionEpochId: null, runtimes: ["claude", "codex"], logoutRuntimes: ["claude", "codex"] }),
      runtimeUpgradeAvailability: async () => "computer_upgrade_required",
      runtimeInstallAvailability: async () => options.availability ?? "ok",
      runtimeInstallPlan: async (machineId: string, runtime: RuntimeAuthRuntime) => {
        plans.push({ machineId, runtime });
        return options.plan ? options.plan() : PLAN;
      },
      installRuntime: async (machineId: string, runtime: RuntimeAuthRuntime) => {
        installs.push({ machineId, runtime });
        return options.install ? options.install() : { kind: "installed", version: "0.1.9" };
      },
    },
  };
}

function routes(baseUrl: string, serverId: string, machineId: string) {
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });
  const base = `${baseUrl}/api/servers/${serverId}/machines/${machineId}`;
  return {
    plan: (token: string, runtime = "grok", body: unknown = {}) =>
      fetch(`${base}/runtimes/${runtime}/install-plan`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }),
    install: (token: string, runtime = "grok", body: unknown = {}) =>
      fetch(`${base}/runtimes/${runtime}/install`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }),
    view: (token: string) => fetch(`${base}/runtime-auth`, { headers: headers(token) }),
  };
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

async function installRecords(serverId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, "computer.runtime_install")));
}

test("runtime_install_button off: no Install in the view, and both routes answer 404 before reaching the Computer", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rti-off", { flag: false });
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const view = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal("runtimeInstall" in view, false);
  assert.equal("installableRuntimes" in view, false);
  for (const refused of [await api.plan(tokens.attacher), await api.install(tokens.attacher)]) {
    assert.equal(refused.status, 404);
    assert.equal(await codeOf(refused), "runtime_install_disabled");
  }
  assert.deepEqual([...fake.plans, ...fake.installs], []);
  assert.deepEqual(await installRecords(server.id), []);
});

test("the same people as Upgrade: the attaching human, an owner and an admin may; a plain member and a guest are refused", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rti-who");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  assert.equal((await api.plan(tokens.bystander)).status, 403, "a plain member who did not connect it");
  assert.equal((await api.install(tokens.bystander)).status, 403);
  assert.equal((await api.view(tokens.bystander)).status, 403, "and sees none of its runtime accounts");
  for (const guest of [await api.plan(tokens.guest), await api.install(tokens.guest)]) {
    assert.ok(guest.status === 403 || guest.status === 404, `a guest is refused (${guest.status})`);
  }
  assert.equal((await api.install(tokens.attacher, "not-a-runtime")).status, 404);
  assert.deepEqual([...fake.plans, ...fake.installs], []);

  for (const token of [tokens.attacher, tokens.owner, tokens.admin]) {
    assert.equal((await api.plan(token)).status, 200);
    assert.equal((await api.install(token, "qwen")).status, 200);
  }
  assert.equal(fake.plans.length, 3);
  assert.deepEqual(fake.installs.map((call) => call.runtime), ["qwen", "qwen", "qwen"]);
  assert.ok([...fake.plans, ...fake.installs].every((call) => call.machineId === machine.id));
});

test("the plan is relayed as the Computer read it; the body names nothing, only the path's runtime reaches the Computer", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rti-plan");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const answer = await api.plan(tokens.attacher, "grok", { command: "rm -rf /", url: "https://evil.example/install.sh", line: "v1" });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await answer.json(), { plan: PLAN });
  const installed = await api.install(tokens.attacher, "grok", { command: "rm -rf /" });
  assert.deepEqual(await installed.json(), { result: { kind: "installed", version: "0.1.9" } });
  assert.deepEqual(fake.plans, [{ machineId: machine.id, runtime: "grok" }]);
  assert.deepEqual(fake.installs, [{ machineId: machine.id, runtime: "grok" }]);

  const manual = fakeOrchestrator({ plan: async () => ({ kind: "unsupported", reason: "requires_privileges", detail: "Needs sudo.", steps: ["sudo npm i -g x"], source: "https://example.com/docs" }) });
  app.app.set("agentOrchestrator", manual.orchestrator);
  assert.deepEqual(await (await api.plan(tokens.attacher)).json(), {
    plan: { kind: "unsupported", reason: "requires_privileges", detail: "Needs sudo.", steps: ["sudo npm i -g x"], source: "https://example.com/docs" },
  });
});

test("answers the server cannot read are internal errors, and nothing of them is passed on", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rti-bad");
  const fake = fakeOrchestrator({
    plan: async () => ({ kind: "plan", steps: ["x"], source: "javascript:alert(1)" }),
    install: async () => ({ kind: "installed", version: "/home/someone/.local/bin/grok", output: "token=abc123" }),
  });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  assert.deepEqual(await (await api.plan(tokens.attacher)).json(), { plan: { kind: "error", code: "internal" } });
  const text = await (await api.install(tokens.attacher)).text();
  assert.deepEqual(JSON.parse(text), { result: { kind: "error", code: "internal" } });
  assert.ok(!text.includes("token=abc123") && !text.includes("/home/someone"));
});

test("the read offers Install with the runtimes the Computer reported installable, to the people who may act", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rti-list");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const before = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal(before.runtimeInstall, true);
  assert.deepEqual(before.installableRuntimes, [], "nothing until the Computer says");

  await runtimeAuthService.recordInstallable(machine.id, ["grok", "qwen"]);
  for (const token of [tokens.attacher, tokens.owner, tokens.admin]) {
    const after = await (await api.view(token)).json() as Record<string, unknown>;
    assert.deepEqual(after.installableRuntimes, ["grok", "qwen"]);
  }
});

test("a Computer without the capability, or offline, answers 409 without a wait; a lost answer is 504", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rti-avail");
  const api = routes(app.baseUrl, server.id, machine.id);

  const old = fakeOrchestrator({ availability: "computer_upgrade_required" });
  app.app.set("agentOrchestrator", old.orchestrator);
  for (const tooOld of [await api.plan(tokens.attacher), await api.install(tokens.attacher)]) {
    assert.equal(tooOld.status, 409);
    assert.equal(await codeOf(tooOld), "computer_upgrade_required");
  }
  const view = await (await api.view(tokens.attacher)).json() as Record<string, unknown>;
  assert.equal("runtimeInstall" in view, false, "no button on a Computer that would drop the request");

  const offline = fakeOrchestrator({ availability: "computer_offline" });
  app.app.set("agentOrchestrator", offline.orchestrator);
  assert.equal(await codeOf(await api.install(tokens.attacher)), "computer_offline");
  assert.deepEqual([...old.plans, ...old.installs, ...offline.plans, ...offline.installs], []);
  assert.deepEqual(await installRecords(server.id), [], "nothing reached the Computer: no install to record");

  const late = fakeOrchestrator({ install: async () => { throw new RouteFailureError("daemon_timeout", "late"); } });
  app.app.set("agentOrchestrator", late.orchestrator);
  const timedOut = await api.install(tokens.attacher);
  assert.equal(timedOut.status, 504);
  assert.equal(await codeOf(timedOut), "computer_timeout");
});

test("each install attempt is recorded on the Computer: who pressed it, the runtime and how it ended", async ({ app }) => {
  const { server, machine, users: people, tokens } = await seedComputer("rti-audit");
  const api = routes(app.baseUrl, server.id, machine.id);

  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  await api.install(tokens.admin, "grok");
  app.app.set("agentOrchestrator", fakeOrchestrator({ install: async () => ({ kind: "failed", exitCode: 1 }) }).orchestrator);
  await api.install(tokens.attacher, "qwen");
  app.app.set("agentOrchestrator", fakeOrchestrator({ install: async () => { throw new RouteFailureError("daemon_timeout", "late"); } }).orchestrator);
  await api.install(tokens.attacher, "qoder");

  const rows = await installRecords(server.id);
  const byRuntime = new Map(rows.map((row) => [(row.metadata as { runtime: string }).runtime, row]));
  assert.equal(rows.length, 3);
  const grok = byRuntime.get("grok")!;
  assert.equal(grok.actorId, people.admin.id);
  assert.equal(grok.outcome, "success");
  assert.equal(grok.targetType, "machine");
  assert.equal(grok.targetId, machine.id);
  assert.deepEqual(grok.metadata, { machineId: machine.id, machineName: machine.name, runtime: "grok", result: "installed", version: "0.1.9", actorRole: "admin" });
  const qwen = byRuntime.get("qwen")!;
  assert.equal(qwen.actorId, people.attacher.id);
  assert.equal(qwen.outcome, "failure");
  assert.deepEqual(qwen.metadata, { machineId: machine.id, machineName: machine.name, runtime: "qwen", result: "failed", exitCode: 1, actorRole: "member" });
  assert.equal((byRuntime.get("qoder")!.metadata as { result: string }).result, "computer_timeout");
  assert.ok(!JSON.stringify(rows).includes("curl"), "never a command");
});

test("installs are rate limited per person and Computer; plan reads have their own, higher bound", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rti-rate");
  const fake = fakeOrchestrator({ install: async () => ({ kind: "already_installed" }) });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await api.install(tokens.attacher)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(fake.installs.length, 5);
  assert.equal((await api.plan(tokens.attacher)).status, 200, "the plan is counted apart");
});

test("respondAsync: 202 with an operation id, then the Computer's answer from the operation read", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("rti-async");
  const fake = fakeOrchestrator({ install: async () => ({ kind: "unsupported", reason: "requires_privileges" }) });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const started = await api.install(tokens.attacher, "grok", { respondAsync: true });
  assert.equal(started.status, 202);
  const { operationId } = await started.json() as { operationId: string };
  const headers = { Authorization: `Bearer ${tokens.attacher}`, "X-Server-Id": server.id };
  let view: { state: string; status?: number; body?: unknown } = { state: "pending" };
  for (let attempt = 0; attempt < 50 && view.state !== "done"; attempt += 1) {
    view = await (await fetch(`${app.baseUrl}/api/servers/${server.id}/machine-operations/${operationId}`, { headers })).json() as typeof view;
    if (view.state !== "done") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(view, { state: "done", status: 200, body: { result: { kind: "unsupported", reason: "requires_privileges" } } });
});
