// Canonical server / channel / user text for agent-facing output (moved
// verbatim from the CLI's commands/server/_format.ts; the CLI wraps these in
// its axSurface registrations and pins the bytes with its snapshot tests).

import { formatHint, formatHintName, RAFT_HINTS, type RaftHintStyle } from "../agentOps/hint";
import { foldAgentOneLineText, indentAgentBodyContinuationLines } from "../agentMessageText";
import type { ChannelAnnouncement } from "../channelAnnouncement";

export interface AgentChannelInfo {
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
  /**
   * When a person or an agent last posted there (thread replies included);
   * null: nobody has. Absent when the Server doesn't know (older Servers, or
   * before its one-time backfill), and then nothing is shown.
   */
  lastPostAt?: string | null;
  /**
   * The channel's announcement (an Artifact homed in it), null for none.
   * Absent when `channel_announcement_v0` is off or the Server is older, and
   * then nothing is shown.
   */
  announcement?: ChannelAnnouncement | null;
}

export interface AgentMemberAgentInfo {
  name: string;
  /** Missing on older Servers; rendered as "unknown". */
  status?: string | null;
  activity?: string | null;
  activityDetail?: string | null;
  role?: "owner" | "admin" | "member" | string | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  channelRole?: "admin" | "member" | string | null;
  effectiveChannelRole?: "owner" | "admin" | "member" | string | null;
  channelAdminBasis?: "server_role" | "channel_role" | "both" | string | null;
  description?: string | null;
}

export interface AgentAgentInfo {
  name: string;
  status?: string | null;
  activity?: string | null;
  activityDetail?: string | null;
  role?: "owner" | "admin" | "member" | string | null;
  description?: string | null;
}

export interface AgentMemberHumanInfo {
  name: string;
  role?: "owner" | "admin" | "member" | string | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  channelRole?: "admin" | "member" | string | null;
  effectiveChannelRole?: "owner" | "admin" | "member" | string | null;
  channelAdminBasis?: "server_role" | "channel_role" | "both" | string | null;
  /** Joint channels only: every server the person participates through. */
  servers?: Array<{ name: string; slug: string; yours?: boolean }> | null;
  description?: string | null;
}

export interface AgentHumanInfo {
  name: string;
  role?: "owner" | "admin" | "member" | string | null;
  description?: string | null;
}

