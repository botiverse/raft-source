import type { AgentApiActionOperationsResponse, RaftQuestionWithdrawal } from "@botiverse/raft-shared";
import { formatAgentQuestionAnsweredFirst, formatAgentQuestionWithdrawn, formatPreparableOperations } from "@botiverse/raft-shared/src/agentCliSurface";

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

const OPERATIONS: AgentApiActionOperationsResponse = {
  enabled: true,
  operations: [
    {
      operation: "agent:start",
      summary: "Start a stopped agent on the Computer it is assigned to.",
      args: [{ name: "agent", description: "the agent's handle, as `raft server info --agents` lists it", required: true }],
      confirmer: "any server member except a guest",
      personSees: { title: "Start <agent>", button: "Start agent" },
      example: { agent: "@builder" },
    },
    {
      operation: "channel:remove_admin",
      summary: "Make a channel admin an ordinary member of the channel (never the other way).",
      args: [
        { name: "channel", description: "the channel, as #name", required: true },
        { name: "member", description: "the channel admin's handle (@name; @name~human or @name~agent when a person and an agent share it)", required: true },
      ],
      confirmer: "a server owner or admin, or a channel admin of that channel (on a joint channel, an owner or admin of its host server)",
      personSees: { title: "Remove channel admin from <member> in <channel>", button: "Remove channel admin" },
      example: { channel: "#ops", member: "@alice" },
    },
  ],
};

export const formatPreparableOperationsList = axSurface(
  "Output of `raft action prepare --list`: the operations this agent may prepare as a request card (request:prepare) on its server, their args, whom to ask and what the person sees, ending with the command that prepares one; or, with none, what to do instead.",
  (data: AgentApiActionOperationsResponse): string => formatPreparableOperations(data),
  {
    examples: [
      { title: "listed", args: [OPERATIONS] },
      { title: "request cards off", args: [{ enabled: false, operations: [] }] },
    ],
  },
);
