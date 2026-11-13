import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  RUNTIME_AUTH_RUNTIMES,
  RUNTIME_AUTH_V1_RUNTIMES,
  RUNTIME_AUTH_V2_RUNTIMES,
  asRuntimeAuthLoginId,
  runtimeAuthSupports,
  type RuntimeAuthProviderConnectInput,
  type RuntimeAuthRuntime,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { computers, featureFlagRules, featureFlags, machines, serverMembers, servers as serversTable, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { __clearRuntimeAuthLocalStoreForTests, __runtimeAuthLocalStoreEntriesForTests, runtimeAuthService } from "../services/runtimeAuthService";
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

const PASTED_CODE = "pasted-one-time-code#state-0123456789";

async function seedComputer(slug: string) {
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
  const server = await createServer(`Auth ${slug}`, slug, owner.id);
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
    attachedByUserId: attacher.id,
  });
  const tokens = {
    owner: await tokenForHuman(owner.email),
    admin: await tokenForHuman(admin.email),
    attacher: await tokenForHuman(attacher.email),
    bystander: await tokenForHuman(bystander.email),
  };
  return { server, machine: machine!, tokens };
}

type Command = { machineId: string; message: { type: string; loginId?: string; code?: string; runtime?: string; region?: string; providerId?: string; oauthMethod?: string } };

function fakeOrchestrator(options: {
  availability?: "ok" | "computer_offline" | "computer_upgrade_required";
  /** The runtimes the Computer signs in (its capabilities); every one by default. */
  runtimes?: readonly RuntimeAuthRuntime[];
  /** The ones it signs out; by default every one of `runtimes` that has a logout. */
  logoutRuntimes?: readonly RuntimeAuthRuntime[];
  logout?: (machineId: string, runtime: string, providerId?: string) => Promise<unknown>;
  sendFails?: boolean;
  providers?: () => Promise<unknown>;
  connect?: (input: RuntimeAuthProviderConnectInput) => Promise<unknown>;
} = {}) {
  const commands: Command[] = [];
  const connects: Array<{ machineId: string; runtime: string; input: RuntimeAuthProviderConnectInput }> = [];
  return {
    commands,
    connects,
    orchestrator: {
      runtimeAuthAvailability: async () => options.availability && options.availability !== "ok"
        ? { state: options.availability }
        : {
          state: "ok",
          connectionEpochId: "epoch-1",
          runtimes: options.runtimes ?? RUNTIME_AUTH_RUNTIMES,
          logoutRuntimes: options.logoutRuntimes ?? (options.runtimes ?? RUNTIME_AUTH_RUNTIMES).filter((runtime) => runtimeAuthSupports(runtime, "logout")),
        },
      // Async like the real one: a send to an unreachable Computer rejects.
      sendRuntimeAuthCommand: async (machineId: string, message: Command["message"]) => {
        if (options.sendFails) throw new RouteFailureError("daemon_offline", "unreachable");
        commands.push({ machineId, message });
      },
      logoutRuntime: options.logout ?? (async () => ({ kind: "logged_out" })),
      listRuntimeProviders: options.providers ?? (async () => ({ kind: "listed", providers: [] })),
      connectRuntimeProvider: async (machineId: string, runtime: string, input: RuntimeAuthProviderConnectInput) => {
        connects.push({ machineId, runtime, input });
        return options.connect ? options.connect(input) : { kind: "connected" };
      },
    },
  };
}

function api(baseUrl: string, serverId: string, machineId: string) {
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });
  const base = `${baseUrl}/api/servers/${serverId}/machines/${machineId}/runtime-auth`;
  return {
    status: (token: string) => fetch(base, { headers: headers(token) }),
    login: (token: string, runtime = "claude", body: Record<string, unknown> = runtime === "kimi" ? { region: "global" } : {}) =>
      fetch(`${base}/${runtime}/login`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }),
    code: (token: string, loginId: string, code: unknown, runtime = "claude") => fetch(`${base}/${runtime}/login/${loginId}/code`, { method: "POST", headers: headers(token), body: JSON.stringify({ code }) }),
    cancel: (token: string, loginId: string, runtime = "claude") => fetch(`${base}/${runtime}/login/${loginId}/cancel`, { method: "POST", headers: headers(token), body: "{}" }),
    logout: (token: string, runtime = "claude", body: Record<string, unknown> = {}) => fetch(`${base}/${runtime}/logout`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }),
    providers: (token: string, runtime = "qwen") => fetch(`${base}/${runtime}/providers`, { headers: headers(token) }),
    connect: (token: string, body: unknown, runtime = "qwen") =>
      fetch(`${base}/${runtime}/connect-provider`, { method: "POST", headers: headers(token), body: typeof body === "string" ? body : JSON.stringify(body) }),
  };
}

async function endLogin(loginId: string) {
  const session = await runtimeAuthService.getSession(asRuntimeAuthLoginId(loginId)!);
  if (session) await runtimeAuthService.endLogin(session);
}

