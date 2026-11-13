// Task v2: the agent-facing address of a task, `#channel:#7` (a task in a DM:
// `dm:@peer:#7`). A task with its own conversation is replied to, read,
// viewed and followed through `raft task reply|read|view|follow|unfollow
// <ref>`; it is never a `raft message send/read` target.
//
// Refs are only ever produced by `formatRaftChannelTaskRef` /
// `formatRaftDmTaskRef` and parsed by `parseRaftRefTarget` (raftRefs.ts), so
// the separator lives in one place.

import { formatHint, RAFT_HINTS } from "../agentOps/hint";
import { formatRaftChannelTaskRef, formatRaftDmTaskRef, parseRaftRefTarget } from "../raftRefs";

/** Same as raftCliGuide MESSAGE_HEREDOC_DELIMITER (kept local so this module stays bundle-light). */
const TASK_REPLY_HEREDOC_DELIMITER = "RAFTMSG";

/** Error code of `raft message send/read` given a task conversation target. */
export const TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE = "task_target_use_task_command";

function canonicalConversationTarget(target: string): string {
  return target.trim().replace(/^dm:user:/i, "dm:@");
}

/**
 * The task ref of task `taskNumber` on the board of conversation `target`
 * (`#channel`, `dm:@peer`, legacy `dm:user:peer`): `#channel:#7`,
 * `dm:@peer:#7`. Null when `target` names neither a channel nor a DM.
 */
export function formatAgentTaskRef(target: string, taskNumber: number): string | null {
  const canonical = canonicalConversationTarget(target);
  const parsed = parseRaftRefTarget(canonical);
  if (parsed?.kind === "channel") return formatRaftChannelTaskRef(parsed.channelName, taskNumber);
  if (parsed?.kind === "dm") return formatRaftDmTaskRef(parsed.peerName, taskNumber);
  // A name outside the ref grammar still gets a ref in the same shape.
  if (/^#[^\s:]+$/u.test(canonical)) return formatRaftChannelTaskRef(canonical.slice(1), taskNumber);
  if (/^dm:@[^\s:]+$/iu.test(canonical)) return formatRaftDmTaskRef(canonical.slice(4), taskNumber);
  return null;
}

/**
 * The tail of a task ref after its board and `:` (`#7` in `#proj:#7`): what a
 * task conversation is called in an agent delivery's `channel_name` (and in a
 * pre-task-v2 client's `messageId` slot). Daemons and CLIs from before task
 * v2 render a thread as `#${parent}:${channel_name}` (`dm:@peer:…`) and a
 * task's discussion as `${board}:${messageId.slice(0, 8)}`, so this tail makes
 * them print — and send to — the task ref itself.
 */
export function formatAgentTaskRefTail(taskNumber: number): string {
  const ref = formatRaftChannelTaskRef("x", taskNumber);
  return ref.startsWith("#x:") ? ref.slice("#x:".length) : ref.slice("#x".length);
}

export interface ParsedAgentTaskRef {
  /** The canonical ref, `#channel:#7` / `dm:@peer:#7`. */
  ref: string;
  /** The board's conversation target, `#channel` / `dm:@peer`. */
  target: string;
  taskNumber: number;
}

/**
 * Parse `#channel:#7` / `dm:@peer:#7`. The legacy `task #7` (no conversation)
 * is not an address and returns null.
 */
export function parseAgentTaskRef(raw: string): ParsedAgentTaskRef | null {
  const parsed = parseRaftRefTarget(raw.trim());
  if (parsed?.kind !== "task") return null;
  if (parsed.channelName !== undefined) {
    return { ref: formatRaftChannelTaskRef(parsed.channelName, parsed.taskNumber), target: `#${parsed.channelName}`, taskNumber: parsed.taskNumber };
  }
  if (parsed.peerName !== undefined) {
    return { ref: formatRaftDmTaskRef(parsed.peerName, parsed.taskNumber), target: `dm:@${parsed.peerName}`, taskNumber: parsed.taskNumber };
  }
  return null;
}

/**
 * The additive `taskCommandHint` a message send / history read answer carries
 * when it reached a task conversation through its ref (a client from before
 * task v2 prints the rest and ignores this; newer CLIs refuse task refs and
 * name the command themselves).
 */
export function formatAgentTaskCommandHint(ref: string, action: "send" | "read"): string {
  return action === "send"
    ? `${ref} is a task conversation: reply with ${formatHint(RAFT_HINTS.taskReply(ref))} (body on stdin).`
    : `${ref} is a task conversation: read it with ${formatHint(RAFT_HINTS.taskRead({ ref }))}.`;
}

/**
 * The refusal text of `raft message send` / `raft message read` given a task
 * conversation (`ref`). It names the exact task command; the whole text
 * travels in the API `error` field so a CLI that predates it prints it as is.
 */
export function formatTaskTargetUseTaskCommand(input: { ref: string; action: "send" | "read" }): string {
  if (input.action === "send") {
    return [
      `${input.ref} is a task conversation, not a message target. Nothing was sent.`,
      "Reply to the task instead (the body is read from stdin):",
      `  ${formatHint(RAFT_HINTS.taskReply(input.ref))} <<'${TASK_REPLY_HEREDOC_DELIMITER}'`,
      "  reply body",
      `  ${TASK_REPLY_HEREDOC_DELIMITER}`,
    ].join("\n");
  }
  return [
    `${input.ref} is a task conversation, not a message target.`,
    "Read the task's discussion instead (same --after/--before/--around/--limit flags):",
    `  ${formatHint(RAFT_HINTS.taskRead({ ref: input.ref }))}`,
  ].join("\n");
}
