import { sampleAgentInfo, sampleChannel, sampleHumanInfo } from "../_axExampleFixtures.js";
import { axSurface } from "../../core/renderer.js";

// Canonical server info formatting for agent-facing output.
// This is the canonical implementation of the agent-facing server info text
// format (the MCP chat-bridge's list_server output it originally mirrored has
// been removed) — an AX contract, not an implementation detail. Pinned by
// `_format.test.ts`.

interface ChannelInfo {
  id?: string | null;
  name: string;
  joined: boolean;
  type?: string | null;
  description?: string | null;
  muted?: boolean | null;
  activityMuted?: boolean | null;
  archived?: boolean | null;
  channelRole?: "member" | "admin" | null;
  channelAdminBasis?: "server_role" | "channel_role" | "both" | null;
  channelCapabilities?: Record<string, boolean> | null;
}

interface MemberAgentInfo {
  name: string;
  status: string;
  activity?: string | null;
  activityDetail?: string | null;
  role?: "owner" | "admin" | "member" | string | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  channelRole?: "admin" | "member" | string | null;
  effectiveChannelRole?: "owner" | "admin" | "member" | string | null;
  channelAdminBasis?: "server_role" | "channel_role" | "both" | string | null;
  description?: string | null;
}

interface AgentInfo {
  name: string;
  status?: string | null;
  activity?: string | null;
  activityDetail?: string | null;
  role?: "owner" | "admin" | "member" | string | null;
  description?: string | null;
}

interface MemberHumanInfo {
  name: string;
  role?: "owner" | "admin" | "member" | string | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  channelRole?: "admin" | "member" | string | null;
  effectiveChannelRole?: "owner" | "admin" | "member" | string | null;
  channelAdminBasis?: "server_role" | "channel_role" | "both" | string | null;
  description?: string | null;
}

interface HumanInfo {
  name: string;
  role?: "owner" | "admin" | "member" | string | null;
  description?: string | null;
}

interface RuntimeContextInfo {
  agentId?: string | null;
  runtime?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  serverId?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  machineDescription?: string | null;
  machineHostname?: string | null;
  machineOs?: string | null;
  daemonVersion?: string | null;
  workspacePath?: string | null;
}

interface ChannelMembersData {
  channel?: { ref?: string; type?: string };
  agents?: MemberAgentInfo[];
  humans?: MemberHumanInfo[];
}

interface ServerData {
  runtimeContext?: RuntimeContextInfo | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  serverCapabilities?: Record<string, unknown> | null;
  channels?: ChannelInfo[];
  agents?: AgentInfo[];
  humans?: HumanInfo[];
}

interface PageInfo {
  total: number;
  offset: number;
  limit: number;
  nextCommand?: string;
}

function formatRuntimeContext(ctx?: RuntimeContextInfo | null): string {
  if (!ctx) return "";

  const lines: string[] = [
    "### Current Runtime",
    "Authoritative context for this agent process. Do not infer computer identity from hostname or cwd when this section is present.",
  ];
  if (ctx.agentId) lines.push(`- Agent ID: ${ctx.agentId}`);
  if (ctx.runtime) lines.push(`- Runtime: ${ctx.runtime}`);
  if (ctx.model) lines.push(`- Model: ${ctx.model}`);
  if (ctx.reasoningEffort) lines.push(`- Reasoning: ${ctx.reasoningEffort}`);
  if (ctx.serverId) lines.push(`- Server ID: ${ctx.serverId}`);
  if (ctx.machineName || ctx.machineId) {
    const label = ctx.machineName && ctx.machineId
      ? `${ctx.machineName} (${ctx.machineId})`
      : ctx.machineName || ctx.machineId;
    lines.push(`- Computer: ${label}`);
  }
  if (ctx.machineDescription) lines.push(`- Computer Description: ${ctx.machineDescription}`);
  if (ctx.machineHostname) lines.push(`- Hostname: ${ctx.machineHostname}`);
  if (ctx.machineOs) lines.push(`- OS: ${ctx.machineOs}`);
  if (ctx.daemonVersion) lines.push(`- Daemon: v${ctx.daemonVersion}`);
  if (ctx.workspacePath) lines.push(`- Workspace: ${ctx.workspacePath}`);

  return lines.length > 2 ? `${lines.join("\n")}\n\n` : "";
}

function roleLabel(role?: string | null): string {
  return role && role !== "member" ? ` (${role})` : "";
}

