import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { RAFT_CLIENT_CAPABILITIES_HEADER, RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider, RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { computers, machines, serverMembers, servers as serversTable, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { RouteFailureError } from "../tracing/routeFailure";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/** Every trace event any module adds while these tests run (the real one still runs). */
const tracedEvents = vi.hoisted(() => [] as Array<{ name: string; attrs: unknown }>);
vi.mock("../tracing/semanticTrace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tracing/semanticTrace")>();
  return {
    ...actual,
    addTraceEvent: (name: string, attrs?: Parameters<typeof actual.addTraceEvent>[1]) => {
      tracedEvents.push({ name, attrs });
      actual.addTraceEvent(name, attrs);
    },
  };
});

const KEY = "0f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f";

async function seedComputer(slug: string, options: { attached?: boolean } = {}) {
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
  const server = await createServer(`Reset ${slug}`, slug, owner.id);
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
    runtimes: ["codex"],
  }).returning();
  await db.insert(computers).values({
    serverId: server.id,
    machineId: machine!.id,
    name: `${slug}-computer`,
    apiKeyHash: `unused-${slug}-computer-hash`,
    apiKeyPrefix: `sk_computer_${slug.slice(0, 8)}`,
    attachedByUserId: options.attached === false ? null : attacher.id,
  });
  const tokens = {
    owner: await tokenForHuman(owner.email),
    admin: await tokenForHuman(admin.email),
    attacher: await tokenForHuman(attacher.email),
    bystander: await tokenForHuman(bystander.email),
  };
  return { server, machine: machine!, tokens, attacher };
}

function snapshot(resets: number): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-11-07T10:00:00.000Z",
    staleAfter: "2026-11-07T10:30:00.000Z",
    collectorVersion: "test",
    accounts: [{ accountKey: "a".repeat(64), maskedLabel: "tea****r@example.com", health: "ok", limitResetsAvailable: resets, windows: [] }],
  };
}

type Redeem = { machineId: string; provider: RuntimeAccountUsageProvider; idempotencyKey: string };

function fakeOrchestrator(options: {
  availability?: "ok" | "computer_offline" | "computer_upgrade_required";
  redeem?: (call: Redeem) => Promise<unknown>;
} = {}) {
  const redeems: Redeem[] = [];
  return {
    redeems,
    orchestrator: {
      runtimeLimitResetAvailability: async () => options.availability ?? "ok",
      redeemRuntimeLimitReset: async (machineId: string, provider: RuntimeAccountUsageProvider, idempotencyKey: string) => {
        const call = { machineId, provider, idempotencyKey };
        redeems.push(call);
        if (options.redeem) return options.redeem(call);
        return { type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result: { kind: "reset" }, snapshot: snapshot(1) };
      },
    },
  };
}

function api(baseUrl: string, serverId: string, machineId: string) {
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });
  return (token: string, body: unknown = { idempotencyKey: KEY }, provider = "codex") =>
    fetch(`${baseUrl}/api/servers/${serverId}/machines/${machineId}/runtime-account-usage/${provider}/limit-reset`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    });
}

test("limit reset: only the attacher and server owners/admins may use one; the key goes through unchanged", async ({ app }) => {
  tracedEvents.length = 0;
  const { server, machine, tokens, attacher } = await seedComputer("limreset-who");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const redeem = api(app.baseUrl, server.id, machine.id);

  const refused = await redeem(tokens.bystander);
  assert.equal(refused.status, 403, "an ordinary member cannot spend the account's reset");
  assert.equal(fake.redeems.length, 0, "nothing reaches the Computer for a refused person");
  assert.equal((await redeem(tokens.attacher, {}, "nope")).status, 404, "an unknown provider");
  assert.equal((await redeem(tokens.attacher, { idempotencyKey: "short" })).status, 400, "a malformed key");
  assert.equal((await redeem(tokens.attacher, {})).status, 400, "no key");
  assert.equal(fake.redeems.length, 0);

  const ok = await redeem(tokens.attacher);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await ok.json(), { result: { kind: "reset" }, snapshot: snapshot(1) });
  assert.deepEqual(fake.redeems, [{ machineId: machine.id, provider: "codex", idempotencyKey: KEY }]);

  assert.equal((await redeem(tokens.owner)).status, 200, "the server owner may");
  assert.equal((await redeem(tokens.admin)).status, 200, "an admin may");
  assert.deepEqual(fake.redeems.map((call) => call.idempotencyKey), [KEY, KEY, KEY], "the same key on every retry");

  const traced = tracedEvents.filter((event) => event.name === "runtime_account_usage.limit_reset.result");
  assert.equal(traced.length, 3);
  assert.deepEqual(traced[0]!.attrs, { machine_id: machine.id, provider: "codex", user_id: attacher.id, outcome: "reset", snapshot: "fresh" });
  assert.ok(!JSON.stringify(traced).includes(KEY), "the key is never traced");
});