test("task #17: the attacher and server owners/admins may sign a runtime in; other members and unknown runtimes may not", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-who");
  const { orchestrator, commands } = fakeOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);

  assert.equal((await calls.status(tokens.bystander)).status, 403, "an ordinary member does not see the accounts");
  assert.equal((await calls.login(tokens.bystander)).status, 403, "nor signs in");
  assert.equal((await calls.logout(tokens.bystander)).status, 403, "nor signs out");
  assert.equal((await calls.login(tokens.attacher, "cursor")).status, 404, "Cursor cannot be signed in from the web");

  const read = await calls.status(tokens.attacher);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await read.json(), {
    status: null,
    availability: "ok",
    runtimes: RUNTIME_AUTH_RUNTIMES.filter((runtime) => runtime !== "antigravity"),
    // Pi signs out per provider on a daemon with its capability (this fake's default: every runtime).
    logoutRuntimes: ["claude", "codex", "kimi", "pi", "grok", "opencode", "codebuddy"],
    canAct: true,
  }, "Antigravity only where its flag is on");
  assert.equal((await calls.login(tokens.attacher, "qwen")).status, 404, "Qwen Code has a provider key, not a sign-in");
  assert.equal((await calls.logout(tokens.attacher, "qwen")).status, 404, "nor a sign-out");

  for (const token of [tokens.attacher, tokens.admin, tokens.owner]) {
    const started = await calls.login(token);
    assert.equal(started.status, 200, await started.clone().text());
    const { loginId } = await started.json() as { loginId: string };
    assert.ok(asRuntimeAuthLoginId(loginId));
    await endLogin(loginId);
  }
  assert.deepEqual(commands.map((command) => command.message.type), Array(3).fill("machine:runtime_auth:login:start"));
});

test("task #17: one sign-in per runtime per Computer; code and cancel answer 404 to anyone but the person who started it", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-bind");
  const { orchestrator, commands } = fakeOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);

  const started = await calls.login(tokens.attacher);
  const { loginId } = await started.json() as { loginId: string };
  const again = await calls.login(tokens.admin);
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { code: string }).code, "login_in_progress");
  assert.equal((await calls.login(tokens.admin, "codex")).status, 200, "another runtime is free");

  assert.equal((await calls.code(tokens.admin, loginId, PASTED_CODE)).status, 404, "an admin cannot answer someone else's sign-in");
  assert.equal((await calls.cancel(tokens.owner, loginId)).status, 404, "nor can the owner cancel it");
  assert.equal((await calls.code(tokens.attacher, loginId, PASTED_CODE, "codex")).status, 404, "the login is bound to its runtime");
  assert.equal((await calls.code(tokens.attacher, "rtl_not-a-real-login-id00", PASTED_CODE)).status, 404);

  assert.equal((await calls.code(tokens.attacher, loginId, "")).status, 400);
  const accepted = await calls.code(tokens.attacher, loginId, PASTED_CODE);
  assert.equal(accepted.status, 202);
  assert.deepEqual(commands.at(-1), { machineId: machine.id, message: { type: "machine:runtime_auth:login:code", loginId, code: PASTED_CODE } });
  assert.equal((await calls.cancel(tokens.attacher, loginId)).status, 202);
  assert.equal(commands.at(-1)?.message.type, "machine:runtime_auth:login:cancel");
});

test("task #17: the pasted code is in no log line and no response", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-nolog");
  const { orchestrator } = fakeOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  const { loginId } = await (await calls.login(tokens.attacher)).json() as { loginId: string };

  const written: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  for (const name of methods) console[name] = (...args: unknown[]) => { written.push(args.map(String).join(" ")); };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { written.push(String(chunk)); return (stdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { written.push(String(chunk)); return (stderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  let bodies: string[];
  try {
    const ok = await calls.code(tokens.attacher, loginId, PASTED_CODE);
    const wrongUser = await calls.code(tokens.admin, loginId, PASTED_CODE);
    const tooLong = await calls.code(tokens.attacher, loginId, `${PASTED_CODE}${"x".repeat(2000)}`);
    bodies = await Promise.all([ok.text(), wrongUser.text(), tooLong.text()]);
  } finally {
    methods.forEach((name, index) => { console[name] = originals[index]!; });
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  assert.ok(!written.join("\n").includes(PASTED_CODE), "no log line carries the code");
  assert.ok(!bodies.join("\n").includes(PASTED_CODE), "no response echoes it");
});

test("task #17: starts are rate-limited per person and Computer", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-rate");
  const { orchestrator } = fakeOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  for (let i = 0; i < 5; i += 1) {
    const started = await calls.login(tokens.attacher);
    assert.equal(started.status, 200);
    await endLogin((await started.json() as { loginId: string }).loginId);
  }
  const sixth = await calls.login(tokens.attacher);
  assert.equal(sixth.status, 429);
  assert.equal((await calls.login(tokens.admin)).status, 200, "another person is counted separately");
});

test("task #17: an offline or old Computer is refused before anything is reserved; logout relays the Computer's answer", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-avail");
  const calls = api(app.baseUrl, server.id, machine.id);

  app.app.set("agentOrchestrator", fakeOrchestrator({ availability: "computer_upgrade_required" }).orchestrator);
  const old = await calls.login(tokens.attacher);
  assert.equal(old.status, 409);
  assert.equal((await old.json() as { code: string }).code, "computer_upgrade_required");

  app.app.set("agentOrchestrator", fakeOrchestrator({ availability: "computer_offline" }).orchestrator);
  assert.equal((await (await calls.logout(tokens.attacher)).json() as { code: string }).code, "computer_offline");

  app.app.set("agentOrchestrator", fakeOrchestrator({ logout: async () => ({ kind: "failed", reason: "still_logged_in" }) }).orchestrator);
  const stillIn = await calls.logout(tokens.owner);
  assert.equal(stillIn.status, 200);
  assert.deepEqual(await stillIn.json(), { result: { kind: "failed", reason: "still_logged_in" } });

  app.app.set("agentOrchestrator", fakeOrchestrator({ logout: async () => { throw new RouteFailureError("daemon_timeout", "timed out"); } }).orchestrator);
  assert.equal((await calls.logout(tokens.owner)).status, 504);

  // Nothing was reserved by the refused start: a working Computer takes the next one.
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  assert.equal((await calls.login(tokens.attacher)).status, 200);
});

test("Kimi and Qoder are signed in only on a Computer whose daemon knows them, reported or not; Qoder is never signed out", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-v2");
  const calls = api(app.baseUrl, server.id, machine.id);
  const upgradeRequired = async (response: Response) => {
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, "computer_upgrade_required");
  };

  // An older daemon (runtime auth, not V2) would drop the start: refused before anything reaches it.
  const older = fakeOrchestrator({ runtimes: RUNTIME_AUTH_V1_RUNTIMES });
  app.app.set("agentOrchestrator", older.orchestrator);
  await upgradeRequired(await calls.login(tokens.attacher, "kimi"));
  await upgradeRequired(await calls.login(tokens.attacher, "qoder"));
  await upgradeRequired(await calls.logout(tokens.attacher, "kimi"));
  assert.equal(older.commands.length, 0, "nothing reached the Computer");
  assert.deepEqual((await (await calls.status(tokens.attacher)).json() as { runtimes: string[] }).runtimes, ["claude", "codex"]);

  // A V2 daemon takes them with no status stored yet (not reported, or expired).
  const current = fakeOrchestrator();
  app.app.set("agentOrchestrator", current.orchestrator);
  assert.equal(await runtimeAuthService.getStatus(machine.id), null);
  for (const runtime of ["kimi", "qoder"]) {
    const started = await calls.login(tokens.attacher, runtime);
    assert.equal(started.status, 200, runtime);
    await endLogin((await started.json() as { loginId: string }).loginId);
  }
  assert.deepEqual(current.commands.map((command) => command.message.runtime), ["kimi", "qoder"]);
  assert.equal((await calls.logout(tokens.attacher, "kimi")).status, 200);
  assert.equal((await calls.logout(tokens.attacher, "qoder")).status, 404, "OAR has no Qoder logout");
});

