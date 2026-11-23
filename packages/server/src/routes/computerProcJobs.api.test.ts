import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agents, computers, integrationAuditEvents, machines, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import * as channelService from "../services/channelService";
import { procJobsCacheService } from "../services/procJobsCacheService";
import { RouteFailureError } from "../tracing/routeFailure";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

// `raft proc` jobs on the Computer page (docs/contracts/proc-jobs.md): the
// read is for whoever may list Computers, without agents the viewer may not
// find; the Stop is for the person who connected the Computer or an
// owner/admin, never for an agent they may not find (404), names the job by
// agent and name with the stopper's handle from the session, and every
// attempt past the checks is audited (`computer.proc_job_stopped`).
// RED proofs: drop the findableAgentIds filter and the assistant's job shows
// to the admin; take stoppedBy from the body and "mallory" reaches the
// Computer; drop recordStop and the audit rows are missing.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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
  const guest = await seed("guest");
  const server = await createServer(`Proc jobs ${slug}`, slug, owner.id);
  const channel = await channelService.createChannel(server.id, `pj-${randomUUID().slice(0, 6)}`);
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
  const agent = async (name: string, assistantOwnerUserId: string | null = null) => {
    const [row] = await db.insert(agents).values({
      serverId: server.id,
      name: `${name}${randomUUID().slice(0, 6)}`,
      status: "inactive",
      runtime: "claude",
      model: "sonnet",
      executionMode: "byoc",
      // A personal assistant is never on a Computer (agents_assistant_not_on_machine);
      // the read and the Stop still never show or reach one for anyone but its owner.
      machineId: assistantOwnerUserId ? null : machine!.id,
      creatorType: "user",
      creatorId: attacher.id,
      ...(assistantOwnerUserId ? { assistantOwnerUserId } : {}),
    }).returning();
    return row!;
  };
  const worker = await agent("worker");
  const assistant = await agent("assistant", attacher.id);
  const tokens = {
    owner: await tokenForHuman(owner.email),
    admin: await tokenForHuman(admin.email),
    attacher: await tokenForHuman(attacher.email),
    bystander: await tokenForHuman(bystander.email),
    guest: await tokenForHuman(guest.email),
  };
  return { server, machine: machine!, users: { owner, admin, attacher }, agents: { worker, assistant }, tokens };
}

type StopCall = { machineId: string; agentId: string; name: string; stoppedBy: string | null };

function fakeOrchestrator(answer: () => Promise<{ outcome: string }> = async () => ({ outcome: "stopped" })) {
  const calls: StopCall[] = [];
  return {
    calls,
    orchestrator: {
      stopProcJob: async (machineId: string, agentId: string, name: string, stoppedBy: string | null) => {
        calls.push({ machineId, agentId, name, stoppedBy });
        return answer();
      },
    },
  };
}

function routes(baseUrl: string, serverId: string, machineId: string) {
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });
  const base = `${baseUrl}/api/servers/${serverId}/machines/${machineId}/proc-jobs`;
  return {
    read: (token: string) => fetch(base, { headers: headers(token) }),
    stop: (token: string, body: unknown) => fetch(`${base}/stop`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }),
  };
}

async function stopRecords(serverId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, "computer.proc_job_stopped")));
}

const job = (agentId: string, name: string) => ({ agentId, name, state: "running" as const, startedAt: "2026-11-19T10:00:00.000Z", memoryMaxBytes: 4 * 1024 ** 3, rssBytes: 1024 });

test("read: unknown until the Computer reports, an empty list once it reports none; viewMachines only; another server's Computer is not found", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("pj-read");
  const api = routes(app.baseUrl, server.id, machine.id);

  const unknown = await api.read(tokens.bystander);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await unknown.json(), { status: "unknown" });

  await procJobsCacheService.write(machine.id, { protocolVersion: 1, reportedAt: "2026-11-19T10:05:00.000Z", jobs: [] });
  assert.deepEqual(await (await api.read(tokens.bystander)).json(), { status: "known", reportedAt: "2026-11-19T10:05:00.000Z", jobs: [] });

  const guest = await api.read(tokens.guest);
  assert.ok(guest.status === 403 || guest.status === 404, `a guest does not list Computers (${guest.status})`);
  const other = await seedComputer("pj-read-other");
  assert.equal((await routes(app.baseUrl, server.id, other.machine.id).read(tokens.owner)).status, 404);
});

test("read: a personal assistant's jobs only for its owner; everyone else sees the other agents' jobs", async ({ app }) => {
  const { server, machine, agents: seeded, tokens } = await seedComputer("pj-view");
  const api = routes(app.baseUrl, server.id, machine.id);
  await procJobsCacheService.write(machine.id, {
    protocolVersion: 1,
    reportedAt: "2026-11-19T10:05:00.000Z",
    jobs: [job(seeded.worker.id, "web"), job(seeded.assistant.id, "secret-job")],
  });
  const namesFor = async (token: string) => ((await (await api.read(token)).json()) as { jobs: Array<{ name: string }> }).jobs.map((entry) => entry.name);
  assert.deepEqual(await namesFor(tokens.attacher), ["web", "secret-job"], "the assistant's owner");
  assert.deepEqual(await namesFor(tokens.admin), ["web"]);
  assert.deepEqual(await namesFor(tokens.owner), ["web"]);
  assert.deepEqual(await namesFor(tokens.bystander), ["web"]);
});

