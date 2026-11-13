import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { RouteFailureError } from "../tracing/routeFailure";
import { agentBootstrapTokens, agentCredentials, reminders, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, getAgent } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createReminder } from "../apps/reminder/service";
import { beginTestAgentMigration } from "../test/agentMigrationFixture";
import { seedBoundGuest } from "../test/guestFixture";
import {
  dispatchPendingAgentArchiveOps,
  getAgentArchive,
  type AgentArchiveDispatchPort,
} from "../services/agentArchiveService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function userHeaders(token: string, serverId: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" };
}

async function seedArchiveFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `archive-${suffix}@slock.test`,
    name: `archive-${suffix}`,
    displayName: "Archive Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Archive", `archive-${suffix}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "archive-machine");
  const agent = await createAgent(server.id, "ArchiveBot", { runtime: "codex", model: "gpt-5-codex", machineId: machine.id });
  return { owner, server, machine, agent, token: await tokenForHuman(owner.email) };
}

/** A Computer connected to this replica, recording the workspaces it deletes. */
function fakePort(machineId: string, options: { result?: "deleted" | "failed" | "timed_out" } = {}) {
  const deleted: string[] = [];
  const port: AgentArchiveDispatchPort = {
    localMachineIds: () => [machineId],
    hasMachineLocally: (candidate) => candidate === machineId,
    deleteMachineWorkspaceDir: async (_machineId, directoryName) => {
      deleted.push(directoryName);
      return options.result ?? "deleted";
    },
  };
  return { port, deleted };
}

async function archive(baseUrl: string, fixture: Awaited<ReturnType<typeof seedArchiveFixture>>, workspace?: string) {
  return fetch(`${baseUrl}/api/agents/${fixture.agent.id}`, {
    method: "DELETE",
    headers: userHeaders(fixture.token, fixture.server.id),
    ...(workspace ? { body: JSON.stringify({ workspace }) } : {}),
  });
}

test("archiving keeps the workspace on its Computer, cancels reminders and revokes credentials", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  const reminder = await createReminder({
    serverId: fixture.server.id,
    ownerAgentId: fixture.agent.id,
    msgId: null,
    title: "later",
    fireAt: new Date(Date.now() + 3_600_000),
    payload: null,
    createdBy: { type: "agent", id: fixture.agent.id },
  });
  await mintAgentCredential({ agentId: fixture.agent.id, scopes: ["send"], name: "archive-test", issuedVia: "human", createdByUserId: fixture.owner.id });

  const res = await archive(app.baseUrl, fixture);
  assert.equal(res.status, 200);

  const row = await getAgentArchive(fixture.agent.id);
  assert.equal(row?.workspaceState, "on_computer");
  assert.equal(row?.machineId, fixture.machine.id);
  assert.equal(row?.machineNameSnapshot, "archive-machine");
  assert.equal(row?.pendingOp, null);
  assert.equal(row?.archivedByUserId, fixture.owner.id);
  assert.ok((await getAgent(fixture.agent.id, true))?.deletedAt);
  const [canceled] = await getDb().select().from(reminders).where(eq(reminders.id, reminder.id));
  assert.equal(canceled.status, "canceled");
  const credentials = await getDb().select().from(agentCredentials).where(eq(agentCredentials.agentId, fixture.agent.id));
  assert.ok(credentials.length > 0 && credentials.every((credential) => credential.revokedReason === "agent_archived"));

  const view = await fetch(`${app.baseUrl}/api/agents/${fixture.agent.id}/archive`, { headers: userHeaders(fixture.token, fixture.server.id) });
  assert.equal(view.status, 200);
  const body = await view.json() as { archive: { workspaceState: string; machineName: string } };
  assert.equal(body.archive.workspaceState, "on_computer");
  assert.equal(body.archive.machineName, "archive-machine");
});


test("only keep and delete are workspace choices; anything else leaves the agent alone", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  for (const workspace of ["backup", "shred"]) {
    const res = await archive(app.baseUrl, fixture, workspace);
    assert.equal(res.status, 400, workspace);
    assert.equal((await res.json() as { code: string }).code, "archive_workspace_choice_invalid");
  }
  assert.equal((await getAgent(fixture.agent.id, true))?.deletedAt, null);
  assert.equal(await getAgentArchive(fixture.agent.id), null);
});

test("a delete op waits for its Computer, then removes the workspace", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, fixture, "delete")).status, 200);
  const pending = await getAgentArchive(fixture.agent.id);
  assert.equal(pending?.pendingOp, "delete");

  // A slow delete is checked again rather than reported as a failure.
  const slow = fakePort(fixture.machine.id, { result: "timed_out" });
  await dispatchPendingAgentArchiveOps(slow.port);
  const stillDeleting = await getAgentArchive(fixture.agent.id);
  assert.equal(stillDeleting?.pendingOp, "delete");
  assert.equal(stillDeleting?.opDispatchedAt, null);
  assert.equal(stillDeleting?.lastErrorCode, "ARCHIVE_DELETE_TIMED_OUT");

  // A failed delete is retried, not dropped.
  const failing = fakePort(fixture.machine.id, { result: "failed" });
  await dispatchPendingAgentArchiveOps(failing.port);
  const retried = await getAgentArchive(fixture.agent.id);
  assert.equal(retried?.pendingOp, "delete");
  assert.equal(retried?.opDispatchedAt, null);
  assert.equal(retried?.lastErrorCode, "ARCHIVE_DELETE_FAILED");

  const computer = fakePort(fixture.machine.id);
  await dispatchPendingAgentArchiveOps(computer.port);
  assert.deepEqual(computer.deleted, [fixture.agent.id]);
  const done = await getAgentArchive(fixture.agent.id);
  assert.equal(done?.pendingOp, null);
  assert.equal(done?.workspaceState, "deleted");
  assert.equal(done?.lastErrorCode, null);
});


test("a workspace kept on archive can be deleted later from the archived profile", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, fixture)).status, 200);
  const request = (action: string) => fetch(`${app.baseUrl}/api/agents/${fixture.agent.id}/archive/workspace`, {
    method: "POST",
    headers: userHeaders(fixture.token, fixture.server.id),
    body: JSON.stringify({ action }),
  });
  assert.equal((await request("backup")).status, 400);
  const res = await request("delete");
  assert.equal(res.status, 200);
  const body = await res.json() as { archive: { pendingOp: string | null } };
  assert.equal(body.archive.pendingOp, "delete");
  const again = await request("delete");
  assert.equal(again.status, 409, "one op at a time");

  const computer = fakePort(fixture.machine.id);
  await dispatchPendingAgentArchiveOps(computer.port);
  assert.deepEqual(computer.deleted, [fixture.agent.id]);
  assert.equal((await getAgentArchive(fixture.agent.id))?.workspaceState, "deleted");
  const gone = await request("delete");
  assert.equal(gone.status, 409);
  assert.equal((await gone.json() as { code: string }).code, "archive_workspace_unavailable");
});

test("a delete that keeps failing is given up after its attempts and says so", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, fixture, "delete")).status, 200);
  const failing = fakePort(fixture.machine.id, { result: "failed" });
  for (let attempt = 0; attempt < 7; attempt += 1) await dispatchPendingAgentArchiveOps(failing.port);
  const row = await getAgentArchive(fixture.agent.id);
  assert.equal(row?.pendingOp, null);
  assert.equal(row?.workspaceState, "on_computer", "the workspace is still there");
  assert.equal(row?.lastErrorCode, "ARCHIVE_ATTEMPTS_EXHAUSTED");
});

test("a delete that keeps timing out is given up as unconfirmed, and asking again confirms it", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, fixture, "delete")).status, 200);
  const slow = fakePort(fixture.machine.id, { result: "timed_out" });
  for (let attempt = 0; attempt < 7; attempt += 1) await dispatchPendingAgentArchiveOps(slow.port);
  const row = await getAgentArchive(fixture.agent.id);
  assert.equal(row?.pendingOp, null);
  assert.equal(row?.lastErrorCode, "ARCHIVE_DELETE_UNCONFIRMED");
  const again = await fetch(`${app.baseUrl}/api/agents/${fixture.agent.id}/archive/workspace`, {
    method: "POST",
    headers: userHeaders(fixture.token, fixture.server.id),
    body: JSON.stringify({ action: "delete" }),
  });
  assert.equal(again.status, 200);
  await dispatchPendingAgentArchiveOps(fakePort(fixture.machine.id).port);
  const done = await getAgentArchive(fixture.agent.id);
  assert.equal(done?.workspaceState, "deleted");
  assert.equal(done?.lastErrorCode, null);
});

test("a dispatch while no Computer is online does not hold up the next one", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, fixture, "delete")).status, 200);
  // Nothing connected to this replica: the run ends at once.
  await dispatchPendingAgentArchiveOps({ ...fakePort(fixture.machine.id).port, localMachineIds: () => [] });
  const computer = fakePort(fixture.machine.id);
  await dispatchPendingAgentArchiveOps(computer.port);
  assert.deepEqual(computer.deleted, [fixture.agent.id]);
  assert.equal((await getAgentArchive(fixture.agent.id))?.workspaceState, "deleted");
});

test("a Computer that never answers holds up neither another Computer nor its own next attempt", async ({ app }) => {
  const stuck = await seedArchiveFixture();
  const other = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, stuck, "delete")).status, 200);
  assert.equal((await archive(app.baseUrl, other, "delete")).status, 200);
  const deleted: string[] = [];
  const port: AgentArchiveDispatchPort = {
    localMachineIds: () => [stuck.machine.id, other.machine.id],
    hasMachineLocally: () => true,
    deleteMachineWorkspaceDir: (machineId, directoryName) => {
      if (machineId === stuck.machine.id) return new Promise<"deleted">(() => {});
      deleted.push(directoryName);
      return Promise.resolve("deleted" as const);
    },
  };
  const first = dispatchPendingAgentArchiveOps(port, null, { opTimeoutMs: 300 });
  // The other Computer's delete goes out while the stuck one waits.
  for (let tries = 0; tries < 50 && deleted.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(deleted, [other.agent.id]);
  await first;
  const released = await getAgentArchive(stuck.agent.id);
  assert.equal(released?.pendingOp, "delete");
  assert.equal(released?.opDispatchedAt, null, "the lease is freed after the timeout");
  assert.equal(released?.lastErrorCode, "ARCHIVE_COMPUTER_UNREACHABLE");

  const answering = fakePort(stuck.machine.id);
  await dispatchPendingAgentArchiveOps(answering.port);
  assert.deepEqual(answering.deleted, [stuck.agent.id], "the same Computer is asked again");
  assert.equal((await getAgentArchive(stuck.agent.id))?.workspaceState, "deleted");
});

test("an archived agent's workspace is read from the Computer that still holds it", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, fixture)).status, 200);
  const original = app.app.get("agentOrchestrator") as Record<string, unknown>;
  const calls: Array<string | undefined> = [];
  let online = true;
  app.app.set("agentOrchestrator", {
    ...original,
    hasMachineLocally: () => true,
    getAgentFileTree: async (_agentId: string, _dirPath: string | undefined, _hidden: boolean, machineId?: string) => {
      calls.push(machineId);
      if (!online) throw new RouteFailureError("daemon_offline", "Agent has no connected machine");
      return [{ name: "MEMORY.md", path: "MEMORY.md", isDirectory: false, size: 3, modifiedAt: new Date(0).toISOString() }];
    },
  });
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${fixture.agent.id}/workspace-files`, { headers: userHeaders(fixture.token, fixture.server.id) });
    assert.equal(res.status, 200);
    const body = await res.json() as { files: Array<{ name: string }>; source: string };
    assert.equal(body.source, "computer");
    assert.deepEqual(body.files.map((file) => file.name), ["MEMORY.md"]);
    assert.deepEqual(calls, [fixture.machine.id], "the archive record names the Computer; daemon_id is cleared");

    online = false;
    const offline = await fetch(`${app.baseUrl}/api/agents/${fixture.agent.id}/workspace-files`, { headers: userHeaders(fixture.token, fixture.server.id) });
    assert.ok(offline.status === 409 || offline.status === 503, `got ${offline.status} ${await offline.clone().text()}`);
  } finally {
    app.app.set("agentOrchestrator", original);
  }
});