test("Antigravity is offered only where agent_runtime_oar_antigravity revives it, its sign-out too", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const current = fakeOrchestrator();
  app.app.set("agentOrchestrator", current.orchestrator);
  const stored = {
    collectedAt: "2026-11-11T10:00:00.000Z",
    runtimes: { claude: { kind: "logged_in" }, antigravity: { kind: "logged_out" } },
  } as const;
  const read = async (calls: ReturnType<typeof api>, token: string) =>
    await (await calls.status(token)).json() as { status: { runtimes: Record<string, unknown> } | null; runtimes: string[] };

  // Flag off (the default): the server says nothing about Antigravity, so the web shows nothing new.
  const off = await seedComputer("rtauth-agy-off");
  const offCalls = api(app.baseUrl, off.server.id, off.machine.id);
  await runtimeAuthService.recordStatus(off.machine.id, stored);
  const offView = await read(offCalls, off.tokens.attacher);
  assert.deepEqual(offView.status?.runtimes, { claude: { kind: "logged_in" } }, "its stored status is left out");
  assert.ok(!offView.runtimes.includes("antigravity"), "and it is not offered");
  assert.ok(offView.runtimes.includes("qwen"), "the others are");
  const refused = await offCalls.login(off.tokens.attacher, "antigravity");
  assert.equal(refused.status, 404);
  const refusal = await refused.json() as { code: string; error: string };
  assert.equal(refusal.code, "runtime_auth_not_offered");
  assert.equal(refusal.error, "This runtime cannot be signed in from the web on this server.");
  const refusedLogout = await offCalls.logout(off.tokens.attacher, "antigravity");
  assert.equal(refusedLogout.status, 404, "its sign-out is refused as its sign-in is");
  assert.equal((await refusedLogout.json() as { code: string }).code, "runtime_auth_not_offered");
  assert.ok(!offView.runtimes.includes("antigravity") && !(offView as { logoutRuntimes?: string[] }).logoutRuntimes?.includes("antigravity"));
  assert.equal(current.commands.length, 0, "nothing reached the Computer");
  assert.ok(!tracedEvents.some((event) => event.name === "runtime_auth.logout.result" && (event.attrs as { runtime?: string }).runtime === "antigravity"), "no logout was relayed");

  // Flag on for this server: offered, its status read, its login relayed.
  const on = await seedComputer("rtauth-agy-on");
  await getDb().insert(featureFlags).values({ key: "agent_runtime_oar_antigravity", randomizationUnit: "server", salt: "test", defaultEnabled: false }).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: "agent_runtime_oar_antigravity", stage: "server", priority: 0, decision: "allow", values: [on.server.id] });
  const onCalls = api(app.baseUrl, on.server.id, on.machine.id);
  await runtimeAuthService.recordStatus(on.machine.id, stored);
  const onView = await read(onCalls, on.tokens.attacher);
  assert.deepEqual(onView.status?.runtimes, stored.runtimes);
  assert.ok(onView.runtimes.includes("antigravity"));
  const started = await onCalls.login(on.tokens.attacher, "antigravity");
  assert.equal(started.status, 200);
  assert.deepEqual(current.commands.at(-1)?.message, { type: "machine:runtime_auth:login:start", loginId: (await started.json() as { loginId: string }).loginId, runtime: "antigravity" });
  await endLogin(current.commands.at(-1)!.message.loginId!);
  // OAR 0.98 logs Antigravity out: relayed to a Computer that runs it, its outcome answered as is.
  assert.ok((onView as { logoutRuntimes?: string[] }).logoutRuntimes?.includes("antigravity"));
  const logout = await onCalls.logout(on.tokens.attacher, "antigravity");
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { result: { kind: "logged_out" } });
  const stillSignedIn = fakeOrchestrator({ logout: async () => ({ kind: "failed", reason: "still_logged_in" }) });
  app.app.set("agentOrchestrator", stillSignedIn.orchestrator);
  assert.deepEqual(await (await onCalls.logout(on.tokens.attacher, "antigravity")).json(), { result: { kind: "failed", reason: "still_logged_in" } });

  // A Computer that signs Antigravity in but runs no logout for it (OAR 0.97): never sent one.
  let loggedOut = 0;
  const noLogout = fakeOrchestrator({ logoutRuntimes: ["claude", "codex", "kimi"], logout: async () => { loggedOut += 1; return { kind: "logged_out" }; } });
  app.app.set("agentOrchestrator", noLogout.orchestrator);
  const noLogoutView = await read(onCalls, on.tokens.attacher);
  assert.ok(noLogoutView.runtimes.includes("antigravity"), "still signed in from here");
  assert.ok(!(noLogoutView as { logoutRuntimes?: string[] }).logoutRuntimes?.includes("antigravity"), "but not signed out");
  const tooOld = await onCalls.logout(on.tokens.attacher, "antigravity");
  assert.equal(tooOld.status, 409);
  assert.equal((await tooOld.json() as { code: string }).code, "computer_upgrade_required");
  assert.equal(loggedOut, 0, "nothing reached the Computer");
  app.app.set("agentOrchestrator", current.orchestrator);

  // A Computer from before Antigravity (no capability): not offered, and its login would be dropped, so 409.
  const older = fakeOrchestrator({ runtimes: RUNTIME_AUTH_RUNTIMES.filter((runtime) => runtime !== "antigravity") });
  app.app.set("agentOrchestrator", older.orchestrator);
  assert.ok(!(await read(onCalls, on.tokens.attacher)).runtimes.includes("antigravity"));
  const upgrade = await onCalls.login(on.tokens.attacher, "antigravity");
  assert.equal(upgrade.status, 409);
  assert.equal((await upgrade.json() as { code: string }).code, "computer_upgrade_required");
  assert.equal(older.commands.length, 0);
});

