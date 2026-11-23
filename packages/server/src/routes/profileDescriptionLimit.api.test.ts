// A new or changed profile description (an agent's or a person's) is at most
// PROFILE_DESCRIPTION_MAX_LENGTH (300) characters. One saved under the older
// 3000-character limit stays as it is: saving it unchanged still succeeds, and
// only once it changes does the limit apply. Covers the human editor's PATCH
// /api/agents/:id, the agent's own profileUpdate and PATCH /api/auth/me.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PROFILE_DESCRIPTION_MAX_LENGTH } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";

const test = createApiTest();
const tag = () => randomUUID().slice(0, 6);
const json = (body: unknown) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// Saved under the older limit (an internal write; the routes would refuse it now).
const LEGACY = `Legacy intro. ${"x".repeat(398)}`;
const FITS = "y".repeat(PROFILE_DESCRIPTION_MAX_LENGTH);
const OVER = "z".repeat(PROFILE_DESCRIPTION_MAX_LENGTH + 1);

test("PATCH /api/agents/:id: an unchanged over-long description saves; a new or changed one over 300 is refused; 300 saves", async ({ http, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agent = await createAgent(server.id, `Long${tag()}`, { runtime: "external", model: "external", description: LEGACY, creatorType: "user", creatorId: owner.id });
  const editor = http.as(owner, server);
  const stored = async () => (await getDb().select({ description: agents.description }).from(agents).where(eq(agents.id, agent.id)))[0]!.description;

  const unchanged = await editor.request(`/api/agents/${agent.id}`, json({ description: LEGACY, displayName: "Renamed" }));
  assert.equal(unchanged.status, 200, "the stored description, sent back with another field, saves");
  assert.equal(await stored(), LEGACY, "nothing truncated or rewritten");

  const changed = await editor.request(`/api/agents/${agent.id}`, json({ description: `${LEGACY}!` }));
  assert.equal(changed.status, 400);
  assert.equal((await changed.json() as { code: string }).code, "profile_description_invalid");
  assert.equal(await stored(), LEGACY);

  const fits = await editor.request(`/api/agents/${agent.id}`, json({ description: FITS }));
  assert.equal(fits.status, 200);
  assert.equal(await stored(), FITS);

  const create = await editor.request("/api/agents", { ...json({ name: `New${tag()}`, description: OVER, external: true }), method: "POST" });
  assert.equal(create.status, 400, "a new agent's description is new");
  assert.equal((await create.json() as { code: string }).code, "profile_description_invalid");
});

test("the agent API's profileUpdate: the agent's unchanged over-long description saves; a changed one over 300 is refused", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agent = await createAgent(server.id, `Self${tag()}`, { runtime: "external", model: "external", description: LEGACY });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "limit", issuedVia: "human", createdByUserId: owner.id });
  const save = (body: unknown) => fetch(`${app.baseUrl}/internal/agent-api/profile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await save({ description: LEGACY, displayName: "Self" })).status, 200);
  const changed = await save({ description: OVER });
  assert.equal(changed.status, 400);
  const refusal = await changed.json() as { code: string; error: string };
  assert.equal(refusal.code, "profile_description_invalid");
  assert.match(refusal.error, /300 characters/);
  assert.equal((await save({ description: FITS })).status, 200);
  const [row] = await getDb().select({ description: agents.description }).from(agents).where(eq(agents.id, agent.id));
  assert.equal(row!.description, FITS);
});

test("PATCH /api/auth/me: a person's unchanged over-long description saves; a new or changed one over 300 is refused; 300 saves", async ({ http, seed }) => {
  const person = await seed.human();
  await getDb().update(users).set({ description: LEGACY }).where(eq(users.id, person.id));
  const me = http.as(person);
  const stored = async () => (await getDb().select({ description: users.description }).from(users).where(eq(users.id, person.id)))[0]!.description;

  assert.equal((await me.request("/api/auth/me", json({ description: LEGACY }))).status, 200);
  assert.equal((await me.request("/api/auth/me", json({ description: ` ${LEGACY}\n` }))).status, 200, "whitespace at the ends is no change");
  assert.equal(await stored(), LEGACY);

  const changed = await me.request("/api/auth/me", json({ description: `${LEGACY}!` }));
  assert.equal(changed.status, 400);
  assert.match((await changed.json() as { error: string }).error, /300 characters/);
  assert.equal(await stored(), LEGACY);

  assert.equal((await me.request("/api/auth/me", json({ description: FITS }))).status, 200);
  assert.equal(await stored(), FITS);
  const fresh = await me.request("/api/auth/me", json({ description: OVER }));
  assert.equal(fresh.status, 400, "after a short one, an over-long one is a change");
});
