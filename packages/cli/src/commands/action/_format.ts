import type { RaftQuestionWithdrawal } from "@botiverse/raft-shared";
import { formatAgentQuestionAnsweredFirst, formatAgentQuestionWithdrawn } from "@botiverse/raft-shared/src/agentCliSurface";

import { axSurface } from "../../core/renderer";

// The text lives in `@botiverse/raft-shared` (`agentOps/actions.ts`) so the
// SDK's `actions.withdraw` returns the same bytes; this file keeps the
// axSurface registrations and their examples.

const CARD = "1a2b3c4d-1111-4222-8333-444455556666";
const ACTION = {
  type: "question:ask",
  ref: "deploy-1",
  addressee: { kind: "user", userId: "00000000-0000-4000-8000-000000000001", handle: "tenny" },
  expiresAt: "2026-10-31T16:00:00.000Z",
  questions: [
    { id: "window", kind: "single", text: "Which window do we deploy in?", options: [{ value: "tue_am", label: "Tue 10:00" }, { value: "wed_pm", label: "Wed 15:00" }] },
    { id: "notes", kind: "text", text: "Anything I should watch for?", required: false },
  ],
};

export const formatQuestionCardWithdrawn = axSurface(
  "Receipt of `raft action withdraw`: the question card was withdrawn (or already was), and who can no longer answer it.",
  (withdrawal: Pick<RaftQuestionWithdrawal, "messageId" | "alreadyWithdrawn" | "metadata">): string => formatAgentQuestionWithdrawn(withdrawal),
  {
    examples: [
      { title: "withdrawn", args: [{ messageId: CARD, alreadyWithdrawn: false, metadata: { kind: "action-card", state: "withdrawn", action: ACTION } }] },
      { title: "already withdrawn, asked anyone", args: [{ messageId: CARD, alreadyWithdrawn: true, metadata: { kind: "action-card", state: "withdrawn", action: { ...ACTION, addressee: { kind: "anyone" } } } }] },
    ],
  },
);

export const formatQuestionCardAnsweredFirst = axSurface(
  "`raft action withdraw` on a question card answered first (ALREADY_ANSWERED): nothing was withdrawn; the answers, as the card's result reply lists them.",
  (messageId: string, metadata: unknown): string => formatAgentQuestionAnsweredFirst(messageId, metadata),
  {
    examples: [{
      args: ["1a2b3c4d", {
        kind: "action-card",
        state: "executed",
        action: ACTION,
        result: {
          kind: "question-answers",
          ref: "deploy-1",
          answeredBy: { userId: "00000000-0000-4000-8000-000000000001", handle: "tenny" },
          answeredAt: "2026-10-30T09:12:00.000Z",
          answers: { window: { kind: "choice", selected: ["tue_am"], other: "or Thu early" }, notes: { kind: "skipped" } },
        },
      }],
    }],
  },
);
