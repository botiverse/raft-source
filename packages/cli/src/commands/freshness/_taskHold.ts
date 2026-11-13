// A task write the Server (or the Computer) held for freshness: nothing was
// applied; print what the agent had not seen of the conversation the write
// lands in, and how to go on (../../../../shared/src/agentWriteLanding.ts).

import type { AgentApiHeldFreshnessResponse, AgentApiTaskWriteUnseen, AgentGatedTaskWriteAction } from "@botiverse/raft-shared";
import { agentWriteLandingTarget, formatAgentTaskWriteUnseen } from "@botiverse/raft-shared/src/agentCliSurface";

import { countRendered } from "../../ax/renderCounts";
import type { CommandContext } from "../../core/context";
import { adoptCliReplyText, writeText } from "../../core/renderer";
import { formatFreshnessHoldOutput, isFreshnessHeldResponse } from "./_format";

const HELD: Record<AgentGatedTaskWriteAction, { heldAction: string; rerun: string }> = {
  task_create: {
    heldAction: "Your task was not created.",
    rerun: "If someone has already taken this, do not create it. Otherwise rerun the same task create command.\n",
  },
  task_claim: {
    heldAction: "Your task claim was not applied.",
    rerun: "After reviewing the newer context, rerun the task claim command if it is still correct.\n",
  },
  task_unclaim: {
    heldAction: "Your task release was not applied.",
    rerun: "After reviewing the newer context, rerun the task unclaim command if it is still correct.\n",
  },
  task_assign: {
    heldAction: "Your task assignment was not applied.",
    rerun: "After reviewing the newer context, rerun the same command if it is still correct.\n",
  },
  task_update: {
    heldAction: "Your task status update was not applied.",
    rerun: "After reviewing the newer context, rerun the task update command if it is still correct.\n",
  },
  task_amend: {
    heldAction: "Your task amendment was not applied.",
    rerun: "After reviewing the newer context, rerun the task amend command if it is still correct.\n",
  },
};

const ISOLATED_RERUN = "Retry remains held while reviewer isolation is active. Use a clean review target, or leave the seat and read only with explicit review authority.\n";

/** Prints the hold and returns true when `data` is a held response; false otherwise. */
export function writeHeldTaskWrite(
  ctx: Pick<CommandContext, "io">,
  agentId: string,
  action: AgentGatedTaskWriteAction,
  body: Record<string, unknown>,
  data: unknown,
  options: { reviewerIsolation?: boolean } = {},
): data is AgentApiHeldFreshnessResponse {
  if (!isFreshnessHeldResponse(data)) return false;
  const withheld = options.reviewerIsolation === true || data.freshnessContextMode === "withheld";
  const text = formatFreshnessHoldOutput(agentWriteLandingTarget(action, body) ?? String(body.channel), data, {
    heldAction: HELD[action].heldAction,
    ...(withheld ? { withholdContext: true } : {}),
    draftInstructions: withheld ? ISOLATED_RERUN : HELD[action].rerun,
  });
  writeText(ctx.io, text);
  countRendered(agentId, "freshness_hold", text);
  return true;
}

/**
 * A task write applied with the conversation's unseen messages attached
 * (agentWriteLanding.ts `attach`): prints them after the write's result.
 */
export function writeAttachedUnseen(ctx: Pick<CommandContext, "io">, agentId: string, data: unknown): void {
  const unseen = data && typeof data === "object" ? (data as { unseen?: AgentApiTaskWriteUnseen }).unseen : undefined;
  const text = formatAgentTaskWriteUnseen(unseen);
  if (!text) return;
  writeText(ctx.io, adoptCliReplyText(`${text}\n`));
  countRendered(agentId, "freshness_attached", text);
}
