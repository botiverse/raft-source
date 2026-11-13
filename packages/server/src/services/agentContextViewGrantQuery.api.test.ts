// #wg-ax:#15: an agent searching another agent's View Context through a
// grant, against the database: every way the grant does not hold is the same
// 404 as an unknown message, before the rate limit; a grant that stops holding
// between the request and the result means the result is not delivered. Rows
// are never deleted for any of these: the grant stays and is decided unusable.
//
// The message lookup (resolveMessageIdVisibleToAgent, unchanged here) is
// stubbed to return the message's sender; the relay, its request store (the
// in-process fallback, which parses the record like Redis's), the recheck and
// the audit rows are the real ones.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import {
  asAgentContextViewRequestId,
  asMachineId,
  mintAgentContextViewGrantId,
  mintAgentContextViewRequestId,
  type AgentContextQuery,
  type AgentContextSearchRequestMessage,
  type AgentContextViewGrantId,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentContextViewGrants, agents, integrationAuditEvents, serverMembers, users } from "../db/schema";
import { createAgentContextViewRequest, getAgentContextViewRequest } from "../replicaRouter";
import { seedGrantWorld, type GrantWorld } from "../test/agentContextViewGrantFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { dbTest } from "../test/integration/dbTest";
import { AgentContextQueryRateLimiter, agentContextNotViewableSentence, handleAgentContextQuery } from "./agentContextQueryApi";
import { createAgentContextViewGrant } from "./agentContextViewGrantService";
import { createAgentContextViewRelay, listAgentContextViews, recheckAgentContextViewRequest } from "./agentContextViewService";
import * as messageService from "./messageService";

vi.mock("./messageService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messageService")>()),
  resolveMessageIdVisibleToAgent: vi.fn(),
}));

/** Each case on its own database (the `db` fixture opens it). */
function test(name: string, run: () => Promise<void>) {
  dbTest(name, async ({ db }) => {
    void db;
    await run();
  });
}

const resolve = vi.mocked(messageService.resolveMessageIdVisibleToAgent);
/** messageId -> the agent that sent it; anything else is a message the caller can't see. */
const senders = new Map<string, string>();
resolve.mockImplementation(async (_serverId, _agentId, messageId) => {
  const senderId = senders.get(messageId);
  return senderId
    ? { ok: true, message: { id: messageId, senderType: "agent", senderId } } as never
    : { ok: false, status: 404, error: "Message not found" } as never;
});

function messageFrom(agentId: string): string {
  const id = randomUUID();
  senders.set(id, agentId);
  return id;
}

const QUERY: AgentContextQuery = { kind: "search", query: "deploy", limit: 20, offset: 0 };
const ANSWER = {
  ok: true,
  runtime: "claude",
  model: null,
  entryCount: 4,
  answer: { kind: "search", total: 1, matches: [{ id: "m1.p0", role: "user", type: "text", hits: 1, line: "the deploy notes" }] },
};

type Harness = {
  ask(agentId: string, messageId: string): Promise<{ status: number; raw: string; body: Record<string, unknown> }>;
  nextFrame(): Promise<AgentContextSearchRequestMessage>;
  postResult(requestId: string, body: unknown): Promise<number>;
  frames: AgentContextSearchRequestMessage[];
  close(): Promise<void>;
};