async function seedMember(serverId: string, role: "member" | "guest") {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `archive-${role}-${suffix}@slock.test`,
    name: `archive-${role}-${suffix}`,
    displayName: role,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  if (role === "guest") await seedBoundGuest({ serverId, userId: user.id });
  else await getDb().insert(serverMembers).values({ serverId, userId: user.id, role });
  return { user, token: await tokenForHuman(user.email) };
}

test("archive routes refuse members without rights, guests, and agents of another server", async ({ app }) => {
  {
    const fixture = await seedArchiveFixture();
    assert.equal((await archive(app.baseUrl, fixture)).status, 200);
    const other = await seedArchiveFixture();
    const member = await seedMember(fixture.server.id, "member");
    const guest = await seedMember(fixture.server.id, "guest");
    const agentUrl = `${app.baseUrl}/api/agents/${fixture.agent.id}`;
    const routes: Array<[string, string, string?]> = [
      ["GET", `${agentUrl}/archive`],
      ["GET", `${agentUrl}/workspace-files`],
      ["GET", `${agentUrl}/workspace-files/read?path=MEMORY.md`],
      ["POST", `${agentUrl}/archive/workspace`, JSON.stringify({ action: "delete" })],
    ];
    for (const [method, url, body] of routes) {
      for (const [who, token, serverId, allowed] of [
        ["member", member.token, fixture.server.id, [403]],
        ["guest", guest.token, fixture.server.id, [403, 404]],
        // The other server's owner, naming their own server: the agent is not theirs.
        ["other server", other.token, other.server.id, [404]],
      ] as const) {
        const res = await fetch(url, { method, headers: userHeaders(token, serverId), ...(body ? { body } : {}) });
        assert.ok((allowed as readonly number[]).includes(res.status), `${who} ${method} ${url} -> ${res.status}`);
      }
    }
    const row = await getAgentArchive(fixture.agent.id);
    assert.equal(row?.pendingOp, null, "nothing was requested");
  }
});

