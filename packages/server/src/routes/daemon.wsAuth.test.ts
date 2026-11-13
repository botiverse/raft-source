import { dbTest as test } from "../test/integration/dbTest";
import { openTestDatabase, closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { serverMachineContextCapabilities } from "../runtimeOutcomeOutboxIngest";
import { RAFT_SERVER_CAPABILITIES_HEADER, SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1 } from "@botiverse/raft-shared";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { eq } from "drizzle-orm";
import { WebSocket } from "ws";

import { getDb } from "../db/index";
import { computers, machines, servers, users } from "../db/schema";
import { setupMachineWebSocket } from "./daemon";
import { createServer as createRaftServer, addMember } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import {
  generateComputerApiKeyMaterial,
  extractComputerApiKeyPrefix,
} from "../services/computerCredentialService";
import argon2 from "argon2";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  MACHINE_CONNECT_FAILURES_PER_ADDRESS_MAX,
  MACHINE_CONNECT_RATE_LIMIT_MAX,
  __resetMachineConnectRateLimitForTests,
} from "../services/machineConnectRateLimit";


// task #88 (#wg-raft-computer 2026-06-05): pins the /daemon/connect auth
// observability seam — every accept AND reject branch must (a) return the
// closed-set Slock-Reason, (b) emit a single span that is ended with the
// outcome/reason, and (c) NEVER leak the raw key / sk_computer_* prefix /
// query string into the span or the response.

type CapturedSpan = {
  name: string;
  startAttrs: Record<string, unknown>;
  events: { name: string; attrs?: Record<string, unknown> }[];
  ended: boolean;
  endStatus: string | undefined;
  endAttrs: Record<string, unknown> | undefined;
};

let httpServer: Server;
let port = 0;
const spans: CapturedSpan[] = [];
const registeredPrincipalKinds: string[] = [];

const capturingTracer = {
  startSpan(name: string, options: { attrs?: Record<string, unknown> }) {
    const span: CapturedSpan = {
      name,
      startAttrs: options.attrs ?? {},
      events: [],
      ended: false,
      endStatus: undefined,
      endAttrs: undefined,
    };
    spans.push(span);
    return {
      context: { traceId: "test-trace", spanId: "test-span" },
      addEvent(eventName: string, attrs?: Record<string, unknown>) {
        span.events.push({ name: eventName, attrs });
      },
      end(status?: string, opts?: { attrs?: Record<string, unknown> }) {
        span.ended = true;
        span.endStatus = status;
        span.endAttrs = opts?.attrs;
      },
    };
  },
};

// Task #374: which machine ids the stub treats as held duplicates.
const heldDuplicateMachineIds = new Set<string>();
const handshakeHoldChecks: string[] = [];

const noopOrchestrator = {
  registerMachine: async (...args: unknown[]) => {
    registeredPrincipalKinds.push(String(args[4] ?? "unknown"));
  },
  refuseHeldDuplicateAtHandshake: async (machineId: string) => {
    handshakeHoldChecks.push(machineId);
    return heldDuplicateMachineIds.has(machineId);
  },
  handleMachineMessage: async () => {},
  handleMachineDisconnect: async () => {},
} as unknown as AgentOrchestrator;

async function seedUser(): Promise<string> {
  const db = getDb();
  const [u] = await db
    .insert(users)
    .values({
      email: `ws-${randomUUID()}@slock.test`,
      name: `ws-${randomUUID()}`,
      displayName: "WS Tester",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
    })
    .returning();
  return u.id;
}

type ConnectResult = { status?: number; reason?: string; open?: boolean; firstMessage?: unknown; upgradeHeaders?: Record<string, string | string[] | undefined> };

