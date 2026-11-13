// Tells the person who started a migration that their agent retried it
// (POST /internal/agent-api/migrations/retry runs on their behalf), and when
// that retry failed too. The same channel that tells them a hosted migration
// waits for their review (hostedAgentMigrationImporter
// notifyHostedMigrationReviewReady): one `system_notice` outbox row, so every
// device, their server level, quiet hours and preview setting apply. The
// text is plain English with no localization key yet: a key needs the web and
// mobile catalogs (follow-up with the web PR).
import { currentDate } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents } from "../db/schema";
import type { AgentMigrationRow } from "./agentMigrationService";
import { enqueueNotificationRows } from "./notifications/enqueue";
import type { NotificationNoticePayload } from "./notifications/envelope";

export type AgentMigrationRetryNoticeKind = "started" | "failed";

export function agentMigrationRetryNoticeText(kind: AgentMigrationRetryNoticeKind, input: {
  agentName: string;
  targetMachineName: string;
}): { title: string; body: string } {
  if (kind === "started") {
    return {
      title: `${input.agentName} is retrying its move to ${input.targetMachineName}`,
      body: `${input.agentName} trimmed its workspace and started the migration again on your behalf (its one retry).`,
    };
  }
  return {
    title: `${input.agentName}'s retried move to ${input.targetMachineName} failed`,
    body: `The migration ${input.agentName} retried did not complete. It can't retry again; start the next migration yourself.`,
  };
}

/**
 * Enqueue the notice for `retry` (a migration with retry_of_migration_id), in
 * `executor`'s transaction when given. Nothing for a migration a person
 * started, or whose starter is gone. Deduped per migration and kind.
 */
export async function notifyStarterOfAgentMigrationRetry(
  retry: Pick<AgentMigrationRow, "id" | "agentId" | "serverId" | "initiatedByUserId" | "retryOfMigrationId" | "targetMachineNameSnapshot">,
  kind: AgentMigrationRetryNoticeKind,
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  if (!retry.retryOfMigrationId || !retry.initiatedByUserId) return;
  const [row] = await executor.select({ agentName: agents.name, displayName: agents.displayName })
    .from(agents)
    .where(eq(agents.id, retry.agentId))
    .limit(1);
  if (!row) return;
  const name = row.displayName?.trim() || row.agentName;
  const text = agentMigrationRetryNoticeText(kind, {
    agentName: name,
    targetMachineName: retry.targetMachineNameSnapshot ?? "another computer",
  });
  const payload: NotificationNoticePayload = {
    title: text.title,
    body: text.body,
    kind: "agent",
    event: "system_notice",
    route: { type: "agent", serverId: retry.serverId, agentId: retry.agentId },
    agent: { id: retry.agentId, name },
  };
  await enqueueNotificationRows([{
    receiverId: retry.initiatedByUserId,
    serverId: retry.serverId,
    kind: null,
    sourceChannelId: null,
    messageId: null,
    messageSeq: null,
    activityAt: currentDate(),
    personalMention: true,
    eventKey: `migration:${retry.id}:retry_${kind}`,
    category: "system_notice",
    payload: payload as unknown as Record<string, unknown>,
  }], executor);
}