test("an agent that is being migrated cannot be archived", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  const { machine: target } = await registerMachine(fixture.server.id, fixture.owner.id, "target-machine");
  await beginTestAgentMigration({
    agentId: fixture.agent.id,
    targetMachineId: target.id,
    initiatedByUserId: fixture.owner.id,
    now: new Date(),
    prepDeadlineMs: 3_600_000,
    transferDeadlineMs: 3_600_000,
    arrivalDeadlineMs: 3_600_000,
  });
  const res = await archive(app.baseUrl, fixture, "delete");
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { code: string }).code, "archive_migration_active");
  assert.equal((await getAgent(fixture.agent.id, true))?.deletedAt, null);
  assert.equal(await getAgentArchive(fixture.agent.id), null);
});

test("archiving revokes the agent's unused bootstrap tokens", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  const [token] = await getDb().insert(agentBootstrapTokens).values({
    tokenLookupHash: Buffer.from(randomUUID()),
    tokenHash: "argon2-placeholder",
    tokenPrefix: "abtk_test",
    targetAgentId: fixture.agent.id,
    serverId: fixture.server.id,
    issuedByUserId: fixture.owner.id,
    scopes: ["send"],
    ttlExpiresAt: new Date(Date.now() + 600_000),
  }).returning();
  assert.equal((await archive(app.baseUrl, fixture)).status, 200);
  const [after] = await getDb().select().from(agentBootstrapTokens).where(eq(agentBootstrapTokens.id, token.id));
  assert.equal(after.revokedReason, "agent_archived");
});