function attemptConnect(
  key: string | null,
  options: { host?: string; authMode?: "header" | "query"; captureFirstMessage?: boolean } | "header" | "query" = {},
): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const host = typeof options === "string" ? undefined : options.host;
    const authMode = typeof options === "string" ? options : options.authMode ?? "header";
    const captureFirstMessage = typeof options === "string" ? false : options.captureFirstMessage ?? false;
    const query = key === null || authMode !== "query" ? "" : `?key=${encodeURIComponent(key)}`;
    const headers = {
      ...(host ? { host } : {}),
      ...(key !== null && authMode === "header" ? { Authorization: `Bearer ${key}` } : {}),
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon/connect${query}`, { headers });
    let settled = false;
    const finish = (value: ConnectResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error("ws connect timeout"));
      }
    }, 4000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const raw = res.headers["slock-reason"];
      res.resume();
      ws.terminate();
      finish({ status: res.statusCode, reason: Array.isArray(raw) ? raw[0] : raw });
    });
    // task #1268: the 101 response pre-reads the server capabilities for the daemon.
    let upgradeHeaders: Record<string, string | string[] | undefined> = {};
    ws.on("upgrade", (res) => { upgradeHeaders = res.headers; });
    ws.on("open", () => {
      if (!captureFirstMessage) {
        clearTimeout(timer);
        ws.close();
        finish({ open: true, upgradeHeaders });
      }
    });
    ws.on("message", (data) => {
      if (!captureFirstMessage) return;
      clearTimeout(timer);
      ws.close();
      finish({ open: true, upgradeHeaders, firstMessage: JSON.parse(data.toString()) });
    });
    ws.on("error", () => {
      // For a 401 the ws client fires `unexpected-response` then `error`;
      // we already settled there. Only surface errors before settling.
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({});
      }
    });
  });
}

function lastSpan(): CapturedSpan {
  const authSpans = spans.filter((span) => span.name === "server.daemon.connect.auth");
  return authSpans[authSpans.length - 1];
}

// Every reject must end the span with the closed-set outcome/reason/auth_stage
// on the ROOT (end) attrs — ScopeDB aggregates 401s on root attrs, so a stage
// that lives only in an event payload is not enough (o11y contract, Leiysky).
function assertRejectSpanContract(reason: string, stage: string): void {
  const span = lastSpan();
  assert.equal(span.name, "server.daemon.connect.auth");
  assert.equal(span.ended, true);
  assert.equal(span.endStatus, "ok");
  assert.equal(span.endAttrs?.outcome, "rejected");
  assert.equal(span.endAttrs?.reason, reason);
  assert.equal(span.endAttrs?.auth_stage, stage);
}

function assertConnectHostContract(span: CapturedSpan, requestHostClass: string, requestHostPresent: boolean): void {
  assert.equal(span.startAttrs.request_host_class, requestHostClass);
  assert.equal(span.startAttrs.request_host_present, requestHostPresent);
  assert.equal(span.startAttrs.cohort, "unknown");
  assert.equal(span.endAttrs?.request_host_class, requestHostClass);
  assert.equal(span.endAttrs?.request_host_present, requestHostPresent);
  assert.equal(span.endAttrs?.cohort, "unknown");
}

beforeAll(async () => {
  await openTestDatabase("pglite://");
  httpServer = createServer((_req, res) => res.end());
  setupMachineWebSocket(httpServer, noopOrchestrator, capturingTracer as never);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

// Every test starts with fresh connect budgets (they are per key and per address).
beforeEach(() => {
  __resetMachineConnectRateLimitForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  // The exception test below deliberately closes the DB to force a query
  // failure; tolerate a double-close here.
  await closeTestDatabase().catch(() => {});
});

test("missing key → 401 missing_key; span ended rejected", async () => {
  const res = await attemptConnect(null);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "missing_key");
  assertRejectSpanContract("missing_key", "format");
  assertConnectHostContract(lastSpan(), "direct", true);
});

test("unrecognized key format → 401 invalid_key_format", async () => {
  const res = await attemptConnect("not-a-real-key");
  assert.equal(res.status, 401);
  assert.equal(res.reason, "invalid_key_format");
  assertRejectSpanContract("invalid_key_format", "format");
});

test("computer key with no matching row → 401 computer_not_found", async () => {
  const { apiKey } = await generateComputerApiKeyMaterial();
  const res = await attemptConnect(apiKey);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "computer_not_found");
  assertRejectSpanContract("computer_not_found", "computer_lookup");
  assert.equal(lastSpan().startAttrs.api_key_fingerprint !== undefined, true);
});

test("revoked computer attachment → 401 computer_revoked", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Revoked Co", `ws-rev-${randomUUID()}`, userId);
  const { machine } = await registerMachine(server.id, userId, "m");
  const mat = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id,
    name: "revoked-box",
    apiKeyHash: mat.apiKeyHash,
    apiKeyPrefix: mat.apiKeyPrefix,
    attachedByUserId: userId,
    machineId: machine.id,
    revokedAt: new Date(),
  });
  const res = await attemptConnect(mat.apiKey);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "computer_revoked");
  assertRejectSpanContract("computer_revoked", "computer_lookup");
});

test("a revoked key's rejection is remembered: the next attempt gets the same 401 without verifying; an unlinked one is not remembered", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Cache Co", `ws-cache-${randomUUID()}`, userId);
  const { machine } = await registerMachine(server.id, userId, "m");
  const revoked = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id, name: "cached-revoked", apiKeyHash: revoked.apiKeyHash, apiKeyPrefix: revoked.apiKeyPrefix,
    attachedByUserId: userId, machineId: machine.id, revokedAt: new Date(),
  });
  const first = await attemptConnect(revoked.apiKey);
  assert.equal(first.reason, "computer_revoked");
  assert.equal(lastSpan().endAttrs?.rejection_cached, undefined);
  assert.equal(lastSpan().endAttrs?.argon2_verify_count, 1, "the first rejection verifies");
  const second = await attemptConnect(revoked.apiKey);
  assert.equal(second.status, 401);
  assert.equal(second.reason, "computer_revoked", "the daemon sees the same answer");
  assertRejectSpanContract("computer_revoked", "computer_lookup");
  assert.equal(lastSpan().endAttrs?.rejection_cached, true);
  assert.equal(lastSpan().endAttrs?.argon2_verify_count, 0, "no verify for a remembered rejection");

  const unlinked = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id, name: "cached-unlinked", apiKeyHash: unlinked.apiKeyHash, apiKeyPrefix: unlinked.apiKeyPrefix,
    attachedByUserId: userId, machineId: null,
  });
  assert.equal((await attemptConnect(unlinked.apiKey)).reason, "computer_machine_unlinked");
  assert.equal((await attemptConnect(unlinked.apiKey)).reason, "computer_machine_unlinked");
  assert.equal(lastSpan().endAttrs?.rejection_cached, undefined, "a machine can be linked again, so it is verified every time");
});

test("same prefix but non-verifying key → 401 computer_key_hash_mismatch", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Mismatch Co", `ws-mm-${randomUUID()}`, userId);
  const present = await generateComputerApiKeyMaterial();
  const other = await generateComputerApiKeyMaterial();
  // Row carries the PRESENTED key's prefix but a DIFFERENT key's hash → the
  // prefix candidate is found but argon2 verify fails.
  await getDb().insert(computers).values({
    serverId: server.id,
    name: "mismatch-box",
    apiKeyHash: other.apiKeyHash,
    apiKeyPrefix: extractComputerApiKeyPrefix(present.apiKey),
    attachedByUserId: userId,
    machineId: null,
  });
  const res = await attemptConnect(present.apiKey);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "computer_key_hash_mismatch");
  assertRejectSpanContract("computer_key_hash_mismatch", "computer_lookup");
  // The failed verify still costs a pool thread, so it is counted.
  assert.equal(lastSpan().endAttrs?.argon2_verify_count, 1);
});

test("computer attachment with null machineId → 401 computer_machine_unlinked", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Unlinked Co", `ws-ul-${randomUUID()}`, userId);
  const mat = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id,
    name: "unlinked-box",
    apiKeyHash: mat.apiKeyHash,
    apiKeyPrefix: mat.apiKeyPrefix,
    attachedByUserId: userId,
    machineId: null,
  });
  const res = await attemptConnect(mat.apiKey);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "computer_machine_unlinked");
  assertRejectSpanContract("computer_machine_unlinked", "machine_lookup");
});

// `computers.machineId` FKs `daemons.id` with `onDelete: set null`, so a
// DELETED machine NULLS the link rather than leaving it dangling — meaning a
// deleted machine surfaces as `computer_machine_unlinked`, NOT
// `machine_not_found`. (`machine_not_found` stays in the code as a defensive
// branch for a read/delete race; it is not DB-constructible here, which is why
// there is no positive test for it.) This pins the REAL reachable behaviour —
// directly relevant to the task #88 RCA: "machine 81e8abd0 deleted" would show
// up as computer_machine_unlinked in the new trace.
test("deleting the linked machine nulls machineId (FK) → 401 computer_machine_unlinked", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("DeleteMachine Co", `ws-dm-${randomUUID()}`, userId);
  const { machine } = await registerMachine(server.id, userId, "doomed-m");
  const mat = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id,
    name: "fk-box",
    apiKeyHash: mat.apiKeyHash,
    apiKeyPrefix: mat.apiKeyPrefix,
    attachedByUserId: userId,
    machineId: machine.id,
  });
  await getDb().delete(machines).where(eq(machines.id, machine.id));
  const res = await attemptConnect(mat.apiKey);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "computer_machine_unlinked");
  assertRejectSpanContract("computer_machine_unlinked", "machine_lookup");
});

test("legacy sk_machine_* key that is migrated → 401 legacy_machine_key_migrated", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Legacy Co", `ws-lg-${randomUUID()}`, userId);
  const { machine, apiKey } = await registerMachine(server.id, userId, "legacy-m");
  await getDb()
    .update(machines)
    .set({ legacyKeyMigratedAt: new Date() })
    .where(eq(machines.id, machine.id));
  const res = await attemptConnect(apiKey);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "legacy_machine_key_migrated");
  assertRejectSpanContract("legacy_machine_key_migrated", "legacy_migration");
});

test("live attachment whose server is soft-deleted → 401 server_not_found", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Soon-Deleted Co", `ws-sd-${randomUUID()}`, userId);
  const { machine } = await registerMachine(server.id, userId, "sd-m");
  const mat = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id,
    name: "sd-box",
    apiKeyHash: mat.apiKeyHash,
    apiKeyPrefix: mat.apiKeyPrefix,
    attachedByUserId: userId,
    machineId: machine.id,
  });
  await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, server.id));
  const res = await attemptConnect(mat.apiKey);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "server_not_found");
  assertRejectSpanContract("server_not_found", "computer_lookup");
});

test("valid computer attachment → 101 accepted; span carries ids, never the key", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Live Co", `ws-live-${randomUUID()}`, userId);
  await addMember(server.id, userId, "owner");
  const { machine } = await registerMachine(server.id, userId, "live-m");
  const mat = await generateComputerApiKeyMaterial();
  const [row] = await getDb()
    .insert(computers)
    .values({
      serverId: server.id,
      name: "live-box",
      apiKeyHash: mat.apiKeyHash,
      apiKeyPrefix: mat.apiKeyPrefix,
      attachedByUserId: userId,
      machineId: machine.id,
    })
    .returning({ id: computers.id });

  const res = await attemptConnect(mat.apiKey, {
    host: "api.slock.ai",
    captureFirstMessage: true,
  });
  assert.equal(res.open, true);
  assert.deepEqual(res.firstMessage, {
    type: "machine:context",
    machineId: machine.id,
    serverId: server.id,
    // task #1268: the server always advertises ready-before-detection.
    capabilities: serverMachineContextCapabilities(),
  });
  const span = lastSpan();
  assert.equal(span.ended, true);
  assert.equal(span.endAttrs?.outcome, "accepted");
  assert.equal(span.endAttrs?.machine_id, machine.id);
  assert.equal(span.endAttrs?.server_id, server.id);
  // One argon2 verify for the one prefix candidate; its wall time is on the root.
  assert.equal(span.endAttrs?.argon2_verify_count, 1);
  assert.equal(typeof span.endAttrs?.argon2_verify_ms_total, "number");
  assert.equal(span.endAttrs?.argon2_verify_ms_max, span.endAttrs?.argon2_verify_ms_total);
  assertConnectHostContract(span, "api_slock_ai", true);
  const acceptEvent = span.events.find((e) => e.name === "auth.accepted");
  assert.ok(acceptEvent);
  assert.equal(acceptEvent?.attrs?.machine_id, machine.id);
  assert.equal(acceptEvent?.attrs?.server_id, server.id);
  assert.equal(acceptEvent?.attrs?.computer_id, row.id);
  assert.equal(registeredPrincipalKinds.at(-1), "computer");

  // No-secret-leak: the entire captured span must not contain the raw key,
  // the sk_computer_ prefix, or the ?key= query string.
  const dump = JSON.stringify(span);
  assert.equal(dump.includes(mat.apiKey), false);
  assert.equal(dump.includes("sk_computer_"), false);
  assert.equal(dump.includes("?key="), false);
  // The correlation handle is the irreversible fingerprint, present + non-key.
  assert.equal(typeof span.startAttrs.api_key_fingerprint, "string");
});

// Task #374: a held duplicate must be refused before the upgrade. A daemon
// resets its reconnect backoff when a socket opens, so an after-open close
// makes an old daemon retry at once; a rejected handshake never opens.
test("task #374: a held duplicate machine is refused with 409 before the upgrade and never registers", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Dup Co", `ws-dup-${randomUUID()}`, userId);
  await addMember(server.id, userId, "owner");
  const { machine } = await registerMachine(server.id, userId, "dup-m");
  const mat = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id,
    name: "dup-box",
    apiKeyHash: mat.apiKeyHash,
    apiKeyPrefix: mat.apiKeyPrefix,
    attachedByUserId: userId,
    machineId: machine.id,
  });
  heldDuplicateMachineIds.add(machine.id);
  const registeredBefore = registeredPrincipalKinds.length;
  try {
    const res = await attemptConnect(mat.apiKey);
    assert.equal(res.status, 409);
    assert.equal(res.reason, "duplicate_machine_connection_held");
    assert.notEqual(res.open, true, "the socket never opens, so the daemon's backoff is not reset");
    assert.equal(registeredPrincipalKinds.length, registeredBefore, "nothing is registered or replaced");
    assert.ok(handshakeHoldChecks.includes(machine.id));
    const span = lastSpan();
    assert.equal(span.endAttrs?.outcome, "refused");
    assert.equal(span.endAttrs?.reason, "duplicate_machine_connection_held");
    assert.equal(span.endAttrs?.machine_id, machine.id);
    assert.doesNotMatch(JSON.stringify(span), new RegExp(mat.apiKey));
  } finally {
    heldDuplicateMachineIds.delete(machine.id);
  }

  // Control: once the hold is gone the same key upgrades normally.
  const ok = await attemptConnect(mat.apiKey);
  assert.equal(ok.open, true);
});

test("argon2 cost on the auth span: 0 when no candidate, 1 on a legacy key's first connect, 0 from the auth cache", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Argon2 Cost Co", `ws-a2-${randomUUID()}`, userId);
  await addMember(server.id, userId, "owner");

  const unknown = await generateComputerApiKeyMaterial();
  const miss = await attemptConnect(unknown.apiKey);
  assert.equal(miss.reason, "computer_not_found");
  assert.equal(lastSpan().endAttrs?.argon2_verify_count, 0);
  assert.equal(lastSpan().endAttrs?.argon2_verify_ms_total, 0);

  const { apiKey } = await registerMachine(server.id, userId, "argon2-cost-m");
  assert.equal((await attemptConnect(apiKey)).open, true);
  assert.equal(lastSpan().endAttrs?.outcome, "accepted");
  assert.equal(lastSpan().endAttrs?.argon2_verify_count, 1);
  assert.equal((await attemptConnect(apiKey)).open, true);
  assert.equal(lastSpan().endAttrs?.argon2_verify_count, 0);
});

test("legacy query-string key remains accepted during daemon rollout", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Legacy Query Co", `ws-lq-${randomUUID()}`, userId);
  await addMember(server.id, userId, "owner");
  const { apiKey } = await registerMachine(server.id, userId, "legacy-query-m");

  const res = await attemptConnect(apiKey, "query");
  assert.equal(res.open, true);
  assert.equal(lastSpan().endAttrs?.outcome, "accepted");
  assert.equal(registeredPrincipalKinds.at(-1), "legacy_machine");
});

test("task #1268: the accepted 101 response carries Raft-Server-Capabilities with runtime-detection-async-v1, matching machine:context", async () => {
  const userId = await seedUser();
  const server = await createRaftServer("Live Co", `ws-caps-${randomUUID()}`, userId);
  await addMember(server.id, userId, "owner");
  const { machine } = await registerMachine(server.id, userId, "caps-m");
  const mat = await generateComputerApiKeyMaterial();
  await getDb()
    .insert(computers)
    .values({
      serverId: server.id,
      name: "caps-box",
      apiKeyHash: mat.apiKeyHash,
      apiKeyPrefix: mat.apiKeyPrefix,
      attachedByUserId: userId,
      machineId: machine.id,
    });

  const res = await attemptConnect(mat.apiKey, { host: "api.slock.ai", captureFirstMessage: true });
  assert.equal(res.open, true);
  const raw = res.upgradeHeaders?.[RAFT_SERVER_CAPABILITIES_HEADER];
  const headerCaps = (Array.isArray(raw) ? raw.join(" ") : raw ?? "").split(/\s+/).filter(Boolean);
  assert.ok(headerCaps.includes(SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1), `header should declare the capability, got ${JSON.stringify(raw)}`);
  const context = res.firstMessage as { type: string; capabilities?: string[] };
  assert.equal(context.type, "machine:context");
  assert.deepEqual([...headerCaps].sort(), [...(context.capabilities ?? [])].sort(), "header and machine:context declare the same list");
});

async function seedLiveComputerKey(label: string): Promise<{ apiKey: string; machineId: string }> {
  const userId = await seedUser();
  const server = await createRaftServer(`Loop ${label}`, `ws-loop-${label}-${randomUUID()}`, userId);
  await addMember(server.id, userId, "owner");
  const { machine } = await registerMachine(server.id, userId, `loop-${label}`);
  const mat = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id, name: `loop-${label}`, apiKeyHash: mat.apiKeyHash, apiKeyPrefix: mat.apiKeyPrefix,
    attachedByUserId: userId, machineId: machine.id,
  });
  return { apiKey: mat.apiKey, machineId: machine.id };
}

test("2026-10-20 incident: two daemons sharing one key in a reconnect loop are capped before any credential work", async () => {
  const { apiKey } = await seedLiveComputerKey("pair");
  const argon2Before = spans.filter((span) => span.name === "server.daemon.connect.auth" && (span.endAttrs?.argon2_verify_count as number) > 0).length;
  // Two daemons on one host kick each other off and reconnect at once: 40 attempts back to back.
  const results: ConnectResult[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) results.push(await attemptConnect(apiKey));
  const opened = results.filter((result) => result.open).length;
  const limited = results.filter((result) => result.status === 429);
  assert.equal(opened, MACHINE_CONNECT_RATE_LIMIT_MAX, "only the window's budget reaches the server");
  assert.equal(limited.length, 40 - MACHINE_CONNECT_RATE_LIMIT_MAX);
  assert.ok(limited.every((result) => result.reason === "connect_rate_limited"));
  const limitedSpans = spans.filter((span) => span.name === "server.daemon.connect.auth" && span.endAttrs?.outcome === "rate_limited");
  assert.ok(limitedSpans.length >= limited.length);
  assert.ok(limitedSpans.every((span) => span.endAttrs?.argon2_verify_count === undefined), "a refused attempt never verifies the key");
  const argon2After = spans.filter((span) => span.name === "server.daemon.connect.auth" && (span.endAttrs?.argon2_verify_count as number) > 0).length;
  assert.ok(argon2After - argon2Before <= MACHINE_CONNECT_RATE_LIMIT_MAX, "argon2 runs at most once per admitted attempt");

  // Another machine's key is unaffected by this key's loop.
  const other = await seedLiveComputerKey("other");
  assert.equal((await attemptConnect(other.apiKey)).open, true);
});

test("429 carries Retry-After; random keys from one address are capped by failed verifications", async () => {
  // Random, invalid keys: each a fresh key budget, so only the failure budget stops them.
  const statuses: number[] = [];
  let retryAfter: string | undefined;
  for (let attempt = 0; attempt < MACHINE_CONNECT_FAILURES_PER_ADDRESS_MAX + 5; attempt += 1) {
    const res = await new Promise<{ status: number; retryAfter?: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon/connect`, { headers: { Authorization: `Bearer sk_computer_${randomUUID().replace(/-/g, "")}` } });
      ws.on("unexpected-response", (_req, response) => {
        const value = response.headers["retry-after"];
        response.resume();
        ws.terminate();
        resolve({ status: response.statusCode ?? 0, retryAfter: Array.isArray(value) ? value[0] : value });
      });
      ws.on("open", () => { ws.close(); resolve({ status: 101 }); });
      ws.on("error", () => {});
    });
    statuses.push(res.status);
    if (res.status === 429) retryAfter = res.retryAfter;
  }
  assert.equal(statuses.filter((status) => status === 401).length, MACHINE_CONNECT_FAILURES_PER_ADDRESS_MAX);
  assert.equal(statuses.filter((status) => status === 429).length, 5);
  assert.ok(Number(retryAfter) >= 1, "Retry-After names whole seconds");
});

