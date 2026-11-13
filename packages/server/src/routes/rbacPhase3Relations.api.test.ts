// RBAC Phase 3, slice 1 (task #90): exact-object Agent creator / Machine registrant authority across
// demotion and Server departure. Rows from the transition matrix v0.2: R01 (Member half only — the Guest
// half is a parked product decision), R02, R03 (Member), R04, and S11's "relations grant nothing without
// Server membership". Every denial is paired with a still-authorized positive control so a universal
// deny cannot pass.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { createChannel } from "../services/channelService";
import { registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { accessTokenForTest, fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: label,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** Owner plus one related human who starts as `startRole`. */
async function seedRelation(label: string, startRole: "admin" | "member") {
  const owner = await seedUser(`${label}-owner`);
  const related = await seedUser(`${label}-related`);
  const server = await createServer(label, `${label}-${randomUUID()}`, owner.id);
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: related.id, role: startRole });
  return {
    owner,
    related,
    server,
    ownerToken: await tokenForHuman(owner.email),
    relatedToken: await tokenForHuman(related.email),
  };
}

function authHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

async function setServerRole(serverId: string, userId: string, role: "member") {
  await getDb().update(serverMembers).set({ role }).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
}

/** Departs through the real HTTP surface so route-level cleanup and socket revocation run. */
async function depart(
  baseUrl: string,
  how: "removed" | "left",
  ctx: { server: { id: string }; related: { id: string }; ownerToken: string; relatedToken: string },
) {
  const response = how === "removed"
    ? await fetch(`${baseUrl}/api/servers/${ctx.server.id}/members/${ctx.related.id}`, {
      method: "DELETE",
      headers: authHeaders(ctx.ownerToken, ctx.server.id),
    })
    : await fetch(`${baseUrl}/api/servers/${ctx.server.id}/leave`, {
      method: "POST",
      headers: authHeaders(ctx.relatedToken, ctx.server.id),
      body: JSON.stringify({}),
    });
  assert.ok(response.status >= 200 && response.status < 300, `${how} must succeed, got ${response.status}`);
  const [membership] = await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, ctx.server.id), eq(serverMembers.userId, ctx.related.id)));
  assert.equal(membership, undefined, `${how} must delete the Server membership row`);
}

