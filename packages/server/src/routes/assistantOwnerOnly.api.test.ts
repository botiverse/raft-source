// A personal assistant's lifecycle is its owner's alone. Nobody else, a server
// owner or admin included, can act on it by id: every by-id agent route answers
// them exactly as for an id that names no agent (agentFindableBy; Tenny,
// #proj-assistant 5cc12a51). Its owner leaving the server archives it. Every
// assistant here is a hosted one made through the my-assistant API, as in
// production.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enablePersonalAssistants, withHostedRuntime, type ProviderCall } from "../test/hostedAssistantFixture";
import { getDb } from "../db/index";
import { agentCredentials, agentRuntimeProvisions, agents, messages } from "../db/schema";
import { addMember, removeMember } from "../services/serverService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed(baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const serverOwner = await seedUser(`aoo-server-owner-${suffix}@slock.test`, `aoo-server-owner-${suffix}`);
  const admin = await seedUser(`aoo-admin-${suffix}@slock.test`, `aoo-admin-${suffix}`);
  const owner = await seedUser(`aoo-owner-${suffix}@slock.test`, `aoo-owner-${suffix}`);
  const member = await seedUser(`aoo-member-${suffix}@slock.test`, `aoo-member-${suffix}`);
  const server = await createServer("Assistant Owner Only", `aoo-${suffix}`, serverOwner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, owner.id);
  await addMember(server.id, member.id);
  await enablePersonalAssistants(server.id);
  const created = await fetch(`${baseUrl}/api/servers/${server.id}/assistant`, {
    method: "POST",
    headers: headers(await tokenForHuman(owner.email), server.id),
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(created.status, 201);
  const mine = (await created.json() as { assistant: { agentId: string; dmChannelId: string } }).assistant;
  const [row] = await getDb().select({ runtime: agents.runtime }).from(agents).where(eq(agents.id, mine.agentId));
  assert.equal(row?.runtime, "external", "a hosted assistant");
  return { serverOwner, admin, owner, member, server, agentId: mine.agentId, dmChannelId: mine.dmChannelId };
}

type Seed = Awaited<ReturnType<typeof seed>>;

const WRITES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "PATCH", path: "", body: { description: "changed" } },
  { method: "POST", path: "/start" },
  { method: "POST", path: "/reset", body: { mode: "restart" } },
  { method: "POST", path: "/interrupt-turn" },
  { method: "PUT", path: "/scopes", body: { scopes: ["read"] } },
  { method: "DELETE", path: "" },
  { method: "POST", path: "/stop" },
  { method: "POST", path: "/archive/workspace", body: { action: "delete" } },
];

// By-id reads, under /api/agents and the routers that name an agent by `:agentId`.
const READS = ["", "/hosted-runtime", "/activity-log", "/scopes", "/channels", "/archive"];

async function call(baseUrl: string, s: Seed, email: string, method: string, path: string, body?: unknown, agentId = s.agentId) {
  const res = await fetch(`${baseUrl}/api/agents/${agentId}${path}`, {
    method,
    headers: headers(await tokenForHuman(email), s.server.id),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.clone().text(), body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

async function assistantState(s: Seed) {
  const [row] = await getDb().select({
    description: agents.description,
    deletedAt: agents.deletedAt,
    pausedAt: agents.assistantPausedAt,
    status: agents.status,
  }).from(agents).where(eq(agents.id, s.agentId));
  return row!;
}

/**
 * Every by-id request on the assistant answers `who` byte for byte as the same
 * request on an id no agent has, and changes nothing.
 */
async function assertReadsAsUnknown(baseUrl: string, s: Seed, email: string, who: string) {
  const before = await assistantState(s);
  const unknownId = randomUUID();
  const requests = [
    ...WRITES,
    ...READS.map((path) => ({ method: "GET", path, body: undefined as unknown })),
  ];
  for (const request of requests) {
    const onAssistant = await call(baseUrl, s, email, request.method, request.path, request.body);
    const onUnknown = await call(baseUrl, s, email, request.method, request.path, request.body, unknownId);
    assert.equal(onAssistant.status, 404, `${who}: ${request.method} ${request.path}: ${onAssistant.text}`);
    assert.deepEqual([onAssistant.status, onAssistant.text], [onUnknown.status, onUnknown.text], `${who}: ${request.method} ${request.path} reads as an unknown agent`);
  }
  // The routers that take the agent as `:agentId`, and the credential routes.
  const token = await tokenForHuman(email);
  for (const path of [`/api/integrations/agents/{id}`, `/api/integrations/agents/{id}/events`, `/api/mcp/agents/{id}`, `/api/agents/{id}/credentials`]) {
    const get = async (id: string) => {
      const res = await fetch(`${baseUrl}${path.replace("{id}", id)}`, { headers: headers(token, s.server.id) });
      return [res.status, await res.text()];
    };
    assert.deepEqual(await get(s.agentId), await get(unknownId), `${who}: GET ${path}`);
  }
  assert.deepEqual(await assistantState(s), before, `${who}: nothing changed`);
}
async function pauseNotices(s: Seed) {
  return getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, s.dmChannelId), eq(messages.systemSubtype, "assistant.stopped_by_admin")));
}

