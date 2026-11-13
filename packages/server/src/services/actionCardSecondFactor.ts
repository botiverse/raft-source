/**
 * What second step executing each action-card kind takes (POST
 * /api/actions/:messageId/execute, actionCardsService.executeActionCard), for
 * a person with two-step verification enforced (sessionIssueGate
 * isSecondFactorEnforced). Every stored kind declares one, so a new kind
 * without it fails typecheck (ACTION_CARD_SECOND_FACTOR is keyed by
 * StoredActionCardActionType):
 *
 *   - `approver`: the executing sign-in passed the second step at some time
 *     (approverSecondFactorCheck), as approving a device or app login or an
 *     app's agent access request (routes/secondFactor.ts refuseUnverifiedApprover).
 *   - `step_up`: it passed it in the last 10 minutes (stepUpGate.ts
 *     recentSecondFactorCheck), as the routes that mint a key or secret.
 *   - `none`: no second step, with the written reason it needs none.
 *
 * A kind that issues a credential or grants access is `approver` or
 * `step_up`, never `none` (actionCardSecondFactor.contract.test.ts). A kind
 * whose execute can also refuse (a form's Deny) names, with `appliesTo`, the
 * submissions that grant: anything else is not gated. Refusing never needs a
 * second step.
 *
 * The check runs once, in executeActionCard, after the card is read and
 * before anything is written (the attempt audit, a form's delivery, the
 * action itself). Refused: 403 `second_factor_step_up_required` with the
 * methods (routes/actions.ts), the same answer the gated routes give, and
 * nothing happens. Anyone without two-step verification enforced is never
 * refused here and sees what they saw before. Only a person's own web
 * (`full`) sign-in executes cards (the route is behind requireAuth, and not a
 * device login's route); agents, machines and app keys never execute a card,
 * they only prepare one.
 */
import type { ActionCardFormSubmission, StoredActionCardActionType } from "@botiverse/raft-shared";

import { approverSecondFactorCheck } from "./sessionIssueGate";
import { STEP_UP_ACTIONS, recentSecondFactorCheck, type StepUpAction } from "./secondFactor/stepUpGate";
import { signInSecondFactorMethods, type SignInSecondFactorMethod } from "./secondFactor/signIn";

/** Whether this execute grants (true) or only refuses (false); absent: every execute grants. */
type AppliesTo = (form: ActionCardFormSubmission | undefined) => boolean;

export type ActionCardSecondFactorRule =
  | { secondFactor: "approver"; reason: string; error: string; appliesTo?: AppliesTo }
  | { secondFactor: "step_up"; reason: string; action: StepUpAction; appliesTo?: AppliesTo }
  | { secondFactor: "none"; reason: string };

