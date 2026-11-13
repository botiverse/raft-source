// The by-id agent routes find an agent on the decoded path, so the gate that
// hides another person's personal assistant must decide on the decoded id
// too: a percent-encoded id (`%2D` for `-`) names the same assistant and
// must get the same answer as an id that names no agent.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enablePersonalAssistants, withHostedRuntime } from "../test/hostedAssistantFixture";
import { addMember } from "../services/serverService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const NO_AGENT = "00000000-0000-0000-0000-000000000000";

async function seed(baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const serverOwner = await seedUser(`uag-server-owner-${suffix}@slock.test`, `uag-server-owner-${suffix}`);
  const owner = await seedUser(`uag-owner-${suffix}@slock.test`, `uag-owner-${suffix}`);
  const server = await createServer("Unfindable Agent Gate", `uag-${suffix}`, serverOwner.id);
  await addMember(server.id, owner.id);
  await enablePersonalAssistants(server.id);
  const created = await fetch(`${baseUrl}/api/servers/${server.id}/assistant`, {
    method: "POST",
    headers: headers(await tokenForHuman(owner.email), server.id),
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(created.status, 201);
  const assistantId = (await created.json() as { assistant: { agentId: string } }).assistant.agentId;
  return { serverOwner, owner, server, assistantId };
}

async function answer(baseUrl: string, method: string, path: string, email: string, serverId: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(await tokenForHuman(email), serverId),
    ...(method === "GET" ? {} : { body: "{}" }),
  });
  return { status: res.status, body: await res.text() };
}

test("a percent-encoded id of another person's assistant is answered as no agent", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const encodedIds = [
      s.assistantId.replaceAll("-", "%2D"),
      s.assistantId.replaceAll("-", "%2d"),
      s.assistantId.replace(/^./, (c) => `%${c.charCodeAt(0).toString(16)}`),
    ];
    for (const [method, sub] of [["GET", ""], ["GET", "/runtime-options"], ["GET", "/external-status"], ["POST", "/start"], ["PATCH", ""]] as const) {
      const expected = await answer(app.baseUrl, method, `/api/agents/${NO_AGENT}${sub}`, s.serverOwner.email, s.server.id);
      for (const id of encodedIds) {
        const got = await answer(app.baseUrl, method, `/api/agents/${id}${sub}`, s.serverOwner.email, s.server.id);
        assert.deepEqual(got, expected, `${method} /api/agents/${id}${sub} answers as an unknown agent`);
      }
    }
    // The owner still reaches their assistant through an encoded id.
    const own = await answer(app.baseUrl, "GET", `/api/agents/${encodedIds[0]}`, s.owner.email, s.server.id);
    assert.equal(own.status, 200, own.body);
  });
});
