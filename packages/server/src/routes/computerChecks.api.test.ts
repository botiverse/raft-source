import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import { getDb } from "../db/index";
import { computers, machines, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { computerChecksCacheService } from "../services/computerChecksCacheService";
import { actorRoleHasServerCapability } from "../lib/actorPermissions";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

// "On this computer" checks (docs/contracts/computer-checks.md), the routes:
// only the person who connected the Computer and holders of editMachines (the
// runtime-account rule) see a report or may ask for one; anyone else gets
// `not_visible` and the Computer is asked nothing. A refresh goes at most
// once per Computer in 30 s (later ones get the stale answer, `refreshing`);
// an older Computer is `unsupported`; the flag off is 404. A fake token in a
// report never comes back out.
// RED proofs: answer the read before canSeeComputerRuntimeAccounts and the
// bystander gets the report; drop tryClaimRefresh and the second refresh is
// sent; drop the server-side scrub and the token is in the answer.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const FAKE_TOKEN = `ghp_${"Q".repeat(36)}`;

async function seedComputer(slug: string) {
  const db = getDb();
  const seed = async (name: string) => {
    const [row] = await db.insert(users).values({
      email: `${name}-${slug}@slock.test`,
      name: `${name}${slug.replace(/[^a-z0-9]/g, "")}`,
      displayName: name,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    return row!;
  };
  const owner = await seed("owner");
  const admin = await seed("admin");
  const attacher = await seed("attacher");
  const bystander = await seed("bystander");
  const outsider = await seed("outsider");
  const server = await createServer(`Checks ${slug}`, slug, owner.id);
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
    runtimes: ["claude"],
  }).returning();
  await db.insert(computers).values({
    serverId: server.id,
    machineId: machine!.id,
    name: `${slug}-computer`,
    apiKeyHash: `unused-${slug}-computer-hash`,
    apiKeyPrefix: `sk_computer_${slug.slice(0, 8)}`,
    attachedByUserId: attacher.id,
  });
  const tokens = {
    owner: await tokenForHuman(owner.email),
    admin: await tokenForHuman(admin.email),
    attacher: await tokenForHuman(attacher.email),
    bystander: await tokenForHuman(bystander.email),
    outsider: await tokenForHuman(outsider.email),
  };
  return { server, machine: machine!, tokens };
}

function fakeOrchestrator(options: { enabled?: boolean; availability?: "ok" | "computer_offline" | "unsupported"; sent?: boolean } = {}) {
  const refreshes: Array<{ machineId: string; serverId: string }> = [];
  return {
    refreshes,
    orchestrator: {
      computerChecksEnabledFor: async () => (options.enabled === false ? null : { github: true, node: true }),
      computerChecksAvailability: async () => options.availability ?? "ok",
      requestComputerChecksRefresh: async (machineId: string, serverId: string) => {
        refreshes.push({ machineId, serverId });
        return options.sent ?? true;
      },
    },
  };
}

function routes(baseUrl: string, serverId: string, machineId: string) {
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });
  const base = `${baseUrl}/api/servers/${serverId}/machines/${machineId}/computer-checks`;
  return {
    read: (token: string) => fetch(base, { headers: headers(token) }),
    refresh: (token: string) => fetch(`${base}/refresh`, { method: "POST", headers: headers(token), body: "{}" }),
  };
}

const report = (value = "2.60.0") => ({
  schemaVersion: 1,
  checkedAt: "2026-11-19T10:00:00.000Z",
  plugins: [{ id: "github", items: [{ key: "gh.version", label: "GitHub CLI", value, status: "ok" }, { key: "git.name", label: "Git name", value: "<img src=x onerror=alert(1)>", displayText: true, status: "local" }], durationMs: 3 }],
});

test("who sees it: the attacher, an owner and an admin; a member gets not_visible and the Computer is asked nothing; a non-member is refused and another server's Computer is 404", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("cc-who");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  await computerChecksCacheService.write(machine.id, report());

  const hidden = await api.read(tokens.bystander);
  assert.equal(hidden.status, 200);
  assert.equal(hidden.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await hidden.json(), { status: "not_visible" });
  const refused = await api.refresh(tokens.bystander);
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { code: string }).code, "computer_checks_not_visible");
  assert.deepEqual(fake.refreshes, [], "a member's visit asks nothing of the Computer");

  for (const token of [tokens.attacher, tokens.owner, tokens.admin]) {
    const body = await (await api.read(token)).json() as { status: string; report: { plugins: Array<{ items: Array<{ value?: string; displayText?: boolean }> }> }; fresh: boolean };
    assert.equal(body.status, "known");
    assert.equal(body.fresh, true);
    // Machine-reported text is kept as plain data, not interpreted or dropped.
    assert.deepEqual(body.report.plugins[0]!.items[1], { key: "git.name", label: "Git name", value: "<img src=x onerror=alert(1)>", displayText: true, status: "local" });
  }
  assert.deepEqual(fake.refreshes, [], "a fresh report asks nothing");

  const outsider = await api.read(tokens.outsider);
  assert.ok(outsider.status === 403 || outsider.status === 404, `a non-member is refused (${outsider.status})`);
  assert.ok(!(await outsider.text()).includes("GitHub CLI"));
  const other = await seedComputer("cc-who-other");
  assert.equal((await routes(app.baseUrl, server.id, other.machine.id).read(tokens.owner)).status, 404);
  assert.equal((await routes(app.baseUrl, server.id, randomUUID()).read(tokens.owner)).status, 404);
});

