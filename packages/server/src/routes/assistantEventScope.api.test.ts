// A personal assistant's live events and sync rows reach its owner only
// (agentEventRoom, agentFindableBy; Tenny, #proj-assistant 5cc12a51); it is on
// no Computer, so in no Computer's agent count. A server owner, an admin or a member who heard its activity,
// session or presence would learn that its owner is using it right now. Every
// other agent reaches the whole server exactly as before.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import {
  AGENT_ACTIVITY_STATE_EVENT,
  AGENT_ACTIVITY_SUBSCRIBE_EVENT,
  AGENT_ACTIVITY_SUBSCRIBED_EVENT,
  AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY,
  EXTERNAL_AGENT_RUNTIME_ID,
  EXTERNAL_AGENT_RUNTIME_MODEL,
  type SyncChangesResponse,
} from "@botiverse/raft-shared";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enablePersonalAssistants, withHostedRuntime } from "../test/hostedAssistantFixture";
import { getDb } from "../db/index";
import { agents, machines } from "../db/schema";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { __setAgentCredentialUseThrottleMsForTests, mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addMember } from "../services/serverService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client") as { io: (url: string, options: Record<string, unknown>) => any };

type User = Awaited<ReturnType<typeof seedUser>>;
type Viewers = Record<"server owner" | "admin" | "member" | "owner", User>;

async function seedPeople(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const user = (role: string) => seedUser(`aes-${label}-${role}-${suffix}@slock.test`, `aes-${label}-${role}-${suffix}`);
  const viewers: Viewers = { "server owner": await user("sowner"), admin: await user("admin"), member: await user("member"), owner: await user("owner") };
  const server = await createServer("Assistant Event Scope", `aes-${label}-${suffix}`, viewers["server owner"].id);
  await addMember(server.id, viewers.admin.id, "admin");
  await addMember(server.id, viewers.member.id);
  await addMember(server.id, viewers.owner.id);
  return { suffix, viewers, server };
}

const EVENTS = ["agent:activity", AGENT_ACTIVITY_STATE_EVENT, "agent:session", "agent:seen"] as const;
type Heard = Array<{ event: string; agentId: string }>;

