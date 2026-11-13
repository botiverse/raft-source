// Shared example fixtures for daemon axSurface definitions (@xxchan: reuse
// samples per data type). PURE DATA with placeholder identifiers; the driver
// stubs carry only the fields the runtime-input formatters read.
import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";

import type { RuntimeDriver } from "./drivers/types";
import type { SystemPromptOptions } from "./drivers/systemPrompt";

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

/**
 * A third-party app event as the daemon receives it (the grouped transport DM).
 * With `inboxItemTarget`, the Server lists it as that inbox item (RFC 081).
 */
export function exampleThirdPartyEvent(seq: number, inboxItemTarget?: string): AgentMessage {
  const id = String(seq).padStart(12, "0");
  return {
    ...exampleMessage,
    message_id: `eeeeeeee-0000-4000-8000-${id}`,
    seq,
    channel_id: "third-party-agent-events:agent-1",
    channel_type: "dm",
    channel_name: "third-party-agent-events:agent-1",
    sender_name: "stamp-bot",
    content: "Third-party notification: checks failed on 9ed73d5",
    third_party_event: {
      id: `ffffffff-0000-4000-8000-${id}`,
      kind: "notification",
      client_id: "stamp",
      client_name: "Stamp",
      payload_hash: "example-hash",
      payload: {},
      expires_at: EXAMPLE_T,
      source: { client_id: "stamp", client_name: "Stamp", oauth_client_id: "oauth-client-1", resource: "raft" },
      ...(inboxItemTarget === undefined ? {} : { inbox_item_target: inboxItemTarget }),
    },
  };
}

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
