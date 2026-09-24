// Shared example fixtures for daemon axSurface definitions (@xxchan: reuse
// samples per data type). PURE DATA with placeholder identifiers; the driver
// stubs carry only the fields the runtime-input formatters read.
import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";

import type { RuntimeDriver } from "./drivers/types.js";
import type { SystemPromptOptions } from "./drivers/systemPrompt.js";

export const EXAMPLE_T = "2026-08-31T08:00:00.000Z";

export const exampleStdinDriver = {
  communication: { chat: "slock_cli" },
  supportsStdinNotification: true,
  busyDeliveryMode: "direct",
} as unknown as RuntimeDriver;

export const exampleRestartDriver = {
  communication: { chat: "slock_cli" },
  supportsStdinNotification: false,
  busyDeliveryMode: "none",
} as unknown as RuntimeDriver;

export const exampleMessage: AgentMessage = {
  channel_id: "ch-1",
  channel_name: "general",
  channel_type: "channel",
  sender_id: "u-1",
  sender_name: "richard",
  sender_type: "human",
  content: "hello, can you look at this?",
  timestamp: EXAMPLE_T,
  message_id: "00000000-1111-2222-3333-444444444444",
  seq: 100,
};

export const exampleUnreadSummary: Record<string, number> = {
  "#channel-a": 12,
  "dm:@peer": 1,
};

export const exampleAgentConfig = {
  name: "alice-agent",
  displayName: "Alice",
  description: "example role (rendered from AgentConfig.description)",
  runtimeContext: {
    agentId: "00000000-0000-0000-0000-000000000001",
    serverId: "00000000-0000-0000-0000-000000000002",
    machineId: "00000000-0000-0000-0000-000000000003",
    machineName: "example-computer",
    machineHostname: "example-host",
    machineOs: "linux arm64",
    daemonVersion: "1.0.23",
    workspacePath: "/home/user/.slock/agents/00000000-0000-0000-0000-000000000001",
  },
} as unknown as AgentConfig;

export const exampleSystemPromptOptions: SystemPromptOptions = {
  extraCriticalRules: [],
};
