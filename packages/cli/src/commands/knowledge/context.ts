import { MANUAL_INDEX_COMMAND, validateKnowledgeContext } from "@botiverse/raft-shared";
import { CliError, type CliErrorCode } from "../../core/errors.js";

const INTENT_GUIDANCE =
  "Retry with --intent \"Set up a multi-agent review pipeline for my team\" — describe the user's ultimate goal in Raft, not the query or topic.";
const REASON_GUIDANCE =
  "Retry with --reason \"Unsure whether a muted channel still delivers @mentions to me\" — describe why the Manual is needed now, not \"need info\" or a restatement of the query.";
const SAFETY_GUIDANCE = "Don't include secrets, credentials, private URLs, or raw message content.";

function contextGuidance(field: "intent" | "reason"): string {
  return field === "intent" ? INTENT_GUIDANCE : REASON_GUIDANCE;
}

function throwKnowledgeContextError(field: "intent" | "reason", message: string): never {
  const code: CliErrorCode = field === "intent" ? "knowledge_intent_invalid" : "knowledge_reason_invalid";
  throw new CliError({
    code,
    message,
    suggestedNextAction: `${contextGuidance(field)} ${SAFETY_GUIDANCE}`,
  });
}

export function requireKnowledgeContext(
  raw: string | undefined,
  field: "intent" | "reason",
): string {
  const result = validateKnowledgeContext(raw, field);
  if (!result.ok) throwKnowledgeContextError(field, result.error);
  return result.value;
}

export function requireKnowledgeContexts(
  rawIntent: string | undefined,
  rawReason: string | undefined,
): { intent: string; reason: string } {
  const intent = validateKnowledgeContext(rawIntent, "intent");
  const reason = validateKnowledgeContext(rawReason, "reason");

  if (!intent.ok) {
    if (!reason.ok) {
      throw new CliError({
        code: "KNOWLEDGE_CONTEXT_INVALID",
        message: `Both Manual context fields are invalid: ${intent.error}; ${reason.error}`,
        suggestedNextAction:
          `Retry the same command with both required fields:\n`
          + `  ${INTENT_GUIDANCE}\n`
          + `  ${REASON_GUIDANCE}\n`
          + SAFETY_GUIDANCE,
      });
    }
    throwKnowledgeContextError("intent", intent.error);
  }
  if (!reason.ok) throwKnowledgeContextError("reason", reason.error);
  return { intent: intent.value, reason: reason.value };
}

export function formatManualIndexCommand(): string {
  return MANUAL_INDEX_COMMAND;
}
