import assert from "node:assert/strict";
import { createRaftAgent } from "./agent";

const muteAction = {
  tool: "mute_conversation",
  tier: "direct",
  description: "Mute or unmute a conversation as Ann. Runs right away and affects only Ann; it can be undone.",
  method: "PATCH",
  path: "/api/channels/:id/notification-settings",
  params: [
    { name: "target", kind: "conversation", description: "A channel (#design) or a DM (dm:@name)." },
    { name: "muted", kind: "boolean", description: "true to mute, false to unmute." },
  ],
  mapping: [
    { param: "target", into: "path", field: "id" },
    { param: "muted", into: "body", field: "activityMuted" },
  ],
};
const levelAction = {
  tool: "set_notification_level",
  tier: "direct",
  description: "Set a notification level as Ann.",
  method: "PUT",
  path: "/api/notification-levels",
  params: [
    { name: "target", kind: "channel_or_server", description: "A channel or server." },
    { name: "level", kind: "enum", values: ["default", "all", "mentions", "none"], description: "The level." },
  ],
  mapping: [
    { param: "target", into: "level_scope" },
    { param: "level", into: "body", field: "level" },
  ],
};
const context = {
  agent: {
    id: "agent-1", name: "ottie", displayName: "Ottie", description: null, runtime: "hosted", external: true,
    assistantOf: { userId: "user-1", name: "ann", displayName: "Ann", ownerActions: [muteAction, levelAction] },
  },
  server: { id: "server-1", slug: "s", name: "S" },
  credential: { capabilities: ["read", "send"] },
  prompt: null,
};

type Call = { url: string; method: string; headers: Headers; body: unknown };

function agentWith(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const raft = createRaftAgent({
    serverUrl: "https://raft.example",
    credential: "sk_agent_owner_actions_test",
    fetch: async (input, init) => {
      const call = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return respond(call);
    },
  });
  return { raft, calls };
}

function route(call: Call): Response {
  if (call.url.endsWith("/internal/agent-api/context")) return Response.json(context);
  if (call.url.includes("/internal/agent-api/assistant/owner-resolve")) {
    const name = new URL(call.url).searchParams.get("name");
    if (name === "#design") return Response.json({ id: "channel-1", type: "channel", name: "design" });
    if (name === "dm:@bob") return Response.json({ id: "dm-1", type: "dm", name: "bob" });
    return Response.json({ error: "not found", code: "owner_resolve_not_found" }, { status: 404 });
  }
  if (call.url === "https://raft.example/api/channels/channel-1/notification-settings") {
    return Response.json({ activityMuted: true, assistant: { done: "Muted #design for Ann.", undo: { tool: "mute_conversation", args: { target: "#design", muted: false }, text: "To undo: mute_conversation(target: \"#design\", muted: false)." } } });
  }
  if (call.url === "https://raft.example/api/channels/dm-1/notification-settings") {
    return Response.json({ activityMuted: true, assistant: { done: "Muted dm:@bob for Ann.", undo: { tool: "mute_conversation", args: { target: "dm:@bob", muted: false }, text: "To undo: mute_conversation(target: \"dm:@bob\", muted: false)." } } });
  }
  if (call.url === "https://raft.example/api/notification-levels") {
    return Response.json({ level: "none", assistant: { done: "Set this server to none for Ann.", undo: null } });
  }
  return Response.json({ error: "unexpected" }, { status: 500 });
}

test("ownerActions.list returns the context's owner actions", async () => {
  const { raft } = agentWith(route);
  const listed = await raft.assistant.ownerActions.list();
  assert.deepEqual(listed.actions.map((action) => action.tool), ["mute_conversation", "set_notification_level"]);
  assert.deepEqual(listed.skipped, []);
});

test("an entry with a tier this SDK doesn't know: the context still parses, list() leaves out only that one and reports it, run() refuses it", async () => {
  const futureAction = { ...levelAction, tool: "move_agent", tier: "approve_twice", description: "Move an agent." };
  const withFuture = { ...context, agent: { ...context.agent, assistantOf: { ...context.agent.assistantOf, ownerActions: [muteAction, futureAction, levelAction] } } };
  const { raft, calls } = agentWith((call) => call.url.endsWith("/internal/agent-api/context") ? Response.json(withFuture) : route(call));
  const contextRead = await raft.identity.whoami();
  assert.equal(contextRead.ok, true, "the whole context read does not fail on an unknown tier");
  const listed = await raft.assistant.ownerActions.list();
  assert.deepEqual(listed.actions.map((action) => action.tool), ["mute_conversation", "set_notification_level"], "exactly the known tools");
  assert.deepEqual(listed.skipped, [{ tool: "move_agent", tier: "approve_twice" }]);
  const refused = await raft.assistant.ownerActions.run("move_agent", { target: "#design", level: "all" });
  assert.ok(!refused.ok);
  assert.equal(refused.code, "UNKNOWN_TOOL");
  assert.equal(refused.text, "move_agent isn't available here yet. Tell Ann they can do it themselves in Raft.");
  assert.equal(calls.some((call) => call.url.includes("/api/")), false);
});

