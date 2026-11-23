// #457 on the write paths: a saved description whose links some of its
// readers can't open is saved as written, and the answer carries `warnings`
// (only then, and only for a new description). The object kind is a fake
// (links `https://docs.test/d/<id>`) whose homes the test sets; the rules are
// core's (services/profileDescriptionLinks.db.test.ts covers each code).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { asServerId } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, featureFlagRules, featureFlags, users } from "../db/schema";
import type { AppObjectHome } from "../platform/apps";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../services/channelService";

const fake = vi.hoisted(() => ({ flag: `docs_links_${Math.random().toString(36).slice(2, 10)}`, homes: new Map<string, unknown>() }));

vi.mock("../apps/firstPartyApps", async (importOriginal) => {
  const original = await importOriginal<typeof import("../apps/firstPartyApps")>();
  const objectKind = {
    kind: "artifact",
    linkId: (url: string) => /^https:\/\/docs\.test\/d\/([\w-]+)$/.exec(url)?.[1] ?? null,
    homes: async (ids: readonly string[]) => new Map(ids.flatMap((id) => (fake.homes.has(id) ? [[id, fake.homes.get(id)] as const] : []))),
  };
  return { ...original, linkedObjectKinds: () => [{ app: { id: "docs", flag: fake.flag }, objectKind }] };
});

const test = createApiTest();
const tag = () => randomUUID().slice(0, 6);
const link = (id: string) => `https://docs.test/d/${id}`;
let rules = 0;

async function allowFlag(serverIds: readonly string[]) {
  await getDb().insert(featureFlags).values({ key: fake.flag, randomizationUnit: "server", salt: "links" }).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ flagKey: fake.flag, stage: "server", priority: rules++, decision: "allow", values: [...serverIds] });
}

type Warning = { code: string; url: string; object: { kind: string; id: string }; server?: { id: string; name: string }; fixes: string[] };

test("the agent API's profileUpdate saves the description and answers its warnings; the same description again warns of nothing", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await allowFlag([server.id]);
  const agent = await createAgent(server.id, `Linker${tag()}`, { runtime: "external", model: "external", description: "Old" });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "links", issuedVia: "human", createdByUserId: owner.id });
  const channel = await createChannel(server.id, `links-${tag()}`, undefined, "private");
  await addAgent(channel.id, agent.id);
  fake.homes = new Map<string, AppObjectHome>([["conv", { serverId: asServerId(server.id), homeKind: "conversation", homeChannelId: channel.id, author: { type: "agent", id: agent.id } }]]);
  const description = `My list: ${link("conv")}`;
  const save = () => fetch(`${app.baseUrl}/internal/agent-api/profile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });

  const res = await save();
  assert.equal(res.status, 200);
  const body = await res.json() as { description: string; warnings?: Warning[] };
  assert.equal(body.description, description);
  assert.deepEqual(body.warnings?.map((warning) => [warning.code, warning.url, warning.object.id]), [["conversation", link("conv"), "conv"]]);
  assert.ok(body.warnings![0]!.fixes.some((fix) => fix.includes(`#${channel.name}`)), "the agent's fix names its channel");
  const [row] = await getDb().select({ description: agents.description }).from(agents).where(eq(agents.id, agent.id));
  assert.equal(row!.description, description, "saved as written");

  const again = await (await save()).json() as { warnings?: Warning[] };
  assert.equal(again.warnings, undefined, "an unchanged description warns of nothing");
});

test("PATCH /api/agents/:id by an editor who can't see the object: saved, warned with the link only", async ({ http, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner, name: `Home ${tag()}` });
  await allowFlag([server.id]);
  const agent = await createAgent(server.id, `Edited${tag()}`, { runtime: "external", model: "external", description: "Old", creatorType: "user", creatorId: owner.id });
  // A conversation of the agent's that the server's owner isn't in.
  const theirs = await createChannel(server.id, `agent-only-${tag()}`, undefined, "private");
  await addAgent(theirs.id, agent.id);
  fake.homes = new Map<string, AppObjectHome>([["private", { serverId: asServerId(server.id), homeKind: "conversation", homeChannelId: theirs.id, author: { type: "agent", id: agent.id } }]]);
  const description = `See ${link("private")}`;

  const res = await http.as(owner, server).request(`/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { description: string; warnings?: Warning[] };
  assert.equal(body.description, description);
  assert.equal(body.warnings?.length, 1);
  const [warning] = body.warnings!;
  assert.deepEqual(Object.keys(warning!).sort(), ["code", "fixes", "object", "url"], "no home, channel or server");
  assert.equal(warning!.code, "unavailable");
  assert.ok(!JSON.stringify(warning).includes(theirs.name));
});

test("PATCH /api/auth/me: a person's description is judged in each of their servers; the warnings are in the answer, never on the stored user", async ({ http, seed }) => {
  const person = await seed.human();
  const a = await seed.server({ owner: person, name: `Alpha ${tag()}` });
  const otherOwner = await seed.human();
  const b = await seed.server({ owner: otherOwner, members: [person], name: `Beta ${tag()}` });
  await allowFlag([a.id, b.id]);
  const channel = await createChannel(a.id, `mine-${tag()}`, undefined, "private");
  await addHuman(channel.id, person.id);
  fake.homes = new Map<string, AppObjectHome>([["whole", { serverId: asServerId(a.id), homeKind: "server", homeChannelId: null, author: { type: "user", id: person.id } }]]);
  const description = `Our plan: ${link("whole")}`;
  const me = http.as(person);

  const res = await me.request("/api/auth/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description }) });
  assert.equal(res.status, 200);
  const body = await res.json() as { description: string; warnings?: Warning[] };
  assert.equal(body.description, description);
  assert.deepEqual(body.warnings?.map((warning) => [warning.code, warning.server]), [["other_server", { id: b.id, name: b.name }]]);
  const [row] = await getDb().select({ description: users.description }).from(users).where(eq(users.id, person.id));
  assert.equal(row!.description, description);
  const reread = await (await me.get("/api/auth/me")).json() as Record<string, unknown>;
  assert.equal("warnings" in reread, false);

  // Another field only: no warnings.
  const renamed = await (await me.request("/api/auth/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Renamed" }) })).json() as Record<string, unknown>;
  assert.equal("warnings" in renamed, false);
});
