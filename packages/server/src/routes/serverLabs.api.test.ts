import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  labDefinitions,
  serverAgentMembers,
  serverLabAccess,
  serverLabAuditEvents,
  serverLabEnrollments,
  serverMembers,
  users,
} from "../db/schema.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { createAgent } from "../services/agentService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function createUser(prefix: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${prefix}-${suffix}@slock.test`,
    name: `${prefix}-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function humanHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

function agentHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

test("Server Labs API enforces human/agent role parity, one cursor CAS, no-op, audit, and readback", async ({ app }) => {
  const db = getDb();
  const [owner, admin, member, outsider] = await Promise.all([
    createUser("labs-owner"),
    createUser("labs-admin"),
    createUser("labs-member"),
    createUser("labs-outsider"),
  ]);
  const server = await createServer("Labs API", `labs-api-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  await db.insert(labDefinitions).values([
    { key: "open_lab", name: "Open Lab", description: "Available", state: "open" },
    { key: "paused_lab", name: "Paused Lab", description: "Paused", state: "paused" },
    { key: "draft_lab", name: "Draft Lab", description: "Hidden", state: "draft" },
    { key: "retired_lab", name: "Retired Lab", description: "Historical", state: "retired" },
  ]);

  const [ownerToken, adminToken, memberToken, outsiderToken] = await Promise.all([
    login(app.baseUrl, owner.email),
    login(app.baseUrl, admin.email),
    login(app.baseUrl, member.email),
    login(app.baseUrl, outsider.email),
  ]);
  const labsUrl = `${app.baseUrl}/api/servers/${server.id}/labs`;

  const unauthenticated = await fetch(labsUrl, { headers: { "X-Server-Id": server.id } });
  assert.equal(unauthenticated.status, 401);

  const crossServer = await fetch(labsUrl, {
    headers: humanHeaders(ownerToken, randomUUID()),
  });
  assert.equal(crossServer.status, 403);
  assert.equal(((await crossServer.json()) as { code: string }).code, "server_scope_forbidden");

  const outsiderRead = await fetch(labsUrl, { headers: humanHeaders(outsiderToken, server.id) });
  assert.equal(outsiderRead.status, 403);

  const memberRead = await fetch(labsUrl, { headers: humanHeaders(memberToken, server.id) });
  assert.equal(memberRead.status, 200, await memberRead.clone().text());
  const initial = await memberRead.json() as {
    accessEnabled: boolean;
    version: number;
    canManageAccess: boolean;
    canManageEnrollments: boolean;
    labs: Array<{ labKey: string; enrolled: boolean; effective: boolean }>;
  };
  assert.equal(initial.accessEnabled, false);
  assert.equal(initial.version, 0);
  assert.equal(initial.canManageAccess, false);
  assert.equal(initial.canManageEnrollments, false);
  assert.deepEqual(initial.labs.map((lab) => lab.labKey), ["open_lab", "paused_lab"]);

  const adminMaster = await fetch(`${labsUrl}/access`, {
    method: "PATCH",
    headers: humanHeaders(adminToken, server.id),
    body: JSON.stringify({ enabled: true, expectedVersion: 0 }),
  });
  assert.equal(adminMaster.status, 403);

  const ownerMaster = await fetch(`${labsUrl}/access`, {
    method: "PATCH",
    headers: { ...humanHeaders(ownerToken, server.id), "X-Request-Id": "human-master-on" },
    body: JSON.stringify({ enabled: true, expectedVersion: 0 }),
  });
  assert.equal(ownerMaster.status, 200, await ownerMaster.clone().text());
  const masterOn = await ownerMaster.json() as { applied: boolean; version: number; accessEnabled: boolean };
  assert.equal(masterOn.applied, true);
  assert.equal(masterOn.version, 1);
  assert.equal(masterOn.accessEnabled, true);

  const sameMaster = await fetch(`${labsUrl}/access`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: true, expectedVersion: 1 }),
  });
  assert.equal(sameMaster.status, 200);
  assert.equal(((await sameMaster.json()) as { applied: boolean }).applied, false);

  const staleMaster = await fetch(`${labsUrl}/access`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: false, expectedVersion: 0 }),
  });
  assert.equal(staleMaster.status, 409);
  assert.deepEqual(await staleMaster.json(), {
    error: "Server Labs version changed",
    code: "server_labs_version_conflict",
    currentVersion: 1,
  });

  const memberEnrollment = await fetch(`${labsUrl}/open_lab`, {
    method: "PUT",
    headers: humanHeaders(memberToken, server.id),
    body: JSON.stringify({ enabled: true, expectedVersion: 1 }),
  });
  assert.equal(memberEnrollment.status, 403);

  const adminEnrollment = await fetch(`${labsUrl}/open_lab`, {
    method: "PUT",
    headers: { ...humanHeaders(adminToken, server.id), "X-Request-Id": "human-enroll-on" },
    body: JSON.stringify({ enabled: true, expectedVersion: 1 }),
  });
  assert.equal(adminEnrollment.status, 200, await adminEnrollment.clone().text());
  const enrolled = await adminEnrollment.json() as {
    applied: boolean;
    version: number;
    labs: Array<{
      labKey: string;
      name: string;
      description: string;
      state: string;
      enrolled: boolean;
      effective: boolean;
      updatedAt: string | null;
    }>;
  };
  assert.equal(enrolled.applied, true);
  assert.equal(enrolled.version, 2);
  const openLab = enrolled.labs.find((lab) => lab.labKey === "open_lab");
  assert.ok(openLab);
  assert.deepEqual(openLab, {
    labKey: "open_lab",
    name: "Open Lab",
    description: "Available",
    state: "open",
    enrolled: true,
    effective: true,
    updatedAt: openLab.updatedAt,
  });

  const sameEnrollment = await fetch(`${labsUrl}/open_lab`, {
    method: "PUT",
    headers: humanHeaders(adminToken, server.id),
    body: JSON.stringify({ enabled: true, expectedVersion: 2 }),
  });
  assert.equal(sameEnrollment.status, 200, await sameEnrollment.clone().text());
  const sameEnrollmentReadback = await sameEnrollment.json() as {
    applied: boolean;
    version: number;
  };
  assert.equal(sameEnrollmentReadback.applied, false);
  assert.equal(sameEnrollmentReadback.version, 2);

  const staleEnrollmentNoOp = await fetch(`${labsUrl}/open_lab`, {
    method: "PUT",
    headers: humanHeaders(adminToken, server.id),
    body: JSON.stringify({ enabled: true, expectedVersion: 1 }),
  });
  assert.equal(staleEnrollmentNoOp.status, 409);
  assert.equal(
    ((await staleEnrollmentNoOp.json()) as { currentVersion: number }).currentVersion,
    2,
  );

  const pausedWrite = await fetch(`${labsUrl}/paused_lab`, {
    method: "PUT",
    headers: humanHeaders(adminToken, server.id),
    body: JSON.stringify({ enabled: true, expectedVersion: 2 }),
  });
  assert.equal(pausedWrite.status, 409);
  assert.equal(((await pausedWrite.json()) as { code: string }).code, "lab_not_open");

  const masterOff = await fetch(`${labsUrl}/access`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ enabled: false, expectedVersion: 2 }),
  });
  assert.equal(masterOff.status, 200);
  const offReadback = await masterOff.json() as {
    version: number;
    labs: Array<{ labKey: string; enrolled: boolean; effective: boolean }>;
  };
  assert.equal(offReadback.version, 3);
  assert.equal(offReadback.labs.find((lab) => lab.labKey === "open_lab")?.enrolled, true);
  assert.equal(offReadback.labs.find((lab) => lab.labKey === "open_lab")?.effective, false);

  const enrollmentWhileDisabled = await fetch(`${labsUrl}/open_lab`, {
    method: "PUT",
    headers: humanHeaders(adminToken, server.id),
    body: JSON.stringify({ enabled: false, expectedVersion: 3 }),
  });
  assert.equal(enrollmentWhileDisabled.status, 409);
  assert.equal(
    ((await enrollmentWhileDisabled.json()) as { code: string }).code,
    "server_labs_access_disabled",
  );

  const agent = await createAgent(server.id, "labs-owner-agent", { runtime: "codex", model: "gpt-5" });
  await db.update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, agent.id)));
  const agentCredential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read", "server"],
    name: "labs-api-agent",
    createdByUserId: owner.id,
  });
  const readOnlyAgentCredential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read"],
    name: "labs-api-read-only-agent",
    createdByUserId: owner.id,
  });

  const unauthenticatedAgentRead = await fetch(`${app.baseUrl}/internal/agent-api/labs`);
  assert.equal(unauthenticatedAgentRead.status, 401);

  const agentRead = await fetch(`${app.baseUrl}/internal/agent-api/labs`, {
    headers: agentHeaders(agentCredential.apiKey),
  });
  assert.equal(agentRead.status, 200, await agentRead.clone().text());
  const agentReadback = await agentRead.json() as {
    version: number;
    canManageAccess: boolean;
    canManageEnrollments: boolean;
  };
  assert.equal(agentReadback.version, 3);
  assert.equal(agentReadback.canManageAccess, false);
  assert.equal(agentReadback.canManageEnrollments, true);

  const agentMasterForbidden = await fetch(`${app.baseUrl}/internal/agent-api/labs/access`, {
    method: "PATCH",
    headers: { ...agentHeaders(agentCredential.apiKey), "X-Request-Id": "agent-master-on" },
    body: JSON.stringify({ enabled: true, expectedVersion: 3 }),
  });
  assert.equal(agentMasterForbidden.status, 403);

  const ownerMasterAgain = await fetch(`${labsUrl}/access`, {
    method: "PATCH",
    headers: { ...humanHeaders(ownerToken, server.id), "X-Request-Id": "human-master-on-again" },
    body: JSON.stringify({ enabled: true, expectedVersion: 3 }),
  });
  assert.equal(ownerMasterAgain.status, 200, await ownerMasterAgain.clone().text());
  assert.equal(((await ownerMasterAgain.json()) as { version: number }).version, 4);

  const readOnlyAgentMutation = await fetch(`${app.baseUrl}/internal/agent-api/labs/open_lab`, {
    method: "PUT",
    headers: agentHeaders(readOnlyAgentCredential.apiKey),
    body: JSON.stringify({ enabled: false, expectedVersion: 4 }),
  });
  assert.equal(readOnlyAgentMutation.status, 403);

  const concurrent = await Promise.all([
    fetch(`${app.baseUrl}/internal/agent-api/labs/open_lab`, {
      method: "PUT",
      headers: { ...agentHeaders(agentCredential.apiKey), "X-Request-Id": "agent-enroll-off-a" },
      body: JSON.stringify({ enabled: false, expectedVersion: 4 }),
    }),
    fetch(`${app.baseUrl}/internal/agent-api/labs/open_lab`, {
      method: "PUT",
      headers: { ...agentHeaders(agentCredential.apiKey), "X-Request-Id": "agent-enroll-off-b" },
      body: JSON.stringify({ enabled: false, expectedVersion: 4 }),
    }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);

  const [access] = await db.select().from(serverLabAccess).where(eq(serverLabAccess.serverId, server.id));
  assert.equal(access.version, 5);
  const [enrollment] = await db.select().from(serverLabEnrollments).where(and(
    eq(serverLabEnrollments.serverId, server.id),
    eq(serverLabEnrollments.labKey, "open_lab"),
  ));
  assert.equal(enrollment.enabled, false);
  assert.equal(enrollment.version, 5);

  const audit = await db.select().from(serverLabAuditEvents)
    .where(eq(serverLabAuditEvents.serverId, server.id))
    .orderBy(asc(serverLabAuditEvents.versionAfter));
  assert.deepEqual(audit.map((row) => ({
    versionBefore: row.versionBefore,
    versionAfter: row.versionAfter,
    actorType: row.actorType,
    actorId: row.actorId,
    requestId: row.requestId,
    operation: row.operation,
    labKey: row.labKey,
  })), [
    { versionBefore: 0, versionAfter: 1, actorType: "human", actorId: owner.id, requestId: "human-master-on", operation: "master_access_set", labKey: null },
    { versionBefore: 1, versionAfter: 2, actorType: "human", actorId: admin.id, requestId: "human-enroll-on", operation: "enrollment_set", labKey: "open_lab" },
    { versionBefore: 2, versionAfter: 3, actorType: "human", actorId: owner.id, requestId: audit[2].requestId, operation: "master_access_set", labKey: null },
    { versionBefore: 3, versionAfter: 4, actorType: "human", actorId: owner.id, requestId: "human-master-on-again", operation: "master_access_set", labKey: null },
    { versionBefore: 4, versionAfter: 5, actorType: "agent", actorId: agent.id, requestId: audit[4].requestId, operation: "enrollment_set", labKey: "open_lab" },
  ]);
  assert.match(audit[2].requestId, /^[0-9a-f-]{36}$/);
  assert.ok(
    ["agent-enroll-off-a", "agent-enroll-off-b"].includes(audit[4].requestId),
    "the winning concurrent request id is preserved as correlation evidence",
  );
});
