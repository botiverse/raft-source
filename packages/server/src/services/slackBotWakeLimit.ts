import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { externalInboundEvents, externalMessageAuthorFacts, messageMentions } from "../db/schema";

/**
 * Sliding-window anti-loop guard, not a provider quota. Count messages, not
 * individual mentioned agents; suppressed mentions remain included. Use the
 * server-assigned commit/payload-erasure timestamp, never a provider-controlled message
 * timestamp. Call only inside the canonical message transaction after the
 * current message's mention targets are known and before creating inbox facts.
 */
export async function slackBotWakeIsLimited(input: {
  db: DatabaseExecutor; projectionId: string; registrationId: string; installId: string;
  workspaceId: string; providerConversationId: string; bindingId: string; messageId: string; now: Date;
}): Promise<boolean> {
  if (!Number.isFinite(input.now.getTime())) throw new Error("Slack bot wake clock unavailable");
  const windowStart = new Date(input.now.getTime() - 5 * 60_000);
  const result = await input.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM (
      SELECT f.message_id FROM ${externalInboundEvents} e
      JOIN ${externalMessageAuthorFacts} f ON f.message_id = e.committed_message_id
      WHERE e.provider = 'slack' AND e.status = 'committed'
        AND e.app_registration_id = ${input.registrationId} AND e.install_id = ${input.installId}
        AND e.workspace_id = ${input.workspaceId} AND e.provider_conversation_id = ${input.providerConversationId}
        AND e.binding_id = ${input.bindingId}
        AND e.payload_erased_at >= ${windowStart} AND e.payload_erased_at <= ${input.now}
        AND f.projection_id = ${input.projectionId}::uuid
        AND f.provider = 'slack' AND f.app_registration_id = ${input.registrationId}
        AND f.install_id = ${input.installId} AND f.workspace_id = ${input.workspaceId}
        AND f.external_conversation_id = ${input.providerConversationId}
        AND f.actor_kind = 'bot' AND f.message_id <> ${input.messageId}::uuid
        AND EXISTS (SELECT 1 FROM ${messageMentions} mm
          WHERE mm.message_id = f.message_id AND mm.target_type = 'agent')
      LIMIT 5
    ) prior
  `);
  const count = result.rows[0]?.count;
  if (!Number.isSafeInteger(count) || count! < 0 || count! > 5) throw new Error("Slack bot wake count unavailable");
  return count! >= 5;
}