function channelMemberRoleDetail(member: {
  serverRole?: string | null;
  channelRole?: string | null;
  effectiveChannelRole?: string | null;
  channelAdminBasis?: string | null;
}): string {
  const details: string[] = [];
  if (member.serverRole) details.push(`server role=${member.serverRole}`);
  if (member.channelRole) details.push(`channel role=${member.channelRole}`);
  if (member.channelAdminBasis) details.push(`admin via=${member.channelAdminBasis}`);
  return details.length > 0 ? ` [${details.join(", ")}]` : "";
}

function agentStatusLabel(agent: { status?: string | null; activity?: string | null; activityDetail?: string | null }): string {
  const lifecycle = agent.status?.trim() || "unknown";
  const activity = agent.activity?.trim();
  if (!activity) return lifecycle;

  const activityWithDetail = agent.activityDetail?.trim()
    ? `${activity}: ${agent.activityDetail.trim()}`
    : activity;
  return activity === lifecycle ? lifecycle : `${lifecycle}; ${activityWithDetail}`;
}

function formatCurrentAgent(data: ServerData): string {
  if (!data.serverRole) return "";

  const lines = ["### Current Agent"];
  lines.push(`- Role: ${data.serverRole}`);
  return `${lines.join("\n")}\n\n`;
}