/** The agent API's handler and the Computer's result route on one app, with a Computer that is online and capable unless told otherwise. */
async function harness(f: GrantWorld, options: { online?: boolean; limiter?: AgentContextQueryRateLimiter } = {}): Promise<Harness> {
  const frames: AgentContextSearchRequestMessage[] = [];
  const relay = createAgentContextViewRelay();
  const limiter = options.limiter ?? new AgentContextQueryRateLimiter();
  const app = express();
  app.set("agentContextViewRelay", relay);
  app.set("agentOrchestrator", {
    getMachineStatus: async () => (options.online === false ? "offline" : "online"),
    machineAdvertisesCapability: async () => true,
    sendAgentContextViewRequest: async (_machineId: string, frame: AgentContextSearchRequestMessage) => {
      frames.push(frame);
      return true;
    },
  });
  app.post("/q", express.json(), (req, res, next) => {
    const { agentId, messageId } = req.body as { agentId: string; messageId: string };
    handleAgentContextQuery(req, res, { agentId, serverId: f.server.id, messageId, query: QUERY, limiter }).catch(next);
  });
  app.post("/result/:requestId", (req, res, next) => {
    relay.receiveResult(req, res, asMachineId(f.machineId)).catch(next);
  });
  const server: Server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    frames,
    async ask(agentId, messageId) {
      const res = await fetch(`${url}/q`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId, messageId }) });
      const raw = await res.text();
      return { status: res.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
    },
    async nextFrame() {
      for (let i = 0; i < 300 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(frames[0], "the search frame was sent to the target's Computer");
      return frames.shift()!;
    },
    async postResult(requestId, body) {
      const res = await fetch(`${url}/result/${encodeURIComponent(requestId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await res.arrayBuffer();
      return res.status;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function grantTo(f: GrantWorld, agentId: string, granter: { id: string } = f.admin, role: "owner" | "admin" = "admin") {
  const result = await createAgentContextViewGrant({ serverId: f.server.id, granterUserId: granter.id, granterRole: role, agentId });
  assert.equal(result.kind, "created");
  return (result as { grant: { id: AgentContextViewGrantId } }).grant.id;
}

function assertNotViewable(r: { status: number; body: Record<string, unknown> }, messageId: string, label = "") {
  assert.equal(r.status, 404, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, "context_not_viewable", label);
  assert.equal(r.body.error, agentContextNotViewableSentence(messageId), label);
}

/** The 404 for a message the caller can't see at all: every refusal must be byte for byte this. */
async function unknownMessageRefusal(h: Harness, f: GrantWorld, messageId: string) {
  senders.delete(messageId);
  const r = await h.ask(f.viewer.id, messageId);
  assertNotViewable(r, messageId, "unknown message");
  return r.raw;
}

async function grantRow(id: AgentContextViewGrantId) {
  const [row] = await getDb().select().from(agentContextViewGrants).where(eq(agentContextViewGrants.id, id));
  return row!;
}

const setRole = (f: GrantWorld, userId: string, role: "owner" | "admin" | "member" | "guest") =>
  // A Guest always has its one channel (server_members_guest_has_channel).
  role === "guest"
    ? seedBoundGuest({ serverId: f.server.id, userId })
    : getDb().update(serverMembers).set({ role }).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, userId)));

/**
 * Each way a grant stops holding, applied to a world where the admin granted
 * the viewer and the target (created by the member) sent the message. None
 * deletes or revokes the grant row, except `revoked` itself.
 */
const STOPS: Array<[string, (f: GrantWorld, grantId: AgentContextViewGrantId) => Promise<unknown>]> = [
  ["the grant is revoked", (_f, id) => getDb().update(agentContextViewGrants).set({ revokedAt: new Date(), revokedByUserId: _f.owner.id }).where(eq(agentContextViewGrants.id, id))],
  ["the granter is demoted to member", (f) => setRole(f, f.admin.id, "member")],
  ["the granter is demoted to member, though they created the target", async (f) => {
    await getDb().update(agents).set({ creatorType: "user", creatorId: f.admin.id }).where(eq(agents.id, f.target.id));
    await setRole(f, f.admin.id, "member");
  }],
  ["the granter becomes a Guest", (f) => setRole(f, f.admin.id, "guest")],
  ["the granter leaves the server", (f) => getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id)))],
  ["the granter's account is deleted (membership row kept)", (f) => getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, f.admin.id))],
  ["the grantee is deleted", (f) => getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.viewer.id))],
  ["the grantee is moved to another server", async (f) => {
    const other = await seedGrantWorld({ flag: true });
    await getDb().update(agents).set({ serverId: other.server.id }).where(eq(agents.id, f.viewer.id));
  }],
  // A personal assistant is hosted, never on a Computer (agents_assistant_not_on_machine).
  ["the grantee becomes a personal assistant", (f) => getDb().update(agents).set({ assistantOwnerUserId: f.owner.id, machineId: null }).where(eq(agents.id, f.viewer.id))],
  ["the target is deleted", (f) => getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.target.id))],
  ["the target leaves the server", async (f) => {
    const other = await seedGrantWorld({ flag: true });
    await getDb().update(agents).set({ serverId: other.server.id }).where(eq(agents.id, f.target.id));
  }],
  ["the target becomes a personal assistant", (f) => getDb().update(agents).set({ assistantOwnerUserId: f.admin.id, machineId: null }).where(eq(agents.id, f.target.id))],
];

test("with a grant, an agent reads another agent's context; the attempt names the grant and its granter", async () => {
  const f = await seedGrantWorld();
  const grantId = await grantTo(f, f.viewer.id);
  const h = await harness(f);
  try {
    const messageId = messageFrom(f.target.id);
    const asking = h.ask(f.viewer.id, messageId);
    const frame = await h.nextFrame();
    assert.equal(frame.agentId, f.target.id, "the target's Computer is asked about the target");
    const stored = await getAgentContextViewRequest(asAgentContextViewRequestId(frame.requestId)!);
    assert.deepEqual([stored?.record.viewerKind, stored?.record.mode, stored?.record.grantId], ["agent", "query", grantId], "the stored record keeps the grant");
    assert.equal(await h.postResult(frame.requestId, ANSWER), 200);
    const r = await asking;
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, ANSWER);

    const [attempt] = await getDb().select().from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "agent.context_view_requested"), eq(integrationAuditEvents.subjectId, f.target.id)));
    assert.deepEqual(
      [attempt?.actorType, attempt?.actorId, attempt?.metadata],
      ["agent", f.viewer.id, { agentId: f.target.id, messageId, machineId: f.machineId, viewerType: "agent", mode: "search", query: "deploy", grantId, granterUserId: f.admin.id }],
    );
    for (let i = 0; i < 100; i++) {
      const [outcome] = await getDb().select().from(integrationAuditEvents)
        .where(and(eq(integrationAuditEvents.eventType, "agent.context_viewed"), eq(integrationAuditEvents.subjectId, f.target.id)));
      if (outcome) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const views = await listAgentContextViews({ serverId: f.server.id, agentId: f.target.id });
    assert.equal(views.length, 1);
    assert.deepEqual(
      [views[0]?.viewerKind, views[0]?.viewer?.id, views[0]?.outcome, views[0]?.query, views[0]?.grant],
      // The list reads what was asked from the attempt row (the match count is on the outcome row).
      ["agent", f.viewer.id, "ok", { mode: "search", query: "deploy", matches: null }, { id: grantId, granter: { id: f.admin.id, name: "grant-admin" } }],
    );
  } finally {
    await h.close();
  }
});

test("its own context needs no grant", async () => {
  const f = await seedGrantWorld();
  const h = await harness(f, { online: false });
  try {
    const r = await h.ask(f.viewer.id, messageFrom(f.viewer.id));
    assert.deepEqual([r.status, r.body.code], [409, "context_offline"], "past the permission check: the Computer is offline");
  } finally {
    await h.close();
  }
});

test("without a usable grant: the same 404 as an unknown message, byte for byte, and nothing reaches the Computer", async () => {
  const f = await seedGrantWorld();
  const other = await seedGrantWorld();
  const off = await seedGrantWorld({ flag: false });
  const h = await harness(f);
  try {
    const unknownId = randomUUID();
    const unknown = await unknownMessageRefusal(h, f, unknownId);
    const cases: Array<[string, () => Promise<{ raw: string; status: number; body: Record<string, unknown> }>, string]> = [];
    const noGrant = messageFrom(f.target.id);
    cases.push(["no grant", () => h.ask(f.viewer.id, noGrant), noGrant]);
    // A grant held by someone else doesn't help the viewer.
    await grantTo(f, f.guestCreated.id);
    const othersGrant = messageFrom(f.target.id);
    cases.push(["another agent's grant", () => h.ask(f.viewer.id, othersGrant), othersGrant]);
    const fromOtherServer = messageFrom(other.target.id);
    cases.push(["a message from another server's agent (a joint channel)", () => h.ask(f.viewer.id, fromOtherServer), fromOtherServer]);
    for (const [label, run, messageId] of cases) {
      const r = await run();
      assertNotViewable(r, messageId, label);
      assert.equal(r.raw, unknown.replace(unknownId, messageId), `${label}: byte for byte`);
    }
    assert.equal(h.frames.length, 0);
  } finally {
    await h.close();
  }
  // The flag off, with a grant.
  const hOff = await harness(off);
  try {
    await getDb().insert(agentContextViewGrants).values({ id: mintAgentContextViewGrantId(), serverId: off.server.id, granteeAgentId: off.viewer.id, granterUserId: off.owner.id });
    const messageId = messageFrom(off.target.id);
    assertNotViewable(await hOff.ask(off.viewer.id, messageId), messageId, "flag off");
    assert.equal(hOff.frames.length, 0);
  } finally {
    await hOff.close();
  }
});

test("a personal assistant's context is never viewable through a grant, even one its owner gave", async () => {
  const f = await seedGrantWorld();
  // Make the granting admin the assistant's owner: canViewAgentContext(admin, assistant) holds.
  await getDb().update(agents).set({ assistantOwnerUserId: f.admin.id }).where(eq(agents.id, f.assistant.id));
  await grantTo(f, f.viewer.id);
  const h = await harness(f);
  try {
    const messageId = messageFrom(f.assistant.id);
    assertNotViewable(await h.ask(f.viewer.id, messageId), messageId);
    assert.equal(h.frames.length, 0);
  } finally {
    await h.close();
  }
});

for (const [label, stop] of STOPS) {
  test(`at the call: ${label} -> the same 404, the grant row stays`, async () => {
    const f = await seedGrantWorld();
    const grantId = await grantTo(f, f.viewer.id);
    const h = await harness(f);
    try {
      const unknownId = randomUUID();
      const unknown = await unknownMessageRefusal(h, f, unknownId);
      const messageId = messageFrom(f.target.id);
      await stop(f, grantId);
      const r = await h.ask(f.viewer.id, messageId);
      assertNotViewable(r, messageId, label);
      assert.equal(r.raw, unknown.replace(unknownId, messageId), "byte for byte");
      assert.equal(h.frames.length, 0, "nothing reached the Computer");
      const row = await grantRow(grantId);
      assert.ok(row, "the grant row is not deleted");
      if (label !== "the grant is revoked") assert.equal(row.revokedAt, null, "nor revoked: it is only unusable");
    } finally {
      await h.close();
    }
  });

  test(`between the request and the result: ${label} -> the result is not delivered`, async () => {
    const f = await seedGrantWorld();
    const grantId = await grantTo(f, f.viewer.id);
    const h = await harness(f);
    try {
      const messageId = messageFrom(f.target.id);
      const asking = h.ask(f.viewer.id, messageId);
      const frame = await h.nextFrame();
      await stop(f, grantId);
      await h.postResult(frame.requestId, ANSWER);
      const r = await asking;
      assertNotViewable(r, messageId, label);
      assert.ok(!r.raw.includes("the deploy notes"), "nothing from the answer reached the viewer");
      assert.ok(await grantRow(grantId), "the grant row is not deleted");
    } finally {
      await h.close();
    }
  });
}

test("the rate limit counts only calls that passed the grant check: refusals never see a 429", async () => {
  const f = await seedGrantWorld();
  const h = await harness(f, { online: false, limiter: new AgentContextQueryRateLimiter(1, 60_000) });
  try {
    const messageId = messageFrom(f.target.id);
    for (let i = 0; i < 3; i++) assertNotViewable(await h.ask(f.viewer.id, messageId), messageId, "no grant yet");
    const grantId = await grantTo(f, f.viewer.id);
    assert.deepEqual([(await h.ask(f.viewer.id, messageId)).status], [409], "allowed: counted (the Computer is offline)");
    assert.equal((await h.ask(f.viewer.id, messageId)).status, 429);
    await getDb().update(agentContextViewGrants).set({ revokedAt: new Date() }).where(eq(agentContextViewGrants.id, grantId));
    assertNotViewable(await h.ask(f.viewer.id, messageId), messageId, "revoked: the 404, not the 429");
  } finally {
    await h.close();
  }
});

test("recheck: an agent viewing another agent needs a record that names a usable grant of its own", async () => {
  const f = await seedGrantWorld();
  const grantId = await grantTo(f, f.viewer.id);
  const othersGrant = await grantTo(f, f.guestCreated.id);
  const record = {
    requestId: mintAgentContextViewRequestId(),
    viewerUserId: f.viewer.id,
    viewerKind: "agent" as const,
    mode: "query" as const,
    agentId: f.target.id,
    serverId: f.server.id,
    messageId: randomUUID(),
    machineId: asMachineId(f.machineId),
    viewerReplicaId: "replica-a",
    viewerEndpoint: null,
    createdAt: new Date().toISOString(),
  };
  assert.equal(await recheckAgentContextViewRequest({ ...record, grantId }), "ok");
  assert.equal(await recheckAgentContextViewRequest(record), "refused", "no grant id (an older replica's record): refused");
  assert.equal(await recheckAgentContextViewRequest({ ...record, grantId: othersGrant }), "refused", "another agent's grant");
  assert.equal(await recheckAgentContextViewRequest({ ...record, grantId: mintAgentContextViewGrantId() }), "refused", "an unknown grant");
  assert.equal(await recheckAgentContextViewRequest({ ...record, viewerUserId: f.target.id }), "ok", "itself: no grant needed");
});

test("the request record keeps viewerKind, mode and grantId through the store; an unknown value makes it unknown", async () => {
  const f = await seedGrantWorld();
  const grantId = mintAgentContextViewGrantId();
  const base = {
    viewerUserId: f.viewer.id,
    agentId: f.target.id,
    serverId: f.server.id,
    messageId: randomUUID(),
    machineId: asMachineId(f.machineId),
    viewerReplicaId: "replica-a",
    viewerEndpoint: null,
    createdAt: new Date().toISOString(),
  };
  const kept = { ...base, requestId: mintAgentContextViewRequestId(), viewerKind: "agent" as const, mode: "query" as const, grantId };
  await createAgentContextViewRequest(kept, 60_000);
  assert.deepEqual((await getAgentContextViewRequest(kept.requestId))?.record, kept);
  const person = { ...base, requestId: mintAgentContextViewRequestId() };
  await createAgentContextViewRequest(person, 60_000);
  assert.deepEqual((await getAgentContextViewRequest(person.requestId))?.record, person);
  const bad = { ...base, requestId: mintAgentContextViewRequestId(), viewerKind: "agent" as const, grantId: "not-a-grant" as never };
  await createAgentContextViewRequest(bad, 60_000);
  assert.equal(await getAgentContextViewRequest(bad.requestId), null, "a malformed grant id fails closed");
});
