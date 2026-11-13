// `raft message send` held for unseen messages, as a continuation (the
// continuation pilot, the Server's `continuations_pilot_v0` flag, which the
// CLI reads when a send is held): instead of saving the message as a draft,
// the send asks the agent what to do and keeps the message in the
// continuation.
//
//   step("send")    the send itself, a write. In the send's first run it is
//                   the attempt already made (today's send, which came back
//                   held), journaled as it is; nothing is sent again.
//   ask("fresh#1")  held: don't send it (a, first, as the held text puts
//                   sending nothing first), a new message (b, on stdin), send
//                   it as it is (c), and once the server suggests it (held 3
//                   or more times, today's `--anyway` rule) send anyway (d).
//   step("send#2")  the next attempt, under a new step id (an earlier id would
//                   replay its held result) and the step's idempotency key as
//                   the message key; and so on: held again, ask again. Not
//                   held: it sends, and the command ends with the usual output.
//
// The attempt itself (attestation, the request, booking what the hold
// showed, the sent output) is the existing send code in send.ts, passed in
// as `attempt`; this file is only the exchange around it. A step's journaled
// result keeps what the question needs: held or not, and the preview, which
// is the agent's own context in its own ledger (never in spans).

import { structuredRaftMentionStillAppears } from "@botiverse/raft-shared/src/agentCliSurface";
import { heldSendContinuationAsk } from "@botiverse/raft-shared/src/agentText/continuations";
import { defineCommand } from "@botiverse/raft-shared/src/continuations/index";

import { defineCliContinuationCommand, type CliContinuationCommand } from "../continuation/_runtime";
import { formatSendContinuationOutcome, type SendContinuationOutcome } from "./_format";

/** The command's name in continuation records. */
export const MESSAGE_SEND_CONTINUATION = "message send";

const HEREDOC_DELIMITER = "RAFTMSG";

/** A mention binding as the send carries it (JSON: kept with the continuation). */
export type SendContinuationMention = { type: "user" | "agent"; id: string; name: string };

/** What the send was started with. Its record keeps it 30 minutes at most, in the agent's own ledger. */
export type SendContinuationArgs = {
  target: string;
  content: string;
  attachmentIds: string[];
  mentions: SendContinuationMention[];
  /** How often the draft this send replaced was held (0: it replaced none). */
  reholdCount: number;
  /** That draft's seen frontier: a floor for what the send attests. */
  seenUpToSeq: number | null;
  seenExactSeqs: number[];
};

/**
 * How an attempt asks the server: as a normal send (the first, or a new
 * message), as the same message again (today's `--send-draft`), or anyway
 * (today's `--send-draft --anyway`).
 */
export type SendAttemptMode = "new" | "same" | "anyway";

export type SendAttempt = {
  content: string;
  mentions: SendContinuationMention[];
  mode: SendAttemptMode;
  /** Holds of this send so far, as the server is told (`draftReholdCount`). */
  reholdCount: number;
  idempotencyKey: string;
};

/** A step's result, journaled: no more than the question needs. */
export type SendStepResult =
  | { held: false; status: "sent" | "committed"; messageId: string | null }
  | { held: true; cardOnlyLead: string | null; preview: string; anywayOffered: boolean };

/** What the exchange gets from send.ts, for this invocation. */
export interface SendContinuationParts {
  /** One attempt: the existing send. Prints the sent output itself when it sends. */
  attempt(args: SendContinuationArgs, attempt: SendAttempt): Promise<SendStepResult>;
  /** Whether this invocation printed the sent output (else a retry of the answer gets a summary). */
  printedSentOutput(): boolean;
  /** After the paused text was written: what is recorded only once the agent saw it. */
  onPaused(): Promise<void>;
}

export function createSendContinuation(parts: SendContinuationParts): CliContinuationCommand<SendContinuationArgs, SendContinuationOutcome> {
  const definition = defineCommand<SendContinuationArgs, SendContinuationOutcome>(MESSAGE_SEND_CONTINUATION, async (ctx, args) => {
    let content = args.content;
    let mode: SendAttemptMode = "new";
    let holds = 0;
    for (let attempt = 1; ; attempt += 1) {
      // A new message binds only the mentions it still names.
      const mentions = args.mentions.filter((mention) => structuredRaftMentionStillAppears(content, mention.name));
      const sent = await ctx.step(attempt === 1 ? "send" : `send#${attempt}`, ({ idempotencyKey }) => parts.attempt(args, {
        content,
        mentions,
        mode,
        reholdCount: args.reholdCount + holds,
        idempotencyKey,
      }));
      if (!sent.held) return { status: sent.status, target: args.target, messageId: sent.messageId };
      holds += 1;
      const answer = await ctx.ask(`fresh#${holds}`, heldSendContinuationAsk(args.target, sent));
      if (answer.choice === "a") return { status: "not_sent" };
      if (answer.choice === "b") {
        content = answer.input ?? content;
        mode = "new";
      } else {
        mode = answer.choice === "d" ? "anyway" : "same";
      }
    }
  });
  return defineCliContinuationCommand<SendContinuationArgs, SendContinuationOutcome>({
    definition,
    // Never the body: the agent writes it again.
    rerun: (args) => [
      `raft message send --target ${JSON.stringify(args.target)}${args.attachmentIds.map((id) => ` --attachment-id ${id}`).join("")} <<'${HEREDOC_DELIMITER}'`,
      "<your message>",
      HEREDOC_DELIMITER,
    ].join("\n"),
    check: (args) => `raft message read --target ${args ? JSON.stringify(args.target) : "<target>"}`,
    renderResult: (outcome) => formatSendContinuationOutcome(outcome, { printedAbove: outcome.status !== "not_sent" && parts.printedSentOutput() }),
    onPaused: () => parts.onPaused(),
    createdSpanAttrs: { pilot: true },
  });
}
