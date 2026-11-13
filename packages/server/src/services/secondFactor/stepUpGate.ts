/**
 * Step-up for sensitive actions (design v8 §3; rollout PR 5): for a person
 * with two-step verification enforced (sessionIssueGate.isSecondFactorEnforced:
 * their own setting), these actions
 * need the second factor passed on THIS sign-in within the last 10 minutes
 * (`session_families.second_factor_verified_at`, stamped by passing the second
 * step at sign-in and again by every POST /api/auth/second-factor/step-up).
 * Otherwise the route answers 403 `second_factor_step_up_required` with the
 * methods (routes/secondFactor.ts refuseWithoutRecentSecondFactor), the same
 * refusal approving a device or app login gives, so the client steps up and
 * retries.
 *
 * Anyone without two-step verification enforced is never refused here and
 * sees exactly what they saw before (design §0): no family read, nothing
 * written.
 *
 * Computer and machine keys are gated only when a person's web sign-in
 * issues them (attach, adopt-legacy, machine register and key rotation): a
 * device login's session (`raft-computer login`) and a device-login grant's
 * attach token pass, their approval already needed a verified sign-in
 * (approverSecondFactorCheck); a machine using its own key never reaches
 * these routes.
 *
 * An app's client secret and webhook signing secret are gated when a
 * person's session creates a new one (POST /api/integrations/clients, which
 * answers with a new app's first secret, POST /api/integrations/clients/:clientId
 * /regenerate-secret, .../app-notifications/webhook/rotate-secret); an agent
 * rotating with its own key (internal agent API) is not a person's session.
 *
 * Linking a sign-in method is gated at every start a link is bound to:
 * /:provider/link/start, /mobile/oauth/:provider/link/start, and the
 * optional-bearer `mode: "link"` starts (/mobile/oauth/start,
 * /mobile/oauth/apple/native/start); their callback, complete and authorize
 * legs only finish what such a start began. stepUpGate.contract.test.ts
 * checks every registered route that can link, change a password or mint a
 * key is gated or exempt with a reason.
 *
 * Executing an action card is gated by its kind (services/actionCardSecondFactor.ts:
 * approver, step-up or none, each kind declares one); registering an app
 * by card is step-up here (`integration_app_register`), as POST /api/integrations/clients.
 *
 * Already gated elsewhere, and not through this: turning two-step
 * verification off, removing a passkey, regenerating backup codes and
 * re-binding TOTP (inline answer, management.ts / passkeyManagement.ts),
 * adding a passkey (passkeyManagement.ts), device and app login approval
 * (approverSecondFactorCheck), Login with Raft consent and approving an
 * app's agent access request, installing an app and approving an installed
 * app's new permissions (approverSecondFactorCheck), account deletion (routes/accountDeletion.ts).
 */
import { currentDate } from "@botiverse/raft-shared";

import { enforcedSecondFactorVerifiedAt } from "../sessionIssueGate";
import { REAUTHENTICATION_WINDOW_MS } from "./reauthentication";

/** How long a passed second factor counts for a sensitive action. */
export const STEP_UP_WINDOW_MS = REAUTHENTICATION_WINDOW_MS;

/**
 * The actions gated here, with the message of their refusal. Every call of
 * the route helper names one (stepUpGate.contract.test.ts pins where).
 */
export const STEP_UP_ACTIONS = {
  password_change: "Confirm it's you with your second step before changing your password.",
  identity_link: "Confirm it's you with your second step before connecting a sign-in method.",
  identity_unlink: "Confirm it's you with your second step before disconnecting a sign-in method.",
  agent_credential_mint: "Confirm it's you with your second step before creating an agent key.",
  agent_bootstrap_token: "Confirm it's you with your second step before creating an agent bootstrap token.",
  computer_attach: "Confirm it's you with your second step before attaching a computer.",
  computer_adopt: "Confirm it's you with your second step before adopting a machine as a computer.",
  machine_key_register: "Confirm it's you with your second step before registering a machine.",
  machine_key_rotate: "Confirm it's you with your second step before creating a new machine key.",
  integration_client_secret_regenerate: "Confirm it's you with your second step before creating a new app client secret.",
  integration_webhook_secret_rotate: "Confirm it's you with your second step before creating a new app webhook signing secret.",
  // POST /api/integrations/clients, and the register_app action card (services/actionCardSecondFactor.ts).
  integration_app_register: "Confirm it's you with your second step before registering an app.",
} as const;

export type StepUpAction = keyof typeof STEP_UP_ACTIONS;

/**
 * "ok" for anyone without two-step verification enforced. For a person with
 * it enforced, "ok" only when `familyId` is their own live `full` sign-in and
 * its second factor was passed within STEP_UP_WINDOW_MS of `now`; a missing
 * family, a device login's session, or an older (or no) verification answers
 * "step_up_required".
 */
export async function recentSecondFactorCheck(
  userId: string,
  familyId: string | null,
  now: Date = currentDate(),
): Promise<"ok" | "step_up_required"> {
  const verifiedAt = await enforcedSecondFactorVerifiedAt(userId, familyId);
  if (verifiedAt === "not_enforced") return "ok";
  return verifiedAt && verifiedAt.getTime() >= now.getTime() - STEP_UP_WINDOW_MS ? "ok" : "step_up_required";
}
