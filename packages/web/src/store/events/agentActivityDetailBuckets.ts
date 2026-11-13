import type { AgentActivityDetailKind } from "@botiverse/raft-shared";

export type AgentActivityDetailBucket =
  | "none"
  | "command"
  | "compaction"
  | "runtime"
  | "lifecycle"
  | "message"
  | "review"
  | "external"
  | "generic";

export const ACTIVITY_DETAIL_BUCKET_BY_KIND = {
  none: "none",
  message_received: "message",
  freshness_hold: "lifecycle",
  starting: "lifecycle",
  runtime_starting: "runtime",
  idle: "none",
  running_command: "command",
  checking_messages: "command",
  compacting_context: "compaction",
  compaction_finished: "compaction",
  compaction_stale: "compaction",
  reviewing_changes: "review",
  review_finished: "review",
  review_stale: "review",
  runtime_reconnecting: "runtime",
  runtime_error: "runtime",
  runtime_crashed: "runtime",
  claude_root_privileges: "runtime",
  runtime_unavailable: "runtime",
  runtime_stalled: "runtime",
  stalled_recovery: "lifecycle",
  stopped: "lifecycle",
  computer_started: "lifecycle",
  computer_restarted: "lifecycle",
  computer_upgraded: "lifecycle",
  computer_operation_failed: "lifecycle",
  ready: "lifecycle",
  runtime_interrupted: "runtime",
  machine_disconnected: "generic",
  daemon_activity: "external",
  external_activity: "external",
  synthetic_repair: "lifecycle",
  slock_action: "message",
  system_message: "message",
  runtime_progress: "runtime",
  delivery_unconsumed: "runtime",
  wake_crash_loop_blocked: "lifecycle",
  terminal_failure_paused: "lifecycle",
  model_request_started: "runtime",
  provider_request_status: "runtime",
  model_response_started: "runtime",
  tool_started: "command",
  tool_end: "command",
  thinking_started: "runtime",
  thinking_end: "runtime",
  subagent_activity: "external",
  other: "generic",
} as const satisfies Record<AgentActivityDetailKind, AgentActivityDetailBucket>;

