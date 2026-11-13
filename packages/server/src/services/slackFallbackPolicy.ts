import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { externalMessageAuthorFacts } from "../db/schema";

export const SLACK_REPEAT_FALLBACK_WAIT_MS = 10 * 60_000;
export const SLACK_FIRST_FALLBACK_WAIT_MS = 24 * 60 * 60_000;

/** A short wait is allowed only when this exact verified Slack identity has an
 * earlier durable fallback author fact. It confers no membership or authority. */
export async function hasSlackFallbackAuthor(executor: DatabaseExecutor, scope: {
  projectionId: string; registrationId: string; installId: string; workspaceId: string; externalActorId: string;
}): Promise<boolean> {
  const [fact] = await executor.select({ id: externalMessageAuthorFacts.messageId }).from(externalMessageAuthorFacts).where(and(
    eq(externalMessageAuthorFacts.projectionId, scope.projectionId), eq(externalMessageAuthorFacts.provider, "slack"),
    eq(externalMessageAuthorFacts.appRegistrationId, scope.registrationId), eq(externalMessageAuthorFacts.installId, scope.installId),
    eq(externalMessageAuthorFacts.workspaceId, scope.workspaceId), eq(externalMessageAuthorFacts.externalActorId, scope.externalActorId),
    eq(externalMessageAuthorFacts.profileFallback, "unresolved"), eq(externalMessageAuthorFacts.actorKind, "unknown"),
  )).limit(1);
  return Boolean(fact);
}

export async function slackFallbackWaitElapsed(executor: DatabaseExecutor, scope: {
  projectionId: string; registrationId: string; installId: string; workspaceId: string; externalActorId: string;
}, receivedAt: Date, at: Date): Promise<boolean> {
  const elapsed = at.getTime() - receivedAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return false;
  return elapsed >= SLACK_FIRST_FALLBACK_WAIT_MS
    || (elapsed >= SLACK_REPEAT_FALLBACK_WAIT_MS && await hasSlackFallbackAuthor(executor, scope));
}