test("stop: the attacher, an owner and an admin may; a member and a guest may not; an agent the person may not find is 404 even with control", async ({ app }) => {
  const { server, machine, agents: seeded, tokens } = await seedComputer("pj-who");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  assert.equal((await api.stop(tokens.bystander, { agentId: seeded.worker.id, name: "web" })).status, 403);
  const guest = await api.stop(tokens.guest, { agentId: seeded.worker.id, name: "web" });
  assert.ok(guest.status === 403 || guest.status === 404, `a guest is refused (${guest.status})`);
  const hidden = await api.stop(tokens.admin, { agentId: seeded.assistant.id, name: "web" });
  assert.equal(hidden.status, 404, "the admin has control but may not find the attacher's assistant");
  assert.equal(((await hidden.json()) as { code: string }).code, "proc_job_not_found");
  assert.equal((await api.stop(tokens.admin, { agentId: randomUUID(), name: "web" })).status, 404, "an agent of no one");
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await stopRecords(server.id), [], "a refusal records nothing");

  for (const bad of [{}, { agentId: seeded.worker.id }, { agentId: seeded.worker.id, name: "a b" }, { agentId: "x", name: "web" }, { agentId: seeded.worker.id, name: "x".repeat(41) }]) {
    assert.equal((await api.stop(tokens.attacher, bad)).status, 400, JSON.stringify(bad));
  }

  for (const token of [tokens.attacher, tokens.owner, tokens.admin]) {
    const ok = await api.stop(token, { agentId: seeded.worker.id, name: "web" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { outcome: "stopped" });
  }
  // A personal assistant is never on a Computer, so it has no job here to stop, even for its owner.
  assert.equal((await api.stop(tokens.attacher, { agentId: seeded.assistant.id, name: "bot" })).status, 404, "not on this Computer");
  assert.equal(fake.calls.length, 3);
});

test("another server's agent is not there: its jobs are not read and it cannot be stopped, even by an owner with control", async ({ app }) => {
  const { server, machine, tokens } = await seedComputer("pj-cross");
  const other = await seedComputer("pj-cross-other");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  await procJobsCacheService.write(machine.id, {
    protocolVersion: 1,
    reportedAt: "2026-11-19T10:05:00.000Z",
    jobs: [job(other.agents.worker.id, "theirs")],
  });
  assert.deepEqual(((await (await api.read(tokens.owner)).json()) as { jobs: unknown[] }).jobs, []);
  assert.equal((await api.stop(tokens.owner, { agentId: other.agents.worker.id, name: "theirs" })).status, 404);
  assert.deepEqual(fake.calls, []);
});

test("stop: only (agent, name) reach the Computer, with the stopper's handle from the session; each attempt is audited with its result", async ({ app }) => {
  const { server, machine, agents: seeded, users: people, tokens } = await seedComputer("pj-relay");
  const fake = fakeOrchestrator(async () => ({ outcome: "already_exited" }));
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);

  const answer = await api.stop(tokens.attacher, { agentId: seeded.worker.id, name: "web", stoppedBy: "mallory", pid: 1, force: true });
  assert.deepEqual(await answer.json(), { outcome: "already_exited" });
  assert.deepEqual(fake.calls, [{ machineId: machine.id, agentId: seeded.worker.id, name: "web", stoppedBy: people.attacher.name }]);

  const [record] = await stopRecords(server.id);
  assert.equal(record?.actorId, people.attacher.id);
  assert.equal(record?.targetId, machine.id);
  assert.equal(record?.outcome, "success");
  assert.deepEqual(record?.metadata, {
    machineId: machine.id, machineName: machine.name, agentId: seeded.worker.id, jobName: "web", result: "already_exited", actorRole: "member",
  });
});

test("stop: offline and an older Computer are 409, no answer in time is 504; each is audited", async ({ app }) => {
  const { server, machine, agents: seeded, tokens } = await seedComputer("pj-ends");
  const api = routes(app.baseUrl, server.id, machine.id);
  const body = { agentId: seeded.worker.id, name: "web" };
  const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;

  app.app.set("agentOrchestrator", fakeOrchestrator(async () => ({ outcome: "computer_offline" })).orchestrator);
  const offline = await api.stop(tokens.owner, body);
  assert.equal(offline.status, 409);
  assert.equal(await codeOf(offline), "computer_offline");

  app.app.set("agentOrchestrator", fakeOrchestrator(async () => ({ outcome: "computer_upgrade_required" })).orchestrator);
  const old = await api.stop(tokens.owner, body);
  assert.equal(old.status, 409);
  assert.equal(await codeOf(old), "computer_upgrade_required");

  app.app.set("agentOrchestrator", fakeOrchestrator(async () => {
    throw new RouteFailureError("daemon_timeout", "daemon did not answer");
  }).orchestrator);
  const late = await api.stop(tokens.owner, body);
  assert.equal(late.status, 504);
  assert.equal(await codeOf(late), "computer_timeout");

  app.app.set("agentOrchestrator", fakeOrchestrator(async () => ({ outcome: "not_found" })).orchestrator);
  assert.deepEqual(await (await api.stop(tokens.owner, body)).json(), { outcome: "not_found" });

  const results = (await stopRecords(server.id)).map((record) => (record.metadata as { result: string }).result).sort();
  assert.deepEqual(results, ["computer_offline", "computer_timeout", "computer_upgrade_required", "not_found"]);
});

test("stop: an agent of this server that is not on this Computer is 404; nothing reaches the Computer", async ({ app }) => {
  const { server, machine, agents: seeded, tokens } = await seedComputer("pj-elsewhere");
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const api = routes(app.baseUrl, server.id, machine.id);
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, seeded.worker.id));
  const res = await api.stop(tokens.owner, { agentId: seeded.worker.id, name: "web" });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, "proc_job_not_found");
  assert.deepEqual(fake.calls, []);
});
