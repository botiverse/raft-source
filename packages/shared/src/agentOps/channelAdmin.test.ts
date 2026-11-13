import assert from "node:assert/strict";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import {
  ADMIN_PERMISSION_NEXT_ACTION,
  addChannelMember,
  archiveChannel,
  createChannel,
  removeChannelMember,
  unarchiveChannel,
  updateChannel,
  updateServer,
} from "./index";

type Call = { method: string; path: string; body: unknown };

function client(script: (path: string, init: RequestInit) => Response, calls: Call[] = []): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return script(path, init ?? {});
      },
    },
  });
}

const DESIGN_ID = "33333333-3333-4333-8333-333333333333";
const serverInfoBody = {
  runtimeContext: { agentId: "agent-1", serverId: "server-1" },
  serverRole: "admin",
  channels: [{ id: DESIGN_ID, name: "design", joined: true, type: "private" }],
  agents: [{ name: "Kirby", status: "online" }],
  humans: [{ name: "tygg", role: "owner" }],
};

// The Server's structured refusal (server_role_required): the SDK forwards the
// code and the plain-sentence next action, never the raw body.
const ROLE_REFUSAL = {
  error: "Agent requires editServerSettings capability to update the server",
  code: "server_role_required",
  requiredRole: "admin",
  currentRole: "member",
  suggestedNextAction: "Changing server settings needs the admin role on this server; your role is member. Ask a server owner or admin to do it, or to change your role.",
};

test("channel create: strips '#', sends visibility, and points at the new channel", async () => {
  const calls: Call[] = [];
  const api = client(() => Response.json({ id: DESIGN_ID, name: "design", type: "private", description: null, createdByAgentId: "agent-1" }), calls);
  const created = await createChannel(api, { name: "#design", visibility: "private" }, { hints: "tool" });
  assert.ok(created.ok);
  assert.equal(created.state, "created");
  assert.deepEqual(created.data, { target: "#design", channelId: DESIGN_ID, visibility: "private" });
  assert.equal(created.text, "Created #design (private). You are joined and can send messages there.");
  assert.deepEqual(calls, [{ method: "POST", path: "/internal/agent-api/channels", body: { name: "design", visibility: "private" } }]);
  assert.equal(created.next?.operation?.name, "messages.read");
});

test("a role refusal reaches the caller as serverCode and the Server's next action", async () => {
  const api = client(() => Response.json(ROLE_REFUSAL, { status: 403 }));
  const refused = await updateServer(api, { name: "Raft HQ" });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error.status, 403);
  assert.equal(refused.error.serverCode, "server_role_required");
  assert.equal(refused.error.nextAction, ROLE_REFUSAL.suggestedNextAction);
  assert.doesNotMatch(JSON.stringify(refused), /requiredRole|currentRole/);
});

test("channel update resolves the target, sends only what changes, and refuses an empty change locally", async () => {
  const calls: Call[] = [];
  const api = client((path) => path.startsWith("/internal/agent-api/server")
    ? Response.json(serverInfoBody)
    : Response.json({ id: DESIGN_ID, name: "design-reviews", type: "private" }), calls);
  const updated = await updateChannel(api, { target: "#design", name: "design-reviews" });
  assert.ok(updated.ok);
  assert.equal(updated.text, "Updated #design-reviews (private).");
  assert.deepEqual(calls.at(-1), { method: "PATCH", path: `/internal/agent-api/channels/${DESIGN_ID}`, body: { name: "design-reviews" } });

  const before = calls.length;
  const empty = await updateChannel(api, { target: "#design" });
  assert.equal(empty.ok ? null : empty.error.code, "INVALID_REQUEST");
  assert.equal(calls.length, before, "nothing sent");

  const missing = await updateChannel(api, { target: "#nope", description: "x" });
  assert.equal(missing.ok ? null : missing.error.code, "NOT_FOUND");
});

test("archive and unarchive pass the target to the Server, which resolves it", async () => {
  const calls: Call[] = [];
  const api = client((path) => Response.json({
    id: DESIGN_ID, name: "design", type: "private",
    archivedAt: path.endsWith("/archive") ? "2026-10-11T09:00:00.000Z" : null,
    archivedByUserId: null, archivedByAgentId: path.endsWith("/archive") ? "agent-1" : null,
  }), calls);
  const archived = await archiveChannel(api, { target: "#design" });
  assert.ok(archived.ok);
  assert.equal(archived.text, "Archived #design. The channel is read-only until unarchived.");
  const unarchived = await unarchiveChannel(api, { target: "#design" });
  assert.ok(unarchived.ok);
  assert.equal(unarchived.state, "unarchived");
  assert.deepEqual(calls.map((call) => [call.path, call.body]), [
    ["/internal/agent-api/channels/archive", { target: "#design" }],
    ["/internal/agent-api/channels/unarchive", { target: "#design" }],
  ]);
  const dm = await archiveChannel(api, { target: "dm:@tygg" });
  assert.equal(dm.ok ? null : dm.error.code, "INVALID_REQUEST");
});

