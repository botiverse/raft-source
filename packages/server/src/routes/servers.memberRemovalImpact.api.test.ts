import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, computers, serverMembers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import { registerMachine } from "../services/machineService";
import { signInForTest } from "../test/integration/credentials";
import { seedBoundGuest } from "../test/guestFixture";

// GET /servers/:id/members/:memberId/removal-impact: what removing a member, or
// leaving, takes offline (the Computers removeMemberInTransaction revokes and
// the agents on them), for the remove-member and leave dialogs. Anyone the
// remove route refuses gets that same answer.

const test = createApiTest();

async function call(baseUrl: string, token: string, method: string, path: string): Promise<{ status: number; body: unknown; cacheControl: string | null }> {
  const serverId = /^\/api\/servers\/([^/]+)\//.exec(path)?.[1];
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(serverId ? { "X-Server-Id": serverId } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null), cacheControl: res.headers.get("cache-control") };
}

async function attachComputer(serverId: string, userId: string, name: string, extra: Partial<typeof computers.$inferInsert> = {}) {
  const { machine } = await registerMachine(serverId, userId, name);
  const material = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId, name, apiKeyHash: material.apiKeyHash, apiKeyPrefix: material.apiKeyPrefix, apiKeyHmac: material.apiKeyHmac,
    attachedByUserId: userId, machineId: machine.id, ...extra,
  });
  return machine.id;
}

async function bindAgent(serverId: string, machineId: string, name: string, creator: { type: "user" | "agent"; id: string }, set: Partial<typeof agents.$inferInsert> = {}) {
  const agent = await createAgent(serverId, name, { runtime: "external", creatorType: creator.type, creatorId: creator.id });
  await getDb().update(agents).set({ machineId, status: "active", ...set }).where(eq(agents.id, agent.id));
  return agent.id;
}

const impactPath = (serverId: string, memberId: string) => `/api/servers/${serverId}/members/${memberId}/removal-impact`;
const removePath = (serverId: string, memberId: string) => `/api/servers/${serverId}/members/${memberId}`;

test("an admin sees what removing a member takes offline; the member sees the same about leaving", async ({ app, seed }) => {
  const owner = await seed.human();
  const person = await seed.human();
  const colleague = await seed.human();
  const admin = await seed.human();
  const server = await seed.server({ owner, members: [person, colleague] });
  const other = await seed.server({ owner, members: [person] });
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });

  const laptop = await attachComputer(server.id, person.id, "zeta-laptop");
  const box = await attachComputer(server.id, person.id, "alpha-box");
  await bindAgent(server.id, laptop, "own-agent", { type: "user", id: person.id });
  await bindAgent(server.id, laptop, "colleague-agent", { type: "user", id: colleague.id });
  const parent = await bindAgent(server.id, box, "colleague-parent", { type: "user", id: colleague.id });
  await bindAgent(server.id, box, "agent-made", { type: "agent", id: parent });
  // A colleague's personal assistant is hosted, never on a Computer
  // (agents_assistant_not_on_machine): removing the person takes it nowhere.
  const assistant = await createAgent(server.id, "colleague-pa", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ status: "active", assistantOwnerUserId: colleague.id }).where(eq(agents.id, assistant.id));
  const gone = await bindAgent(server.id, box, "deleted-agent", { type: "user", id: colleague.id });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone));
  // Not counted: a revoked Computer of theirs, theirs on another server, a colleague's here.
  const revoked = await attachComputer(server.id, person.id, "old-laptop", { revokedAt: new Date() });
  await bindAgent(server.id, revoked, "on-revoked", { type: "user", id: colleague.id });
  const elsewhere = await attachComputer(other.id, person.id, "elsewhere");
  await bindAgent(other.id, elsewhere, "on-elsewhere", { type: "user", id: owner.id });
  const colleagues = await attachComputer(server.id, colleague.id, "colleague-pc");
  await bindAgent(server.id, colleagues, "on-colleague-pc", { type: "user", id: person.id });

  const expected = { computers: 2, agents: 4, othersAgents: 3, computerNames: ["alpha-box", "zeta-laptop"] };
  const asAdmin = await call(app.baseUrl, (await signInForTest(admin.id)).token, "GET", impactPath(server.id, person.id));
  assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.body));
  assert.deepEqual(asAdmin.body, expected);
  assert.equal(asAdmin.cacheControl, "no-store");

  const asSelf = await call(app.baseUrl, (await signInForTest(person.id)).token, "GET", impactPath(server.id, person.id));
  assert.equal(asSelf.status, 200, JSON.stringify(asSelf.body));
  assert.deepEqual(asSelf.body, expected);
});

test("names at most three Computers, by name; nothing attached reads as zero", async ({ app, seed }) => {
  const owner = await seed.human();
  const person = await seed.human();
  const idle = await seed.human();
  const server = await seed.server({ owner, members: [person, idle] });
  for (const name of ["d", "b", "a", "c"]) await attachComputer(server.id, person.id, name);
  const { token } = await signInForTest(owner.id);

  const many = await call(app.baseUrl, token, "GET", impactPath(server.id, person.id));
  assert.deepEqual(many.body, { computers: 4, agents: 0, othersAgents: 0, computerNames: ["a", "b", "c"] });
  const none = await call(app.baseUrl, token, "GET", impactPath(server.id, idle.id));
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, { computers: 0, agents: 0, othersAgents: 0, computerNames: [] });
});

test("whoever the remove route refuses gets that same refusal", async ({ app, seed }) => {
  const owner = await seed.human();
  const coOwner = await seed.human();
  const member = await seed.human();
  const target = await seed.human();
  const admin = await seed.human();
  const peerAdmin = await seed.human();
  const guest = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [member, target] });
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: coOwner.id, role: "owner" },
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: peerAdmin.id, role: "admin" },
  ]);
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  await attachComputer(server.id, owner.id, "owner-box");

  const cases: Array<[string, string, string]> = [
    ["a member about another member", member.id, target.id],
    ["an admin about an owner", admin.id, owner.id],
    ["an admin about another admin", admin.id, peerAdmin.id],
    ["a Guest about a member", guest.id, target.id],
    ["a Guest about itself", guest.id, guest.id],
    ["an admin about a non-member", admin.id, outsider.id],
  ];
  for (const [label, callerId, memberId] of cases) {
    const { token } = await signInForTest(callerId);
    const impact = await call(app.baseUrl, token, "GET", impactPath(server.id, memberId));
    assert.notEqual(impact.status, 200, label);
    const removal = await call(app.baseUrl, token, "DELETE", removePath(server.id, memberId));
    assert.deepEqual({ status: impact.status, body: impact.body }, { status: removal.status, body: removal.body }, label);
  }
  // The refusals did not remove anyone (an owner still sees the target).
  const { token } = await signInForTest(coOwner.id);
  assert.equal((await call(app.baseUrl, token, "GET", impactPath(server.id, owner.id))).status, 200, "an owner asks about another owner");
});