// R01 (Member half): demotion keeps the exact Agent bundle, and only for that Agent.
test("R01: an Agent creator demoted from Admin to Member keeps managing that exact Agent and gains no other Agent", async ({ app }) => {
  const ctx = await seedRelation("p3-r01", "admin");
  const own = await createAgent(ctx.server.id, "p3-r01-own", { runtime: "codex", creatorType: "user", creatorId: ctx.related.id });
  const other = await createAgent(ctx.server.id, "p3-r01-other", { runtime: "codex", creatorType: "user", creatorId: ctx.owner.id });
  await setServerRole(ctx.server.id, ctx.related.id, "member");
  const headers = authHeaders(ctx.relatedToken, ctx.server.id);
  const call = (method: string, path: string, body?: unknown) => fetch(`${app.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const patchOwn = await call("PATCH", `/api/agents/${own.id}`, { description: "still mine after demotion" });
  assert.equal(patchOwn.status, 200, "agent.update via exact creator relation");
  assert.equal((await patchOwn.json() as { description: string | null }).description, "still mine after demotion");
  assert.equal((await call("POST", `/api/agents/${own.id}/stop`, {})).status, 200, "agent.runtime.controlProcess on own Agent");
  assert.equal((await call("POST", `/api/agents/${own.id}/reset`, { mode: "full" })).status, 202, "agent.workspace.reset on own Agent");
  // Credentials are issued only for external Agents; the creator relation is what is under test here.
  const ownExternal = await createAgent(ctx.server.id, "p3-r01-own-ext", { runtime: "external", model: "external", creatorType: "user", creatorId: ctx.related.id });
  assert.equal((await call("POST", `/api/agents/${ownExternal.id}/credentials`, {})).status, 201, "agentCredential.issue on own Agent");
  assert.equal((await call("POST", `/api/agents/${own.id}/credentials`, {})).status, 400, "managed Agents never get an sk_agent_* from a session");

  // Member role alone grants none of these on someone else's Agent (truth table 3.2).
  assert.equal((await call("PATCH", `/api/agents/${other.id}`, { description: "must not widen" })).status, 403);
  assert.equal((await call("POST", `/api/agents/${other.id}/reset`, { mode: "full" })).status, 403);
  assert.equal((await call("DELETE", `/api/agents/${other.id}`)).status, 403);
  assert.equal((await call("POST", `/api/agents/${other.id}/credentials`, {})).status, 403);
  const [otherAfter] = await getDb().select().from(agents).where(eq(agents.id, other.id));
  assert.ok(otherAfter && otherAfter.deletedAt === null && otherAfter.description !== "must not widen", "denied writes changed nothing");

  assert.equal((await call("DELETE", `/api/agents/${own.id}`)).status, 200, "agent.delete on own Agent");
});

// R02 + S11: departure revokes every exact Agent authority; an authorized actor is unaffected.
for (const how of ["removed", "left"] as const) {
  test(`R02: an Agent creator who ${how === "removed" ? "is removed from" : "leaves"} the Server loses every exact Agent authority`, async ({ app }) => {
    const ctx = await seedRelation(`p3-r02-${how}`, "member");
    const agent = await createAgent(ctx.server.id, `p3-r02-${how}`, { runtime: "codex", creatorType: "user", creatorId: ctx.related.id });
    const staleHeaders = authHeaders(ctx.relatedToken, ctx.server.id);
    const stale = (method: string, path: string, body?: unknown) => fetch(`${app.baseUrl}${path}`, {
      method,
      headers: staleHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Pre-transition: the relation is live, so the later denials cannot be a pre-existing universal deny.
    assert.equal((await stale("PATCH", `/api/agents/${agent.id}`, { description: "before departure" })).status, 200);

    await depart(app.baseUrl, how, ctx);

    for (const [method, path, body] of [
      ["PATCH", `/api/agents/${agent.id}`, { description: "after departure" }],
      ["POST", `/api/agents/${agent.id}/stop`, {}],
      ["POST", `/api/agents/${agent.id}/reset`, { mode: "full" }],
      ["POST", `/api/agents/${agent.id}/migrate`, {}],
      ["DELETE", `/api/agents/${agent.id}`, undefined],
    ] as const) {
      const response = await stale(method, path, body);
      // Denied by the membership guard itself, not by a creator/capability check that could mask a missing guard.
      assert.equal(response.status, 403, `${method} ${path} must deny a departed creator`);
      assert.equal((await response.json() as { error: string }).error, "Not a member of this server");
    }
    // Credential routes resolve Server context from the Agent and cloak non-members as a missing Agent.
    for (const method of ["POST", "GET"] as const) {
      const response = await stale(method, `/api/agents/${agent.id}/credentials`, method === "POST" ? {} : undefined);
      assert.equal(response.status, 404, `${method} credentials must deny a departed creator`);
      assert.equal((await response.json() as { code: string }).code, "agent_missing");
    }

    // The relation itself is untouched: authority ended because membership ended, not because the row changed.
    const [row] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
    assert.equal(row?.creatorId, ctx.related.id);
    assert.equal(row?.deletedAt, null);
    assert.equal(row?.description, "before departure", "no denied write committed");

    // Positive control: a still-authorized actor keeps full management of the same Agent.
    const ownerPatch = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: authHeaders(ctx.ownerToken, ctx.server.id),
      body: JSON.stringify({ description: "owner after departure" }),
    });
    assert.equal(ownerPatch.status, 200);
  });
}

// R03 (Member half): demotion keeps the exact Machine bundle without widening to the collection.
test("R03: a Machine registrant demoted from Admin to Member keeps managing that exact Machine and gains no other Machine", async ({ app }) => {
  const ctx = await seedRelation("p3-r03", "admin");
  const own = (await registerMachine(ctx.server.id, ctx.related.id, "p3-r03-own")).machine;
  const other = (await registerMachine(ctx.server.id, ctx.owner.id, "p3-r03-other")).machine;
  await setServerRole(ctx.server.id, ctx.related.id, "member");
  const headers = authHeaders(ctx.relatedToken, ctx.server.id);
  const machinePath = (id: string, suffix = "") => `${app.baseUrl}/api/servers/${ctx.server.id}/machines/${id}${suffix}`;

  const patchOwn = await fetch(machinePath(own.id), { method: "PATCH", headers, body: JSON.stringify({ description: "still mine" }) });
  assert.equal(patchOwn.status, 200, "machine.update via exact registrant relation");
  const rotated = await fetch(machinePath(own.id, "/rotate-key"), { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(rotated.status, 200, "machineKey.rotate on own Machine");
  assert.ok((await rotated.json() as { apiKey?: string }).apiKey, "rotation returns the new key to the registrant");

  assert.equal((await fetch(machinePath(other.id), { method: "PATCH", headers, body: JSON.stringify({ description: "must not widen" }) })).status, 403);
  assert.equal((await fetch(machinePath(other.id, "/rotate-key"), { method: "POST", headers, body: JSON.stringify({}) })).status, 403);
  assert.equal((await fetch(machinePath(other.id), { method: "DELETE", headers })).status, 403);
  const [otherAfter] = await getDb().select().from(machines).where(eq(machines.id, other.id));
  assert.ok(otherAfter && otherAfter.description !== "must not widen", "denied writes changed nothing");

  assert.equal((await fetch(machinePath(own.id), { method: "DELETE", headers })).status, 200, "machine.remove on own Machine");
});

// R04 + S11: departure revokes every exact Machine authority; an authorized actor is unaffected.
for (const how of ["removed", "left"] as const) {
  test(`R04: a Machine registrant who ${how === "removed" ? "is removed from" : "leaves"} the Server loses every exact Machine authority`, async ({ app }) => {
    const ctx = await seedRelation(`p3-r04-${how}`, "member");
    const machine = (await registerMachine(ctx.server.id, ctx.related.id, `p3-r04-${how}`)).machine;
    const staleHeaders = authHeaders(ctx.relatedToken, ctx.server.id);
    const machinePath = (suffix = "") => `${app.baseUrl}/api/servers/${ctx.server.id}/machines/${machine.id}${suffix}`;

    assert.equal((await fetch(machinePath(), { method: "PATCH", headers: staleHeaders, body: JSON.stringify({ description: "before departure" }) })).status, 200);

    await depart(app.baseUrl, how, ctx);

    for (const [method, suffix, body] of [
      ["PATCH", "", { description: "after departure" }],
      ["POST", "/rotate-key", {}],
      ["POST", "/computer/restart", {}],
      ["GET", "/workspaces", undefined],
      ["DELETE", "", undefined],
    ] as const) {
      const response = await fetch(machinePath(suffix), {
        method,
        headers: staleHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // The Server router's membership guard runs before any registrant check.
      assert.equal(response.status, 403, `${method} machines/:id${suffix} must deny a departed registrant`);
      assert.equal((await response.json() as { error: string }).error, "Not a member of this server");
    }

    const [row] = await getDb().select().from(machines).where(eq(machines.id, machine.id));
    assert.equal(row?.userId, ctx.related.id, "registrant relation row is untouched");
    assert.equal(row?.description, "before departure", "no denied write committed");

    const ownerPatch = await fetch(machinePath(), {
      method: "PATCH",
      headers: authHeaders(ctx.ownerToken, ctx.server.id),
      body: JSON.stringify({ description: "owner after departure" }),
    });
    assert.equal(ownerPatch.status, 200);
  });
}

function waitForPacket(ws: WebSocket, packets: string[], predicate: (packet: string) => boolean) {
  if (packets.some(predicate) || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off("message", message); ws.off("close", closed); };
    const closed = () => { cleanup(); resolve(); };
    const message = (data: WebSocket.RawData) => { if (predicate(data.toString())) closed(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Socket observation did not settle")); }, 5_000);
    ws.on("message", message);
    ws.on("close", closed);
  });
}

async function openServerSocket(baseUrl: string, userId: string, serverId: string) {
  const packets: string[] = [];
  const token = await accessTokenForTest(userId);
  const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
  ws.on("message", (data) => {
    const packet = data.toString();
    packets.push(packet);
    if (packet.startsWith("0")) ws.send(`40${JSON.stringify({ token, serverId })}`);
  });
  await waitForPacket(ws, packets, (packet) => packet.startsWith("42") && packet.includes('"rooms:joined"'));
  assert.ok(packets.some((packet) => packet.includes('"rooms:joined"')), "socket must finish real room setup");
  return { ws, packets };
}

async function closeSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close");
  ws.close();
  await closed;
}

// S11 / R02 / R04 transport tooth: the departed creator/registrant's live connection stops receiving
// Agent and Machine events, while an authorized member's connection in the same Server still does.
for (const how of ["removed", "left"] as const) {
  test(`S11: after the creator ${how === "removed" ? "is removed" : "leaves"}, their open socket stops receiving Agent and Machine events`, async ({ app }) => {
    const ctx = await seedRelation(`p3-s11-${how}`, "member");
    const agent = await createAgent(ctx.server.id, `p3-s11-${how}`, { runtime: "codex", creatorType: "user", creatorId: ctx.related.id });
    const machine = (await registerMachine(ctx.server.id, ctx.related.id, `p3-s11-${how}`)).machine;
    const departed = await openServerSocket(app.baseUrl, ctx.related.id, ctx.server.id);
    const control = await openServerSocket(app.baseUrl, ctx.owner.id, ctx.server.id);
    try {
      app.io.to(`server:${ctx.server.id}`).emit("agent:session", { agentId: agent.id, sessionId: "p3-before-departure" });
      await waitForPacket(departed.ws, departed.packets, (packet) => packet.includes("p3-before-departure"));
      assert.ok(departed.packets.some((packet) => packet.includes("p3-before-departure")), "creator receives Agent events before departure");

      await depart(app.baseUrl, how, ctx);

      app.io.to(`server:${ctx.server.id}`).emit("agent:session", { agentId: agent.id, sessionId: "p3-agent-after-departure" });
      app.io.to(`server:${ctx.server.id}`).emit("machine:status", { machineId: machine.id, status: "p3-machine-after-departure" });
      await waitForPacket(control.ws, control.packets, (packet) => packet.includes("p3-machine-after-departure"));
      assert.ok(control.packets.some((packet) => packet.includes("p3-agent-after-departure")), "an authorized member still receives Agent events");
      assert.ok(control.packets.some((packet) => packet.includes("p3-machine-after-departure")), "an authorized member still receives Machine events");

      const barrier = waitForPacket(departed.ws, departed.packets, (packet) => packet.includes('"p3:barrier"'));
      app.io.to(`user:${ctx.related.id}`).emit("p3:barrier");
      await barrier;
      assert.equal(departed.packets.some((packet) => packet.includes("p3-agent-after-departure")), false, "departed creator must not receive Agent events");
      assert.equal(departed.packets.some((packet) => packet.includes("p3-machine-after-departure")), false, "departed registrant must not receive Machine events");
    } finally {
      await closeSocket(departed.ws);
      await closeSocket(control.ws);
    }
  });
}

// Stopping agents is an owner/admin's (cindyz, 2026-10-29): a member stops only agents it
// created, and its stop-all reaches only those; restart, reset session and Stop turn stay open.
test("a Member may stop only the Agents it created; restart and reset session stay open", async ({ app }) => {
  const ctx = await seedRelation("stop-member", "member");
  const own = await createAgent(ctx.server.id, "stop-own", { runtime: "codex", creatorType: "user", creatorId: ctx.related.id });
  const other = await createAgent(ctx.server.id, "stop-other", { runtime: "codex", creatorType: "user", creatorId: ctx.owner.id });
  const channel = await createChannel(ctx.server.id, `stop-${randomUUID().slice(0, 8)}`, undefined, "channel", {
    type: "user", id: ctx.owner.id, initialUserIds: [ctx.related.id], initialAgentIds: [own.id, other.id],
  });
  const as = (token: string) => (method: string, path: string, body?: unknown) => fetch(`${app.baseUrl}${path}`, {
    method,
    headers: authHeaders(token, ctx.server.id),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const member = as(ctx.relatedToken);
  const owner = as(ctx.ownerToken);

  assert.equal((await member("POST", `/api/agents/${other.id}/stop`, {})).status, 403, "member must not stop someone else's agent");
  assert.equal((await member("POST", `/api/agents/${own.id}/stop`, {})).status, 200, "creator stops its own agent");
  for (const mode of ["restart", "session"] as const) {
    assert.equal((await member("POST", `/api/agents/${other.id}/reset`, { mode })).status, 202, `member keeps ${mode}`);
  }

  const stopAll = await member("POST", `/api/channels/${channel.id}/stop-all-agents`, {});
  assert.equal(stopAll.status, 200);
  const rows = (await stopAll.json() as { results: Array<{ agentId: string; ok: boolean; reason?: string }> }).results;
  assert.deepEqual(rows.find((row) => row.agentId === other.id), { agentId: other.id, ok: false, reason: "forbidden" });
  assert.equal(rows.find((row) => row.agentId === own.id)?.ok, true);

  // Positive control: the owner stops someone else's agent and every agent in the channel.
  assert.equal((await owner("POST", `/api/agents/${own.id}/stop`, {})).status, 200);
  // A person's stop-all is their Stop: each agent is told `owner_stop`, which also ends its `raft proc` jobs.
  const orchestrator = app.app.get("agentOrchestrator") as { stopAgent: (agentId: string, reason?: string, options?: { daemonReason?: string }) => Promise<unknown> };
  const originalStop = orchestrator.stopAgent;
  const told: string[] = [];
  orchestrator.stopAgent = async (agentId, reason, options) => {
    told.push(`${agentId}:${options?.daemonReason}`);
    return originalStop.call(orchestrator, agentId, reason, options);
  };
  try {
    const ownerAll = await owner("POST", `/api/channels/${channel.id}/stop-all-agents`, {});
    assert.equal(ownerAll.status, 200);
    assert.ok((await ownerAll.json() as { results: Array<{ ok: boolean }> }).results.every((row) => row.ok));
  } finally {
    orchestrator.stopAgent = originalStop;
  }
  assert.deepEqual(told.sort(), [`${own.id}:owner_stop`, `${other.id}:owner_stop`].sort());
});