async function pauseState(s: Seed) {
  const [row] = await getDb().select({ pausedAt: agents.assistantPausedAt, by: agents.assistantPausedByUserId }).from(agents).where(eq(agents.id, s.agentId));
  return row!;
}

async function agentPayload(baseUrl: string, s: Seed, email: string) {
  const res = await fetch(`${baseUrl}/api/agents/${s.agentId}`, { headers: headers(await tokenForHuman(email), s.server.id) });
  assert.equal(res.status, 200);
  return await res.json() as Record<string, unknown>;
}

const stopCalls = (calls: ProviderCall[]) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/stop")).length;

test("nobody but its owner acts on an assistant by id: server owner, admin and members get exactly an unknown agent's answer", async ({ app }) => {
  await withHostedRuntime(async (calls) => {
    const s = await seed(app.baseUrl);
    const providerCallsBefore = calls.length;
    await assertReadsAsUnknown(app.baseUrl, s, s.serverOwner.email, "server owner");
    await assertReadsAsUnknown(app.baseUrl, s, s.admin.email, "admin");
    await assertReadsAsUnknown(app.baseUrl, s, s.member.email, "member");
    assert.equal(stopCalls(calls.slice(providerCallsBefore)), 0, "no stop reached the provider");
    assert.deepEqual(await pauseNotices(s), [], "no pause, no notice");

    // Its owner still does all of it.
    assert.equal((await call(app.baseUrl, s, s.owner.email, "GET", "")).status, 200);
    assert.equal((await call(app.baseUrl, s, s.owner.email, "PATCH", "", { description: "mine" })).status, 200);
    assert.equal((await assistantState(s)).description, "mine");
    const stop = await call(app.baseUrl, s, s.owner.email, "POST", "/stop");
    assert.equal(stop.status, 200, stop.text);
    assert.equal(stopCalls(calls), 1, "the owner's stop reaches the provider");
    assert.equal((await call(app.baseUrl, s, s.owner.email, "POST", "/start")).status, 200);
    const restart = await call(app.baseUrl, s, s.owner.email, "POST", "/reset", { mode: "restart" });
    assert.notEqual(restart.status, 404, `the owner's restart finds it: ${restart.text}`);
    const archived = await call(app.baseUrl, s, s.owner.email, "DELETE", "");
    assert.ok(archived.status < 300, archived.text);
    assert.ok((await assistantState(s)).deletedAt, "the owner archived it");
  });
});

test("a pause an admin set before stays the owner's to see and lift; nobody else reads it", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    // Written as an older server's admin Stop left it.
    await getDb().update(agents).set({ assistantPausedAt: new Date(), assistantPausedByUserId: s.admin.id }).where(eq(agents.id, s.agentId));
    const ownerView = await agentPayload(app.baseUrl, s, s.owner.email);
    assert.equal(typeof ownerView.assistantPausedAt, "string");
    assert.deepEqual(ownerView.assistantPausedBy, { id: s.admin.id, name: s.admin.displayName ?? s.admin.name });
    assert.equal("assistantPausedByUserId" in ownerView, false);
    for (const viewer of [s.admin, s.serverOwner, s.member]) {
      assert.equal((await call(app.baseUrl, s, viewer.email, "GET", "")).status, 404, viewer.name);
      assert.equal((await call(app.baseUrl, s, viewer.email, "POST", "/start")).status, 404, viewer.name);
    }
    assert.deepEqual((await call(app.baseUrl, s, s.owner.email, "POST", "/start")).body, { ok: true, resumed: true });
    assert.equal((await pauseState(s)).pausedAt, null);
  });
});

test("only the owner moves the assistant's read position", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const readAll = async (email: string) => (await fetch(`${app.baseUrl}/api/channels/${s.dmChannelId}/read-all`, {
      method: "POST",
      headers: headers(await tokenForHuman(email), s.server.id),
      body: JSON.stringify({ receiver: { kind: "agent", id: s.agentId } }),
    })).status;
    assert.equal(await readAll(s.admin.email), 403);
    assert.equal(await readAll(s.serverOwner.email), 403);
    assert.equal(await readAll(s.owner.email), 200);
  });
});

