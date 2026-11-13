import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { externalAppInstalls, externalAppRegistrations, externalChannelBindings, externalDeliveryOperatorDecisions,
  externalMessageLinks, externalOutboundDeliveries, externalDeliveryAttempts } from "../db/schema";

/** Allow small inter-host clock skew without ignoring a plausible earlier send. */
export const SLACK_BOT_SEND_CLOCK_SKEW_MS = 5_000;

/**
 * Read both facts in one SQL statement. Separate reads can straddle the commit
 * that moves an outbound send from outcome_unknown to accepted: an inbound
 * worker could then see neither the old pending row nor the new exact link.
 *
 * Only the same verified registration/install/workspace/conversation can be
 * evidence. Old binding epochs remain useful positive echo evidence, but a
 * file ID alone does not identify a message because files may be re-shared.
 * A manualSkipCandidate is only same-channel, time-scoped audit context after
 * this event was isolated; it does not claim a skipped send caused the event.
 * Caller must repeat the check at its final transactional decision boundary;
 * this snapshot alone does not authorize a discard or materialization.
 */
export async function readSlackInboundOutboundEvidence(input: {
  db: DatabaseExecutor;
  registrationId: string;
  environment: "test" | "production";
  providerAppId: string;
  installId: string;
  workspaceId: string;
  conversationId: string;
  providerMessageId: string;
  /** Trusted server receipt time; later sends cannot explain this event. */
  receivedAt: Date;
  /** Most recent isolation time, only when this event was held on an uncertain send. */
  pendingSince?: Date;
}): Promise<{ exactMessageMatch: boolean; unresolvedCandidate: boolean; manualSkipCandidate: boolean }> {
  if (!Number.isFinite(input.receivedAt.getTime())) throw new Error("Invalid Slack receipt time");
  if (input.pendingSince && !Number.isFinite(input.pendingSince.getTime())) throw new Error("Invalid Slack pending time");
  const result = await input.db.execute<{ exactMessageMatch: boolean; unresolvedCandidate: boolean; manualSkipCandidate: boolean }>(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM ${externalMessageLinks} l
        JOIN ${externalAppInstalls} i ON i.id = ${input.installId}::uuid AND l.install_id = ${input.installId}
        JOIN ${externalAppRegistrations} r ON r.id = i.registration_id
        WHERE r.provider = 'slack' AND r.environment = ${input.environment}
          AND r.provider_app_id = ${input.providerAppId} AND i.provider_app_id = ${input.providerAppId}
          AND l.provider = 'slack'
          AND i.id = ${input.installId}::uuid
          AND i.registration_id = ${input.registrationId}::uuid
          AND i.provider_authority_id = ${input.workspaceId}
          AND l.provider_authority_id = ${input.workspaceId}
          AND l.provider_conversation_id = ${input.conversationId}
          AND l.provider_message_id = ${input.providerMessageId}
          AND l.first_direction = 'raft_outbound'
          AND l.outcome_state = 'accepted'
      ) AS "exactMessageMatch",
      EXISTS (
        SELECT 1 FROM ${externalOutboundDeliveries} d
        JOIN ${externalChannelBindings} b ON b.id::text = d.binding_id
        JOIN ${externalAppInstalls} i ON i.id = b.install_id
        JOIN ${externalAppRegistrations} r ON r.id = i.registration_id
        WHERE r.provider = 'slack' AND r.environment = ${input.environment}
          AND r.provider_app_id = ${input.providerAppId} AND i.provider_app_id = ${input.providerAppId}
          AND i.id = ${input.installId}::uuid
          AND i.registration_id = ${input.registrationId}::uuid
          AND i.provider_authority_id = ${input.workspaceId}
          AND b.registration_id = ${input.registrationId}::uuid
          AND b.provider_conversation_id = ${input.conversationId}
          AND d.state IN ('dispatching', 'outcome_unknown')
          AND (EXISTS (SELECT 1 FROM ${externalDeliveryAttempts} a WHERE a.delivery_id = d.id
            AND a.provider_io_started_at <= ${new Date(input.receivedAt.getTime() + SLACK_BOT_SEND_CLOCK_SKEW_MS)}::timestamptz)
            OR (d.provider_attempts > 0 AND NOT EXISTS (SELECT 1 FROM ${externalDeliveryAttempts} a WHERE a.delivery_id = d.id)))
      ) AS "unresolvedCandidate",
      EXISTS (
        SELECT 1 FROM ${externalOutboundDeliveries} d
        JOIN ${externalChannelBindings} b ON b.id::text = d.binding_id
        JOIN ${externalAppInstalls} i ON i.id = b.install_id
        JOIN ${externalAppRegistrations} r ON r.id = i.registration_id
        WHERE ${input.pendingSince ?? null}::timestamptz IS NOT NULL
          AND r.provider = 'slack' AND r.environment = ${input.environment}
          AND r.provider_app_id = ${input.providerAppId} AND i.provider_app_id = ${input.providerAppId}
          AND i.id = ${input.installId}::uuid AND i.registration_id = ${input.registrationId}::uuid
          AND i.provider_authority_id = ${input.workspaceId}
          AND b.registration_id = ${input.registrationId}::uuid AND b.provider_conversation_id = ${input.conversationId}
          AND d.state = 'skipped' AND d.state_reason = 'operator_audited_skip'
          AND (EXISTS (SELECT 1 FROM ${externalDeliveryAttempts} a WHERE a.delivery_id = d.id
            AND a.provider_io_started_at <= ${new Date(input.receivedAt.getTime() + SLACK_BOT_SEND_CLOCK_SKEW_MS)}::timestamptz)
            OR (d.provider_attempts > 0 AND NOT EXISTS (SELECT 1 FROM ${externalDeliveryAttempts} a WHERE a.delivery_id = d.id)))
          AND EXISTS (SELECT 1 FROM ${externalDeliveryOperatorDecisions} od
            WHERE od.delivery_id = d.id AND od.action = 'skip' AND od.data_loss_acknowledged = true
              AND od.consumed_at >= ${input.pendingSince ?? null}::timestamptz)
      ) AS "manualSkipCandidate"
  `);
  const row = result.rows[0];
  if (!row || typeof row.exactMessageMatch !== "boolean" || typeof row.unresolvedCandidate !== "boolean"
    || typeof row.manualSkipCandidate !== "boolean") {
    throw new Error("Slack outbound evidence is unavailable");
  }
  return row;
}
