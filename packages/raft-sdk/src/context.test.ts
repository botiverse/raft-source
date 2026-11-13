import assert from "node:assert/strict";
import { createRaftClient } from "./index";

const credential = "sk_agent_context_test_sentinel";
const body = {
  agent: {
    id: "agent-1", name: "bobo", displayName: "BoBo", description: null,
    runtime: "external", external: true, future_agent_field: "discard",
  },
  server: { id: "server-1", slug: "botiverse", name: "Botiverse", future_server_field: "discard" },
  credential: { capabilities: ["send", "read"] },
  prompt: { audience: "self-hosted-runner", text: "# Guide" },
};

test("agent.context returns the bound agent, server slug and name, and capabilities", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const client = createRaftClient({
    serverUrl: "https://raft.example/",
    credential,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json(body);
    },
  });

  const result = await client.agent.context();

  assert.deepEqual(calls, [{
    url: "https://raft.example/internal/agent-api/context",
    method: "GET",
    authorization: `Bearer ${credential}`,
  }]);
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    data: {
      agent: {
        id: "agent-1", name: "bobo", displayName: "BoBo", description: null,
        runtime: "external", external: true, assistantOf: null, raftbenchReader: false,
      },
      server: { id: "server-1", slug: "botiverse", name: "Botiverse" },
      capabilities: ["send", "read"],
      guide: "# Guide",
      features: { reminderApp: false, vaultApp: false, enabledApps: [] },
    },
  });
});

test("agent.context maps a managed agent's null prompt to a null guide", async () => {
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => Response.json({ ...body, prompt: null }),
  });
  const result = await client.agent.context();
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.data.guide : "unreached", null);
});

test("agent.context failures carry a stable code and no response body", async () => {
  const secret = "server-private-detail";
  const http = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => Response.json({ error: secret }, { status: 401 }),
  });
  const httpResult = await http.agent.context();
  assert.equal(httpResult.ok, false);
  if (httpResult.ok) return;
  assert.equal(httpResult.status, 401);
  assert.equal(httpResult.error.code, "HTTP_ERROR");
  assert.equal(JSON.stringify(httpResult).includes(secret), false);

  const invalid = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => Response.json({ ...body, server: { id: "server-1" } }),
  });
  const invalidResult = await invalid.agent.context();
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.ok ? null : invalidResult.error.code, "INVALID_RESPONSE");

  const transport = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => { throw new Error(secret); },
  });
  const transportResult = await transport.agent.context();
  assert.equal(transportResult.ok, false);
  if (transportResult.ok) return;
  assert.equal(transportResult.error.code, "TRANSPORT_ERROR");
  assert.equal(JSON.stringify(transportResult).includes(secret), false);
});

test("agent.context carries assistantOf (RFC 074/075): the owner when set, null when null or absent", async () => {
  const contextWith = async (agentExtra: Record<string, unknown>) => {
    const client = createRaftClient({
      serverUrl: "https://raft.example",
      credential,
      fetch: async () => Response.json({ ...body, agent: { ...body.agent, ...agentExtra } }),
    });
    const result = await client.agent.context();
    assert.equal(result.ok, true);
    return result.ok ? result.data.agent.assistantOf : "unreached";
  };
  const owner = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    await contextWith({ assistantOf: { userId: owner, name: "ada", displayName: "Ada", timezone: "Asia/Shanghai", language: "zh-CN", dmTarget: "dm:@ada~human" } }),
    { userId: owner, name: "ada", displayName: "Ada", raftCheck: false, timezone: "Asia/Shanghai", language: "zh-CN", dmTarget: "dm:@ada~human" },
  );
  assert.deepEqual(await contextWith({ assistantOf: { userId: owner } }), { userId: owner, name: null, displayName: null, raftCheck: false, timezone: null, language: null, dmTarget: null }, "older Servers omit the newer fields");
  assert.equal(await contextWith({ assistantOf: null }), null);
  assert.equal(await contextWith({}), null, "older Servers omit it");
});

test("agent.context carries the Server's app rollout features; older Servers read as both off and no apps", async () => {
  const featuresFrom = async (extra: Record<string, unknown>) => {
    const client = createRaftClient({
      serverUrl: "https://raft.example",
      credential,
      fetch: async () => Response.json({ ...body, ...extra }),
    });
    const result = await client.agent.context();
    assert.equal(result.ok, true);
    return result.ok ? result.data.features : "unreached";
  };
  assert.deepEqual(
    await featuresFrom({ features: { reminderApp: true, vaultApp: false, enabledApps: ["artifacts", "future-app"] } }),
    { reminderApp: true, vaultApp: false, enabledApps: ["artifacts", "future-app"] },
    "ids are passed through as the Server sends them, unknown ones included",
  );
  assert.deepEqual(
    await featuresFrom({ features: { reminderApp: true, vaultApp: false } }),
    { reminderApp: true, vaultApp: false, enabledApps: [] },
    "a Server with the booleans but without enabledApps",
  );
  assert.deepEqual(await featuresFrom({}), { reminderApp: false, vaultApp: false, enabledApps: [] });
});

 test("context projects reader availability and defaults older Servers to false", async () => {
   for (const allowed of [true, false]) {
     const client = createRaftClient({ serverUrl: "https://raft.example", credential,
       fetch: async () => Response.json({ ...body, agent: { ...body.agent, ...(allowed ? { raftbenchReader: true } : {}) } }) });
     const result = await client.agent.context();
     assert.equal(result.ok, true);
     if (result.ok) assert.equal(result.data.agent.raftbenchReader, allowed);
   }
 });