/** A socket of `user` on the server, recording every agent event it hears. */
async function connect(baseUrl: string, user: User, serverId: string, capable: boolean) {
  const socket = clientIo(baseUrl, {
    auth: { token: await tokenForHuman(user.email), serverId, ...(capable ? { capabilities: [AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY] } : {}) },
    transports: ["websocket"],
    autoConnect: false,
  });
  const heard: Heard = [];
  for (const event of EVENTS) socket.on(event, (payload: { agentId: string }) => heard.push({ event, agentId: payload.agentId }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${user.name}: no rooms:joined`)), 4_000);
    socket.once("rooms:joined", () => { clearTimeout(timer); resolve(); });
    socket.connect();
  });
  return { socket, heard };
}

async function subscribe(socket: any, agentIds: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no agent:activity:subscribed")), 4_000);
    socket.once(AGENT_ACTIVITY_SUBSCRIBED_EVENT, (payload: { agentIds: string[] }) => { clearTimeout(timer); resolve(payload.agentIds); });
    socket.emit(AGENT_ACTIVITY_SUBSCRIBE_EVENT, { agentIds });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The event names each socket heard about `agentId`, once `until` holds (and a little after, for strays). */
async function heardBy(sockets: Array<{ label: string; heard: Heard }>, agentId: string, until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i += 1) await sleep(50);
  assert.ok(until(), "the expected events arrived");
  await sleep(200);
  return Object.fromEntries(sockets.map(({ label, heard }) => [label, [...new Set(heard.filter((h) => h.agentId === agentId).map((h) => h.event))].sort()]));
}

test("an assistant's activity, session and presence reach only its owner: not a member, an admin or the server owner", async ({ app }) => {
  await withHostedRuntime(async () => {
    __setAgentCredentialUseThrottleMsForTests(0);
    const { suffix, viewers, server } = await seedPeople("events");
    await enablePersonalAssistants(server.id);
    const made = await fetch(`${app.baseUrl}/api/servers/${server.id}/assistant`, {
      method: "POST",
      headers: headers(await tokenForHuman(viewers.owner.email), server.id),
      body: JSON.stringify({ name: "Ada" }),
    });
    assert.equal(made.status, 201);
    const assistantId = (await made.json() as { assistant: { agentId: string } }).assistant.agentId;
    // An ordinary external agent of the same person: reaches everyone, as before.
    const plain = await createAgent(server.id, `aes-plain-${suffix}`, {
      runtime: EXTERNAL_AGENT_RUNTIME_ID,
      model: EXTERNAL_AGENT_RUNTIME_MODEL,
      creatorType: "user",
      creatorId: viewers.owner.id,
    });

    // Each viewer: an older client (server-wide push) and a capable one (coarse state, subscriptions).
    const sockets: Array<{ label: string; socket: any; heard: Heard }> = [];
    for (const [who, user] of Object.entries(viewers)) {
      sockets.push({ label: `${who} (legacy)`, ...await connect(app.baseUrl, user, server.id, false) });
      sockets.push({ label: `${who} (capable)`, ...await connect(app.baseUrl, user, server.id, true) });
    }
    const orchestrator = new AgentOrchestrator();
    orchestrator.setIO(app.io);
    try {
      // Detailed activity: only its owner may subscribe to the assistant.
      for (const entry of sockets.filter((e) => e.label.endsWith("(capable)"))) {
        const joined = await subscribe(entry.socket, [assistantId, plain.id]);
        assert.deepEqual(joined.sort(), (entry.label.startsWith("owner") ? [assistantId, plain.id] : [plain.id]).sort(), `${entry.label}: subscribed`);
      }

      for (const agentId of [assistantId, plain.id]) {
        await (orchestrator as any).emitActivity(agentId, "working", "Reading mail", "action", Date.now());
        (orchestrator as any).broadcastAgentSession(await (orchestrator as any).getCachedAgent(agentId), `session-${agentId}`);
        // Presence: the agent's own credential in use, through the real agent API.
        const { apiKey } = await mintAgentCredential({ agentId, scopes: ["read"], name: "aes-test", issuedVia: "computer", createdByUserId: null });
        const context = await fetch(`${app.baseUrl}/internal/agent-api/context`, { headers: { Authorization: `Bearer ${apiKey}` } });
        assert.equal(context.status, 200);
      }

      const legacy = ["agent:activity", "agent:seen", "agent:session"];
      const capable = ["agent:activity", AGENT_ACTIVITY_STATE_EVENT, "agent:seen", "agent:session"].sort();
      const ownerHeard = (agentId: string) => () => sockets
        .filter((e) => e.label.startsWith("owner"))
        .every((e) => e.heard.filter((h) => h.agentId === agentId).length >= 3);

      const ofAssistant = await heardBy(sockets, assistantId, ownerHeard(assistantId));
      assert.deepEqual(ofAssistant, {
        "server owner (legacy)": [],
        "server owner (capable)": [],
        "admin (legacy)": [],
        "admin (capable)": [],
        "member (legacy)": [],
        "member (capable)": [],
        // The coarse state goes to all of the owner's sockets (agentActivityStateRoom);
        // a client without the capability ignores it.
        "owner (legacy)": capable,
        "owner (capable)": capable,
      }, "the assistant's events reach its owner's sockets only");

      const ofPlain = await heardBy(sockets, plain.id, () => sockets.every((e) => e.heard.filter((h) => h.agentId === plain.id).length >= 3));
      for (const entry of sockets) {
        assert.deepEqual(ofPlain[entry.label], entry.label.endsWith("(legacy)") ? legacy : capable, `${entry.label}: an ordinary agent's events, as before`);
      }
    } finally {
      __setAgentCredentialUseThrottleMsForTests(null);
      await orchestrator.shutdown();
      for (const entry of sockets) entry.socket.disconnect();
    }
  });
});

