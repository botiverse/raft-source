import type { RuntimeAccountUsageProvider, RuntimeLimitResetKind, RuntimeLimitResetResult, ServerRole } from "@botiverse/raft-shared";
import { computerNoticeRecipient } from "./computerNoticeRecipient";
import { sanitizeClientName } from "./deviceAuthService";
import { sendLimitResetUsedByOtherEmail } from "./emailService";
import { recordIntegrationAuditEventBestEffort, serverAuditContextMetadata } from "./integrationAuditService";

/** A usage provider's product name, as the web's Computers list says it (RACK_PROVIDER_NAMES). */
const RUNTIME_NAME: Record<RuntimeAccountUsageProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi",
  grok: "Grok",
  antigravity: "Antigravity",
};

/**
 * How the Computer said a reset was spent:
 * - `reset`: the redeem went through;
 * - `already_redeemed`: a retry, with the same key, of a redeem that went
 *   through but whose `reset` answer never arrived (or, if it did, was
 *   recorded then too);
 * - `five_hour_spent`: Claude's older program spent the account's 5-hour
 *   reset on its own, on a redeem of another kind (`unknown` with
 *   `fiveHourSpent`) or on opening the list for a read (`read` with
 *   `fiveHourSpent`).
 */
export type LimitResetSpentAnswer = "reset" | "already_redeemed" | "five_hour_spent";

export interface LimitResetUsedByOtherInput {
  serverId: string;
  machine: { id: string; name: string };
  provider: RuntimeAccountUsageProvider;
  /** The Claude reset spent (`five_hour` for `five_hour_spent`); absent for Codex. */
  resetKind?: RuntimeLimitResetKind;
  /** The Claude reset the redeem asked for, when another one was spent instead. */
  requestedKind?: RuntimeLimitResetKind;
  /** The route that spent it: a redeem, or a read of the resets. */
  via: "redeem" | "read";
  answer: LimitResetSpentAnswer;
  /** The owner or admin who used it, and their role as the route read it. */
  usedByUserId: string;
  usedByRole: ServerRole | null;
  /** The person who connected the Computer (its runtime account is usually theirs). */
  connectorUserId: string;
}

/**
 * A server owner or admin who did not connect a Computer used one of its
 * runtime account's limit resets (Claude Code, Codex, any provider the
 * redeem route takes), and the Computer said one was spent
 * (LimitResetSpentAnswer; Tenny's condition on opening Claude resets to owners
 * and admins, artin, 2026-11). Records `computer.limit_reset_used_by_other`
 * (who, which Computer and provider, when, how; the outcome is `success`) and
 * emails the person who connected the Computer, like an owner or admin moving
 * or re-keying a member's Computer (computerAdoptionService.ts). Never for the
 * connector's own use, a refusal, a rate limit, a timeout or an answer that
 * spent nothing: the caller decides that (spentLimitReset). Best effort: neither the audit write nor the email
 * ever fails the redeem, which has already happened. The email is not awaited.
 */
export async function recordLimitResetUsedByOther(input: LimitResetUsedByOtherInput): Promise<void> {
  await recordIntegrationAuditEventBestEffort({
    serverId: input.serverId,
    eventType: "computer.limit_reset_used_by_other",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.usedByUserId },
    subject: { type: "human", id: input.connectorUserId },
    target: { type: "machine", id: input.machine.id },
    metadata: {
      machineId: input.machine.id,
      machineName: input.machine.name,
      provider: input.provider,
      ...(input.resetKind ? { resetKind: input.resetKind } : {}),
      ...(input.requestedKind ? { requestedKind: input.requestedKind } : {}),
      via: input.via,
      answer: input.answer,
      ...serverAuditContextMetadata({ actorRole: input.usedByRole }),
    },
  });
  void notifyConnector(input);
}

/** One email to the person who connected the Computer, while they are in the server and their account is not retired. */
async function notifyConnector(input: LimitResetUsedByOtherInput): Promise<void> {
  try {
    const to = await computerNoticeRecipient(input.serverId, input.connectorUserId, input.usedByUserId);
    if (!to) return;
    await sendLimitResetUsedByOtherEmail(to.email, to.name, {
      locale: to.locale,
      usedByName: to.actorName,
      runtimeName: RUNTIME_NAME[input.provider],
      computerName: sanitizeClientName(input.machine.name) ?? "(unnamed)",
      server: to.server,
    });
  } catch (err) {
    console.error("[runtime-limit-reset] used-by-other notice email failed:", err);
  }
}

/**
 * Whether a redeem's answer says a reset was spent, and which: the input for
 * recordLimitResetUsedByOther beyond who and where, or null when nothing was
 * spent (or it is not known that anything was).
 */
export function spentLimitReset(
  result: RuntimeLimitResetResult,
  kind: RuntimeLimitResetKind | undefined,
): Pick<LimitResetUsedByOtherInput, "resetKind" | "requestedKind" | "via" | "answer"> | null {
  switch (result.kind) {
    case "reset":
    case "already_redeemed":
      return { via: "redeem", answer: result.kind, ...(kind ? { resetKind: kind } : {}) };
    case "unknown":
      return result.fiveHourSpent
        ? { via: "redeem", answer: "five_hour_spent", resetKind: "five_hour", ...(kind ? { requestedKind: kind } : {}) }
        : null;
    default:
      return null;
  }
}
