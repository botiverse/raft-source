import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceAttributes } from "@botiverse/raft-shared";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { transientTransactionSqlState } from "./transientTransactionRetry";

/**
 * Lock order of one transaction attempt, written to the current span only when
 * the attempt ends in 40P01 or runs longer than 1 s. Neon's log export carries
 * no deadlock DETAIL (#proj-o11y:058cb07b), so the killed side reports its own
 * order here, and the other side, which waited at least deadlock_timeout, shows
 * up as a slow transaction in the same second on the same server_id.
 *
 * Foreign-key FOR KEY SHARE locks are implicit and not recorded. Parameters are
 * only compared with `rowRoles`; no literal value or id reaches the event.
 */
const SLOW_TRANSACTION_MS = 1_000;
const MAX_STEPS = 100;

interface LockOrderStep {
  seq: number;
  ms: number;
  wait_ms?: number;
  table: string;
  lock: string;
  role?: string;
  sql_hash: string;
  sqlstate?: string;
}

interface LockOrderRecording {
  startMs: number;
  nextSeq: number;
  roleById: Map<string, string>;
  steps: LockOrderStep[];
}

const recordingStore = new AsyncLocalStorage<LockOrderRecording>();

/** Which business row each id is. An id holding several roles reports them joined with "+". */
function roleByIdFrom(rowRoles: Record<string, string | null | undefined>): Map<string, string> {
  const roleById = new Map<string, string>();
  for (const [role, id] of Object.entries(rowRoles)) {
    if (!id) continue;
    const existing = roleById.get(id);
    roleById.set(id, existing ? `${existing}+${role}` : role);
  }
  return roleById;
}

function classifyLock(text: string): { table: string; lock: string } | null {
  if (/\bpg_(?:try_)?advisory(?:_xact)?_lock/i.test(text)) {
    return { table: "-", lock: /_lock_shared/i.test(text) ? "ADVISORY SHARE" : "ADVISORY" };
  }
  const rowLock = /\bfor\s+(no\s+key\s+update|key\s+share|update|share)\b/i.exec(text);
  if (rowLock) {
    const table = /\bfrom\s+"?(\w+)"?/i.exec(text)?.[1] ?? "unknown";
    return { table, lock: `FOR ${rowLock[1]!.replace(/\s+/g, " ").toUpperCase()}` };
  }
  const upsert = /\binsert\s+into\s+"?(\w+)"?[\s\S]*\bon\s+conflict\b[\s\S]*\bdo\s+update\b/i.exec(text);
  if (upsert) return { table: upsert[1]!, lock: "UPSERT" };
  const update = /\bupdate\s+"?(\w+)"?\s+(?:as\s+\w+\s+)?set\b/i.exec(text);
  if (update) return { table: update[1]!, lock: "UPDATE" };
  const deleted = /\bdelete\s+from\s+"?(\w+)"?/i.exec(text);
  if (deleted) return { table: deleted[1]!, lock: "DELETE" };
  return null;
}

function roleOf(values: unknown, roleById: Map<string, string>): string | undefined {
  if (!Array.isArray(values)) return undefined;
  const roles = new Set<string>();
  for (const value of values) {
    const role = typeof value === "string" ? roleById.get(value) : undefined;
    if (role) roles.add(role);
  }
  return roles.size > 0 ? [...roles].join(",") : undefined;
}

/**
 * Called by the instrumented client for every statement. Returns the callback
 * that closes the step, or undefined when nothing is being recorded or the
 * statement takes no recorded lock.
 */
export function beginLockOrderStep(
  text: string | undefined,
  values: unknown,
  hashOf: () => string,
): ((err?: unknown) => void) | undefined {
  const recording = recordingStore.getStore();
  if (!recording || !text) return undefined;
  const now = Date.now();
  if (/^\s*begin\b/i.test(text)) {
    recording.startMs = now;
    return undefined;
  }
  const classified = classifyLock(text);
  if (!classified) return undefined;
  const seq = recording.nextSeq;
  recording.nextSeq += 1;
  if (recording.steps.length >= MAX_STEPS) return undefined;
  const role = roleOf(values, recording.roleById);
  const step: LockOrderStep = {
    seq,
    ms: now - recording.startMs,
    ...classified,
    ...(role ? { role } : {}),
    sql_hash: hashOf(),
  };
  recording.steps.push(step);
  return (err) => {
    step.wait_ms = Date.now() - now;
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "string") step.sqlstate = code;
  };
}

/** Wrap one attempt: inside withTransientTransactionRetry, so each attempt reports its own order. */
export async function withLockOrderRecording<T>(
  input: { transaction: string; serverId?: string | null; rowRoles: Record<string, string | null | undefined> },
  work: () => Promise<T>,
): Promise<T> {
  const recording: LockOrderRecording = {
    startMs: Date.now(),
    nextSeq: 1,
    roleById: roleByIdFrom(input.rowRoles),
    steps: [],
  };
  const emit = (trigger: "deadlock" | "slow") => {
    const attrs: TraceAttributes = {
      event_kind: "db_lock_order",
      transaction: input.transaction,
      trigger,
      duration_ms: Date.now() - recording.startMs,
      step_count: recording.nextSeq - 1,
      steps: JSON.stringify(recording.steps),
      ...(input.serverId ? { server_id: input.serverId } : {}),
    };
    recordTraceEvent("db.lock_order", attrs);
  };
  let result: T;
  try {
    result = await recordingStore.run(recording, work);
  } catch (error) {
    if (transientTransactionSqlState(error) === "40P01") emit("deadlock");
    else if (Date.now() - recording.startMs > SLOW_TRANSACTION_MS) emit("slow");
    throw error;
  }
  if (Date.now() - recording.startMs > SLOW_TRANSACTION_MS) emit("slow");
  return result;
}