test("ownerActions.run resolves dm:@peer to the owner's existing DM", async () => {
  const { raft, calls } = agentWith(route);
  const result = await raft.assistant.ownerActions.run("mute_conversation", { target: "dm:@bob", muted: true });
  assert.ok(result.ok);
  assert.equal(result.text, "Muted dm:@bob for Ann. To undo: mute_conversation(target: \"dm:@bob\", muted: false).");
  assert.ok(calls.some((call) => call.url === "https://raft.example/api/channels/dm-1/notification-settings"));
  const none = await raft.assistant.ownerActions.run("mute_conversation", { target: "dm:@carol", muted: true });
  assert.ok(!none.ok && none.code === "NOT_FOUND");
  assert.equal(none.ok ? "" : none.text, "No DM with @carol that Ann can see.");
  const thread = await raft.assistant.ownerActions.run("mute_conversation", { target: "#design:1a2b3c4d", muted: true });
  assert.ok(!thread.ok && thread.code === "INVALID_ARGS");
  assert.equal(thread.ok ? "" : thread.text, "Only channels (#name) and DMs (dm:@name) for now; Ann can do this for a thread themselves.");
  const levelDm = await raft.assistant.ownerActions.run("set_notification_level", { target: "dm:@bob", level: "all" });
  assert.ok(!levelDm.ok && levelDm.code === "INVALID_ARGS");
});

test("ownerActions.run resolves #channel as the owner, calls the owner's route with the agent credential, returns Raft's text", async () => {
  const { raft, calls } = agentWith(route);
  const result = await raft.assistant.ownerActions.run("mute_conversation", { target: "#design", muted: true });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.text, "Muted #design for Ann. To undo: mute_conversation(target: \"#design\", muted: false).");
  assert.deepEqual(result.data, { activityMuted: true });
  const call = calls.find((entry) => entry.url.includes("/api/channels/"))!;
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { activityMuted: true });
  assert.equal(call.headers.get("authorization"), "Bearer sk_agent_owner_actions_test");
  assert.equal(call.headers.get("x-server-id"), "server-1");
});

