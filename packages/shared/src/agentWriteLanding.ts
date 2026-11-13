/**
 * Where a gated agent write's result lands — the chat message, lifecycle line,
 * or inbox / Activity entry others see — which is the conversation its
 * freshness check reads (#wg-task-v2:98488173): before an agent does something
 * others will see in a conversation, it must have seen what is new there.
 *
 * One table for both sides: the Computer attests what the model has seen of
 * the landing ({@link agentWriteLandingTarget}) and names it in `seenFor`; the
 * Server resolves the same landing and checks only a boundary attested for it.
 */
import { formatAgentTaskRef } from "./agentText/taskRef";
import { agentTaskThreadTarget } from "./agentText/tasks";

export type AgentWriteLanding =
  /** The conversation the write names (`target`): a message send. */
  | "target"
  /** The task's own conversation, `#channel:#N`. */
  | "task_conversation"
  /** The thread of the message a task is created from, `#channel:<message short id>`. */
  | "source_thread";

export const AGENT_WRITE_LANDINGS = ["target", "task_conversation", "source_thread"] as const satisfies readonly AgentWriteLanding[];

type GatedWrite = {
  /** Agent API path under `/internal/agent-api`; the method is POST. */
  path: string;
  landing: AgentWriteLanding;
  /**
   * What the Server does when the landing has messages the model has not
   * seen: `hold` the write (the agent reads them and reruns it), or apply it
   * and `attach` them to its response. Holding costs the agent a whole extra
   * turn, so only a write that takes work or decides for someone else holds;
   * a task's state stays consistent through its own checks (claim conflict,
   * revision) either way (#wg-task-v2:98488173). A task create has no such
   * check: a message may have any number of tasks, and the hold (showing the
   * agent someone else's 📌 line or "on it" first) is all that keeps two from
   * taking the same work; two creates in the same second may both land
   * (#wg-task-v2:458f336e).
   */
  onUnseen: "hold" | "attach";
  /**
   * Which messages count as unseen: `all`, or only `chat` messages (people's
   * and agents' words), not system lines: a task conversation's lifecycle
   * lines restate the task's state, which the write's own checks cover.
   */
  counts: "all" | "chat";
  /** The held write as the agent reads it in its activity. */
  heldTitle: string;
};

export const AGENT_GATED_WRITES = {
  send: { path: "/send", landing: "target", onUnseen: "hold", counts: "all", heldTitle: "Send held by freshness check" },
  // The source thread is where someone else's "on it" and the "created #N
  // from this message" line land: both mean the work may already be taken.
  task_create: { path: "/tasks", landing: "source_thread", onUnseen: "hold", counts: "all", heldTitle: "Task create held by freshness check" },
  task_claim: { path: "/tasks/claim", landing: "task_conversation", onUnseen: "hold", counts: "chat", heldTitle: "Task claim held by freshness check" },
  task_assign: { path: "/tasks/assign", landing: "task_conversation", onUnseen: "hold", counts: "chat", heldTitle: "Task assignment held by freshness check" },
  task_unclaim: { path: "/tasks/unclaim", landing: "task_conversation", onUnseen: "attach", counts: "chat", heldTitle: "Task release held by freshness check" },
  task_update: { path: "/tasks/update-status", landing: "task_conversation", onUnseen: "attach", counts: "chat", heldTitle: "Task update held by freshness check" },
  task_amend: { path: "/tasks/amend", landing: "task_conversation", onUnseen: "attach", counts: "chat", heldTitle: "Task amendment held by freshness check" },
} as const satisfies Record<string, GatedWrite>;

export type AgentGatedWriteAction = keyof typeof AGENT_GATED_WRITES;
export type AgentGatedTaskWriteAction = Exclude<AgentGatedWriteAction, "send">;

const ACTION_BY_PATH = new Map<string, AgentGatedWriteAction>(
  (Object.entries(AGENT_GATED_WRITES) as [AgentGatedWriteAction, GatedWrite][])
    .map(([action, write]) => [`/internal/agent-api${write.path}`, action]),
);

/** The gated write a POST to this path is, if any. */
export function agentGatedWriteForPath(pathname: string): AgentGatedWriteAction | undefined {
  return ACTION_BY_PATH.get(pathname);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The one task a task write names (`task_number`, or a lone `task_numbers` entry). */
export function agentWriteTaskNumber(body: Record<string, unknown>): number | undefined {
  if (typeof body.task_number === "number") return body.task_number;
  const numbers = Array.isArray(body.task_numbers) ? body.task_numbers : [];
  const messages = Array.isArray(body.message_ids) ? body.message_ids : [];
  return numbers.length === 1 && messages.length === 0 && typeof numbers[0] === "number" ? numbers[0] : undefined;
}

/** The one message a create hangs its tasks under (`tasks[].source_message_id`). */
export function agentWriteSourceMessageId(body: Record<string, unknown>): string | undefined {
  const ids = new Set((Array.isArray(body.tasks) ? body.tasks : [])
    .map((task) => nonEmpty(task && typeof task === "object" ? (task as { source_message_id?: unknown }).source_message_id : undefined))
    .filter((id): id is string => id !== undefined));
  return ids.size === 1 ? [...ids][0] : undefined;
}

/**
 * The conversation, as an agent target, where this write's result lands.
 * Undefined when it lands in no single conversation (several tasks, a create
 * without a source message): such a write attests nothing and is not checked.
 */
export function agentWriteLandingTarget(action: AgentGatedWriteAction, body: Record<string, unknown>): string | undefined {
  const landing: AgentWriteLanding = AGENT_GATED_WRITES[action].landing;
  if (landing === "target") return nonEmpty(body.target);
  const channel = nonEmpty(body.channel);
  if (!channel) return undefined;
  if (landing === "source_thread") {
    const source = agentWriteSourceMessageId(body);
    return source ? agentTaskThreadTarget(channel, source) : undefined;
  }
  const taskNumber = agentWriteTaskNumber(body);
  return taskNumber === undefined ? undefined : (formatAgentTaskRef(channel, taskNumber) ?? undefined);
}

/** A task write's identity: the action and what it changes, so a hold covers only its own rerun. */
export function agentTaskWriteKey(action: AgentGatedTaskWriteAction, body: Record<string, unknown>): string {
  if (action === "task_create") return `task_create:${agentWriteSourceMessageId(body) ?? ""}`;
  if (action === "task_update") return `task_update:${String(body.task_number)}:${String(body.status)}`;
  if (action === "task_assign") return `task_assign:${String(body.task_number)}:${String(body.assignee)}`;
  return `${action}:${String(agentWriteTaskNumber(body))}`;
}
