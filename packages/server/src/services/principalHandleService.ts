import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { agents } from "../db/schema";

export class PrincipalHandleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrincipalHandleConflictError";
  }
}

function serverIdToLockKey(serverId: string): number {
  const hex = serverId.replace(/-/g, "").slice(0, 8);
  return parseInt(hex, 16) | 0;
}

export async function lockServerPrincipalHandles(db: DatabaseExecutor, serverId: string) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(${serverIdToLockKey(serverId)}, 1)`);
}

export async function assertAgentHandleAvailableInServer(
  db: DatabaseExecutor,
  serverId: string,
  handle: string,
) {
  const [existingAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.name, handle), isNull(agents.deletedAt)));
  if (existingAgent) {
    throw new PrincipalHandleConflictError(`Agent name "${handle}" is already taken`);
  }
}

/**
 * Personal assistants' handles (`<owner>-assistant`, `-2`…, assistantService
 * assistantHandleCandidates) are reserved: no other agent may take one. Agent
 * handles are unique per server, so without this a create that hit another
 * person's assistant would answer "already taken" and reveal that they have
 * one, though nobody else may find it (agentFindableBy). The refusal depends
 * on the name alone, never on whether such an assistant exists.
 */
const ASSISTANT_HANDLE_RE = /-assistant(-[0-9]+)?$/i;

export const ASSISTANT_RESERVED_HANDLE_CODE = "agent_name_reserved_for_assistants";

export class AssistantReservedHandleError extends Error {
  readonly code = ASSISTANT_RESERVED_HANDLE_CODE;
  constructor(handle: string) {
    super(`Agent name @${handle} is reserved: names ending in "-assistant" belong to personal assistants. Choose another name.`);
    this.name = "AssistantReservedHandleError";
  }
}

export function isAssistantReservedAgentHandle(handle: string): boolean {
  return ASSISTANT_HANDLE_RE.test(handle.trim().replace(/^@/, ""));
}

export function isPrincipalHandleConflictError(err: unknown) {
  return err instanceof PrincipalHandleConflictError;
}