test("ownerActions.run maps \"server\" to the server scope", async () => {
  const { raft, calls } = agentWith(route);
  const result = await raft.assistant.ownerActions.run("set_notification_level", { target: "server", level: "none" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.at(-1)!.body, { scope: "server", id: "server-1", level: "none" });
});

test("ownerActions.run refuses before any route call: unknown tool, bad args, a channel the owner can't see", async () => {
  const { raft, calls } = agentWith(route);
  const unknown = await raft.assistant.ownerActions.run("delete_server", {});
  assert.equal(unknown.ok, false);
  assert.ok(!unknown.ok && unknown.code === "UNKNOWN_TOOL");
  const bad = await raft.assistant.ownerActions.run("mute_conversation", { target: "#design", muted: "yes" });
  assert.ok(!bad.ok && bad.code === "INVALID_ARGS");
  const hidden = await raft.assistant.ownerActions.run("mute_conversation", { target: "#secret", muted: true });
  assert.ok(!hidden.ok && hidden.code === "NOT_FOUND");
  assert.equal(hidden.ok ? "" : hidden.text, "No channel named #secret that Ann can see.");
  assert.equal(calls.some((call) => call.url.includes("/api/")), false);
});

test("ownerActions.run passes Raft's refusal through", async () => {
  const { raft } = agentWith((call) => call.url.includes("/api/channels/")
    ? Response.json({ error: "Not allowed.", code: "assistant_owner_action_not_allowed", suggestedNextAction: "Don't retry." }, { status: 403 })
    : route(call));
  const result = await raft.assistant.ownerActions.run("mute_conversation", { target: "#design", muted: true });
  assert.ok(!result.ok);
  assert.equal(result.code, "HTTP_ERROR");
  assert.equal(result.errorCode, "assistant_owner_action_not_allowed");
  assert.equal(result.text, "Not allowed. Don't retry.");
});

const moveAction = {
  tool: "move_conversation",
  tier: "direct",
  description: "Move a conversation in the sidebar as Ann.",
  method: "PATCH",
  path: "/api/servers/:id/sidebar-order",
  params: [
    { name: "target", kind: "conversation", description: "A channel or a DM with a person." },
    { name: "position", kind: "position", description: "top, bottom or { after }." },
  ],
  mapping: [
    { param: "target", into: "body_ref", field: "targetId" },
    { param: "position", into: "body_position", field: "position" },
  ],
  requiredFields: ["targetId", "position"],
};

test("ownerActions.run sends a transform entry's tool body: refs resolved to ids, the route path's :id is this server, Raft computes the rest", async () => {
  const withMove = { ...context, agent: { ...context.agent, assistantOf: { ...context.agent.assistantOf, ownerActions: [muteAction, levelAction, moveAction] } } };
  const sidebarUrl = "https://raft.example/api/servers/server-1/sidebar-order";
  const { raft, calls } = agentWith((call) => {
    if (call.url.endsWith("/internal/agent-api/context")) return Response.json(withMove);
    if (call.url === sidebarUrl) {
      return Response.json({ channelOrder: [], assistant: { done: "Moved #design right after dm:@bob in Ann's sidebar.", undo: { tool: "move_conversation", args: { target: "#design", position: "top" }, text: "To undo: move_conversation(target: \"#design\", position: \"top\"), where it was before." } } });
    }
    return route(call);
  });
  const after = await raft.assistant.ownerActions.run("move_conversation", { target: "#design", position: { after: "dm:@bob" } });
  assert.ok(after.ok);
  assert.equal(after.text, "Moved #design right after dm:@bob in Ann's sidebar. To undo: move_conversation(target: \"#design\", position: \"top\"), where it was before.");
  const sent = calls.filter((call) => call.url === sidebarUrl);
  assert.deepEqual(sent.map((call) => call.body), [{ targetId: "channel-1", position: { after: "dm-1" } }]);
  assert.equal(sent[0]!.method, "PATCH");
  assert.equal(calls.some((call) => call.method === "GET" && call.url === sidebarUrl), false, "no read-then-write of the order");

  const top = await raft.assistant.ownerActions.run("move_conversation", { target: "#design", position: "top" });
  assert.ok(top.ok);
  assert.deepEqual(calls.at(-1)!.body, { targetId: "channel-1", position: "top" });

  const bad = await raft.assistant.ownerActions.run("move_conversation", { target: "#design", position: "middle" });
  assert.ok(!bad.ok && bad.code === "INVALID_ARGS");
  assert.equal(bad.ok ? "" : bad.text, "position must be \"top\", \"bottom\" or { after: \"#name\" }.");
  const unseen = await raft.assistant.ownerActions.run("move_conversation", { target: "#design", position: { after: "#secret" } });
  assert.ok(!unseen.ok && unseen.code === "NOT_FOUND");
  assert.equal(calls.filter((call) => call.url === sidebarUrl).length, 2, "refused before any route call");
});

const arrangeAction = {
  tool: "arrange_conversations",
  tier: "direct",
  description: "Arrange a whole list of Ann's sidebar.",
  method: "PATCH",
  path: "/api/servers/:id/sidebar-order",
  params: [
    { name: "list", kind: "enum", values: ["pinned", "channels", "external", "dms"], description: "Which list." },
    { name: "order", kind: "conversation_list", description: "The conversations in order." },
  ],
  mapping: [
    { param: "list", into: "body", field: "list" },
    { param: "order", into: "body_ref_list", field: "orderIds" },
  ],
  requiredFields: ["list", "orderIds"],
};

test("ownerActions.run sends a conversation_list as ids in order (#proj-assistant:#28), and refuses a bad or unseen one before any route call", async () => {
  const withArrange = { ...context, agent: { ...context.agent, assistantOf: { ...context.agent.assistantOf, ownerActions: [muteAction, arrangeAction] } } };
  const sidebarUrl = "https://raft.example/api/servers/server-1/sidebar-order";
  const { raft, calls } = agentWith((call) => {
    if (call.url.endsWith("/internal/agent-api/context")) return Response.json(withArrange);
    if (call.url === sidebarUrl) return Response.json({ pinned: [], assistant: { done: "Pinned in Ann's sidebar, in this order: dm:@bob, #design.", undo: null } });
    return route(call);
  });
  const ok = await raft.assistant.ownerActions.run("arrange_conversations", { list: "pinned", order: ["dm:@bob", "#design"] });
  assert.ok(ok.ok);
  assert.deepEqual(calls.filter((call) => call.url === sidebarUrl).map((call) => call.body), [{ list: "pinned", orderIds: ["dm-1", "channel-1"] }]);

  const notList = await raft.assistant.ownerActions.run("arrange_conversations", { list: "pinned", order: "#design" });
  assert.ok(!notList.ok && notList.code === "INVALID_ARGS");
  const unseen = await raft.assistant.ownerActions.run("arrange_conversations", { list: "channels", order: ["#design", "#secret"] });
  assert.ok(!unseen.ok && unseen.code === "NOT_FOUND");
  assert.equal(calls.filter((call) => call.url === sidebarUrl).length, 1, "refused before any route call");
});

test("a confirm action: @agent resolved as the owner, the computer sent as is, and Raft's 202 text (nothing ran yet) passed through verbatim", async () => {
  const moveAgent = {
    tool: "move_agent",
    tier: "confirm",
    description: "Move one of your owner's agents to another computer as Ann. Doesn't run until Ann confirms it on a card Raft posts in your DM.",
    method: "POST",
    path: "/api/agents/:id/migrate",
    params: [
      { name: "agent", kind: "agent", description: "The agent to move, as @name." },
      { name: "computer", kind: "text", description: "The computer's name." },
    ],
    mapping: [
      { param: "agent", into: "path", field: "id" },
      { param: "computer", into: "body", field: "targetComputer" },
    ],
    requiredFields: ["targetComputer"],
  };
  const withMove = { ...context, agent: { ...context.agent, assistantOf: { ...context.agent.assistantOf, ownerActions: [muteAction, moveAgent] } } };
  const pending = "Not done yet. Raft posted a card in your DM asking Ann to confirm: \"Ottie wants to move @sage to box-b as you\". Nothing changes unless they press Confirm; the card expires at 2026-11-05T15:00:00.000Z. Don't call this again: you'll get an event when they confirm or decline, or when it expires. If Ann asked for this, tell them the card is waiting.";
  const { raft, calls } = agentWith((call) => {
    if (call.url.endsWith("/internal/agent-api/context")) return Response.json(withMove);
    if (call.url.includes("/internal/agent-api/assistant/owner-resolve")) {
      const name = new URL(call.url).searchParams.get("name");
      return name === "@sage~agent" ? Response.json({ id: "agent-9", type: "agent", name: "sage" }) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (call.url === "https://raft.example/api/agents/agent-9/migrate") {
      return Response.json({ assistant: { state: "pending_owner_confirm", text: pending, cardMessageId: "msg-1", expiresAt: "2026-11-05T15:00:00.000Z" } }, { status: 202 });
    }
    return route(call);
  });
  const listed = await raft.assistant.ownerActions.list();
  assert.deepEqual(listed.actions.map((action) => action.tool), ["mute_conversation", "move_agent"]);
  const result = await raft.assistant.ownerActions.run("move_agent", { agent: "@sage", computer: "box-b" });
  assert.ok(result.ok);
  assert.equal(result.status, 202);
  assert.equal(result.text, pending);
  assert.equal(result.assistant?.state, "pending_owner_confirm");
  const routeCall = calls.find((call) => call.url === "https://raft.example/api/agents/agent-9/migrate");
  assert.deepEqual(routeCall?.body, { targetComputer: "box-b" });

  const unknown = await raft.assistant.ownerActions.run("move_agent", { agent: "@nobody", computer: "box-b" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.text, "No agent named @nobody that Ann can see.");
  const notAnAgent = await raft.assistant.ownerActions.run("move_agent", { agent: "sage", computer: "box-b" });
  assert.equal(notAnAgent.ok, false);
  assert.equal(notAnAgent.text, "\"sage\" is not an agent. Give an agent as @name.");
});

test("ownerActions.run on a read: a GET with the optional filter as its only query, left out when not given; the text is Raft's", async () => {
  const readAction = {
    tool: "list_owner_channels",
    tier: "read",
    description: "The channels your owner is in on this server.",
    method: "GET",
    path: "/api/channels",
    params: [{ name: "filter", kind: "text", description: "Optional: part of a name.", optional: true }],
    mapping: [{ param: "filter", into: "query", field: "filter" }],
  };
  const withRead = { ...context, agent: { ...context.agent, assistantOf: { ...context.agent.assistantOf, ownerActions: [readAction] } } };
  const text = "[Raft: what follows is your owner's data from Raft.]\nYour owner's channels on this server (1):\n#design · public · default\n[Raft: end of your owner's data.]";
  const { raft, calls } = agentWith((call) => {
    if (call.url.endsWith("/internal/agent-api/context")) return Response.json(withRead);
    if (call.url.startsWith("https://raft.example/api/channels")) return Response.json({ assistant: { text } });
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  const listed = await raft.assistant.ownerActions.list();
  assert.deepEqual(listed.actions.map((action) => action.tool), ["list_owner_channels"]);
  assert.deepEqual(listed.skipped, []);

  const all = await raft.assistant.ownerActions.run("list_owner_channels", {});
  assert.ok(all.ok, all.ok ? "" : all.text);
  assert.equal(all.text, text);
  const narrowed = await raft.assistant.ownerActions.run("list_owner_channels", { filter: "des ign" });
  assert.ok(narrowed.ok);
  const reads = calls.filter((call) => call.url.startsWith("https://raft.example/api/channels"));
  assert.deepEqual(reads.map((call) => [call.method, call.url, call.body]), [
    ["GET", "https://raft.example/api/channels", undefined],
    ["GET", "https://raft.example/api/channels?filter=des+ign", undefined],
  ]);
});
