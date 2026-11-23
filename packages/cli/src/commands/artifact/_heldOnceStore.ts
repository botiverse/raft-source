// Where a command that holds itself once keeps the hold (the agent's ledger),
// and the count of it: one trace span when a command is held and one when the
// same command went through afterwards. The agent is shown no code for such a
// hold (CliErrorOptions.informative), so how often each one fires, and how
// often it is simply run again, is read from these spans.

import { ARTIFACT_NOT_A_PAGE_HOLD_MS } from "@botiverse/raft-shared/src/agentCliSurface";
import { deleteArtifactPushHold, readArtifactPushHold, writeArtifactPushHold } from "../../state/agentLedger";
import { emitCliTraceSpan } from "../../transportTrace";

/** Which hold: a new artifact with no page, or an HTML or Markdown file uploaded as an attachment. */
export type HeldOnceKind = "artifact_push_no_page" | "attachment_upload_page";

export function heldOnceStore(agentId: string, kind: HeldOnceKind, env: NodeJS.ProcessEnv | undefined) {
  const span = (outcome: "held" | "went_through") => emitCliTraceSpan("cli.held_once", { hold_kind: kind, outcome }, { status: "ok", kind: "internal" }, env);
  return {
    heldAt: (key: string) => readArtifactPushHold(agentId, key, env),
    hold: (key: string, at: number) => {
      writeArtifactPushHold(agentId, key, at, at - ARTIFACT_NOT_A_PAGE_HOLD_MS, env);
      span("held");
    },
    /** Called once the command went through: counted only when it had been held. */
    release: (key: string) => {
      const wasHeld = readArtifactPushHold(agentId, key, env) !== undefined;
      deleteArtifactPushHold(agentId, key, env);
      if (wasHeld) span("went_through");
    },
  };
}
