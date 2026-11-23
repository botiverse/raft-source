import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { serverMembers, users } from "../db/schema";
import { signInForTest } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";

// A deleted account (users.retired_at) keeps its server_members row and role
// for history, but its owner row is no owner: the last live owner can neither
// demote themselves nor leave, and removing the kept row is no last-owner case.

const test = createApiTest();

type Seed = ReturnType<typeof createSeed>;

async function call(baseUrl: string, userId: string, method: string, path: string, body?: unknown) {
  const serverId = /^\/api\/servers\/([^/]+)\//.exec(path)?.[1];
  const { token } = await signInForTest(userId);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(serverId ? { "X-Server-Id": serverId } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function roleOf(serverId: string, userId: string) {
  const [row] = await getDb().select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row?.role ?? null;
}

async function seedTwoOwners(seed: Seed, opts: { retireCoOwner: boolean }) {
  const owner = await seed.human();
  const coOwner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: coOwner.id, role: "owner" });
  if (opts.retireCoOwner) await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, coOwner.id));
  return { owner, coOwner, member, server };
}

test("a deleted co-owner's kept owner row does not let the last live owner demote themselves or leave", async ({ app, seed }) => {
  const { owner, coOwner, server } = await seedTwoOwners(seed, { retireCoOwner: true });

  const demote = await call(app.baseUrl, owner.id, "PATCH", `/api/servers/${server.id}/members/${owner.id}`, { role: "admin" });
  assert.equal(demote.status, 400, JSON.stringify(demote.body));
  assert.equal(await roleOf(server.id, owner.id), "owner");

  const leave = await call(app.baseUrl, owner.id, "POST", `/api/servers/${server.id}/leave`);
  assert.equal(leave.status, 405, JSON.stringify(leave.body));
  assert.equal(await roleOf(server.id, owner.id), "owner");

  // Removing the kept row takes no live owner away: not refused as the last owner.
  const remove = await call(app.baseUrl, owner.id, "DELETE", `/api/servers/${server.id}/members/${coOwner.id}`);
  assert.equal(remove.status, 200, JSON.stringify(remove.body));
  assert.equal(await roleOf(server.id, coOwner.id), null);
});

test("with two live owners, one may demote themselves, and one may leave", async ({ app, seed }) => {
  const first = await seedTwoOwners(seed, { retireCoOwner: false });
  const demote = await call(app.baseUrl, first.owner.id, "PATCH", `/api/servers/${first.server.id}/members/${first.owner.id}`, { role: "admin" });
  assert.equal(demote.status, 200, JSON.stringify(demote.body));
  assert.equal(await roleOf(first.server.id, first.owner.id), "admin");

  const second = await seedTwoOwners(seed, { retireCoOwner: false });
  const leave = await call(app.baseUrl, second.owner.id, "POST", `/api/servers/${second.server.id}/leave`);
  assert.equal(leave.status, 200, JSON.stringify(leave.body));
  assert.equal(await roleOf(second.server.id, second.owner.id), null);
});