test("flag off: both routes are 404 computer_checks_disabled", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("cc-off");
  const fake = fakeOrchestrator({ enabled: false });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  for (const res of [await api.read(tokens.attacher), await api.refresh(tokens.attacher)]) {
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "computer_checks_disabled");
  }
  assert.deepEqual(fake.refreshes, []);
});

test("an older Computer is unsupported and is asked nothing", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("cc-old");
  const fake = fakeOrchestrator({ availability: "unsupported" });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  assert.deepEqual(await (await api.read(tokens.attacher)).json(), { status: "unsupported" });
  assert.deepEqual(await (await api.refresh(tokens.attacher)).json(), { status: "unsupported" });
  assert.deepEqual(fake.refreshes, []);
});

test("refresh: once per Computer in 30 s; meanwhile the stale answer with refreshing; a read with no report asks too, within the same limit", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("cc-rate");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  assert.deepEqual(await (await api.read(tokens.attacher)).json(), { status: "unknown", refreshing: true });
  assert.equal(fake.refreshes.length, 1, "no report yet: the read asked");
  assert.deepEqual(await (await api.refresh(tokens.admin)).json(), { status: "unknown", refreshing: true });
  assert.equal(fake.refreshes.length, 1, "within 30 s: not asked again");

  // The Computer answers; within the same 30 s a refresh gets that answer, not a new round.
  await computerChecksCacheService.write(machine.id, report());
  const answered = await (await api.refresh(tokens.attacher)).json() as { status: string; refreshing: boolean };
  assert.equal(answered.status, "known");
  assert.equal(answered.refreshing, false);
  assert.equal(fake.refreshes.length, 1);
  assert.deepEqual(fake.refreshes[0], { machineId: machine.id, serverId: server.id });
});

test("a fake token in a report never comes back out of the server, nor reaches its logs", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("cc-token");
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  const logs: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
  try {
    assert.ok(await computerChecksCacheService.write(machine.id, report(`2.60.0 ${FAKE_TOKEN}`)));
    const body = await (await routes(app.baseUrl, server.id, machine.id).read(tokens.attacher)).text();
    assert.ok(body.includes("2.60.0"));
    assert.ok(!body.includes(FAKE_TOKEN));
    assert.ok(!JSON.stringify(await computerChecksCacheService.read(machine.id)).includes(FAKE_TOKEN));
    assert.ok(!logs.join("\n").includes(FAKE_TOKEN));
  } finally {
    vi.restoreAllMocks();
  }
});

test("roles: a non-attacher sees it exactly when the role holds editMachines (roles are fixed; owner and admin today)", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("cc-roles");
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  await computerChecksCacheService.write(machine.id, report());
  for (const [role, token] of [["owner", tokens.owner], ["admin", tokens.admin], ["member", tokens.bystander]] as const) {
    const body = await (await api.read(token)).json() as { status: string };
    assert.equal(body.status !== "not_visible", actorRoleHasServerCapability(role, "editMachines"), role);
  }
});

test("a refresh that could not be sent gives its 30 s claim back: the next visit asks again", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("cc-unsent");
  const unsent = fakeOrchestrator({ sent: false });
  app.app.set("agentOrchestrator", unsent.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  assert.deepEqual(await (await api.refresh(tokens.attacher)).json(), { status: "unknown", refreshing: false });
  assert.deepEqual(await (await api.refresh(tokens.attacher)).json(), { status: "unknown", refreshing: false });
  assert.equal(unsent.refreshes.length, 2, "not held back by a claim whose refresh never went out");

  const sending = fakeOrchestrator();
  app.app.set("agentOrchestrator", sending.orchestrator);
  assert.deepEqual(await (await api.refresh(tokens.attacher)).json(), { status: "unknown", refreshing: true });
  await api.refresh(tokens.attacher);
  assert.equal(sending.refreshes.length, 1);
});