test("CodeBuddy Code is signed in and out with no server flag, only on a Computer whose daemon knows it", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const current = fakeOrchestrator();
  app.app.set("agentOrchestrator", current.orchestrator);
  const stored = {
    collectedAt: "2026-11-13T10:00:00.000Z",
    runtimes: { claude: { kind: "logged_in" }, codebuddy: { kind: "logged_in" } },
  } as const;
  const read = async (calls: ReturnType<typeof api>, token: string) =>
    await (await calls.status(token)).json() as { status: { runtimes: Record<string, unknown> } | null; runtimes: string[]; logoutRuntimes: string[] };

  // Like Qoder, no server flag: offered, its status read, its login and logout relayed.
  const seeded = await seedComputer("rtauth-cb");
  const calls = api(app.baseUrl, seeded.server.id, seeded.machine.id);
  await runtimeAuthService.recordStatus(seeded.machine.id, stored);
  const view = await read(calls, seeded.tokens.attacher);
  assert.deepEqual(view.status?.runtimes, stored.runtimes);
  assert.ok(view.runtimes.includes("codebuddy") && view.logoutRuntimes.includes("codebuddy"));
  const started = await calls.login(seeded.tokens.attacher, "codebuddy");
  assert.equal(started.status, 200);
  assert.deepEqual(current.commands.at(-1)?.message, { type: "machine:runtime_auth:login:start", loginId: (await started.json() as { loginId: string }).loginId, runtime: "codebuddy" });
  await endLogin(current.commands.at(-1)!.message.loginId!);
  const logout = await calls.logout(seeded.tokens.attacher, "codebuddy");
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { result: { kind: "logged_out" } });

  // A Computer from before CodeBuddy's sign-in: the upgrade answer, nothing sent.
  const older = fakeOrchestrator({ runtimes: RUNTIME_AUTH_RUNTIMES.filter((runtime) => runtime !== "codebuddy"), logoutRuntimes: ["claude", "codex", "kimi"] });
  app.app.set("agentOrchestrator", older.orchestrator);
  assert.ok(!(await read(calls, seeded.tokens.attacher)).runtimes.includes("codebuddy"));
  for (const upgrade of [await calls.login(seeded.tokens.attacher, "codebuddy"), await calls.logout(seeded.tokens.attacher, "codebuddy")]) {
    assert.equal(upgrade.status, 409);
    assert.equal((await upgrade.json() as { code: string }).code, "computer_upgrade_required");
  }
  assert.equal(older.commands.length, 0);
});

test("Kimi's sign-in starts only with the region the person chose, and relays it; no other runtime takes a region", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-region");
  const { orchestrator, commands } = fakeOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  const invalidRegion = async (response: Response, why: string) => {
    assert.equal(response.status, 400, why);
    assert.equal((await response.json() as { code: string }).code, "invalid_region", why);
  };

  await invalidRegion(await calls.login(tokens.attacher, "kimi", {}), "Kimi without a region: no default, no guess");
  await invalidRegion(await calls.login(tokens.attacher, "kimi", { region: "auto" }), "a region Kimi does not know");
  await invalidRegion(await calls.login(tokens.attacher, "claude", { region: "global" }), "Claude Code has no region");
  await invalidRegion(await calls.login(tokens.attacher, "qoder", { region: "mainland-cn" }), "Qoder has no region");
  assert.equal(commands.length, 0, "nothing reached the Computer");

  for (const region of ["mainland-cn", "global"]) {
    const started = await calls.login(tokens.attacher, "kimi", { region });
    assert.equal(started.status, 200, region);
    await endLogin((await started.json() as { loginId: string }).loginId);
  }
  const codex = await calls.login(tokens.attacher, "codex");
  assert.equal(codex.status, 200);
  await endLogin((await codex.json() as { loginId: string }).loginId);
  assert.deepEqual(
    commands.map(({ message }) => ({ runtime: message.runtime, region: message.region })),
    [{ runtime: "kimi", region: "mainland-cn" }, { runtime: "kimi", region: "global" }, { runtime: "codex", region: undefined }],
  );
  assert.ok(!("region" in commands[2]!.message), "Codex's start is unchanged: no region key");
});

