import {
  runtimeAccountUsageSnapshotForClient,
  withoutHiddenAccountAgentIds,
  type RuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";
import { and, inArray, sql } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import { agents } from "../db/schema";
import { agentFindableBy } from "./agentMemberListPolicy";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A usage snapshot as one person may read it (every server->web usage
 * answer: the read, a manual refresh, a limit reset's answer). An account
 * read from an agent's own folder lists that agent (`agentIds`); a personal
 * assistant is found only by its owner (agentFindableBy), so its id is
 * removed for anyone else, and an account left listing no one is dropped
 * (`withoutHiddenAccountAgentIds`). That happens before the client shaping
 * (`runtimeAccountUsageSnapshotForClient`), so an older bundle, which gets
 * no `agentIds`, never sees such an account either.
 */
export async function runtimeAccountUsageSnapshotForViewer(
  snapshot: RuntimeAccountUsageSnapshot,
  capabilitiesHeader: unknown,
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<RuntimeAccountUsageSnapshot> {
  // Ids that are not uuids name no agent row (and would fail the uuid column's cast).
  const listed = [...new Set(snapshot.accounts.flatMap((account) => account.agentIds ?? []))].filter((id) => UUID_RE.test(id));
  const hidden = new Set<string>(listed.length === 0 ? [] : (await executor
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, listed), sql`not ${agentFindableBy({ userId })}`)))
    .map((row) => row.id));
  return runtimeAccountUsageSnapshotForClient(withoutHiddenAccountAgentIds(snapshot, hidden), capabilitiesHeader);
}