async function syncChanges(baseUrl: string, user: User, serverId: string, since?: string): Promise<SyncChangesResponse> {
  const res = await fetch(`${baseUrl}/api/sync/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`, { headers: headers(await tokenForHuman(user.email), serverId) });
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as SyncChangesResponse;
}

async function machineAgentCount(baseUrl: string, user: User, serverId: string, machineId: string): Promise<number | undefined> {
  const res = await fetch(`${baseUrl}/api/servers/${serverId}/machines`, { headers: headers(await tokenForHuman(user.email), serverId) });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json() as { machines: Array<{ id: string; agentCount: number }> }).machines.find((m) => m.id === machineId)?.agentCount;
}

test("an assistant's sync rows are its owner's only; it is in no Computer's agent count", async ({ app }) => {
  const { suffix, viewers, server } = await seedPeople("sync");
  const db = getDb();
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: viewers["server owner"].id,
    name: `aes-computer-${suffix}`,
    apiKeyHash: "unused-aes-hash",
    runtimes: ["claude"],
  }).returning();
  const [other] = await db.insert(machines).values({
    serverId: server.id,
    userId: viewers["server owner"].id,
    name: `aes-computer-2-${suffix}`,
    apiKeyHash: "unused-aes-hash-2",
    runtimes: ["claude"],
  }).returning();
  app.app.set("agentOrchestrator", {
    getCurrentTimeMs: () => Date.now(),
    getMachineStatus: async () => "online",
    getMachineStatusVersion: async () => 1,
    getMachineDaemonVersion: () => null,
    getMachineComputerVersion: async () => "0.0.70",
  });
  // Only the owner column makes an agent an assistant (agentFindableBy).
  const [assistant] = await db.insert(agents).values({
    serverId: server.id, name: `aes-sync-${suffix}-assistant`, creatorType: "user", creatorId: viewers.owner.id,
    // Never on a machine (agents_assistant_not_on_machine).
    assistantOwnerUserId: viewers.owner.id,
  }).returning();
  const [plain] = await db.insert(agents).values({
    serverId: server.id, name: `aes-sync-plain-${suffix}`, creatorType: "user", creatorId: viewers.owner.id, machineId: machine!.id,
  }).returning();

  for (const [who, user] of Object.entries(viewers)) {
    assert.equal(await machineAgentCount(app.baseUrl, user, server.id, machine!.id), 1, `${who}: the Computer's agent count`);
  }

  const cursors = Object.fromEntries(await Promise.all(Object.entries(viewers).map(async ([who, user]) => [who, (await syncChanges(app.baseUrl, user, server.id)).cursor] as const)));
  // An update (the plain one a move to another Computer), then a hard delete, of both agents.
  await db.update(agents).set({ description: "changed" }).where(eq(agents.id, assistant!.id));
  await db.update(agents).set({ machineId: other!.id }).where(eq(agents.id, plain!.id));
  for (const id of [assistant!.id, plain!.id]) await db.delete(agents).where(eq(agents.id, id));
  for (const [who, user] of Object.entries(viewers)) {
    const round = await syncChanges(app.baseUrl, user, server.id, cursors[who]);
    const agentOps = (id: string) => round.changes.filter((c) => c.entity === "agent" && c.id === id).map((c) => c.op);
    assert.deepEqual(agentOps(plain!.id), ["delete"], `${who}: an ordinary agent's delete, as before`);
    if (who === "owner") {
      assert.deepEqual(agentOps(assistant!.id), ["delete"], "its owner: the assistant's delete");
    } else {
      assert.ok(!JSON.stringify(round).includes(assistant!.id), `${who}: no row names another person's assistant: ${JSON.stringify(round.changes)}`);
    }
  }
});