test("limit reset: offline, old or unattached Computers are refused; outcomes and timeouts are relayed", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("limreset-avail");
  const redeem = api(app.baseUrl, server.id, machine.id);

  app.app.set("agentOrchestrator", fakeOrchestrator({ availability: "computer_offline" }).orchestrator);
  const offline = await redeem(tokens.attacher);
  assert.equal(offline.status, 409);
  assert.equal((await offline.json() as { code: string }).code, "computer_offline");

  const old = fakeOrchestrator({ availability: "computer_upgrade_required" });
  app.app.set("agentOrchestrator", old.orchestrator);
  const upgrade = await redeem(tokens.attacher);
  assert.equal(upgrade.status, 409);
  assert.equal((await upgrade.json() as { code: string }).code, "computer_upgrade_required");
  assert.equal(old.redeems.length, 0, "an old Computer is never sent a redeem");

  app.app.set("agentOrchestrator", fakeOrchestrator({
    redeem: async () => ({ type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result: { kind: "nothing_to_reset" } }),
  }).orchestrator);
  assert.deepEqual(await (await redeem(tokens.owner)).json(), { result: { kind: "nothing_to_reset" }, snapshot: null });

  app.app.set("agentOrchestrator", fakeOrchestrator({
    redeem: async () => ({ type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result: { kind: "something_new" }, snapshot: { broken: true } }),
  }).orchestrator);
  assert.deepEqual(await (await redeem(tokens.owner)).json(), { result: { kind: "unknown" }, snapshot: null }, "an unreadable answer is unknown, never success");

  app.app.set("agentOrchestrator", fakeOrchestrator({ redeem: async () => { throw new RouteFailureError("daemon_timeout", "timed out"); } }).orchestrator);
  const timeout = await redeem(tokens.owner);
  assert.equal(timeout.status, 504);
  assert.equal((await timeout.json() as { code: string }).code, "computer_timeout");

  app.app.set("agentOrchestrator", fakeOrchestrator({ redeem: async () => { throw new RouteFailureError("daemon_offline", "gone"); } }).orchestrator);
  const gone = await redeem(tokens.owner);
  assert.equal(gone.status, 409);
  assert.equal((await gone.json() as { code: string }).code, "computer_offline");

  const unattached = await seedComputer("limreset-noattach", { attached: false });
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const noOwner = await api(app.baseUrl, unattached.server.id, unattached.machine.id)(unattached.tokens.owner);
  assert.equal(noOwner.status, 409);
  assert.equal((await noOwner.json() as { code: string }).code, "computer_not_attached");
  assert.equal(fake.redeems.length, 0);
});

test("limit reset: the usage read after it carries window scopes only to a client that declares it reads them", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("limreset-scope");
  const scoped: RuntimeAccountUsageSnapshot = {
    ...snapshot(1),
    accounts: [{
      ...snapshot(1).accounts[0]!,
      windows: [{ id: "w0_aaaaaaaaaaaa", label: "1 week", status: "ok", usedRatio: 0.3, scope: { kind: "model", name: "GPT-5.3-Codex-Spark" } }],
    }],
  };
  app.app.set("agentOrchestrator", fakeOrchestrator({
    redeem: async () => ({ type: "machine:runtime_account_usage:limit_reset:result", requestId: "r", result: { kind: "reset" }, snapshot: scoped }),
  }).orchestrator);
  const url = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-account-usage/codex/limit-reset`;
  const headers = { Authorization: `Bearer ${tokens.attacher}`, "X-Server-Id": server.id, "Content-Type": "application/json" };

  // An older web bundle: its strict parse would drop a snapshot with a key it does not know.
  const plain = await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: KEY }) })).json() as { snapshot: RuntimeAccountUsageSnapshot };
  assert.equal("scope" in plain.snapshot.accounts[0]!.windows[0]!, false);

  const capable = await (await fetch(url, {
    method: "POST",
    headers: { ...headers, [RAFT_CLIENT_CAPABILITIES_HEADER]: RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY },
    body: JSON.stringify({ idempotencyKey: KEY }),
  })).json() as { snapshot: RuntimeAccountUsageSnapshot };
  assert.deepEqual(capable.snapshot.accounts[0]!.windows[0]!.scope, { kind: "model", name: "GPT-5.3-Codex-Spark" });
});