test("task #17: a Computer that cannot be reached when the start is sent gets 409 and frees the runtime", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-sendfail");
  const calls = api(app.baseUrl, server.id, machine.id);
  app.app.set("agentOrchestrator", fakeOrchestrator({ sendFails: true }).orchestrator);
  const refused = await calls.login(tokens.attacher);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json() as { code: string }).code, "computer_offline");
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  assert.equal((await calls.login(tokens.attacher)).status, 200, "the lock was released, not held for the login's TTL");
});

test("task #17: a Computer that reconnects while the start is sent gets 409, a cancel, and its runtime freed", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-reconnect");
  const calls = api(app.baseUrl, server.id, machine.id);
  const fake = fakeOrchestrator();
  let reads = 0;
  // The first read is the connection the login is bound to; by the second, after the send, it was replaced.
  fake.orchestrator.runtimeAuthAvailability = async () => ({ state: "ok", connectionEpochId: reads++ === 0 ? "epoch-1" : "epoch-2", runtimes: RUNTIME_AUTH_RUNTIMES, logoutRuntimes: [] });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const refused = await calls.login(tokens.attacher);
  assert.equal(refused.status, 409);
  assert.deepEqual(fake.commands.map((command) => command.message.type), ["machine:runtime_auth:login:start", "machine:runtime_auth:login:cancel"]);
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  assert.equal((await calls.login(tokens.attacher)).status, 200, "the runtime is free for a retry");
});

test("task #17: a malformed code body is a plain 400 and its text reaches no log", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-badjson");
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  const { loginId } = await (await calls.login(tokens.attacher)).json() as { loginId: string };
  const written: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { written.push(args.map(String).join(" ")); };
  let body = "";
  try {
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-auth/claude/login/${loginId}/code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.attacher}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: `{"code": ${PASTED_CODE}`,
    });
    assert.equal(res.status, 400);
    body = await res.text();
    assert.equal((JSON.parse(body) as { code?: string }).code, "invalid_code", "answered by the route's own parser, not the global one (whose error can quote the body)");
  } finally {
    console.error = original;
  }
  assert.ok(!body.includes(PASTED_CODE) && !written.join("\n").includes(PASTED_CODE));
});

test("task #17: a Computer with no attaching human is not offered a sign-in", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-orphan");
  await getDb().update(computers).set({ attachedByUserId: null }).where(eq(computers.machineId, machine.id));
  app.app.set("agentOrchestrator", fakeOrchestrator().orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  const refused = await calls.login(tokens.owner);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json() as { code: string }).code, "computer_not_attached");
  assert.equal((await (await calls.status(tokens.owner)).json() as { availability: string }).availability, "computer_not_attached");
});

// ─── Qwen Code: a provider's API key, relayed once ───

// High-entropy, so any 8 characters of it found in an output are a leak, not a coincidence.
const API_KEY = "sk-Zq7XwP3mT9vK2rL8nB4cY6dF1gH5jJ0a";
const CONNECT = { providerId: "deepseek", apiKey: API_KEY };

/**
 * Whether `text` holds any 8 consecutive characters of the key. Node's JSON
 * parser quotes only a snippet of a malformed body, so a check for the whole
 * key could never catch that leak.
 */
function leaksKey(text: string): boolean {
  for (let i = 0; i + 8 <= API_KEY.length; i += 1) if (text.includes(API_KEY.slice(i, i + 8))) return true;
  return false;
}

