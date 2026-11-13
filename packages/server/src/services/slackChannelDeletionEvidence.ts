import { and, asc, desc, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { slackChannelDeletions } from "../db/schema";

export type SlackChannelDeletionEvidence = typeof slackChannelDeletions.$inferSelect;
export type SlackChannelDeletionScope = Pick<SlackChannelDeletionEvidence,
  "registrationId" | "environment" | "providerAppId" | "providerAuthorityId" | "providerConversationId">;
/** Both directions use the same recorded fact, retaining its original provenance. */
export async function loadSlackChannelDeletionEvidence(executor: DatabaseExecutor, scope: SlackChannelDeletionScope): Promise<SlackChannelDeletionEvidence | null> {
  const [fact] = await executor.select().from(slackChannelDeletions).where(and(
    eq(slackChannelDeletions.registrationId, scope.registrationId), eq(slackChannelDeletions.environment, scope.environment),
    eq(slackChannelDeletions.providerAppId, scope.providerAppId), eq(slackChannelDeletions.providerAuthorityId, scope.providerAuthorityId),
    eq(slackChannelDeletions.providerConversationId, scope.providerConversationId),
  )).orderBy(desc(eq(slackChannelDeletions.sourceKind, "signed_event")), asc(slackChannelDeletions.observedAt), asc(slackChannelDeletions.id)).limit(1);
  return fact ?? null;
}