/** Each kind's second step. Keyed by every stored kind: one missing (or unknown) fails typecheck. */
export const ACTION_CARD_SECOND_FACTOR: { readonly [T in StoredActionCardActionType]: ActionCardSecondFactorRule } = {
  "integration:approve_agent_login": {
    secondFactor: "approver",
    reason: "approves an app's request to act as an agent (an OAuth grant), as POST /api/integrations/requests/:requestId/approve",
    error: "Confirm it's you with your second step before approving this app's access.",
  },
  "integration:install_marketplace_app": {
    secondFactor: "approver",
    reason: "installs an app into the server with its scopes and data groups, as POST /api/integrations/marketplace/:clientId/install",
    error: "Confirm it's you with your second step before installing this app.",
  },
  "integration:recover_app_owner": {
    secondFactor: "approver",
    reason: "makes an agent the owner of an app (it may then rotate the app's secrets and change it)",
    error: "Confirm it's you with your second step before making an agent this app's owner.",
  },
  "assistant:owner_action": {
    secondFactor: "none",
    reason: "a confirmed card runs the owner's own route on their own web session, with that route's own checks (its step-ups included); Decline runs nothing",
  },
  "agent:approve_call": {
    secondFactor: "approver",
    reason: "lets a hosted agent's held call run with the credentials of its mount; Deny runs nothing and is not gated",
    error: "Confirm it's you with your second step before approving this call.",
    // The decision form's only value is `decision` (approve | deny); only
    // exactly "deny" is a refusal, anything else is gated (fail closed).
    appliesTo: (form) => form?.values?.decision !== "deny",
  },
  "integration:register_app": {
    secondFactor: "step_up",
    reason: "registers an app and hands its new client secret to the requesting agent, as creating a new secret (regenerate-secret)",
    action: "integration_app_register",
  },
  "integration:update_app_registration": {
    secondFactor: "none",
    reason: "disabled: execute answers 410 LEGACY_APP_UPDATE_DISABLED before writing anything",
  },
  "integration:connect_mcp": {
    secondFactor: "none",
    reason: "never executed by the card (409 DIALOG_REQUIRED): the MCP connection routes choose or authorize the Connection, then mark-executed records it",
  },
  "channel:create": {
    secondFactor: "none",
    reason: "creates a channel as the person, as POST /api/channels does; no credential or access to anything outside the server",
  },
  "agent:create": {
    secondFactor: "none",
    reason: "never executed by the card (409 DIALOG_REQUIRED): the create-agent dialog's own route creates it, then mark-executed records it",
  },
  "agent:migrate": {
    secondFactor: "none",
    reason: "never executed by the card (409 DIALOG_REQUIRED): the migration dialog's own route (POST /api/agents/:id/migrate) starts the move, then mark-executed records it",
  },
  "channel:add_member": {
    secondFactor: "none",
    reason: "never executed by the card (409 DIALOG_REQUIRED): the add-members dialog's own routes add them, then mark-executed records it",
  },
  "feedback:submit": {
    secondFactor: "none",
    reason: "files product feedback as the person; no credential or access",
  },
  "plan:upgrade": {
    secondFactor: "none",
    reason: "never executed (409 NOT_EXECUTABLE): the card only opens the upgrade dialog",
  },
  "seats:add": {
    secondFactor: "none",
    reason: "never executed (409 NOT_EXECUTABLE): the owner adds seats through billing, then POST /actions/:messageId/seats-added",
  },
  "question:ask": {
    secondFactor: "none",
    reason: "records a person's answers to an agent's questions on the card and replies to the agent; no credential or access",
  },
};

/** For a stored kind this server does not know: the strictest rule, so nothing new runs unchecked. */
const UNKNOWN_KIND: ActionCardSecondFactorRule = {
  secondFactor: "approver",
  reason: "an unknown kind",
  error: "Confirm it's you with your second step before doing this.",
};

export function actionCardSecondFactorRule(actionType: string): ActionCardSecondFactorRule {
  return Object.hasOwn(ACTION_CARD_SECOND_FACTOR, actionType)
    ? ACTION_CARD_SECOND_FACTOR[actionType as StoredActionCardActionType]
    : UNKNOWN_KIND;
}

/**
 * Null when this person may execute this card on this sign-in (anyone
 * without two-step verification enforced, a `none` kind, a refusal), else
 * the refusal's message and the methods to step up with.
 */
export async function actionCardSecondFactorRefusal(input: {
  actionType: string;
  userId: string;
  /** sessionService.webSessionFamilyOf: the person's own web sign-in, or null. */
  webSessionFamilyId: string | null;
  form?: ActionCardFormSubmission;
}): Promise<{ error: string; methods: SignInSecondFactorMethod[] } | null> {
  const rule = actionCardSecondFactorRule(input.actionType);
  if (rule.secondFactor === "none") return null;
  if (rule.appliesTo && !rule.appliesTo(input.form)) return null;
  const verdict = rule.secondFactor === "approver"
    ? await approverSecondFactorCheck(input.userId, input.webSessionFamilyId)
    : await recentSecondFactorCheck(input.userId, input.webSessionFamilyId);
  if (verdict === "ok") return null;
  return {
    error: rule.secondFactor === "approver" ? rule.error : STEP_UP_ACTIONS[rule.action],
    methods: await signInSecondFactorMethods(input.userId),
  };
}