/** Everything the request could leave behind: console and stdio lines, trace events, the runtime-auth store. */
async function capturing<T>(run: () => Promise<T>): Promise<{ value: T; written: string; traced: string; stored: string }> {
  const written: string[] = [];
  const traceStart = tracedEvents.length;
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  for (const name of methods) console[name] = (...args: unknown[]) => { written.push(args.map(String).join(" ")); };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { written.push(String(chunk)); return (stdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { written.push(String(chunk)); return (stderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  try {
    const value = await run();
    return { value, written: written.join("\n"), traced: JSON.stringify(tracedEvents.slice(traceStart)), stored: __runtimeAuthLocalStoreEntriesForTests().join("\n") };
  } finally {
    methods.forEach((name, index) => { console[name] = originals[index]!; });
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

test("Qwen Code: the attacher and owners/admins list providers and connect one; other members, and runtimes without a provider key, may not", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-qwen-who");
  const providers = [{ id: "deepseek", label: "DeepSeek API Key", configured: false, endpoint: { kind: "fixed" }, needsModelIds: false }];
  const fake = fakeOrchestrator({ providers: async () => ({ kind: "listed", providers }) });
  app.app.set("agentOrchestrator", fake.orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);

  assert.equal((await calls.providers(tokens.bystander)).status, 403);
  assert.equal((await calls.connect(tokens.bystander, CONNECT)).status, 403);
  assert.equal((await calls.providers(tokens.attacher, "claude")).status, 404, "Claude Code has no provider key to connect");
  assert.equal((await calls.connect(tokens.attacher, CONNECT, "kimi")).status, 404);

  const listed = await calls.providers(tokens.attacher);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { result: { kind: "listed", providers } });
  for (const token of [tokens.attacher, tokens.admin, tokens.owner]) {
    const connected = await calls.connect(token, { ...CONNECT, apiKey: ` ${API_KEY}\n` });
    assert.equal(connected.status, 200);
    assert.deepEqual(await connected.json(), { result: { kind: "connected" } });
  }
  assert.deepEqual(fake.connects.map(({ runtime, input }) => ({ runtime, input })), Array(3).fill({ runtime: "qwen", input: CONNECT }), "the key is trimmed and relayed as is");
  assert.ok(fake.connects.every(({ machineId }) => machineId === machine.id));
});

test("Qwen Code: a bad connect is a 400 that names the field, never the key; a malformed body never reaches the global parser", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-qwen-input");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  const refused = async (body: unknown, code: string) => {
    const { value, written } = await capturing(async () => {
      const response = await calls.connect(tokens.attacher, body);
      return { status: response.status, text: await response.text() };
    });
    assert.equal(value.status, 400, code);
    assert.equal((JSON.parse(value.text) as { code: string }).code, code);
    assert.ok(!leaksKey(value.text) && !leaksKey(written), `${code}: no part of the key is in the answer or a log`);
  };
  await refused({ apiKey: API_KEY }, "invalid_provider");
  await refused({ providerId: "deepseek", apiKey: `${API_KEY} ${API_KEY}` }, "invalid_api_key");
  await refused({ providerId: "deepseek", apiKey: "" }, "invalid_api_key");
  await refused({ ...CONNECT, baseUrl: `https://user:${API_KEY}@example.com` }, "invalid_base_url");
  await refused({ ...CONNECT, modelIds: ["two words"] }, "invalid_model");
  // Malformed right at the key, where Node's parser error would quote it.
  await refused(`{"providerId":"deepseek","apiKey":${API_KEY}`, "invalid_input");
  await refused(JSON.stringify({ ...CONNECT, pad: "x".repeat(20_000) }), "invalid_input");
  assert.equal(fake.connects.length, 0, "nothing reached the Computer");
});

test("Qwen Code: the key reaches the Computer's relay once and no log, trace, store or answer, on success or failure", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-qwen-nolog");
  const calls = api(app.baseUrl, server.id, machine.id);
  const outcomes: Array<[ReturnType<typeof fakeOrchestrator>, number]> = [
    [fakeOrchestrator(), 200],
    [fakeOrchestrator({ connect: async () => ({ kind: "failed", reason: "rejected" }) }), 200],
    [fakeOrchestrator({ connect: async () => { throw new RouteFailureError("daemon_timeout", "timed out"); } }), 504],
    [fakeOrchestrator({ connect: async () => { throw new RouteFailureError("daemon_offline", "unreachable"); } }), 409],
    [fakeOrchestrator({ connect: async () => { throw new Error(`relay blew up holding ${API_KEY}`); } }), 500],
  ];
  for (const [fake, status] of outcomes) {
    app.app.set("agentOrchestrator", fake.orchestrator);
    const { value, written, traced, stored } = await capturing(async () => {
      const response = await calls.connect(tokens.attacher, { ...CONNECT, baseUrl: "https://api.example.com/v1" });
      return { status: response.status, text: await response.text() };
    });
    assert.equal(value.status, status);
    assert.equal(fake.connects.length, 1, "relayed exactly once");
    assert.equal(fake.connects[0]!.input.apiKey, API_KEY);
    assert.ok(!leaksKey(value.text), `${status}: not in the answer`);
    assert.ok(!leaksKey(written), `${status}: not in a log line`);
    assert.ok(!leaksKey(traced) && !traced.includes("api.example.com"), `${status}: not in a trace, nor the endpoint`);
    assert.ok(!leaksKey(stored), `${status}: not in the runtime-auth store (Redis in production)`);
    if (status === 200) assert.ok(traced.includes("runtime_auth.connect_provider.result") && traced.includes("deepseek"), "the trace has the provider and outcome");
  }
});

test("Qwen Code: an older Computer, an offline one or one with no owner is refused before anything is sent; attempts are rate-limited", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-qwen-avail");
  const calls = api(app.baseUrl, server.id, machine.id);
  const refusedWith = async (response: Response, code: string) => {
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, code);
  };

  // A Computer from before Qwen Code (runtime auth V2 only) would drop both requests: the person would wait for the relay budget.
  const older = fakeOrchestrator({ runtimes: RUNTIME_AUTH_V2_RUNTIMES });
  app.app.set("agentOrchestrator", older.orchestrator);
  await refusedWith(await calls.providers(tokens.attacher), "computer_upgrade_required");
  await refusedWith(await calls.connect(tokens.attacher, CONNECT), "computer_upgrade_required");
  assert.equal(older.connects.length, 0);
  assert.deepEqual((await (await calls.status(tokens.attacher)).json() as { runtimes: string[] }).runtimes, ["claude", "codex", "kimi", "qoder"]);

  app.app.set("agentOrchestrator", fakeOrchestrator({ availability: "computer_offline" }).orchestrator);
  await refusedWith(await calls.connect(tokens.attacher, CONNECT), "computer_offline");

  app.app.set("agentOrchestrator", fakeOrchestrator({ providers: async () => { throw new RouteFailureError("daemon_timeout", "timed out"); } }).orchestrator);
  assert.equal((await calls.providers(tokens.attacher)).status, 504);

  const current = fakeOrchestrator();
  app.app.set("agentOrchestrator", current.orchestrator);
  for (let i = 0; i < 5; i += 1) assert.equal((await calls.connect(tokens.attacher, CONNECT)).status, 200);
  const sixth = await calls.connect(tokens.attacher, CONNECT);
  assert.equal(sixth.status, 429);
  assert.equal(current.connects.length, 5, "the refused attempt sent nothing");
  // Lists are read each time the dialog opens: a higher limit, counted apart from connects.
  // (One list was read above, the one that timed out.)
  for (let i = 1; i < 30; i += 1) assert.equal((await calls.providers(tokens.attacher)).status, 200, `list ${i + 1}`);
  assert.equal((await calls.providers(tokens.attacher)).status, 429, "the 31st list in the window");
  assert.equal((await calls.connect(tokens.admin, CONNECT)).status, 200, "another person is counted separately");

  await getDb().update(computers).set({ attachedByUserId: null }).where(eq(computers.machineId, machine.id));
  await refusedWith(await calls.connect(tokens.owner, CONNECT), "computer_not_attached");
});

