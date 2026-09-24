import assert from "node:assert/strict";
import test from "node:test";
import { createRaftClient, RaftSdkConfigurationError } from "./index.js";

test("createRaftClient sends through the typed Agent API without CLI state", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const credential = "sk_agent_sdk_test";
  const client = createRaftClient({
    serverUrl: "https://raft.example/",
    credential,
    headers: {
      authorization: "Bearer must-not-win",
      "x-sdk-test": "rss",
    },
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({
        ok: true,
        state: "sent",
        messageId: "message-1",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.messages.send({
    target: "#rss",
    content: "New post",
    idempotencyKey: "feed:item-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.data.messageId : null, "message-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://raft.example/internal/agent-api/send");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    target: "#rss",
    content: "New post",
    idempotencyKey: "feed:item-1",
  });
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${credential}`);
  assert.equal(headers.get("x-sdk-test"), "rss");
});

test("createRaftClient resolves and joins a visible public channel by target", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential: "sk_agent_sdk_test",
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      if (init?.method === "GET") {
        return new Response(JSON.stringify({
          runtimeContext: { agentId: "agent-1", serverId: "server-1" },
          channels: [{ id: "channel-1", name: "engineering", joined: false }],
          agents: [],
          humans: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const result = await client.channels.join({ target: "#engineering" });

  assert.deepEqual(calls, [
    { url: "https://raft.example/internal/agent-api/server", method: "GET" },
    { url: "https://raft.example/internal/agent-api/channels/channel-1/join", method: "POST" },
  ]);
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    data: {
      state: "joined",
      target: "#engineering",
      channelId: "channel-1",
    },
  });
});

test("channel join is idempotent when server info already reports membership", async () => {
  let fetches = 0;
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential: "sk_agent_sdk_test",
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        runtimeContext: { agentId: "agent-1", serverId: "server-1" },
        channels: [{ id: "channel-1", name: "engineering", joined: true }],
        agents: [],
        humans: [],
      }), { status: 200 });
    },
  });

  const result = await client.channels.join({ target: "#engineering" });

  assert.equal(fetches, 1);
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.data.state : null, "already_joined");
});

test("channel join rejects invalid or invisible targets without a join request", async () => {
  let fetches = 0;
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential: "sk_agent_sdk_test",
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        runtimeContext: { agentId: "agent-1", serverId: "server-1" },
        channels: [],
        agents: [],
        humans: [],
      }), { status: 200 });
    },
  });

  const invalid = await client.channels.join({ target: "engineering" });
  assert.equal(invalid.ok, false);
  if (invalid.ok) assert.fail("expected invalid target failure");
  assert.equal(invalid.operation, "validate_target");
  assert.equal(invalid.error.reason, "invalid_target");
  assert.equal(fetches, 0);

  const invisible = await client.channels.join({ target: "#private-channel" });
  assert.equal(invisible.ok, false);
  if (invisible.ok) assert.fail("expected target resolution failure");
  assert.equal(invisible.operation, "resolve_target");
  assert.equal(invisible.error.reason, "target_not_found");
  assert.equal(fetches, 1);
});

test("channel join preserves typed Agent API failures", async () => {
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential: "sk_agent_sdk_test",
    fetch: async (input, init) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({
          runtimeContext: { agentId: "agent-1", serverId: "server-1" },
          channels: [{ id: "channel-1", name: "engineering", joined: false }],
          agents: [],
          humans: [],
        }), { status: 200 });
      }
      assert.match(String(input), /\/channels\/channel-1\/join$/);
      return new Response(JSON.stringify({
        error: "Private channels require an invitation",
        errorCode: "invitation_required",
      }), { status: 403, statusText: "Forbidden" });
    },
  });

  const result = await client.channels.join({ target: "#engineering" });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected channel join failure");
  assert.equal(result.operation, "channel_join");
  assert.equal(result.status, 403);
  assert.equal(result.error.kind, "http");
  if (result.error.kind !== "http") assert.fail("expected HTTP failure");
  assert.equal(result.error.errorCode, "invitation_required");
});

test("createRaftClient keeps send on v1 and exposes typed mentions only through sendV2", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential: "sk_agent_sdk_test",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({
        ok: true,
        state: "sent",
        messageId: "message-v2",
        unresolvedMentionHandles: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.messages.sendV2({
    target: "#rss",
    content: "hello @reader",
    mentions: [{
      type: "user",
      id: "11111111-1111-4111-8111-111111111111",
      name: "reader",
    }],
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://raft.example/internal/agent-api/v2/send");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    target: "#rss",
    content: "hello @reader",
    mentions: [{
      type: "user",
      id: "11111111-1111-4111-8111-111111111111",
      name: "reader",
    }],
  });
});

test("createRaftClient preserves typed server failures", async () => {
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential: "sk_agent_send_only",
    fetch: async () => new Response(JSON.stringify({
      error: "Permission denied",
      errorCode: "SCOPE_DENIED",
      suggestedNextAction: "Mint a credential with send scope.",
    }), {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/json" },
    }),
  });

  const result = await client.messages.send({ target: "#rss", content: "New post" });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected an HTTP failure");
  assert.equal(result.error.kind, "http");
  if (result.error.kind !== "http") assert.fail("expected an HTTP error");
  assert.equal(result.error.status, 403);
  assert.equal(result.error.errorCode, "SCOPE_DENIED");
  assert.equal(result.error.suggestedNextAction, "Mint a credential with send scope.");
});

test("createRaftClient preserves the typed freshness hold response", async () => {
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential: "sk_agent_send_only",
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      state: "held",
      subtype: "freshness",
      decision: "local_hold",
      producerFactId: "fact-1",
    }), { status: 200 }),
  });

  const result = await client.messages.send({ target: "#rss", content: "New post" });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.data.state : null, "held");
  assert.equal(result.ok && result.data.state === "held" ? result.data.producerFactId : null, "fact-1");
});

test("createRaftClient rejects contract mismatches without using fetch", async () => {
  let fetched = false;
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential: "sk_agent_send_only",
    fetch: async () => {
      fetched = true;
      return new Response("{}");
    },
  });

  const result = await client.messages.send({ target: 42 } as never);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected a validation failure");
  assert.equal(result.error.kind, "validation");
  assert.equal(result.error.reason, "request_contract_mismatch");
  assert.equal(fetched, false);
});

test("configuration errors fail before transport without exposing credential bytes", () => {
  const secret = "sk_agent_super_secret";
  const cases: Array<{
    options: Parameters<typeof createRaftClient>[0];
    code: string;
  }> = [
    { options: { serverUrl: "", credential: secret }, code: "MISSING_SERVER_URL" },
    { options: { serverUrl: "raft.example", credential: secret }, code: "INVALID_SERVER_URL" },
    { options: { serverUrl: "file:///tmp/raft", credential: secret }, code: "INVALID_SERVER_URL" },
    { options: { serverUrl: "https://user:pass@raft.example", credential: secret }, code: "INVALID_SERVER_URL" },
    { options: { serverUrl: "https://raft.example", credential: "  " }, code: "MISSING_AGENT_CREDENTIAL" },
    { options: { serverUrl: "https://raft.example", credential: "sk_machine_wrong_family" }, code: "INVALID_AGENT_CREDENTIAL" },
    { options: { serverUrl: "https://raft.example", credential: "user_session_wrong_family" }, code: "INVALID_AGENT_CREDENTIAL" },
    { options: { serverUrl: "https://raft.example", credential: "arbitrary-bearer" }, code: "INVALID_AGENT_CREDENTIAL" },
    { options: { serverUrl: "https://raft.example", credential: "sk_agent_" }, code: "INVALID_AGENT_CREDENTIAL" },
  ];

  for (const entry of cases) {
    assert.throws(
      () => createRaftClient(entry.options),
      (error: unknown) => {
        assert.ok(error instanceof RaftSdkConfigurationError);
        assert.equal(error.code, entry.code);
        assert.doesNotMatch(error.message, /sk_agent_|sk_machine_|user_session_|arbitrary-bearer|super_secret|user:pass/);
        return true;
      },
    );
  }
});