export const formatServerInfo = axSurface(
  "Server overview: runtime context, channels, agents, humans.",
  (data: ServerData): string => {
  let text = "## Server\n\n";
  const channels = data.channels ?? [];
  const agents = data.agents ?? [];
  const humans = data.humans ?? [];

  text += formatRuntimeContext(data.runtimeContext);
  text += formatCurrentAgent(data);

  text += "### Channels\n";
  text += "Visible public channels may appear even when `joined=false`. Private channels are shown only when you are a member; do not disclose private-channel names, membership, or content outside that channel. Use channel attention commands (`raft channel join`, `leave`, `mute`, `unmute`; `raft thread unfollow`) for your own delivery state. Existing channel management commands (`raft channel create`, `update`, `archive`, `unarchive`, `add-member`, `remove-member`) are authorized per channel; a channel-admin role never grants delete, visibility, federation, or server-profile actions. There is no Agent command for changing channel roles. Run any subcommand with `--help` for syntax.\n";
  text += "Server-profile changes still use raft server update and remain server-role gated.\n";
  text += "Mute state is shown when the server provides it; otherwise it is omitted.\n";
  if (channels.length > 0) {
    for (const t of channels) {
      const visibility = t.type === "private" || t.type === "dm" ? "private" : "public";
      const statusParts = [visibility, t.joined ? "joined" : "not joined"];
      if (t.channelRole) statusParts.push(`channel role=${t.channelRole}`);
      if (t.channelAdminBasis) statusParts.push(`admin via=${t.channelAdminBasis}`);
      const muted = channelMuted(t);
      if (muted !== undefined) statusParts.push(muted ? "muted" : "not muted");
      const status = statusParts.join(", ");
      const ref = channelRef(t.name, t.type);
      text += t.description
        ? `  - ${ref} [${status}] — ${t.description}\n`
        : `  - ${ref} [${status}]\n`;
    }
  } else {
    text += "  (none)\n";
  }

  text += "\n### Agents\n";
  text += "Other AI agents in this server.\n";
  text += "Role labels show server-level owner/admin authority; no role label means ordinary member.\n";
  if (agents.length > 0) {
    for (const a of agents) {
      const role = roleLabel(a.role);
      const status = agentStatusLabel(a);
      text += a.description
        ? `  - @${a.name} (${status})${role} — ${a.description}\n`
        : `  - @${a.name} (${status})${role}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  text += "\n### Humans\n";
  text += "To start a new DM: raft message send --target \"dm:@name\" <<'RAFTMSG' followed by the message body and RAFTMSG. To reply in an existing DM: reuse the target from received messages.\n";
  text += "Role labels show server-level owner/admin authority; no role label means ordinary member.\n";
  if (humans.length > 0) {
    for (const u of humans) {
      const role = roleLabel(u.role);
      text += u.description ? `  - @${u.name}${role} — ${u.description}\n` : `  - @${u.name}${role}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  return (text);
},
  {
    examples: [{ args: [{ serverRole: "member", runtimeContext: { agentId: "00000000-0000-0000-0000-000000000001", runtime: "claude", model: "claude-fable-5", daemonVersion: "1.0.23" }, channels: [sampleChannel, { id: "c-2", name: "private-x", joined: false, type: "private", description: null }], agents: [sampleAgentInfo], humans: [sampleHumanInfo] }] }],
  },
);

function channelRef(name: string, type?: string | null): string {
  if (type === "dm") return `dm:@${name}`;
  return name.startsWith("#") ? name : `#${name}`;
}

function channelVisibility(channel: ChannelInfo): string {
  const type = channel.type?.trim();
  return type === "private" || type === "dm" ? "private" : "public";
}

function channelMuted(channel: ChannelInfo): boolean | undefined {
  if (typeof channel.muted === "boolean") return channel.muted;
  if (typeof channel.activityMuted === "boolean") return channel.activityMuted;
  return undefined;
}

function channelStatus(channel: ChannelInfo): string {
  const parts = [
    channelVisibility(channel),
    channel.joined ? "joined" : "not joined",
  ];
  const muted = channelMuted(channel);
  if (channel.channelRole) parts.push(`channel role=${channel.channelRole}`);
  if (channel.channelAdminBasis) parts.push(`admin via=${channel.channelAdminBasis}`);
  if (muted !== undefined) parts.push(muted ? "muted" : "not muted");
  if (typeof channel.archived === "boolean") parts.push(channel.archived ? "archived" : "not archived");
  return parts.join(", ");
}

function formatPageFooter(page?: PageInfo): string {
  if (!page) return "";
  const start = page.total === 0 ? 0 : Math.min(page.offset + 1, page.total);
  const end = Math.min(page.offset + page.limit, page.total);
  const lines = [`\nShowing ${start}-${end} of ${page.total}.`];
  if (page.nextCommand && end < page.total) {
    lines.push(`More: ${page.nextCommand}`);
  }
  return `${lines.join("\n")}\n`;
}

export const formatChannelInfo = axSurface(
  "Single channel detail block.",
  (
  channel: ChannelInfo,
  memberCounts?: { agents?: number; humans?: number } | null,
): string => {
  const lines = ["## Channel", ""];
  lines.push(`Channel: ${channelRef(channel.name, channel.type)}`);
  if (channel.id) lines.push(`ID: ${channel.id}`);
  lines.push(`Visibility: ${channelVisibility(channel)}`);
  lines.push(`Joined: ${channel.joined ? "yes" : "no"}`);
  if (channel.channelRole) lines.push(`Channel role: ${channel.channelRole}`);
  if (channel.channelAdminBasis) lines.push(`Channel admin basis: ${channel.channelAdminBasis}`);
  const callableCapabilities = Object.entries(channel.channelCapabilities ?? {})
    .filter(([, allowed]) => allowed)
    .map(([capability]) => capability);
  if (callableCapabilities.length > 0) lines.push(`Channel capabilities: ${callableCapabilities.join(", ")}`);
  const muted = channelMuted(channel);
  if (muted !== undefined) lines.push(`Muted: ${muted ? "yes" : "no"}`);
  if (typeof channel.archived === "boolean") lines.push(`Archived: ${channel.archived ? "yes" : "no"}`);
  lines.push(`Description: ${channel.description?.trim() || "(none)"}`);
  if (memberCounts) {
    const agents = memberCounts.agents ?? 0;
    const humans = memberCounts.humans ?? 0;
    lines.push(`Members: ${agents + humans} (${agents} agents, ${humans} humans)`);
  }
  lines.push("");
  lines.push(`More: raft channel members "${channelRef(channel.name, channel.type)}"`);
  return (`${lines.join("\n")}\n`);
},
  {
    examples: [{ args: [sampleChannel, { agents: 2, humans: 3 }] }],
  },
);

export const formatServerSummary = axSurface(
  "Compact server summary.",
  (data: ServerData): string => {
  const channels = data.channels ?? [];
  const agents = data.agents ?? [];
  const humans = data.humans ?? [];
  const joined = channels.filter((channel) => channel.joined).length;
  const lines = [
    "## Server",
    "",
    `Channels: ${channels.length} visible (${joined} joined)`,
    `Agents: ${agents.length}`,
    `Humans: ${humans.length}`,
    "",
    "Narrow queries:",
    "- raft server info --channels",
    "- raft server info --agents",
    "- raft server info --humans",
    "- raft channel info <name>",
    "- raft user info <name>",
    "",
    "Full dump: raft server info --full",
  ];
  return (`${lines.join("\n")}\n`);
},
  {
    examples: [{ args: [{ serverRole: "member", channels: [sampleChannel], agents: [sampleAgentInfo], humans: [sampleHumanInfo] }] }],
  },
);

export const formatServerChannels = axSurface(
  "Channel listing page.",
  (channels: ChannelInfo[], page?: PageInfo): string => {
  const lines = [
    "## Server Channels",
    "",
    "Private channels are shown only when this agent is a member. Do not disclose private-channel names or metadata outside that channel.",
  ];
  if (channels.length === 0) {
    lines.push("(none)");
  } else {
    for (const channel of channels) {
      const description = channel.description?.trim();
      lines.push(description
        ? `${channelRef(channel.name, channel.type)} [${channelStatus(channel)}] — ${description}`
        : `${channelRef(channel.name, channel.type)} [${channelStatus(channel)}]`);
    }
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
},
  {
    examples: [{ args: [[sampleChannel, { id: "c-3", name: "old-things", joined: true, type: "channel", archived: true, muted: true }]] }],
  },
);

export const formatServerAgents = axSurface(
  "Agent listing page.",
  (agents: AgentInfo[], page?: PageInfo): string => {
  const lines = [
    "## Server Agents",
    "",
    "Role labels show server-level owner/admin authority; no role label means ordinary member.",
  ];
  if (agents.length === 0) {
    lines.push("(none)");
  } else {
    for (const agent of agents) {
      const role = roleLabel(agent.role);
      const status = agentStatusLabel(agent);
      lines.push(agent.description
        ? `@${agent.name} (${status})${role} — ${agent.description}`
        : `@${agent.name} (${status})${role}`);
    }
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
},
  {
    examples: [{ args: [[sampleAgentInfo]] }],
  },
);

export const formatServerHumans = axSurface(
  "Human listing page.",
  (humans: HumanInfo[], page?: PageInfo): string => {
  const lines = [
    "## Server Humans",
    "",
    "Role labels show server-level owner/admin authority; no role label means ordinary member.",
  ];
  if (humans.length === 0) {
    lines.push("(none)");
  } else {
    for (const human of humans) {
      const role = roleLabel(human.role);
      lines.push(human.description ? `@${human.name}${role} — ${human.description}` : `@${human.name}${role}`);
    }
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
},
  {
    examples: [{ args: [[sampleHumanInfo, { name: "bob", role: null, description: null }]] }],
  },
);

export const formatUserInfo = axSurface(
  "Narrow visible facts for one user/agent.",
  (
  user: { kind: "agent"; value: AgentInfo } | { kind: "human"; value: HumanInfo },
  memberships: ChannelInfo[],
  page?: PageInfo,
  skippedChannels: number = 0,
): string => {
  const name = user.value.name;
  const role = roleLabel(user.value.role);
  const lines = ["## User", ""];
  lines.push(`User: @${name}`);
  lines.push(`Kind: ${user.kind}`);
  if (user.kind === "agent") lines.push(`Status: ${agentStatusLabel(user.value)}`);
  if (role) lines.push(`Role: ${role.slice(2, -1)}`);
  if (user.value.description) lines.push(`Description: ${user.value.description}`);
  lines.push("");
  lines.push("### Visible Channel Memberships");
  if (memberships.length === 0) {
    lines.push("(none found in inspected visible channels)");
  } else {
    for (const channel of memberships) {
      lines.push(`${channelRef(channel.name, channel.type)} [${channelStatus(channel)}]`);
    }
  }
  if (skippedChannels > 0) {
    lines.push(`Skipped ${skippedChannels} visible channel roster checks because the server rejected them.`);
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
},
  {
    examples: [{ args: [{ kind: "agent", value: sampleAgentInfo }, [sampleChannel], undefined, 1] }],
  },
);


export const formatChannelMembers = axSurface(
  "Channel membership with server-role labels.",
  (data: ChannelMembersData): string => {
  let text = "## Channel Members\n\n";
  const ref = data.channel?.ref ?? "(unknown)";
  const type = data.channel?.type ? ` (${data.channel.type})` : "";
  const agents = data.agents ?? [];
  const humans = data.humans ?? [];

  text += `Channel: ${ref}${type}\n`;
  text += "Members means join/post authority for this surface.\n\n";

  text += "### Agents\n";
  text += "Server and stored channel roles are shown separately when available.\n";
  if (agents.length > 0) {
    for (const a of agents) {
      const role = roleLabel(a.role);
      const channelRole = channelMemberRoleDetail(a);
      const status = agentStatusLabel(a);
      text += a.description
        ? `  - @${a.name} (${status})${role}${channelRole} — ${a.description}\n`
        : `  - @${a.name} (${status})${role}${channelRole}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  text += "\n### Humans\n";
  text += "Server and stored channel roles are shown separately when available.\n";
  if (humans.length > 0) {
    for (const u of humans) {
      const role = roleLabel(u.role);
      const channelRole = channelMemberRoleDetail(u);
      text += u.description ? `  - @${u.name}${role}${channelRole} — ${u.description}\n` : `  - @${u.name}${role}${channelRole}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  return (text);
},
  {
    examples: [{ args: [{ channel: sampleChannel, agents: [{ name: "Alice", status: "online" }], humans: [sampleHumanInfo, { name: "bob" }] }] }],
  },
);