test("the archived agents list is for members, not guests", async ({ app }) => {
  const fixture = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, fixture)).status, 200);
  const owner = await fetch(`${app.baseUrl}/api/agents/archived`, { headers: userHeaders(fixture.token, fixture.server.id) });
  assert.equal(owner.status, 200);
  const listed = await owner.json() as { agents: Array<{ agentId: string; machineName: string | null; workspaceState: string }> };
  assert.deepEqual(listed.agents.map((entry) => [entry.agentId, entry.machineName, entry.workspaceState]), [[fixture.agent.id, "archive-machine", "on_computer"]]);
  const member = await seedMember(fixture.server.id, "member");
  assert.equal((await fetch(`${app.baseUrl}/api/agents/archived`, { headers: userHeaders(member.token, fixture.server.id) })).status, 200);
  const guest = await seedMember(fixture.server.id, "guest");
  assert.equal((await fetch(`${app.baseUrl}/api/agents/archived`, { headers: userHeaders(guest.token, fixture.server.id) })).status, 403);
});


test("a Computer's `ready` dispatches only its own ops, and a sweep claims only Computers with pending ops", async ({ app }) => {
  const mine = await seedArchiveFixture();
  const other = await seedArchiveFixture();
  const idle = await seedArchiveFixture();
  assert.equal((await archive(app.baseUrl, mine, "delete")).status, 200);
  assert.equal((await archive(app.baseUrl, other, "delete")).status, 200);

  // One replica with three Computers connected; only `mine` just sent ready.
  const deleted: Array<{ machineId: string; directoryName: string }> = [];
  const connected = [mine.machine.id, other.machine.id, idle.machine.id];
  const port: AgentArchiveDispatchPort = {
    localMachineIds: () => connected,
    hasMachineLocally: (machineId) => connected.includes(machineId),
    deleteMachineWorkspaceDir: async (machineId, directoryName) => {
      deleted.push({ machineId, directoryName });
      return "deleted";
    },
  };
  await dispatchPendingAgentArchiveOps(port, null, { machineIds: [mine.machine.id] });
  assert.deepEqual(deleted, [{ machineId: mine.machine.id, directoryName: mine.agent.id }]);
  assert.equal((await getAgentArchive(other.agent.id))?.pendingOp, "delete", "another Computer's op waits for the sweep");
  assert.equal((await getAgentArchive(other.agent.id))?.opDispatchedAt, null, "and was not even claimed");

  // A machine-scoped call for a Computer not on this replica does nothing.
  await dispatchPendingAgentArchiveOps({ ...port, hasMachineLocally: () => false }, null, { machineIds: [other.machine.id] });
  assert.equal((await getAgentArchive(other.agent.id))?.pendingOp, "delete");

  // The sweep picks up the rest; the idle Computer has nothing to claim.
  await dispatchPendingAgentArchiveOps(port);
  assert.deepEqual(deleted.map((entry) => entry.machineId), [mine.machine.id, other.machine.id]);
  assert.equal((await getAgentArchive(other.agent.id))?.workspaceState, "deleted");
});
