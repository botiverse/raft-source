import type { StoredActionCardAction } from "@botiverse/raft-shared";
import { useAgentStore } from "../../store/agentStore";
import { McpConnectCardBody } from "./McpConnectCardBody";

/**
 * The connect card's connection picker (McpConnectCardBody, D1–D5) as the
 * spec frame mounts it under the spec body, whose spec has no button for it
 * (ActionCardSpecCard). The card stores ids only, so the Agent is named from
 * the viewer's store: its display name, else its name when that is empty, as
 * the spec frame's done line names it. `onGranted` is
 * useMarkActionCardExecuted's `mcpConnectionGranted` (actionCardIntentFlows).
 */
export function McpConnectCardSlot({ messageId, action, onGranted }: {
  messageId: string;
  action: Extract<StoredActionCardAction, { type: "integration:connect_mcp" }>;
  onGranted: () => Promise<void>;
}) {
  const agent = useAgentStore((state) => state.agents.find((candidate) => candidate.id === action.agentId) ?? null);
  return (
    <McpConnectCardBody
      appId={action.mcpServerId}
      agentId={action.agentId}
      agentName={agent?.displayName || agent?.name || action.agentId.slice(0, 8)}
      actionCardMessageId={messageId}
      onGranted={onGranted}
    />
  );
}