test("a key that verified before still connects from an address whose failure budget is spent", async () => {
  const { apiKey } = await seedLiveComputerKey("verified");
  assert.equal((await attemptConnect(apiKey)).open, true, "verifies once");
  for (let attempt = 0; attempt < MACHINE_CONNECT_FAILURES_PER_ADDRESS_MAX; attempt += 1) {
    await attemptConnect(`sk_computer_${randomUUID().replace(/-/g, "")}`);
  }
  const random = await attemptConnect(`sk_computer_${randomUUID().replace(/-/g, "")}`);
  assert.equal(random.status, 429, "the address budget is spent for unknown keys");
  assert.equal(random.reason, "auth_failure_rate_limited");
  assert.equal((await attemptConnect(apiKey)).open, true, "the verified key passes it");
  const fresh = await seedLiveComputerKey("never-verified");
  assert.equal((await attemptConnect(fresh.apiKey)).status, 429, "a valid key that never verified from here waits like any other");
});

// MUST be the last test: it closes the DB to force the auth lookup to throw,
// exercising the exception branch (500). The `afterAll` hook tolerates the
// already-closed DB.
test("auth resolution throws → 500; span ended outcome=error reason=exception, no leak", async () => {
  const { apiKey } = await generateComputerApiKeyMaterial();
  await closeTestDatabase();
  const res = await attemptConnect(apiKey);
  assert.equal(res.status, 500);
  const span = lastSpan();
  assert.equal(span.ended, true);
  assert.equal(span.endStatus, "error");
  assert.equal(span.endAttrs?.outcome, "error");
  assert.equal(span.endAttrs?.reason, "exception");
  assert.equal(span.endAttrs?.auth_stage, "exception");
  const dump = JSON.stringify(span);
  assert.equal(dump.includes(apiKey), false);
  assert.equal(dump.includes("sk_computer_"), false);
});

