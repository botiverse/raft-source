// View Context grants (#wg-ax:#15): who may grant, revoke and list, to which
// agents, the audit rows, and the flag. The grant's use is in
// services/agentContextViewGrantQuery.api.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index";
import { asAgentContextViewGrantId, mintAgentContextViewGrantId } from "@botiverse/raft-shared";
import { agentContextViewGrants, agents, integrationAuditEvents, serverMembers } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { seedGrantUser, seedGrantWorld, type GrantWorld } from "../test/agentContextViewGrantFixture";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";

const test = createApiTest();

type AppHandle = { baseUrl: string };
type Body = Record<string, unknown>;

async function call(app: AppHandle, method: string, f: GrantWorld, path: string, auth: { email: string } | { bearer: string }, body?: unknown) {
  const bearer = "bearer" in auth ? auth.bearer : await tokenForHuman(auth.email);
  const res = await fetch(`${app.baseUrl}/api/servers/${f.server.id}/agent-context-view-grants${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "X-Server-Id": f.server.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
}

const grant = (app: AppHandle, f: GrantWorld, email: string, agentId: string) => call(app, "POST", f, "", { email }, { agentId });
const revoke = (app: AppHandle, f: GrantWorld, email: string, grantId: string) => call(app, "DELETE", f, `/${grantId}`, { email });

async function grantRows(serverId: string) {
  return getDb().select().from(agentContextViewGrants).where(eq(agentContextViewGrants.serverId, serverId));
}

async function auditRows(serverId: string, eventType: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, eventType)));
}

test("an owner and an admin grant; one active grant per agent; the list names agent and granter; each grant is audited", async ({ app }) => {
  const f = await seedGrantWorld();
  const byOwner = await grant(app, f, f.owner.email, f.viewer.id);
  assert.equal(byOwner.status, 201, JSON.stringify(byOwner.body));
  assert.equal(byOwner.body.created, true);
  const first = byOwner.body.grant as { id: string; agent: { id: string }; granter: { id: string; name: string } | null; grantedAt: string };
  assert.deepEqual([first.agent.id, first.granter?.id], [f.viewer.id, f.owner.id]);

  const again = await grant(app, f, f.admin.email, f.viewer.id);
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false, "the agent already holds one");
  assert.equal((again.body.grant as { id: string }).id, first.id);

  const byAdmin = await grant(app, f, f.admin.email, f.target.id);
  assert.equal(byAdmin.status, 201);

  const list = await call(app, "GET", f, "", { email: f.admin.email });
  assert.equal(list.status, 200);
  const grants = list.body.grants as Array<{ agent: { id: string }; granter: { id: string } | null }>;
  assert.deepEqual(new Set(grants.map((g) => `${g.agent.id}:${g.granter?.id}`)), new Set([`${f.viewer.id}:${f.owner.id}`, `${f.target.id}:${f.admin.id}`]));

  const rows = await auditRows(f.server.id, "agent.context_view_granted");
  assert.equal(rows.length, 2, "the repeated grant writes nothing");
  const ownerRow = rows.find((row) => row.actorId === f.owner.id)!;
  assert.deepEqual(
    [ownerRow.eventCategory, ownerRow.subjectId, ownerRow.targetId, ownerRow.metadata],
    ["membership", f.viewer.id, first.id, { grantId: first.id, agentId: f.viewer.id, actorRole: "owner" }],
  );
});

test("the list says which grants stopped working and why, from the checks that don't need a target", async ({ app }) => {
  const f = await seedGrantWorld();
  const created = await grant(app, f, f.admin.email, f.viewer.id);
  assert.deepEqual([created.body.grant && (created.body.grant as Body).usable, (created.body.grant as Body).unusableReason], [true, undefined], "a new grant works");
  const listed = async () => {
    const res = await call(app, "GET", f, "", { email: f.owner.email });
    const [only] = res.body.grants as Body[];
    return [only?.usable, only?.unusableReason];
  };
  assert.deepEqual(await listed(), [true, undefined]);

  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id)));
  assert.deepEqual(await listed(), [false, "granter_not_admin"]);
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id)));
  assert.deepEqual(await listed(), [true, undefined], "it works again once the condition holds again");

  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.viewer.id));
  assert.deepEqual(await listed(), [false, "agent_ineligible"]);
  await getDb().update(agents).set({ deletedAt: null }).where(eq(agents.id, f.viewer.id));

  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id)));
  assert.deepEqual(await listed(), [false, "granter_gone"]);
});

test("a member and a Guest cannot grant or list, even as the agent's creator", async ({ app }) => {
  const f = await seedGrantWorld();
  // The member created the target; the Guest is recorded as creating guestCreated.
  for (const [email, agentId] of [[f.member.email, f.target.id], [f.guest.email, f.guestCreated.id]] as const) {
    const res = await grant(app, f, email, agentId);
    assert.equal(res.status, 403, email);
    assert.equal(res.body.code, "context_view_grant_forbidden");
    assert.equal((await call(app, "GET", f, "", { email })).status, 403);
  }
  assert.equal((await grantRows(f.server.id)).length, 0);
});

test("an agent credential cannot grant, even for an agent it created", async ({ app }) => {
  const f = await seedGrantWorld();
  const minted = await mintAgentCredential({ agentId: f.viewer.id, scopes: ["send", "read"], name: "grant-agent", issuedVia: "human", createdByUserId: f.member.id });
  for (const agentId of [f.agentCreated.id, f.viewer.id]) {
    const res = await call(app, "POST", f, "", { bearer: minted.apiKey }, { agentId });
    assert.ok(res.status === 401 || res.status === 403, `refused, got ${res.status}`);
  }
  assert.equal((await call(app, "GET", f, "", { bearer: minted.apiKey })).status === 200, false);
  assert.equal((await grantRows(f.server.id)).length, 0);
});

test("only an ordinary agent of this server can hold a grant: not a personal assistant, an App Bot, another server's or a deleted agent", async ({ app }) => {
  const f = await seedGrantWorld();
  const other = await seedGrantWorld();
  const unknown = await grant(app, f, f.owner.email, randomUUID());
  assert.equal(unknown.status, 404);
  const [deleted] = await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.agentCreated.id)).returning();
  for (const [label, agentId] of [
    ["personal assistant", f.assistant.id],
    ["App Bot", f.bot.id],
    ["another server's agent", other.viewer.id],
    ["deleted agent", deleted!.id],
  ] as const) {
    const res = await grant(app, f, f.owner.email, agentId);
    assert.equal(res.status, 404, label);
    assert.deepEqual(res.body, unknown.body, `${label}: the same answer as an unknown agent`);
  }
  const malformed = await grant(app, f, f.owner.email, "not-a-uuid");
  assert.equal(malformed.status, 400);
  assert.equal((await grantRows(f.server.id)).length, 0);
});

test("the granter or another owner/admin revokes; a second revoke changes nothing; a member who isn't the granter gets the unknown-id 404", async ({ app }) => {
  const f = await seedGrantWorld();
  const a = ((await grant(app, f, f.admin.email, f.viewer.id)).body.grant as { id: string }).id;
  const b = ((await grant(app, f, f.admin.email, f.target.id)).body.grant as { id: string }).id;

  const byMember = await revoke(app, f, f.member.email, a);
  const unknown = await revoke(app, f, f.member.email, "00000000-0000-4000-8000-000000000000");
  assert.deepEqual([byMember.status, byMember.body], [unknown.status, unknown.body], "an existing grant looks like an unknown id");
  assert.equal(byMember.status, 404);
  assert.equal(byMember.body.code, "context_view_grant_not_found");

  const byGranter = await revoke(app, f, f.admin.email, a);
  assert.deepEqual([byGranter.status, byGranter.body], [200, { ok: true, revoked: true }]);
  const twice = await revoke(app, f, f.admin.email, a);
  assert.deepEqual([twice.status, twice.body], [200, { ok: true, revoked: false }], "idempotent");
  const byOwner = await revoke(app, f, f.owner.email, b);
  assert.deepEqual([byOwner.status, byOwner.body], [200, { ok: true, revoked: true }], "another owner/admin may revoke");

  const rows = await grantRows(f.server.id);
  assert.deepEqual(
    new Map(rows.map((row) => [row.id, row.revokedByUserId])),
    new Map([[a, f.admin.id], [b, f.owner.id]]),
  );
  assert.ok(rows.every((row) => row.revokedAt instanceof Date));
  const audits = await auditRows(f.server.id, "agent.context_view_grant_revoked");
  assert.equal(audits.length, 2, "the repeated revoke writes nothing");
  assert.deepEqual(
    audits.find((row) => row.targetId === b)?.metadata,
    { grantId: b, agentId: f.target.id, granterUserId: f.admin.id, byGranter: false, actorRole: "owner" },
  );

  // Revoked: the agent may be granted again, as a new row.
  const regrant = await grant(app, f, f.owner.email, f.viewer.id);
  assert.equal(regrant.status, 201);
  assert.notEqual((regrant.body.grant as { id: string }).id, a);
});

test("a granter demoted to member can still revoke their own grant", async ({ app }) => {
  const f = await seedGrantWorld();
  const id = ((await grant(app, f, f.admin.email, f.viewer.id)).body.grant as { id: string }).id;
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id)));
  assert.deepEqual((await revoke(app, f, f.admin.email, id)).body, { ok: true, revoked: true });
});

test("a grant id of another server, or none at all, is not found", async ({ app }) => {
  const f = await seedGrantWorld();
  const other = await seedGrantWorld();
  const otherId = asAgentContextViewGrantId(((await grant(app, other, other.owner.email, other.viewer.id)).body.grant as { id: string }).id)!;
  for (const id of [otherId, randomUUID(), "not-a-uuid"]) {
    const res = await revoke(app, f, f.owner.email, id);
    assert.equal(res.status, 404, id);
    assert.equal(res.body.code, "context_view_grant_not_found");
  }
  const [still] = await getDb().select().from(agentContextViewGrants).where(and(eq(agentContextViewGrants.id, otherId), isNull(agentContextViewGrants.revokedAt)));
  assert.ok(still, "the other server's grant is untouched");
});

test("with agent_context_view_v0 off every route is the same 404, for an owner too", async ({ app }) => {
  const f = await seedGrantWorld({ flag: false });
  const [row] = await getDb().insert(agentContextViewGrants).values({ id: mintAgentContextViewGrantId(), serverId: f.server.id, granteeAgentId: f.viewer.id, granterUserId: f.owner.id }).returning();
  const answers = [
    await call(app, "GET", f, "", { email: f.owner.email }),
    await grant(app, f, f.owner.email, f.target.id),
    await revoke(app, f, f.owner.email, row!.id),
  ];
  for (const res of answers) {
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, answers[0]!.body);
    assert.equal(res.body.code, "context_view_grants_unavailable");
  }
  const rows = await grantRows(f.server.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.revokedAt, null);
});

test("a non-member is refused before the grant routes", async ({ app }) => {
  const f = await seedGrantWorld();
  const stranger = await seedGrantUser("grant-stranger");
  const res = await grant(app, f, stranger.email, f.viewer.id);
  assert.ok(res.status === 403 || res.status === 404, `refused, got ${res.status}`);
  assert.equal((await grantRows(f.server.id)).length, 0);
});