test("members: exactly one of user and agent, handles sent without '@', CLI text", async () => {
  const calls: Call[] = [];
  const api = client((path, init) => {
    if (path.startsWith("/internal/agent-api/server")) return Response.json(serverInfoBody);
    const member = { type: "agent", id: "agent-2", name: "Kirby" };
    return init.method === "DELETE"
      ? Response.json({ ok: true, wasMember: true, channelId: DESIGN_ID, member, attention: { ordinaryActivity: "Ordinary channel activity no longer reaches @Kirby." } })
      : Response.json({ ok: true, alreadyMember: false, channelId: DESIGN_ID, member });
  }, calls);

  const both = await addChannelMember(api, { target: "#design", user: "@tygg", agent: "@Kirby" });
  assert.equal(both.ok ? null : both.error.code, "INVALID_REQUEST");
  assert.equal(calls.length, 0, "nothing sent");

  const added = await addChannelMember(api, { target: "#design", agent: "@Kirby" });
  assert.ok(added.ok);
  assert.equal(added.text, "Added @Kirby to #design as an agent.");
  assert.deepEqual(calls.at(-1), { method: "POST", path: `/internal/agent-api/channels/${DESIGN_ID}/members`, body: { agent: "Kirby" } });

  const removed = await removeChannelMember(api, { target: "#design", agent: "Kirby" });
  assert.ok(removed.ok);
  assert.equal(removed.text, "Removed @Kirby from #design.\nOrdinary channel activity no longer reaches @Kirby.");
  assert.deepEqual(calls.at(-1), { method: "DELETE", path: `/internal/agent-api/channels/${DESIGN_ID}/members`, body: { agent: "Kirby" } });
});

test("remove-member: a private channel's last member is refused with the deleting call as the next step; deleteIfLast sends it and says the channel went", async () => {
  const calls: Call[] = [];
  const api = client((path) => {
    if (path.startsWith("/internal/agent-api/server")) return Response.json(serverInfoBody);
    if ((calls.at(-1)?.body as { deleteIfLast?: boolean }).deleteIfLast !== true) {
      return Response.json({ error: "…", code: "last_member_deletes_channel", suggestedNextAction: "(the Server's CLI form)" }, { status: 409 });
    }
    return Response.json({ ok: true, wasMember: true, channelId: DESIGN_ID, member: { type: "human", id: "user-1", name: "tygg" }, channelDeleted: true });
  }, calls);

  const refused = await removeChannelMember(api, { target: "#design", user: "@tygg" }, { hints: "tool" });
  assert.ok(!refused.ok);
  assert.equal(refused.error.message, "@tygg is the last member of #design, a private channel: removing them would delete the channel and all its messages, and that can't be undone. Nothing changed.");
  assert.equal(refused.error.nextAction, `Only if the channel and all its messages should go: channels_remove_member({ target: "#design", user: "@tygg", deleteIfLast: true }). Otherwise leave them in it.`);
  assert.deepEqual(calls.at(-1)?.body, { user: "tygg" });

  const removed = await removeChannelMember(api, { target: "#design", user: "@tygg", deleteIfLast: true });
  assert.ok(removed.ok);
  assert.deepEqual(calls.at(-1)?.body, { user: "tygg", deleteIfLast: true });
  assert.equal(removed.text, "@tygg was the last member of #design, a private channel, so it and all its messages were deleted. That can't be undone.");
});

test("server update sends the trimmed name and refuses an empty change locally", async () => {
  const calls: Call[] = [];
  const api = client(() => Response.json({ id: "server-1", name: "Raft HQ", hideHumansFromMembers: false, avatarUrl: null }), calls);
  const updated = await updateServer(api, { name: " Raft HQ " });
  assert.ok(updated.ok);
  assert.equal(updated.text, "Updated server Raft HQ.");
  assert.deepEqual(calls, [{ method: "PATCH", path: "/internal/agent-api/server", body: { name: "Raft HQ" } }]);
  const empty = await updateServer(api, {});
  assert.equal(empty.ok ? null : empty.error.code, "INVALID_REQUEST");
  assert.equal(calls.length, 1);
});

test("a 403 with no next action from the Server still says it is a permission problem", async () => {
  const api = client(() => Response.json({ error: "Agent requires createChannels capability to create channels" }, { status: 403 }));
  const refused = await createChannel(api, { name: "design" });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error.nextAction, ADMIN_PERMISSION_NEXT_ACTION);
  assert.match(refused.text, /Your role does not allow this here/);

  // Other statuses keep the generic default.
  const conflict = await createChannel(client(() => Response.json({ error: "Channel name taken" }, { status: 409 })), { name: "design" });
  assert.notEqual(conflict.ok ? null : conflict.error.nextAction, ADMIN_PERMISSION_NEXT_ACTION);
});

test("known non-role 403 codes get their own next action, not the role sentence", async () => {
  const serverInfo = { runtimeContext: { agentId: "agent-1", serverId: "server-1" }, channels: [{ id: DESIGN_ID, name: "design", joined: false, type: "channel" }, { id: "44444444-4444-4444-8444-444444444444", name: "all", joined: true, type: "channel" }], agents: [], humans: [] };
  const refusal = (code: string) => client((path) => path.startsWith("/internal/agent-api/server")
    ? Response.json(serverInfo)
    : Response.json({ error: "refused", code }, { status: 403 }));

  const outside = await updateChannel(refusal("channel_membership_required"), { target: "#design", visibility: "private" }, { hints: "tool" });
  assert.equal(outside.ok ? null : outside.error.nextAction, "Join the channel first (`channels_join`), then retry.");

  const all = await updateChannel(refusal("all_channel_visibility_managed_separately"), { target: "#all", visibility: "private" });
  assert.equal(all.ok ? null : all.error.nextAction, "Only a human can change #all's visibility, from channel settings or server settings.");

  // An unknown code is left as the Server sent it.
  const other = await updateChannel(refusal("something_else"), { target: "#design", name: "x" });
  assert.notEqual(other.ok ? null : other.error.nextAction, ADMIN_PERMISSION_NEXT_ACTION);
});
