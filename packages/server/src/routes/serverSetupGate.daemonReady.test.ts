import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import { openTestDatabase, closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll } from "vitest";

import { WebSocket } from "ws";

import { getDb } from "../db/index.js";
import { computers, users } from "../db/schema.js";
import { setupMachineWebSocket } from "./daemon.js";
import { createServer as createRaftServer } from "../services/serverService.js";
import { registerMachine } from "../services/machineService.js";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";
import type { ReplicaStateStore } from "../services/replicaStateStore.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";
import {
  createServerSetupStateService,
  DrizzleServerSetupStateRepository,
  resolveServerSetupLiveFacts,
} from "../services/serverSetupStateService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// task #207 — the setup gate must be proven to OPEN, not only to stay shut.
//
// Every pre-existing assertion around this gate covered the CLOSED surface
// ("computer_runtime") or an already-COMPLETE server. Nothing exercised the
// transition, so a regression that never opens the gate would have kept the
// suite green while hard-locking real onboarding (the #5254 family: a gate
// that traps an account).
//
// Everything here is driven through the REAL protocol -- a real computer
// credential, a real authenticated /daemon/connect socket, a real `ready`
// frame -- against a REAL AgentOrchestrator. The projection is computed by
// product code the same way routes/servers.ts composes it. Nothing injects a
// projection or stubs machine status; injecting either would only test the
// fixture, which is the exact failure this card exists to prevent.
//
// ⛔ SEAMS THIS TEST DOES NOT COVER (do not read it as wider than it is):
//   1. It proves the server behaves correctly GIVEN a protocol-compliant
//      daemon report. It does NOT prove a real daemon emits that shape --
//      that belongs to daemon-side contract tests.
//   2. It does NOT prove the browser releases the wizard. The component layer
//      separately pins "given ready -> Next enabled". TWO GREEN LIGHTS DO NOT
//      AUTOMATICALLY JOIN: component-green + server-green must NOT be reported
//      as full-chain E2E PASS. The browser link stays NOT_COVERED until a
//      dedicated full-stack E2E harness card closes it (archer, 2026-08-25).
//      The shared Playwright harness cannot close it today: integration/app
//      hardcodes getMachineStatus -> "offline", so NO Playwright test can put
//      a machine online.

// Substitutes ONLY the Redis-backed replica-owner adapter, mirroring the same
// helper in agentMigrationService.test.ts. Since #6-era "harden replica affinity
// handoff" (c5b49cfd), owner registration is a readiness commit: without Redis
// commitMachineReplicaGeneration throws and the machine can never come online.
// This is an INFRASTRUCTURE double, not a double of the system under test --
// the orchestrator, the /daemon/connect route, machine registration, capability
// persistence and the projection are all the real product code.
function makeAvailableReplicaStateStore(): ReplicaStateStore {
  let statusVersion = 0;
  // Tracks real registration state rather than answering "yes" unconditionally.
  // A constant `hasMachineReplica: true` made the machine look online before any
  // socket existed, which the test's own "offline before connect" assertion
  // caught — the double must not manufacture the very state under test.
  const registered = new Map<string, string>();
  return {
    isAvailable: () => true,
    registerMachineReplica: async (machineId: string) => {
      const generation = `gate-test-generation-${statusVersion}`;
      registered.set(machineId, generation);
      return generation;
    },
    restoreMachineReplicaGeneration: async (machineId: string, generation: string) => {
      registered.set(machineId, generation);
    },
    unregisterMachineReplica: async (machineId: string) => {
      registered.delete(machineId);
    },
    refreshMachineReplica: async () => {},
    hasMachineReplica: async (machineId: string) => registered.has(machineId),
    getMachineReplicaOwner: async (machineId: string) => (registered.has(machineId) ? "gate-test-replica" : null),
    bumpMachineStatusVersion: async () => {
      statusVersion += 1;
      return statusVersion;
    },
    getMachineStatusVersion: async () => statusVersion,
    acquireWakeLock: async () => true,
    releaseWakeLock: async () => {},
    setAgentActivity: async () => {},
    getAgentActivity: async () => null,
    setAgentRuntimeError: async () => {},
    getAgentRuntimeError: async () => null,
    setMachineMeta: async () => {},
    getMachineMeta: async () => null,
    clearMachineMeta: async () => {},
  };
}

let httpServer: Server;
let port = 0;
let orchestrator: AgentOrchestrator;

