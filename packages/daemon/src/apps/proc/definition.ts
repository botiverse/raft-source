/**
 * `system.proc`: the Inbox notices that one of the agent's `raft proc` jobs
 * was ended for it: the Computer stopped it at its memory cap
 * (#proj-raft-computer:#114, class `memory_limit`), or a person stopped it
 * from the Computer page (class `owner_stop`, docs/contracts/proc-jobs.md).
 *
 * One item per job name (`app:system.proc/...`): a job stopped again later
 * updates the same item instead of adding one. The item is minted here, on the
 * Computer, and is transient: a daemon restart drops it, and `raft proc list`
 * still shows how the job ended. The action is `raft proc logs <name>`, built
 * only from a valid job name.
 */

import {
  AGENT_INBOX_PREVIEW_MAX_CHARS,
  formatProcMemoryLimitExit,
  formatProcOwnerStopExit,
  isValidProcName,
  type AgentInboxAppItem,
} from "@botiverse/raft-shared";
import type {
  AgentAppInboxNoticeOptions,
  AgentAppInboxStore,
  AgentAppNotificationClassDefinition,
} from "../../agentAppInbox";

export const PROC_APP_ID = "system.proc" as const;
export const PROC_MEMORY_LIMIT_NOTIFICATION_CLASS = "memory_limit" as const;
export const PROC_OWNER_STOP_NOTIFICATION_CLASS = "owner_stop" as const;
const PROC_JOB_SOURCE_KIND = "proc_job";

/** Both classes: transient, one item per job name, the action reads the job's last output. */
const procJobClass: AgentAppNotificationClassDefinition = {
  retention: "transient",
  primaryAction: { kind: "run_command", commandId: "proc.logs" },
  normalizeSourceRef: (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, message: "proc sourceRef must be an object" };
    const cand = raw as Record<string, unknown>;
    for (const key of Object.keys(cand)) {
      if (key !== "kind" && key !== "id") return { ok: false, message: `proc sourceRef rejects field: ${key}` };
    }
    if (cand.kind !== PROC_JOB_SOURCE_KIND) return { ok: false, message: `proc sourceRef kind must be ${PROC_JOB_SOURCE_KIND}` };
    if (!isValidProcName(cand.id)) return { ok: false, message: "proc sourceRef.id must be a job name" };
    return { ok: true, ref: { kind: PROC_JOB_SOURCE_KIND, id: cand.id } };
  },
  materializeActionCli: ({ sourceRef }) => (isValidProcName(sourceRef.id) ? `raft proc logs ${sourceRef.id}` : null),
};

/** Injected registry fragment (registry.manifest.ts). */
export const PROC_AGENT_INBOX_REGISTRY = {
  [PROC_APP_ID]: {
    [PROC_MEMORY_LIMIT_NOTIFICATION_CLASS]: procJobClass,
    [PROC_OWNER_STOP_NOTIFICATION_CLASS]: procJobClass,
  },
} as const;

/**
 * The notice: what happened, in the words `raft proc list` uses, and what the
 * agent can do; its action reads the job's last output. Title and summary
 * each fit the Inbox preview bound (AGENT_INBOX_PREVIEW_MAX_CHARS, 120).
 */
export function procMemoryLimitNotice(name: string, memoryMaxBytes: number): { title: string; summary: string } {
  return {
    title: `${name} ${formatProcMemoryLimitExit(memoryMaxBytes)}; it is not restarted`,
    summary: "Over the memory cap per job on this Computer. To run it again: lower its memory use, or ask the owner to raise the cap.",
  };
}

/**
 * Mint (or update) the job's item and let the agent notice it: never starts a
 * stopped agent and never interrupts a turn; it is read at the next idle drain
 * or the next wake. False when the item could not be minted.
 */
export async function notifyProcMemoryLimit(
  deps: {
    getInbox(agentId: string): AgentAppInboxStore;
    notifyInbox(agentId: string, item: AgentInboxAppItem, notice?: AgentAppInboxNoticeOptions): Promise<boolean>;
  },
  input: { agentId: string; name: string; memoryMaxBytes: number },
): Promise<boolean> {
  const minted = deps.getInbox(input.agentId).mint({
    appId: PROC_APP_ID,
    notificationClass: PROC_MEMORY_LIMIT_NOTIFICATION_CLASS,
    sourceRef: { kind: PROC_JOB_SOURCE_KIND, id: input.name },
    ...procMemoryLimitNotice(input.name, input.memoryMaxBytes),
  });
  if (!minted.ok) return false;
  await deps.notifyInbox(input.agentId, minted.item, { startStoppedAgent: false, requireIdle: true });
  return true;
}

const OWNER_STOP_TITLE_TAIL = " from the Computer page";

/**
 * A person stopped the job from the Computer page: who (the words `raft proc
 * list` uses) and that it stays stopped until the agent has asked them. The
 * title fits the preview bound (AGENT_INBOX_PREVIEW_MAX_CHARS) for the longest
 * name and handle: the job name is shortened (`…`), never the stopper.
 */
export function procOwnerStopNotice(name: string, stoppedBy: string | null): { title: string; summary: string } {
  const rest = ` ${formatProcOwnerStopExit(stoppedBy)}${OWNER_STOP_TITLE_TAIL}`;
  const room = AGENT_INBOX_PREVIEW_MAX_CHARS - rest.length;
  const shown = name.length <= room ? name : `${name.slice(0, Math.max(1, room - 1))}…`;
  return {
    title: `${shown}${rest}`,
    // Names whom to ask when known: the agent's next step, without going back to the title.
    summary: stoppedBy
      ? `It is not restarted. Ask @${stoppedBy} before you start it again.`
      : "A person stopped it; it is not restarted. Ask them before you start it again.",
  };
}

/** Mint (or update) the job's owner-stop item, noticed as the memory one is. False when it could not be minted. */
export async function notifyProcOwnerStop(
  deps: {
    getInbox(agentId: string): AgentAppInboxStore;
    notifyInbox(agentId: string, item: AgentInboxAppItem, notice?: AgentAppInboxNoticeOptions): Promise<boolean>;
  },
  input: { agentId: string; name: string; stoppedBy: string | null },
): Promise<boolean> {
  const minted = deps.getInbox(input.agentId).mint({
    appId: PROC_APP_ID,
    notificationClass: PROC_OWNER_STOP_NOTIFICATION_CLASS,
    sourceRef: { kind: PROC_JOB_SOURCE_KIND, id: input.name },
    ...procOwnerStopNotice(input.name, input.stoppedBy),
  });
  if (!minted.ok) return false;
  await deps.notifyInbox(input.agentId, minted.item, { startStoppedAgent: false, requireIdle: true });
  return true;
}