test("Pi signs in and out one provider at a time: the provider is required for Pi, refused elsewhere, and relayed", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-pi");
  const logouts: Array<[string, string | undefined]> = [];
  const { orchestrator, commands } = fakeOrchestrator({ logout: async (_machineId, runtime, providerId) => { logouts.push([runtime, providerId]); return { kind: "logged_out" }; } });
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  const refusedProvider = async (response: Response) => {
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "invalid_provider");
  };

  await refusedProvider(await calls.login(tokens.attacher, "pi"));
  await refusedProvider(await calls.login(tokens.attacher, "pi", { providerId: "../../etc" }));
  await refusedProvider(await calls.login(tokens.attacher, "claude", { providerId: "anthropic" }));
  await refusedProvider(await calls.logout(tokens.attacher, "pi"));
  await refusedProvider(await calls.logout(tokens.attacher, "codex", { providerId: "openai" }));
  assert.equal(commands.length, 0, "nothing reached the Computer");
  assert.deepEqual(logouts, []);

  const started = await calls.login(tokens.attacher, "pi", { providerId: "github-copilot" });
  assert.equal(started.status, 200, await started.clone().text());
  const { loginId } = await started.json() as { loginId: string };
  assert.deepEqual(commands.at(-1), { machineId: machine.id, message: { type: "machine:runtime_auth:login:start", loginId, runtime: "pi", providerId: "github-copilot" } });
  // Pasting a code (Anthropic) or the landing page's address (OpenRouter) is the same code route.
  assert.equal((await calls.code(tokens.attacher, loginId, "http://localhost:3000/callback?code=abc", "pi")).status, 202);
  await endLogin(loginId);

  const out = await calls.logout(tokens.admin, "pi", { providerId: "anthropic" });
  assert.equal(out.status, 200);
  assert.deepEqual(logouts, [["pi", "anthropic"]]);
});

test("Pi: a key Pi would run as a command or fill in from the environment is a 400 on the key, never sent or echoed", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-pi-key");
  const { orchestrator, connects } = fakeOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  for (const apiKey of ["!op read op://vault/openrouter", "$OPENROUTER_API_KEY", "sk-${HOME}", "sk-\u4e2d"]) {
    const refused = await calls.connect(tokens.attacher, { providerId: "openrouter", apiKey }, "pi");
    assert.equal(refused.status, 400);
    const body = await refused.text();
    assert.equal((JSON.parse(body) as { code: string }).code, "invalid_api_key");
    assert.ok(!body.includes(apiKey), "never echoed");
  }
  const withUrl = await calls.connect(tokens.attacher, { providerId: "openrouter", apiKey: "sk-or-v1-abc", baseUrl: "https://example.com" }, "pi");
  assert.equal(withUrl.status, 400, "Pi takes no endpoint from the web");
  assert.equal(connects.length, 0, "nothing reached the Computer");
  assert.ok(!JSON.stringify(tracedEvents).includes("op://"), "nor a trace");

  const ok = await calls.connect(tokens.attacher, { providerId: "openrouter", apiKey: "sk-or-v1-abc" }, "pi");
  assert.equal(ok.status, 200);
  assert.deepEqual(connects, [{ machineId: machine.id, runtime: "pi", input: { providerId: "openrouter", apiKey: "sk-or-v1-abc" } }]);
  // The same key is fine for Qwen Code, whose settings do not run it.
  assert.equal((await calls.connect(tokens.attacher, { providerId: "deepseek", apiKey: "sk-$abc" })).status, 200);
});

test("Grok is signed in and out only on a Computer whose daemon knows it (OAR 0.99): an older one gets the upgrade answer before anything is sent", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-grok");
  const calls = api(app.baseUrl, server.id, machine.id);

  // A Computer from before Grok's sign-in (OAR 0.98): its daemon would drop both.
  const older = fakeOrchestrator({ runtimes: RUNTIME_AUTH_RUNTIMES.filter((runtime) => runtime !== "grok") });
  app.app.set("agentOrchestrator", older.orchestrator);
  for (const response of [await calls.login(tokens.attacher, "grok"), await calls.logout(tokens.attacher, "grok")]) {
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, "computer_upgrade_required");
  }
  assert.equal(older.commands.length, 0, "nothing reached the Computer");
  const olderView = await (await calls.status(tokens.attacher)).json() as { runtimes: string[]; logoutRuntimes: string[] };
  assert.ok(!olderView.runtimes.includes("grok") && !olderView.logoutRuntimes.includes("grok"), "the web offers the upgrade instead");

  // A current Computer: the login is relayed with no region or provider, and so is the logout's answer.
  let loggedOut = 0;
  const current = fakeOrchestrator({ logout: async () => { loggedOut += 1; return { kind: "failed", reason: "still_logged_in" }; } });
  app.app.set("agentOrchestrator", current.orchestrator);
  const view = await (await calls.status(tokens.attacher)).json() as { runtimes: string[]; logoutRuntimes: string[] };
  assert.ok(view.runtimes.includes("grok") && view.logoutRuntimes.includes("grok"), "no server flag gates it");
  const started = await calls.login(tokens.attacher, "grok");
  assert.equal(started.status, 200, await started.clone().text());
  await endLogin((await started.json() as { loginId: string }).loginId);
  assert.deepEqual(current.commands.map((command) => [command.message.type, command.message.runtime, command.message.region, command.message.providerId]), [["machine:runtime_auth:login:start", "grok", undefined, undefined]]);
  assert.equal((await calls.login(tokens.attacher, "grok", { region: "global" })).status, 400, "Grok's login takes no region");
  const logout = await calls.logout(tokens.attacher, "grok");
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { result: { kind: "failed", reason: "still_logged_in" } }, "another sign-in still active: answered as is");
  assert.equal(loggedOut, 1);
});