export interface AgentRuntimeContextInfo {
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

export interface AgentChannelMembersData {
  channel?: { ref?: string; type?: string };
  agents?: AgentMemberAgentInfo[];
  humans?: AgentMemberHumanInfo[];
}

export interface AgentServerData {
  runtimeContext?: AgentRuntimeContextInfo | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  serverCapabilities?: Record<string, unknown> | null;
  channels?: AgentChannelInfo[];
  agents?: AgentAgentInfo[];
  humans?: AgentHumanInfo[];
}

export interface AgentPageInfo {
  total: number;
  offset: number;
  limit: number;
  nextCommand?: string;
}

function formatRuntimeContext(ctx?: AgentRuntimeContextInfo | null): string {
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
    const label = indentAgentBodyContinuationLines(ctx.machineName && ctx.machineId
      ? `${ctx.machineName} (${ctx.machineId})`
      : ctx.machineName || ctx.machineId || "");
    lines.push(`- Computer: ${label}`);
  }
  if (ctx.machineDescription) lines.push(`- Computer Description: ${indentAgentBodyContinuationLines(ctx.machineDescription)}`);
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

/**
 * Joint rosters: the servers a person participates through, by display name
 * ("this server" for the agent's own; the slug when two listed servers share a
 * name).
 */
function memberServersDetail(servers?: ReadonlyArray<{ name: string; slug: string; yours?: boolean }> | null): string {
  if (!servers || servers.length === 0) return "";
  const nameCounts = new Map<string, number>();
  for (const server of servers) nameCounts.set(server.name, (nameCounts.get(server.name) ?? 0) + 1);
  const labels = servers.map((server) => {
    if (server.yours) return "this server";
    return (nameCounts.get(server.name) ?? 0) > 1 || !server.name ? server.slug : foldAgentOneLineText(server.name);
  });
  return ` [servers: ${labels.join(", ")}]`;
}

export function agentStatusLabel(agent: { status?: string | null; activity?: string | null; activityDetail?: string | null }): string {
  const lifecycle = agent.status?.trim() || "unknown";
  const activity = agent.activity?.trim();
  if (!activity) return lifecycle;

  const activityWithDetail = agent.activityDetail?.trim()
    ? `${activity}: ${agent.activityDetail.trim()}`
    : activity;
  return activity === lifecycle ? lifecycle : `${lifecycle}; ${activityWithDetail}`;
}

function formatCurrentAgent(data: AgentServerData): string {
  if (!data.serverRole) return "";

  const lines = ["### Current Agent"];
  lines.push(`- Role: ${data.serverRole}`);
  return `${lines.join("\n")}\n\n`;
}

/** Server overview: runtime context, channels, agents, humans. */
export function formatAgentServerInfo(data: AgentServerData, style: RaftHintStyle = "cli", now: number = Date.now()): string {
  let text = "## Server\n\n";
  const channels = data.channels ?? [];
  const agents = data.agents ?? [];
  const humans = data.humans ?? [];

  text += formatRuntimeContext(data.runtimeContext);
  text += formatCurrentAgent(data);

  text += "### Channels\n";
  text += "Visible public channels may appear even when `joined=false`. Private channels are shown only when you are a member; do not disclose private-channel names, membership, or content outside that channel. ";
  text += style === "cli"
    ? `Use channel attention commands (\`${formatHintName(RAFT_HINTS.channelJoinName())}\`, \`leave\`, \`mute\`, \`unmute\`; \`${formatHintName(RAFT_HINTS.threadUnfollowName())}\`) for your own delivery state. Existing channel management commands (\`${formatHintName(RAFT_HINTS.channelCreateName())}\`, \`update\`, \`archive\`, \`unarchive\`, \`add-member\`, \`remove-member\`) work when your server role allows them, or, for update, archive, unarchive and remove-member, your channel-admin role in that channel; the Server checks on each call, and a refusal says what is missing. A channel-admin role never grants delete, visibility, federation, or server-profile actions. There is no Agent command for changing channel roles. Run any subcommand with \`--help\` for syntax.\n`
    : `Use the channel attention tools (${[RAFT_HINTS.channelJoinName(), RAFT_HINTS.channelLeaveName(), RAFT_HINTS.channelMuteName(), RAFT_HINTS.channelUnmuteName()].map((hint) => `\`${formatHintName(hint, style)}\``).join(", ")}; \`${formatHintName(RAFT_HINTS.threadUnfollowName(), style)}\`) for your own delivery state. Channel management tools (${[RAFT_HINTS.channelCreateName(), RAFT_HINTS.channelUpdateName(), RAFT_HINTS.channelArchiveName(), RAFT_HINTS.channelUnarchiveName(), RAFT_HINTS.channelAddMemberName(), RAFT_HINTS.channelRemoveMemberName()].map((hint) => `\`${formatHintName(hint, style)}\``).join(", ")}) work when your server role allows them, or, for update, archive, unarchive and remove-member, your channel-admin role in that channel; the Server checks on each call, and a refusal says what is missing. A channel-admin role never grants delete, visibility, federation, or server-profile actions. There is no tool for changing channel roles.\n`;
  text += style === "cli"
    ? `Server-profile changes still use ${formatHintName(RAFT_HINTS.serverUpdateName())} and remain server-role gated.\n`
    : `Server-profile changes use \`${formatHintName(RAFT_HINTS.serverUpdateName(), style)}\` and remain server-role gated.\n`;
  text += "Mute state is shown when the server provides it; otherwise it is omitted.\n";
  if (channels.length > 0) {
    for (const t of channels) {
      const statusParts = [channelVisibility(t), t.joined ? "joined" : "not joined"];
      if (t.channelRole) statusParts.push(`channel role=${t.channelRole}`);
      if (t.channelAdminBasis) statusParts.push(`admin via=${t.channelAdminBasis}`);
      const muted = channelMuted(t);
      if (muted !== undefined) statusParts.push(muted ? "muted" : "not muted");
      const lastPost = channelLastPost(t, now);
      if (lastPost) statusParts.push(lastPost);
      const status = statusParts.join(", ");
      const ref = agentChannelRef(t.name, t.type);
      text += t.description
        ? `  - ${ref} [${status}] — ${indentAgentBodyContinuationLines(t.description)}\n`
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
        ? `  - @${a.name} (${status})${role} — ${indentAgentBodyContinuationLines(a.description)}\n`
        : `  - @${a.name} (${status})${role}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  text += "\n### Humans\n";
  const newDm = formatHint(RAFT_HINTS.messageSend({ target: "dm:@name" }), style);
  text += style === "cli"
    ? `To start a new DM: ${newDm} <<'RAFTMSG' followed by the message body and RAFTMSG. To reply in an existing DM: reuse the target from received messages.\n`
    : `To start a new DM: ${newDm}. To reply in an existing DM: reuse the target from received messages.\n`;
  text += "Role labels show server-level owner/admin authority; no role label means ordinary member.\n";
  if (humans.length > 0) {
    for (const u of humans) {
      const role = roleLabel(u.role);
      text += u.description ? `  - @${u.name}${role} — ${indentAgentBodyContinuationLines(u.description)}\n` : `  - @${u.name}${role}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  return (text);
}

export function agentChannelRef(name: string, type?: string | null): string {
  if (type === "dm") return `dm:@${name}`;
  return name.startsWith("#") ? name : `#${name}`;
}

// A joint channel is shared with members of other servers and is
// membership-gated like a private one; calling it "public" hid that.
export function channelVisibility(channel: Pick<AgentChannelInfo, "type">): string {
  const type = channel.type?.trim();
  if (type === "joint") return "joint";
  return type === "private" || type === "dm" ? "private" : "public";
}

function channelMuted(channel: AgentChannelInfo): boolean | undefined {
  if (typeof channel.muted === "boolean") return channel.muted;
  if (typeof channel.activityMuted === "boolean") return channel.activityMuted;
  return undefined;
}

/** `2026-10-18 07:12Z` (the Server keeps minutes). */
function minuteStamp(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/** `3d ago`; a time at or after `now` (clock skew) reads `just now`. */
function agoLabel(at: Date, now: number): string {
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * When a person or an agent last posted (thread replies included; system
 * messages and app events don't count). Nothing when the Server doesn't say:
 * an unknown time must not read as "no posts yet".
 */
export function channelLastPost(channel: Pick<AgentChannelInfo, "lastPostAt">, now: number = Date.now()): string | undefined {
  if (channel.lastPostAt === undefined) return undefined;
  if (channel.lastPostAt === null) return "no posts yet";
  const at = new Date(channel.lastPostAt);
  if (Number.isNaN(at.getTime())) return undefined;
  return `last post ${minuteStamp(at)} (${agoLabel(at, now)})`;
}

function channelStatus(channel: AgentChannelInfo, now: number = Date.now()): string {
  const parts = [
    channelVisibility(channel),
    channel.joined ? "joined" : "not joined",
  ];
  const muted = channelMuted(channel);
  if (channel.channelRole) parts.push(`channel role=${channel.channelRole}`);
  if (channel.channelAdminBasis) parts.push(`admin via=${channel.channelAdminBasis}`);
  if (muted !== undefined) parts.push(muted ? "muted" : "not muted");
  if (typeof channel.archived === "boolean") parts.push(channel.archived ? "archived" : "not archived");
  const lastPost = channelLastPost(channel, now);
  if (lastPost) parts.push(lastPost);
  return parts.join(", ");
}

function formatPageFooter(page?: AgentPageInfo): string {
  if (!page) return "";
  const start = page.total === 0 ? 0 : Math.min(page.offset + 1, page.total);
  const end = Math.min(page.offset + page.limit, page.total);
  const lines = [`\nShowing ${start}-${end} of ${page.total}.`];
  if (page.nextCommand && end < page.total) {
    lines.push(`More: ${page.nextCommand}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The channel's announcement line (`raft channel info`), or nothing when it
 * has none or the Server doesn't say: `Announcement: "Ops rules" (pt_…, v3,
 * updated 2026-11-10 07:12Z) — read: raft artifact read pt_…`.
 */
export function channelAnnouncementLine(channel: Pick<AgentChannelInfo, "announcement">, style: RaftHintStyle = "cli"): string | undefined {
  const channelAnnouncement = channel.announcement;
  if (!channelAnnouncement) return undefined;
  const at = new Date(channelAnnouncement.updatedAt);
  const updated = Number.isNaN(at.getTime()) ? "" : `, updated ${minuteStamp(at)}`;
  const read = formatHint(RAFT_HINTS.artifactRead({ artifact: channelAnnouncement.artifactId }), style);
  return `Announcement: "${foldAgentOneLineText(channelAnnouncement.title)}" (${channelAnnouncement.artifactId}, v${channelAnnouncement.version}${updated}) — read: ${read}`;
}

/**
 * `raft channel update`'s answer: `Updated #ops (public).`, and when the
 * request set or removed the announcement, what it is now.
 */
export function formatAgentChannelUpdated(
  channel: { name: string; type?: string | null; announcement?: ChannelAnnouncement | null },
  opts: { channelAnnouncementChanged?: boolean } = {},
  style: RaftHintStyle = "cli",
): string {
  const head = `Updated #${channel.name} (${channel.type === "private" ? "private" : "public"}).`;
  if (!opts.channelAnnouncementChanged || channel.announcement === undefined) return head;
  if (channel.announcement === null) return `${head} It has no announcement now.`;
  return `${head}\n${channelAnnouncementLine(channel, style)}`;
}

/** Single channel detail block. */
export function formatAgentChannelInfo(
  channel: AgentChannelInfo,
  memberCounts?: { agents?: number; humans?: number } | null,
  style: RaftHintStyle = "cli",
): string {
  const lines = ["## Channel", ""];
  lines.push(`Channel: ${agentChannelRef(channel.name, channel.type)}`);
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
  if (typeof channel.archived === "boolean") lines.push(`Archived: ${channel.archived ? "yes (read-only: you can read its history, nothing new can be posted)" : "no"}`);
  lines.push(`Description: ${indentAgentBodyContinuationLines(channel.description?.trim() || "(none)")}`);
  const channelAnnouncement = channelAnnouncementLine(channel, style);
  if (channelAnnouncement) lines.push(channelAnnouncement);
  if (memberCounts) {
    const agents = memberCounts.agents ?? 0;
    const humans = memberCounts.humans ?? 0;
    lines.push(`Members: ${agents + humans} (${agents} agents, ${humans} humans)`);
  }
  lines.push("");
  lines.push(`More: ${formatHint(RAFT_HINTS.channelMembers(agentChannelRef(channel.name, channel.type)), style)}`);
  return (`${lines.join("\n")}\n`);
}

/** Compact server summary. */
export function formatAgentServerSummary(data: AgentServerData, style: RaftHintStyle = "cli"): string {
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
    ...(data.serverRole ? [`Your role: ${data.serverRole}`] : []),
    "",
    "Narrow queries:",
    ...[
      RAFT_HINTS.serverInfo({ view: "channels" }),
      RAFT_HINTS.serverInfo({ view: "agents" }),
      RAFT_HINTS.serverInfo({ view: "humans" }),
      RAFT_HINTS.channelInfo(),
      RAFT_HINTS.userInfo(),
    ].map((hint) => `- ${formatHint(hint, style)}`),
    "",
    `Full dump: ${formatHint(RAFT_HINTS.serverInfo({ view: "full" }), style)}`,
  ];
  return (`${lines.join("\n")}\n`);
}

/** Channel listing page. */
/**
 * The line under the last page of the default channel listing when the
 * agent can see archived channels it leaves out (`archivedNotShown` > 0).
 */
export function archivedChannelsNotShownLine(count: number, listCommand: string): string {
  return `${count} archived ${count === 1 ? "channel" : "channels"} not shown (read-only). To list them: ${listCommand}`;
}

export function formatAgentServerChannels(
  channels: AgentChannelInfo[],
  page?: AgentPageInfo,
  now: number = Date.now(),
  archivedNotShown?: { count: number; listCommand: string },
): string {
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
        ? `${agentChannelRef(channel.name, channel.type)} [${channelStatus(channel, now)}] — ${indentAgentBodyContinuationLines(description)}`
        : `${agentChannelRef(channel.name, channel.type)} [${channelStatus(channel, now)}]`);
    }
  }
  const body = `${lines.join("\n")}${formatPageFooter(page)}`;
  // Only under the last page (or the unpaged list), only when there are some.
  const lastPage = !page || page.offset + page.limit >= page.total;
  if (!archivedNotShown || archivedNotShown.count <= 0 || !lastPage) return body;
  const line = archivedChannelsNotShownLine(archivedNotShown.count, archivedNotShown.listCommand);
  return body.endsWith("\n") ? `${body}${line}\n` : `${body}\n${line}`;
}

/** Agent listing page. */
export function formatAgentServerAgents(agents: AgentAgentInfo[], page?: AgentPageInfo): string {
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
        ? `@${agent.name} (${status})${role} — ${indentAgentBodyContinuationLines(agent.description)}`
        : `@${agent.name} (${status})${role}`);
    }
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
}

/** Human listing page. */
export function formatAgentServerHumans(humans: AgentHumanInfo[], page?: AgentPageInfo): string {
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
      lines.push(human.description ? `@${human.name}${role} — ${indentAgentBodyContinuationLines(human.description)}` : `@${human.name}${role}`);
    }
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
}

