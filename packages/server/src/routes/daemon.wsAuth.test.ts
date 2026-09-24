import { dbTest as test } from "../test/integration/dbTest.js";
import { openTestDatabase, closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll } from "vitest";

import { eq } from "drizzle-orm";
import { WebSocket } from "ws";

import { getDb } from "../db/index.js";
import { computers, machines, servers, users } from "../db/schema.js";
import { setupMachineWebSocket } from "./daemon.js";
import { createServer as createRaftServer, addMember } from "../services/serverService.js";
import { registerMachine } from "../services/machineService.js";
import {
  generateComputerApiKeyMaterial,
  extractComputerApiKeyPrefix,
} from "../services/computerCredentialService.js";
import argon2 from "argon2";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";


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

const noopOrchestrator = {
  registerMachine: async (...args: unknown[]) => {
    registeredPrincipalKinds.push(String(args[4] ?? "unknown"));
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

type ConnectResult = { status?: number; reason?: string; open?: boolean; firstMessage?: unknown };

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
    ws.on("open", () => {
      if (!captureFirstMessage) {
        clearTimeout(timer);
        ws.close();
        finish({ open: true });
      }
    });
    ws.on("message", (data) => {
      if (!captureFirstMessage) return;
      clearTimeout(timer);
      ws.close();
      finish({ open: true, firstMessage: JSON.parse(data.toString()) });
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
  return spans[spans.length - 1];
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
  });
  const span = lastSpan();
  assert.equal(span.ended, true);
  assert.equal(span.endAttrs?.outcome, "accepted");
  assert.equal(span.endAttrs?.machine_id, machine.id);
  assert.equal(span.endAttrs?.server_id, server.id);
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