test("Pi is signed in only on a Computer whose daemon knows it: an older one gets the upgrade answer before anything is sent", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-pi-old");
  const older = fakeOrchestrator({ runtimes: RUNTIME_AUTH_RUNTIMES.filter((runtime) => runtime !== "pi") });
  app.app.set("agentOrchestrator", older.orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  for (const response of [
    await calls.login(tokens.attacher, "pi", { providerId: "anthropic" }),
    await calls.logout(tokens.attacher, "pi", { providerId: "anthropic" }),
    await calls.providers(tokens.attacher, "pi"),
    await calls.connect(tokens.attacher, { providerId: "deepseek", apiKey: "sk-abc" }, "pi"),
  ]) {
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, "computer_upgrade_required");
  }
  assert.equal(older.commands.length + older.connects.length, 0);
});

test("OpenCode signs in per provider by the method the person chose: provider required, method optional and OpenCode's only, both relayed", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-opencode");
  const logouts: Array<[string, string | undefined]> = [];
  const { orchestrator, commands } = fakeOrchestrator({ logout: async (_machineId, runtime, providerId) => { logouts.push([runtime, providerId]); return { kind: "logged_out" }; } });
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  const refusedWithCode = async (response: Response, code: string) => {
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, code);
  };

  await refusedWithCode(await calls.login(tokens.attacher, "opencode"), "invalid_provider");
  await refusedWithCode(await calls.login(tokens.attacher, "opencode", { providerId: "github-copilot", oauthMethod: "x".repeat(81) }), "invalid_oauth_method");
  await refusedWithCode(await calls.login(tokens.attacher, "opencode", { providerId: "github-copilot", oauthMethod: "two\nlines" }), "invalid_oauth_method");
  await refusedWithCode(await calls.login(tokens.attacher, "pi", { providerId: "anthropic", oauthMethod: "Anthropic (Claude Pro/Max)" }), "invalid_oauth_method");
  await refusedWithCode(await calls.login(tokens.attacher, "claude", { oauthMethod: "Claude" }), "invalid_oauth_method");
  assert.equal(commands.length, 0, "nothing reached the Computer");

  const started = await calls.login(tokens.attacher, "opencode", { providerId: "github-copilot", oauthMethod: "Login with GitHub (device)" });
  assert.equal(started.status, 200, await started.clone().text());
  const { loginId } = await started.json() as { loginId: string };
  assert.deepEqual(commands.at(-1), {
    machineId: machine.id,
    message: { type: "machine:runtime_auth:login:start", loginId, runtime: "opencode", providerId: "github-copilot", oauthMethod: "Login with GitHub (device)" },
  });
  await endLogin(loginId);

  const preferred = await calls.login(tokens.attacher, "opencode", { providerId: "openai" });
  assert.equal(preferred.status, 200, "no method: the Computer runs the provider's preferred one");
  await endLogin((await preferred.json() as { loginId: string }).loginId);

  assert.equal((await calls.logout(tokens.admin, "opencode", { providerId: "deepseek" })).status, 200);
  assert.deepEqual(logouts, [["opencode", "deepseek"]]);
});

test("OpenCode: a key that reads as an {env:} or {file:} reference, or beyond one byte per character, is a 400 on the key, never sent or echoed", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-opencode-key");
  const { orchestrator, connects } = fakeOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  for (const apiKey of ["{env:OPENAI_API_KEY}", "{file:~/.secrets/key}", "sk-\u4e2d"]) {
    const refused = await calls.connect(tokens.attacher, { providerId: "deepseek", apiKey }, "opencode");
    assert.equal(refused.status, 400);
    const body = await refused.text();
    assert.equal((JSON.parse(body) as { code: string }).code, "invalid_api_key");
    assert.ok(!body.includes(apiKey), "never echoed");
  }
  assert.equal((await calls.connect(tokens.attacher, { providerId: "deepseek", apiKey: "sk-abc", modelIds: ["m"] }, "opencode")).status, 400, "no model from the web");
  assert.equal(connects.length, 0, "nothing reached the Computer");
  assert.ok(!JSON.stringify(tracedEvents).includes("{file:"), "nor a trace");

  const ok = await calls.connect(tokens.attacher, { providerId: "deepseek", apiKey: "sk-$abc" }, "opencode");
  assert.equal(ok.status, 200, "a $ is literal for OpenCode");
  assert.deepEqual(connects, [{ machineId: machine.id, runtime: "opencode", input: { providerId: "deepseek", apiKey: "sk-$abc" } }]);
});

test("OpenCode is signed in only on a Computer whose daemon knows it (OAR 0.100): an older one gets the upgrade answer before anything is sent", async ({ app }) => {
  __clearRuntimeAuthLocalStoreForTests();
  const { server, machine, tokens } = await seedComputer("rtauth-opencode-old");
  const older = fakeOrchestrator({ runtimes: RUNTIME_AUTH_RUNTIMES.filter((runtime) => runtime !== "opencode") });
  app.app.set("agentOrchestrator", older.orchestrator);
  const calls = api(app.baseUrl, server.id, machine.id);
  for (const response of [
    await calls.login(tokens.attacher, "opencode", { providerId: "github-copilot" }),
    await calls.logout(tokens.attacher, "opencode", { providerId: "github-copilot" }),
    await calls.providers(tokens.attacher, "opencode"),
    await calls.connect(tokens.attacher, { providerId: "deepseek", apiKey: "sk-abc" }, "opencode"),
  ]) {
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, "computer_upgrade_required");
  }
  assert.equal(older.commands.length + older.connects.length, 0);
  const view = await (await calls.status(tokens.attacher)).json() as { runtimes: string[]; logoutRuntimes: string[] };
  assert.ok(!view.runtimes.includes("opencode") && !view.logoutRuntimes.includes("opencode"), "the web offers the upgrade instead");
});