/** Narrow visible facts for one user/agent. */
export function formatAgentUserInfo(
  user: { kind: "agent"; value: AgentAgentInfo } | { kind: "human"; value: AgentHumanInfo },
  memberships: AgentChannelInfo[],
  page?: AgentPageInfo,
  skippedChannels: number = 0,
): string {
  const name = user.value.name;
  const role = roleLabel(user.value.role);
  const lines = ["## User", ""];
  lines.push(`User: @${name}`);
  lines.push(`Kind: ${user.kind}`);
  if (user.kind === "agent") lines.push(`Status: ${agentStatusLabel(user.value)}`);
  if (role) lines.push(`Role: ${role.slice(2, -1)}`);
  if (user.value.description) lines.push(`Description: ${indentAgentBodyContinuationLines(user.value.description)}`);
  lines.push("");
  lines.push("### Visible Channel Memberships");
  if (memberships.length === 0) {
    lines.push("(none found in inspected visible channels)");
  } else {
    for (const channel of memberships) {
      lines.push(`${agentChannelRef(channel.name, channel.type)} [${channelStatus(channel)}]`);
    }
  }
  if (skippedChannels > 0) {
    lines.push(`Skipped ${skippedChannels} visible channel roster checks because the server rejected them.`);
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
}

/** Channel membership with server-role labels. */
export function formatAgentChannelMembers(data: AgentChannelMembersData): string {
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
        ? `  - @${a.name} (${status})${role}${channelRole} — ${indentAgentBodyContinuationLines(a.description)}\n`
        : `  - @${a.name} (${status})${role}${channelRole}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  text += "\n### Humans\n";
  text += "Server and stored channel roles are shown separately when available.\n";
  if (humans.some((human) => (human.servers?.length ?? 0) > 0)) {
    text += "`[servers: ...]` marks people in this joint channel who take part through another server, and lists each server they come through (\"this server\" is yours). People without it are only on this server. For someone not on this server, the role shown is their role on their own server; it gives them no rights here.\n";
  }
  if (humans.length > 0) {
    for (const u of humans) {
      const role = roleLabel(u.role);
      const channelRole = channelMemberRoleDetail(u);
      const servers = memberServersDetail(u.servers);
      text += u.description ? `  - @${u.name}${role}${channelRole}${servers} — ${indentAgentBodyContinuationLines(u.description)}\n` : `  - @${u.name}${role}${channelRole}${servers}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  return (text);
}

/**
 * A private channel goes with its last member: the Server deletes it and all
 * its messages. The web asks a person "Leave and Delete Channel?" first; an
 * agent says so with `deleteIfLast` (`--delete-if-last`), and without it the
 * Server refuses (409 `last_member_deletes_channel`) and changes nothing.
 * `member` is the one being removed (`@alice`); absent, the agent is leaving.
 */
export function formatLastMemberRefusal(
  input: { target: string; member?: { user: string } | { agent: string } },
  style: RaftHintStyle = "cli",
): { message: string; nextAction: string } {
  const { target, member } = input;
  const who = member ? ("user" in member ? member.user : member.agent) : null;
  const message = who
    ? `${who} is the last member of ${target}, a private channel: removing them would delete the channel and all its messages, and that can't be undone. Nothing changed.`
    : `You are the last member of ${target}, a private channel: leaving would delete the channel and all its messages, and that can't be undone. Nothing changed.`;
  const again = member ? RAFT_HINTS.channelRemoveMemberDeleting(target, member) : RAFT_HINTS.channelLeaveDeleting(target);
  const otherwise = who ? "Otherwise leave them in it." : "Otherwise stay in it, or ask a person to add someone else first.";
  return { message, nextAction: `Only if the channel and all its messages should go: ${formatHint(again, style)}. ${otherwise}` };
}

/** The line after a removal that deleted the channel with its last member. */
export function formatChannelDeletedWithLastMember(target: string, member?: string): string {
  return member
    ? `${member} was the last member of ${target}, a private channel, so it and all its messages were deleted. That can't be undone.`
    : `You were the last member of ${target}, a private channel, so it and all its messages were deleted. That can't be undone.`;
}

/** The Server's code for that refusal. */
export const LAST_MEMBER_DELETES_CHANNEL = "last_member_deletes_channel";
