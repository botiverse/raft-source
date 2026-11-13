import { sampleAgentInfo, sampleChannel, sampleHumanInfo } from "../_axExampleFixtures";
import { axSurface } from "../../core/renderer";
import type {
  AgentAgentInfo,
  AgentChannelInfo,
  AgentChannelMembersData,
  AgentHumanInfo,
  AgentPageInfo,
  AgentServerData,
} from "@botiverse/raft-shared";
import {
  formatAgentChannelInfo,
  formatAgentChannelMembers,
  formatAgentServerAgents,
  formatAgentServerChannels,
  formatAgentServerHumans,
  formatAgentServerInfo,
  formatAgentServerSummary,
  formatAgentUserInfo,
} from "@botiverse/raft-shared/src/agentCliSurface";

// Canonical server info formatting for agent-facing output. The text lives in
// `@botiverse/raft-shared` (`agentText/server.ts`) so the SDK renders the same
// bytes; this file keeps the axSurface registrations and their examples.
// An AX contract, not an implementation detail. Pinned by `_format.test.ts`.

type ChannelInfo = AgentChannelInfo;
type AgentInfo = AgentAgentInfo;
type HumanInfo = AgentHumanInfo;
type ChannelMembersData = AgentChannelMembersData;
type ServerData = AgentServerData;
type PageInfo = AgentPageInfo;

export const formatServerInfo = axSurface(
  "Server overview: runtime context, channels, agents, humans.",
  (data: ServerData, now?: number): string => formatAgentServerInfo(data, "cli", now),
  {
    examples: [{ args: [{ serverRole: "member", runtimeContext: { agentId: "00000000-0000-0000-0000-000000000001", runtime: "claude", model: "claude-fable-5", daemonVersion: "1.0.23" }, channels: [sampleChannel, { id: "c-2", name: "private-x", joined: false, type: "private", description: null }], agents: [sampleAgentInfo], humans: [sampleHumanInfo] }] }],
  },
);

export const formatChannelInfo = axSurface(
  "Single channel detail block.",
  (channel: ChannelInfo, memberCounts?: { agents?: number; humans?: number } | null): string => formatAgentChannelInfo(channel, memberCounts),
  {
    examples: [{ args: [sampleChannel, { agents: 2, humans: 3 }] }],
  },
);

export const formatServerSummary = axSurface(
  "Compact server summary.",
  (data: ServerData): string => formatAgentServerSummary(data),
  {
    examples: [{ args: [{ serverRole: "member", channels: [sampleChannel], agents: [sampleAgentInfo], humans: [sampleHumanInfo] }] }],
  },
);

export const formatServerChannels = axSurface(
  "Channel listing page.",
  (channels: ChannelInfo[], page?: PageInfo, now?: number, archivedNotShown?: { count: number; listCommand: string }): string =>
    formatAgentServerChannels(channels, page, now, archivedNotShown),
  {
    examples: [
      {
        args: [[sampleChannel], { total: 1, offset: 0, limit: 50 }, undefined, { count: 2, listCommand: "raft server info --channels --archived" }],
      },
      { args: [[sampleChannel, { id: "c-3", name: "old-things", joined: true, type: "channel", archived: true, muted: true }]] },
      {
        args: [[
          { ...sampleChannel, lastPostAt: "2026-10-18T07:12:40.000Z" },
          { id: "c-4", name: "empty-room", joined: false, type: "channel", lastPostAt: null },
        ], undefined, Date.parse("2026-10-21T08:30:00.000Z")],
      },
    ],
  },
);

export const formatServerAgents = axSurface(
  "Agent listing page.",
  (agents: AgentInfo[], page?: PageInfo): string => formatAgentServerAgents(agents, page),
  {
    examples: [{ args: [[sampleAgentInfo]] }],
  },
);

export const formatServerHumans = axSurface(
  "Human listing page.",
  (humans: HumanInfo[], page?: PageInfo): string => formatAgentServerHumans(humans, page),
  {
    examples: [{ args: [[sampleHumanInfo, { name: "bob", role: null, description: null }]] }],
  },
);

export const formatUserInfo = axSurface(
  "Narrow visible facts for one user/agent.",
  (user: { kind: "agent"; value: AgentInfo } | { kind: "human"; value: HumanInfo }, memberships: ChannelInfo[], page?: PageInfo, skippedChannels: number = 0): string => formatAgentUserInfo(user, memberships, page, skippedChannels),
  {
    examples: [{ args: [{ kind: "agent", value: sampleAgentInfo }, [sampleChannel], undefined, 1] }],
  },
);

export const formatChannelMembers = axSurface(
  "Channel membership with server-role labels.",
  (data: ChannelMembersData): string => formatAgentChannelMembers(data),
  {
    examples: [{ args: [{ channel: sampleChannel, agents: [{ name: "Alice", status: "online" }], humans: [sampleHumanInfo, { name: "bob" }] }] }],
  },
);
