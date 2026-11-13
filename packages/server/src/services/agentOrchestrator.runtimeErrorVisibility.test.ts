/**
 * #wg-rbac:#57: an agent's runtime error text reaches only its managers (the
 * human creator, `editAgents` owner/admin; a personal assistant's owner),
 * scrubbed and capped. Every other socket of the server gets the error code
 * and its fixed sentence, or the generic message, never the text. Real DB rows
 * and the real ingest path; only the machine socket and Socket.IO are stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";

import {
  boundedRuntimeErrorDetail,
  GENERIC_RUNTIME_ERROR_MESSAGE,
  RUNTIME_ERROR_CODE_SENTENCES,
  agentActivityCapableServerRoom,
  agentActivityRoom,
  type MachineToServerMessage,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { getAgentLastRuntimeError, listAgentRuntimeErrorDetailViewerUserIds } from "./agentService";
import { socketUserServerRoom } from "../socket/platformScope";

afterEach(async () => {
  await closeTestDatabase();
});

type Push = { to: string[]; except: string[]; event: string; payload: Record<string, unknown> };

function capturingIo(pushes: Push[]): SocketServer {
  const operator = (to: string[], except: string[]): any => ({
    to: (room: string | string[]) => operator([...to, ...[room].flat()], except),
    in: (room: string | string[]) => operator([...to, ...[room].flat()], except),
    except: (room: string | string[]) => operator(to, [...except, ...[room].flat()]),
    socketsJoin: () => undefined,
    emit: (event: string, payload: Record<string, unknown>) => {
      pushes.push({ to, except, event, payload });
      return true;
    },
  });
  return { to: (room: string | string[]) => operator([room].flat(), []), in: (room: string | string[]) => operator([room].flat(), []) } as unknown as SocketServer;
}

class VisibilityOrchestrator extends AgentOrchestrator {
  readonly pushes: Push[] = [];
  jointChannels: string[] = [];
  viewersFail = false;

  constructor() {
    super();
    this.setIO(capturingIo(this.pushes));
  }

  protected override async sendToMachine(): Promise<boolean> {
    return true;
  }

  protected override async loadJointActivityProjectionChannelIdsForAgent(): Promise<string[]> {
    return this.jointChannels;
  }

  protected override async loadRuntimeErrorDetailViewerUserIds(agentId: string): Promise<string[]> {
    if (this.viewersFail) throw new Error("db down");
    return super.loadRuntimeErrorDetailViewerUserIds(agentId);
  }

  /** The activity push is scheduled after the frame's ingest: wait for it. */
  async settled(isShown: (payload: Record<string, unknown>) => boolean = (payload) => payload.activity === "error"): Promise<void> {
    for (let i = 0; i < 200 && !this.pushes.some((push) => push.event === "agent:activity" && isShown(push.payload)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  activityPushes(): Push[] {
    return this.pushes.filter((push) => push.event === "agent:activity");
  }
}

async function seed() {
  const db = getDb();
  const user = async (name: string) => (await db.insert(users).values({
    email: `${name}@example.com`, name, passwordHash: "hash", emailVerified: true,
  }).returning())[0]!;
  const owner = await user("scrub-owner");
  const admin = await user("scrub-admin");
  const creator = await user("scrub-creator");
  const member = await user("scrub-member");
  const [server] = await db.insert(servers).values({ name: "Scrub", slug: "scrub-test", ownerId: owner.id }).returning();
  await db.insert(serverMembers).values([
    { serverId: server!.id, userId: owner.id, role: "owner" },
    { serverId: server!.id, userId: admin.id, role: "admin" },
    { serverId: server!.id, userId: creator.id, role: "member" },
    { serverId: server!.id, userId: member.id, role: "member" },
  ]);
  const [machine] = await db.insert(machines).values({
    serverId: server!.id, userId: owner.id, name: "scrub-box", apiKeyHash: "hash-scrub",
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "scrubby",
    status: "inactive",
    runtime: "codex",
    model: "gpt-5",
    executionMode: "byoc",
    machineId: machine!.id,
    creatorType: "user",
    creatorId: creator.id,
  }).returning();
  const orchestrator = new VisibilityOrchestrator();
  (orchestrator as any).machineConnections.set(machine!.id, {
    ws: {}, machineId: machine!.id, serverId: server!.id, principalKind: "computer",
    connectionEpochId: `epoch-${machine!.id}`, heartbeatTimer: null, runtimeAccountUsageTimer: null,
    lastPong: Date.now(), lastIngressAt: Date.now(), daemonVersion: "1.0.48", capabilities: new Set<string>(),
    runtimes: ["codex"], migrationTransport: null, shutdownIntent: null, computerVersion: "1.0.48",
  });
  const send = (msg: MachineToServerMessage) => orchestrator.handleMachineMessage(machine!.id, msg);
  return { server: server!, agent: agent!, owner, admin, creator, member, orchestrator, send };
}

const SECRET_DETAIL = [
  "Codex failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
  "at /Users/jane/work/raft/src/index.ts for jane.doe@example.com",
  "OPENAI_API_KEY=sk-proj-abcdefghijklmnop0123",
  "z".repeat(700),
].join(" ");

function errorFrame(agentId: string, detail: string, runtimeError?: Record<string, unknown>): MachineToServerMessage {
  return {
    type: "agent:activity",
    agentId,
    launchId: "launch-1",
    daemonInstanceId: "daemon-a",
    clientSeq: 10,
    activity: "error",
    detail,
    detailKind: "runtime_error",
    isHeartbeat: false,
    ...(runtimeError ? { runtimeError } : {}),
  } as unknown as MachineToServerMessage;
}

function assertNoSecret(text: unknown, label: string) {
  assert.equal(typeof text, "string", label);
  for (const secret of ["abcdefghijklmnopqrstuvwxyz0123", "/Users/jane", "jane.doe@example.com", "sk-proj-abcdefghijklmnop0123"]) {
    assert.ok(!(text as string).includes(secret), `${label} leaks ${secret}`);
  }
}

test("the viewers of an agent's error text are its creator and the owner/admin members; an assistant's, its owner alone", async ({ db: _db }) => {
  const { agent, owner, admin, creator, orchestrator } = await seed();
  try {
    assert.deepEqual(new Set(await listAgentRuntimeErrorDetailViewerUserIds(agent.id)), new Set([owner.id, admin.id, creator.id]));
  } finally {
    await orchestrator.shutdown();
  }
});

test("an uncoded error: the stored row and the managers' push carry the scrubbed, capped text; every other socket the generic message, no code", async ({ db: _db }) => {
  const { server, agent, owner, admin, creator, orchestrator, send } = await seed();
  try {
    orchestrator.jointChannels = ["joint-1"];
    await send(errorFrame(agent.id, SECRET_DETAIL));
    await orchestrator.settled();

    const stored = await getAgentLastRuntimeError(agent.id);
    assertNoSecret(stored?.message, "stored last_runtime_error");
    assert.ok(stored!.message.length <= 512, "stored text is capped");
    assert.match(stored!.message, /\[REDACTED_TOKEN\]/);

    const pushes = orchestrator.activityPushes().filter((push) => push.payload.activity === "error");
    assert.ok(pushes.length > 0, "the error was pushed");
    const managerRooms = [owner.id, admin.id, creator.id].map((id) => socketUserServerRoom(id, server.id)).sort();
    for (const push of pushes) {
      assertNoSecret(push.payload.detail, `push to ${push.to.join(",")}`);
      assert.ok(String(push.payload.detail).length <= 512);
      const isJoint = push.to.includes("channel:joint-1");
      const isManager = push.to.every((room) => managerRooms.includes(room));
      if (isJoint) {
        assert.equal(push.payload.detail, "", "joint rooms keep the empty detail");
      } else if (isManager) {
        assert.deepEqual([...push.to].sort(), managerRooms);
        assert.equal(push.payload.detail, stored!.message, "managers read the stored scrubbed text");
        assert.equal(push.payload.errorCode, undefined);
      } else {
        assert.equal(push.payload.detail, GENERIC_RUNTIME_ERROR_MESSAGE, "members read the generic message");
        assert.equal(push.payload.errorCode, undefined, "unknown error: no code");
        for (const room of managerRooms) assert.ok(push.except.includes(room), "managers' sockets are left out of the member push");
      }
    }
    const memberTargets = pushes.filter((push) => push.payload.detail === GENERIC_RUNTIME_ERROR_MESSAGE).map((push) => push.to[0]);
    assert.ok(memberTargets.includes(`server:${server.id}`));
    assert.ok(memberTargets.includes(agentActivityRoom(agent.id)));
    const serverRoomPush = pushes.find((push) => push.to[0] === `server:${server.id}`)!;
    assert.ok(serverRoomPush.except.includes(agentActivityCapableServerRoom(server.id)));
  } finally {
    await orchestrator.shutdown();
  }
});

test("a common case: members get the code and its fixed sentence, managers the scrubbed text and the code", async ({ db: _db }) => {
  const { server, agent, creator, orchestrator, send } = await seed();
  try {
    await send(errorFrame(agent.id, `You've hit your usage limit for ${"jane.doe@example.com"} at /Users/jane/x`));
    await orchestrator.settled();
    const pushes = orchestrator.activityPushes().filter((push) => push.payload.activity === "error");
    const managerPush = pushes.find((push) => push.to.includes(socketUserServerRoom(creator.id, server.id)))!;
    const memberPush = pushes.find((push) => push.to[0] === `server:${server.id}`)!;
    assert.equal(memberPush.payload.errorCode, "usage_limit");
    assert.equal(memberPush.payload.detail, RUNTIME_ERROR_CODE_SENTENCES.usage_limit);
    assert.equal(managerPush.payload.errorCode, "usage_limit");
    assert.match(String(managerPush.payload.detail), /usage limit/);
    assertNoSecret(managerPush.payload.detail, "manager push");
  } finally {
    await orchestrator.shutdown();
  }
});

test("a typed carrier decides the code: AuthError reads auth_required to members", async ({ db: _db }) => {
  const { server, agent, orchestrator, send } = await seed();
  try {
    await send(errorFrame(agent.id, "Codex is not logged in on this machine.", {
      errorClass: "AuthError", errorReason: "auth_failed", fingerprint: "a111111111111111", reasonProvenance: "runtime_error_event", requiredAction: "user_reauth",
    }));
    await orchestrator.settled();
    const memberPushes = orchestrator.activityPushes().filter((push) => push.payload.activity === "error" && push.to[0] === `server:${server.id}`);
    assert.ok(memberPushes.length > 0);
    for (const push of memberPushes) {
      assert.equal(push.payload.errorCode, "auth_required");
      assert.equal(push.payload.detail, RUNTIME_ERROR_CODE_SENTENCES.auth_required);
    }
  } finally {
    await orchestrator.shutdown();
  }
});

test("when the managers cannot be read, nobody gets the text", async ({ db: _db }) => {
  const { agent, orchestrator, send } = await seed();
  try {
    orchestrator.viewersFail = true;
    await send(errorFrame(agent.id, SECRET_DETAIL));
    await orchestrator.settled();
    const pushes = orchestrator.activityPushes().filter((push) => push.payload.activity === "error");
    assert.ok(pushes.length > 0);
    for (const push of pushes) assert.ok(push.payload.detail === GENERIC_RUNTIME_ERROR_MESSAGE || push.payload.detail === "", "member text only");
  } finally {
    await orchestrator.shutdown();
  }
});

test("a personal assistant's error goes to its owner only, scrubbed (no machine: the push itself)", async ({ db: _db }) => {
  const pushes: Push[] = [];
  const orchestrator = new VisibilityOrchestrator();
  orchestrator.setIO(capturingIo(pushes));
  let viewerReads = 0;
  (orchestrator as any).loadRuntimeErrorDetailViewerUserIds = async () => { viewerReads += 1; return ["admin-1"]; };
  (orchestrator as any).getCachedAgent = async (id: string) => ({ id, serverId: "s1", assistantOwnerUserId: "owner-1", lastRuntimeError: null });
  try {
    await (orchestrator as any).emitActivity("a1", "error", boundedRuntimeErrorDetail(SECRET_DETAIL), "runtime_error", 100);
    const errorPushes = pushes.filter((push) => push.event === "agent:activity");
    const ownerRoom = socketUserServerRoom("owner-1", "s1");
    assert.deepEqual(errorPushes.map((push) => push.to), [[ownerRoom], [agentActivityRoom("a1")]], "the owner's room and the agent's room (only its owner may subscribe)");
    for (const push of errorPushes) {
      assertNoSecret(push.payload.detail, "assistant push");
      assert.notEqual(push.payload.detail, GENERIC_RUNTIME_ERROR_MESSAGE, "the owner reads the scrubbed text");
    }
    assert.equal(viewerReads, 0, "no admin override: the managers are not even read");
  } finally {
    await orchestrator.shutdown();
  }
});

test("a crash reported on a non-error activity (offline + runtime_crashed): members get no text, managers the scrubbed text", async ({ db: _db }) => {
  const { server, agent, creator, orchestrator, send } = await seed();
  try {
    await send({ ...(errorFrame(agent.id, SECRET_DETAIL) as object), activity: "offline", detailKind: "runtime_crashed" } as unknown as MachineToServerMessage);
    await orchestrator.settled((payload) => payload.detailKind === "runtime_crashed");
    const pushes = orchestrator.activityPushes().filter((push) => push.payload.detailKind === "runtime_crashed");
    assert.ok(pushes.length > 0, "the crash was pushed");
    const managerRoom = socketUserServerRoom(creator.id, server.id);
    const managerPush = pushes.find((push) => push.to.includes(managerRoom));
    const memberPush = pushes.find((push) => push.to[0] === `server:${server.id}`);
    assert.ok(managerPush && memberPush);
    assert.notEqual(managerPush.payload.activity, "error", "the activity is not error");
    assertNoSecret(managerPush.payload.detail, "manager crash push");
    assert.match(String(managerPush.payload.detail), /\[REDACTED_TOKEN\]/, "managers read the scrubbed text");
    assert.equal(memberPush.payload.detail, GENERIC_RUNTIME_ERROR_MESSAGE, "members read no text");
    assert.ok(memberPush.except.includes(managerRoom));
    assertNoSecret((await orchestrator.getActivity(agent.id)).activityDetail, "activity read");
    const served = (orchestrator as any).formatActivityFromSnapshot({ activity: "offline", detail: "crash", detailKind: "runtime_crashed", updatedAt: 1 });
    assert.equal(served.activityDetailKind, "runtime_crashed", "a read of a crash snapshot keeps the kind, so REST can project it");
  } finally {
    await orchestrator.shutdown();
  }
});

test("the managers are read at most once per agent per 30 s; evictCache reads them again", async ({ db: _db }) => {
  let now = 1_000_000;
  const clock = { now: () => now, scheduleRepeated: () => null, cancelRepeated: () => undefined, setTimeout: () => null, clearTimeout: () => undefined };
  const orchestrator = new AgentOrchestrator(undefined, clock as never);
  const pushes: Push[] = [];
  orchestrator.setIO(capturingIo(pushes));
  let reads = 0;
  (orchestrator as any).loadRuntimeErrorDetailViewerUserIds = async () => { reads += 1; return ["mgr-1"]; };
  (orchestrator as any).loadJointActivityProjectionChannelIdsForAgent = async () => [];
  (orchestrator as any).getCachedAgent = async (id: string) => ({ id, serverId: "s1", assistantOwnerUserId: null, lastRuntimeError: null });
  try {
    const emit = () => (orchestrator as any).emitActivity("a1", "error", "boom", "runtime_error", now);
    await emit();
    await emit();
    assert.equal(reads, 1, "a burst reads once");
    now += AgentOrchestrator.RUNTIME_ERROR_VIEWER_CACHE_TTL_MS;
    await emit();
    assert.equal(reads, 2, "after the TTL: read again");
    orchestrator.evictCache("a1");
    await emit();
    assert.equal(reads, 3, "evictCache drops it");
    assert.ok(pushes.some((push) => push.to.includes(socketUserServerRoom("mgr-1", "s1"))));
  } finally {
    await orchestrator.shutdown();
  }
});
