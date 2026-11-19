// An agent's app notices consumed by its acting on their object through the
// app (consumed_via `acted`, platform/activity). Its own module, importing no
// app: the apps reach it through platform/activity, and firstPartyAppHost
// imports every app's registration.
import { and, eq, gt, isNull, or, type SQL } from "drizzle-orm";
import { type DatabaseExecutor } from "../db/index";
import { thirdPartyAgentEvents, type SystemAppKey } from "../db/schema";
import { markAgentProgress } from "./agentProgressMarks";

/**
 * RFC 081 §5, `acted`: the agent dealt with one of an app's objects through
 * the app itself (an Artifact it read through or commented on), which is what
 * the app's notices about that object asked of it. Its unread notices about
 * the object are consumed as `raft inbox read` would consume them (`delivered`,
 * consumed_via `acted`), so they leave its inbox and no re-delivery sends them
 * again (#raft-antiproton:#16: handled Artifact comment notices expired as
 * `delivering`, and a restart re-send would have repeated them).
 *
 * One statement: `onlyIf`, the app's own condition (the agent has now seen
 * everything in the object), is read in the same snapshot as the notices, so
 * a notice queued by a commit that also made the condition false is either
 * not seen at all or seen with the condition false: never taken unread.
 * Inside `executor`'s transaction; idempotent. Returns the ids it moved.
 */
export async function consumeAgentObjectNotices(executor: DatabaseExecutor, input: {
  systemApp: SystemAppKey;
  agentId: string;
  objectRef: string;
  now: Date;
  onlyIf?: SQL;
}): Promise<string[]> {
  const t = thirdPartyAgentEvents;
  const moved = await executor.update(t)
    .set({ status: "delivered", deliveredAt: input.now, updatedAt: input.now, consumedVia: "acted" })
    .where(and(
      eq(t.agentId, input.agentId),
      isNull(t.clientId),
      eq(t.systemApp, input.systemApp),
      eq(t.objectRef, input.objectRef),
      or(eq(t.status, "queued"), eq(t.status, "delivering")),
      gt(t.expiresAt, input.now),
      input.onlyIf,
    ))
    .returning({ id: t.id });
  // #proj-runtime:#62: consuming an app event is the agent moving forward (as consumeThirdPartyAgentEvents).
  if (moved.length > 0) markAgentProgress(input.agentId);
  return moved.map((row) => row.id);
}
