import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { apiTest as test } from "../test/integration/apiTest";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __testRisingWaveInbox, createChannel, canAgentAccessChannel } from "../services/channelService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { __setAgentEventsWaitForDepsForTests } from "./agentEventsWaitFor";

afterEach(() => {
  __testRisingWaveInbox.reset();
  __setAgentEventsWaitForDepsForTests({});
});

// Exercise the actual credential-authenticated route and its real visibility
// queries. Only RisingWave's rows and the sleep clock are synthetic: a target
// with no agent inbox row still has a latest seq in rw_target_latest_v4.
test("events wait_for ignores private, foreign and missing targets; visible targets retain catch-up hints", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const otherServer = await seed.server({ owner: await seed.human() });
  const agent = await createAgent(server.id, `wait-visibility-${randomUUID().slice(0, 8)}`, { runtime: "external", model: "external" });
  const hidden = await createChannel(server.id, `wait-private-${randomUUID().slice(0, 8)}`, undefined, "private");
  const foreign = await createChannel(otherServer.id, `wait-foreign-${randomUUID().slice(0, 8)}`);
  const visible = await createChannel(server.id, `wait-public-${randomUUID().slice(0, 8)}`);
  assert.equal(await canAgentAccessChannel(hidden.id, agent.id), false);
  assert.equal(await canAgentAccessChannel(foreign.id, agent.id), false);
  assert.equal(await canAgentAccessChannel(visible.id, agent.id), true);
  const key = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "wait-visibility", issuedVia: "computer", createdByUserId: null });
  app.app.set("agentOrchestrator", new AgentOrchestrator());
  let time = 0;
  const sleeps: number[] = [];
  __setAgentEventsWaitForDepsForTests({ now: () => time, sleep: async (ms) => { sleeps.push(ms); time += ms; }, overloaded: () => false });
  const queried: string[] = [];
  const latest = new Map([hidden.id, foreign.id, visible.id].map((id) => [id, "100"]));
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, sql: string, values: unknown[] = []) => {
      if (sql.includes("rw_target_latest_v4")) {
        const ids = values[0] as string[];
        queried.push(...ids);
        return { result: { rows: ids.flatMap((id) => latest.has(id) ? [{ target_id: id, latest_seq: latest.get(id) }] : []) } };
      }
      return { result: { rows: [] } };
    }) as never,
  });
  async function read(targets: string) {
    const response = await fetch(`${app.baseUrl}/internal/agent-api/events?wait_for=${targets}`, { headers: { Authorization: `Bearer ${key.apiKey}` } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  const missingId = randomUUID();
  const missing = await read(`${missingId}:1`);
  assert.equal(missing.has_more, false);
  assert.equal(missing.retry_after_ms, undefined);
  assert.deepEqual(missing.events, []);
  for (const id of [hidden.id, foreign.id]) {
    assert.deepEqual(await read(`${id}:1`), missing, "invisible activity is indistinguishable from a missing target");
  }
  assert.equal(sleeps.length, 0, "invisible targets cause no wait timing signal");
  assert.deepEqual(queried, [], "invisible targets never reach the global target-latest read");
  assert.equal((await read(`${visible.id}:1`)).has_more, false, "an already-caught-up visible target does not retry");
  const behind = await read(`${hidden.id}:1,${visible.id}:101`);
  assert.equal(behind.has_more, true, "a visible target behind the requested seq still retries");
  assert.equal(behind.retry_after_ms, 1000);
  assert.deepEqual(behind.events, []);
  assert.ok(sleeps.length > 0, "the visible target follows the wait path");
  assert.ok(queried.length > 0);
  assert.ok(queried.every((id) => id === visible.id), "a mixed batch cannot smuggle hidden targets into the read");
});