// An assistant can only be in its DM with its owner (a DB guard), which only
// the owner can see; the per-agent decision in stop-all / resume-all is the
// second line should that ever change.
test("a channel's stop-all and resume-all reach an assistant only through its owner's DM", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const bulk = async (email: string, action: "stop-all-agents" | "resume-all-agents") => {
      const res = await fetch(`${app.baseUrl}/api/channels/${s.dmChannelId}/${action}`, {
        method: "POST",
        headers: headers(await tokenForHuman(email), s.server.id),
        body: JSON.stringify({}),
      });
      const body = await res.json() as { results?: Array<{ agentId: string; ok: boolean; reason?: string }> };
      return { status: res.status, row: body.results?.find((row) => row.agentId === s.agentId) };
    };
    for (const who of [s.member, s.admin, s.serverOwner]) {
      assert.equal((await bulk(who.email, "stop-all-agents")).status, 404, `${who.name} stop-all`);
      assert.equal((await bulk(who.email, "resume-all-agents")).status, 404, `${who.name} resume-all`);
    }
    assert.equal((await bulk(s.owner.email, "stop-all-agents")).row?.ok, true);
    assert.deepEqual(await pauseNotices(s), [], "the owner's own stop is not announced");
  });
});

test("the owner leaving the server archives the assistant; nobody else finds it archived either", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    assert.deepEqual(await removeMember(s.server.id, s.owner.id, { actorUserId: s.admin.id }), { archivedAssistantIds: [s.agentId], detachedComputers: [] });

    const [row] = await getDb().select({ deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, s.agentId));
    assert.ok(row?.deletedAt, "archived with its owner");
    const credentials = await getDb().select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.agentId, s.agentId));
    assert.ok(credentials.length > 0 && credentials.every((c) => c.revokedAt !== null), "every credential revoked");
    const [provision] = await getDb().select({ state: agentRuntimeProvisions.state }).from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, s.agentId));
    assert.equal(provision?.state, "deleting", "the hosted runtime is being deleted");

    // Archived, it is still nobody else's to find: a hosted assistant has no
    // Computer workspace to clean up, and its archive reads as unknown.
    for (const who of [s.member, s.admin, s.serverOwner]) {
      for (const [method, path, body] of [["POST", "/archive/workspace", { action: "delete" }], ["GET", "/archive", undefined]] as const) {
        const onAssistant = await call(app.baseUrl, s, who.email, method, path, body);
        const onUnknown = await call(app.baseUrl, s, who.email, method, path, body, randomUUID());
        assert.equal(onAssistant.status, 404, `${who.name} ${path}`);
        assert.deepEqual([onAssistant.status, onAssistant.text], [onUnknown.status, onUnknown.text], `${who.name} ${path}`);
      }
    }
  });
});

test("an assistant is always Ottie: no agent profile route renames it or changes its avatar, for its owner either", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const profile = async () => {
      const [row] = await getDb().select({ displayName: agents.displayName, avatarUrl: agents.avatarUrl, description: agents.description }).from(agents).where(eq(agents.id, s.agentId));
      return row!;
    };
    const before = await profile();
    assert.deepEqual([before.displayName, before.avatarUrl], ["Ottie", "pixel:ottie"]);
    for (const body of [{ displayName: "Jarvis" }, { displayName: null }, { avatarUrl: "pixel:robot" }, { avatarUrl: null }, { displayName: "Jarvis", description: "renamed" }]) {
      const refused = await call(app.baseUrl, s, s.owner.email, "PATCH", "", body);
      assert.deepEqual([refused.status, refused.body?.code], [403, "assistant_profile_fixed"], JSON.stringify(body));
    }
    // The avatar upload is refused before any file is read.
    const upload = await fetch(`${app.baseUrl}/api/agents/${s.agentId}/avatar`, { method: "POST", headers: { Authorization: `Bearer ${await tokenForHuman(s.owner.email)}`, "X-Server-Id": s.server.id } });
    assert.deepEqual([upload.status, ((await upload.json()) as { code?: string }).code], [403, "assistant_profile_fixed"]);
    const after = await profile();
    assert.deepEqual([after.displayName, after.avatarUrl], ["Ottie", "pixel:ottie"]);
    assert.notEqual(after.description, "renamed", "a refused request changes nothing");
    // Resending the fixed name and avatar is a no-op and passes, so a form that echoes them still saves.
    const echo = await call(app.baseUrl, s, s.owner.email, "PATCH", "", { displayName: "Ottie", avatarUrl: "pixel:ottie", description: "mine" });
    assert.equal(echo.status, 200, JSON.stringify(echo.body));
    assert.deepEqual(await profile(), { displayName: "Ottie", avatarUrl: "pixel:ottie", description: "mine" });
  });
});
