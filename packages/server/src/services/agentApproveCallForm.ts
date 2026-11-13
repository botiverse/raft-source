// `agent:approve_call` as a form card (form.v1): its button opens the
// decision form, Approve or Deny with no default (shared
// buildAgentApproveCallForms), and its submission decides the held call
// through antiproton (agentRuntimeApprovalService.decideApproval). antiproton
// is called in `deliver`, before execute's transaction (which locks the
// card's channel); the decider is checked there, at the click, by the hold's
// agent and server, never by who the card went to. execute only records the
// result deliver returned; decideApproval has already written this person's
// card as theirs, so execute finds it done by them (a same-form retry). A hold
// that ended some other way (someone else decided first, the console, expiry)
// is ActionCardAlreadyExecutedError with the refreshed card; anything else
// (this person may not decide, antiproton is down) an ApprovalDecisionError
// with its status and code, and the card stays as it was.
import { buildAgentApproveCallForms, type ActionCardResult } from "@botiverse/raft-shared";
import type { ActionCardFormHandler } from "./actionCardForms";
import { decideApproval } from "./agentRuntimeApprovalService";

export interface AgentApproveCallFormInput {
  decision: "approve" | "deny";
  /** antiproton's record of this person's decision (deliver). */
  result?: Extract<ActionCardResult, { kind: "agent-call-approval" }>;
}

export const agentApproveCallFormHandler: ActionCardFormHandler<"agent:approve_call", AgentApproveCallFormInput> = {
  buildForm() {
    return buildAgentApproveCallForms();
  },

  async validate(values) {
    // The shared checks passed: the decision is chosen (required) and is one of the two options.
    return { input: { decision: values.decision === "approve" ? "approve" : "deny" } };
  },

  async deliver(input, ctx) {
    const result = await decideApproval({
      approvalId: ctx.action.approvalId,
      agentId: ctx.requesterAgentId,
      serverId: ctx.serverId,
      userId: ctx.userId,
      decision: input.decision,
      messageId: ctx.messageId,
      formId: ctx.formId,
      io: ctx.io,
    });
    return { ...input, result };
  },

  async execute(input) {
    if (!input.result) throw new Error("An approval card is recorded only once antiproton recorded the decision");
    return input.result;
  },
};
