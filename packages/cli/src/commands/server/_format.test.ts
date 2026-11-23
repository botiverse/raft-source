// Snapshot-style tests for agent-facing server info output format.
// Pins the exact text shape matching MCP list_server output.

import assert from "node:assert/strict";

import { formatChannelMembers, formatServerInfo } from "./_format";

test("formatServerInfo: full server with channels, agents, humans", () => {
  const out = formatServerInfo({
    runtimeContext: {
      agentId: "agent-1",
      runtime: "codex",
      model: "gpt-5-codex",
      reasoningEffort: "high",
      serverId: "server-1",
      machineId: "machine-1",
      machineName: "Dev Mac",
      machineDescription: "Runs browser QA and local web previews.",
      machineHostname: "dev-mac.local",
      machineOs: "darwin arm64",
      daemonVersion: "0.41.1",
      workspacePath: "/Users/alice/.slock/agents/agent-1",
    },
    serverRole: "admin",
    serverCapabilities: {
      editServerSettings: true,
      editChannelMetadata: true,
      inviteMembers: true,
      editAgents: true,
      joinPublicChannels: true,
    },
    channels: [
      { name: "general", type: "channel", joined: true, activityMuted: true, description: "General discussion" },
      { name: "engineering", type: "private", joined: true, muted: false },
      { name: "random", type: "channel", joined: false, description: "Off-topic" },
      { name: "partners", type: "joint", joined: true, description: "Shared with another server" },
      { name: "system.reminder", type: "dm", joined: true, description: "Reminder app" },
    ],
    agents: [
      { name: "akko", status: "online", role: "admin", description: "runtime IC" },
      { name: "kuku", status: "idle" },
      { name: "meichen", status: "active", activity: "error", activityDetail: "Runtime crashed" },
    ],
    humans: [
      { name: "xxchan", role: "owner", description: "tech lead" },
      { name: "alice" },
    ],
  });
  assert.match(out, /## Server/);
  assert.match(out, /### Current Runtime/);
  assert.match(out, /Authoritative context for this agent process/);
  assert.match(out, /- Agent ID: agent-1/);
  assert.match(out, /- Runtime: codex/);
  assert.match(out, /- Model: gpt-5-codex/);
  assert.match(out, /- Reasoning: high/);
  assert.match(out, /- Server ID: server-1/);
  assert.match(out, /- Computer: Dev Mac \(machine-1\)/);
  assert.match(out, /- Computer Description: Runs browser QA and local web previews\./);
  assert.match(out, /- Hostname: dev-mac.local/);
  assert.match(out, /- OS: darwin arm64/);
  assert.match(out, /- Daemon: v0.41.1/);
  assert.match(out, /- Workspace: \/Users\/alice\/\.slock\/agents\/agent-1/);
  assert.match(out, /### Current Agent/);
  assert.match(out, /- Role: admin/);
  assert.doesNotMatch(out, /Capabilities:/);
  assert.match(out, /### Channels/);
  assert.match(out, /Private channels are shown only when you are a member/);
  assert.match(out, /Use channel attention commands/);
  assert.match(out, /`raft channel join`, `leave`, `mute`, `unmute`/);
  assert.match(out, /`raft channel create`, `update`, `archive`, `unarchive`, `add-member`, `remove-member`/);
  assert.match(out, /raft server update/);
  assert.match(out, /Run any subcommand with `--help` for syntax/);
  assert.match(out, /Mute state is shown when the server provides it; otherwise it is omitted\./);
  assert.match(out, /raft thread unfollow/);
  assert.match(out, /#general \[public, joined, muted\] — General discussion/);
  assert.match(out, /#engineering \[private, joined, not muted\]/);
  assert.match(out, /#random \[public, not joined\] — Off-topic/);
  assert.match(out, /#partners \[joint, joined\] — Shared with another server/);
  assert.match(out, /dm:@system\.reminder \[private, joined\] — Reminder app/);
  assert.match(out, /### Agents/);
  assert.match(out, /@akko \(online\) \(admin\) — runtime IC/);
  assert.match(out, /@kuku \(idle\)/);
  assert.match(out, /@meichen \(active; error: Runtime crashed\)/);
  assert.match(out, /### Humans/);
  assert.match(out, /raft message send --target "dm:@name" <<'RAFTMSG'/);
  assert.doesNotMatch(out, /<<'EOF'/);
  assert.match(out, /@xxchan \(owner\) — tech lead/);
  assert.match(out, /@alice\n/);
});


test("formatChannelMembers: full channel member list", () => {
  const out = formatChannelMembers({
    channel: { ref: "#proj-runtime", type: "channel" },
    agents: [
      { name: "akko", status: "active", role: "admin", serverRole: "member", channelRole: "admin", channelAdminBasis: "channel_role", description: "runtime IC" },
      { name: "kuku", status: "idle" },
    ],
    humans: [
      { name: "xxchan", role: "owner", serverRole: "owner", channelRole: "member", channelAdminBasis: "server_role", description: "tech lead" },
      { name: "alice" },
    ],
  });
  assert.match(out, /## Channel Members/);
  assert.match(out, /Channel: #proj-runtime \(channel\)/);
  assert.match(out, /Members means join\/post authority/);
  assert.match(out, /### Agents/);
  assert.match(out, /Server and stored channel roles are shown separately/);
  assert.match(out, /@akko \(active\) \(admin\) \[server role=member, channel role=admin, admin via=channel_role\] — runtime IC/);
  assert.match(out, /@kuku \(idle\)/);
  assert.match(out, /### Humans/);
  assert.match(out, /Server and stored channel roles are shown separately/);
  // A plain member is the default: only a channel admin is marked.
  assert.match(out, /@xxchan \(owner\) \[server role=owner, admin via=server_role\] — tech lead/);
  assert.match(out, /@alice/);
});

test("formatChannelMembers: joint roster lists every server a person takes part through", () => {
  const out = formatChannelMembers({
    channel: { ref: "#shared-room", type: "joint" },
    agents: [],
    humans: [
      { name: "dual", role: "member", servers: [{ name: "Home", slug: "home", yours: true }, { name: "Peer Co", slug: "peer" }] },
      { name: "peer-only", role: "owner", servers: [{ name: "Peer Co", slug: "peer" }] },
      { name: "twins", servers: [{ name: "Acme", slug: "acme-1" }, { name: "Acme", slug: "acme-2" }] },
      { name: "local" },
    ],
  });
  assert.match(out, /`\[servers: \.\.\.\]` marks people in this joint channel/);
  assert.match(out, /gives them no rights here/);
  assert.match(out, /@dual \[servers: this server, Peer Co\]\n/);
  assert.match(out, /@peer-only \(owner\) \[servers: Peer Co\]\n/);
  // Two listed servers with the same display name fall back to their slugs.
  assert.match(out, /@twins \[servers: acme-1, acme-2\]\n/);
  assert.match(out, /@local\n/);

  const plain = formatChannelMembers({ channel: { ref: "#all", type: "channel" }, agents: [], humans: [{ name: "local" }] });
  assert.doesNotMatch(plain, /servers/);
});

test("formatChannelMembers: the channel role the Server sends marks channel admins, agents and people alike", () => {
  const out = formatChannelMembers({
    channel: { ref: "#design", type: "channel" },
    agents: [
      { name: "kirby", status: "active", role: "member", channelRole: "admin" },
      { name: "scout", status: "idle", role: "member", channelRole: "member" },
    ],
    humans: [
      { name: "tygg", role: "member", channelRole: "admin" },
      { name: "boss", role: "owner", channelRole: "member" },
      { name: "alice", role: "member", channelRole: "member" },
    ],
  });
  assert.match(out, /  - @kirby \(active\) \[channel role=admin\]\n/);
  assert.match(out, /  - @scout \(idle\)\n/);
  assert.match(out, /  - @tygg \[channel role=admin\]\n/);
  assert.match(out, /  - @boss \(owner\)\n/);
  assert.match(out, /  - @alice\n/);

  // No channel roles (#all, a DM, a thread): the Server sends none, and nothing is added.
  const all = formatChannelMembers({ channel: { ref: "#all", type: "channel" }, agents: [{ name: "kirby", status: "active" }], humans: [{ name: "tygg", role: "member" }] });
  assert.doesNotMatch(all, /channel role=/);
  assert.match(all, /  - @kirby \(active\)\n/);
  assert.match(all, /  - @tygg\n/);
});

test("formatChannelMembers: empty members", () => {
  const out = formatChannelMembers({ channel: { ref: "#all", type: "channel" }, agents: [], humans: [] });
  assert.match(out, /\(none\)/);
});

test("formatServerInfo: empty server", () => {
  const out = formatServerInfo({ channels: [], agents: [], humans: [] });
  assert.match(out, /\(none\)/);
});
