import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index.js";
import { agents } from "../db/schema.js";

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

export function isPrincipalHandleConflictError(err: unknown) {
  return err instanceof PrincipalHandleConflictError;
}