function setupStateService() {
  return createServerSetupStateService({
    repository: new DrizzleServerSetupStateRepository(),
    resolveActorRole: (serverId, actor) => getActorServerRoleInServer(serverId, actor.type, actor.id),
    resolveLiveFacts: (serverId, userId) => resolveServerSetupLiveFacts(serverId, userId, orchestrator),
  });
}

async function seedOwner(): Promise<string> {
  const [user] = await getDb()
    .insert(users)
    .values({
      email: `gate-${randomUUID()}@slock.test`,
      name: `gate-${randomUUID()}`,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  return user.id;
}

/** Attach a computer the way the product does: credential row bound to a machine. */
async function attachComputer(serverId: string, userId: string) {
  const { machine } = await registerMachine(serverId, userId, `gate-box-${randomUUID().slice(0, 8)}`);
  const material = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId,
    name: "gate-box",
    apiKeyHash: material.apiKeyHash,
    apiKeyPrefix: material.apiKeyPrefix,
    attachedByUserId: userId,
    machineId: machine.id,
  });
  return { machineId: machine.id, apiKey: material.apiKey };
}

function openDaemonSocket(apiKey: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon/connect`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("daemon socket did not open in time"));
    }, 4000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error(`daemon socket rejected: HTTP ${res.statusCode} ${res.headers["slock-reason"] ?? ""}`));
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function surfaceFor(serverId: string, userId: string): Promise<string> {
  const projection = await setupStateService().resolveServerSetup({
    serverId,
    actor: { type: "user", id: userId },
  });
  return projection.surface;
}

async function waitFor<T>(read: () => Promise<T>, want: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  let last: T = await read();
  while (!want(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  assert.ok(want(last), `${label} (last observed: ${JSON.stringify(last)})`);
  return last;
}

beforeAll(async () => {
  await openTestDatabase("pglite://");
  orchestrator = new AgentOrchestrator(makeAvailableReplicaStateStore());
  httpServer = createServer((_req, res) => res.end());
  setupMachineWebSocket(httpServer, orchestrator);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await closeTestDatabase().catch(() => {});
});

test("setup gate opens only after a computer is BOTH online and has reported runtimes", async () => {
  const userId = await seedOwner();
  const server = await createRaftServer("Gate Co", `gate-${randomUUID()}`, userId);
  const { machineId, apiKey } = await attachComputer(server.id, userId);

  // 1. Attached but nothing connected: the gate is shut.
  assert.equal(await orchestrator.getMachineStatus(machineId), "offline");
  assert.equal(await surfaceFor(server.id, userId), "computer_runtime");

  const socket = await openDaemonSocket(apiKey);
  try {
    // 2. Online but NOT ready.
    //
    // "still computer_runtime" is a NEGATIVE assertion: it would also hold if
    // the socket had silently failed to connect, in which case it would guard
    // nothing. It is therefore paired with a POSITIVE reading taken at the
    // same moment -- the machine must be provably online while the gate is
    // still shut -- so "closed" means "online but not ready" rather than
    // "never came online". (Control required by @Hipp; it is what caught the
    // Playwright harness being structurally unable to run this at all.)
    await waitFor(
      () => orchestrator.getMachineStatus(machineId),
      (status) => status === "online",
      "authenticated daemon socket must register the machine as online",
    );
    const live = await resolveServerSetupLiveFacts(server.id, userId, orchestrator);
    assert.equal(live.computer, "online");
    assert.equal(
      await surfaceFor(server.id, userId),
      "computer_runtime",
      "online alone must NOT open the gate — reported runtimes are a separate condition",
    );

    // 3. Report runtimes over the real protocol; the gate opens.
    socket.send(JSON.stringify({
      type: "ready",
      runtimes: ["claude"],
      runningAgents: [],
      hostname: "gate-box",
      os: "linux",
      daemonVersion: "0.0.0-test",
    }));

    await waitFor(
      () => surfaceFor(server.id, userId),
      (surface) => surface === "create_agent",
      "gate must open once the computer is online AND has runtimes",
    );

    const ready = await resolveServerSetupLiveFacts(server.id, userId, orchestrator);
    assert.equal(ready.computer, "online");
  } finally {
    // Let the disconnect projection finish BEFORE the suite closes the DB.
    // Closing the socket kicks off async agent cleanup inside the orchestrator;
    // racing it against closeDatabase() surfaced a "PGlite is closed" error in
    // the log. Waiting on the observable effect (machine back to offline) keeps
    // teardown deterministic instead of sleeping and hoping.
    socket.close();
    await waitFor(
      () => orchestrator.getMachineStatus(machineId),
      (status) => status === "offline",
      "machine should return to offline once the socket closes",
    ).catch(() => {});
  }
});
