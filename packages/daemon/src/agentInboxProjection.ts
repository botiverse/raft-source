// Moved to @botiverse/raft-shared (agentInboxProjection.ts) so the server's
// External Agent inbox notice push renders the same rows; re-exported here for
// the daemon's existing imports.
export {
  AGENT_INBOX_TARGET_ROW_KEYS,
  formatAgentReplyAffordanceSuffix,
  formatAgentInboxDelta,
  formatAgentInboxSnapshot,
  projectAgentInboxLatestPreviews,
  projectAgentInboxSnapshot,
  projectAgentInboxSnapshotWithoutAppItems,
  projectAgentInboxWholePreviewMessages,
  type AgentInboxFlag,
  type AgentInboxProjectionMessage,
  type AgentInboxTargetRow,
  type SuppressedByTarget,
} from "@botiverse/raft-shared";
