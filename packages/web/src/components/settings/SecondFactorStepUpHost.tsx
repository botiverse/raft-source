/**
 * The app's one "Verify it's you" for sensitive actions (design dlg-stepup;
 * secondFactorStepUp.ts): mounted once in the app shell, it shows the dialog
 * while a request waits for a step-up, sends the answer to POST
 * /auth/second-factor/step-up and lets the request go again.
 */
import { useCallback, useEffect } from "react";
import { useIntl } from "react-intl";

import type { MessageId } from "../../i18n/messages/en";
import { useAuthStore } from "../../store/authStore";
import { secondFactorFailureOf, stepUpThisSignIn } from "./secondFactorApi";
import type { StepUpAnswer } from "./secondFactorApi";
import { registerSecondFactorStepUpHost, useSecondFactorStepUpStore } from "./secondFactorStepUp";
import type { StepUpReason } from "./secondFactorStepUp";
import { lazyDialog } from "../../boot/deferredUi";

// Only someone with two-step verification on ever sees it: kept out of the shell bundle.
// A failed download opens a small dialog with Try again; Close answers the step-up "no".
const VerifyItsYouDialog = lazyDialog(() => import("./VerifyItsYouDialog"));

const DESCRIPTION_IDS = {
  signInMethod: "settings.twoStep.stepUpDescription",
  agentKey: "settings.twoStep.stepUpAgentKeyDescription",
  appAccess: "settings.twoStep.stepUpAppAccessDescription",
  agentAccess: "settings.twoStep.stepUpAgentAccessDescription",
  secret: "settings.twoStep.stepUpSecretDescription",
  actionCard: "settings.twoStep.stepUpActionCardDescription",
  other: "settings.twoStep.stepUpGenericDescription",
} as const satisfies Record<StepUpReason, MessageId>;

export default function SecondFactorStepUpHost() {
  const { formatMessage } = useIntl();
  const pending = useSecondFactorStepUpStore((state) => state.pending);
  useEffect(() => registerSecondFactorStepUpHost(), []);

  const settle = pending?.settle;
  const handleAnswer = useCallback(async (answer: StepUpAnswer) => {
    try {
      await stepUpThisSignIn(answer);
    } catch (err) {
      // Turned off meanwhile: nothing to step up, the request goes as it is.
      if (secondFactorFailureOf(err).code !== "second_factor_not_enabled") throw err;
    }
    settle?.(true);
  }, [settle]);

  const handleClose = useCallback(() => settle?.(false), [settle]);

  const handleSignInAgain = useCallback(() => {
    settle?.(false);
    useAuthStore.getState().logout();
  }, [settle]);

  if (!pending) return null;
  return (
    <VerifyItsYouDialog
      description={formatMessage({ id: DESCRIPTION_IDS[pending.reason] })}
      methods={pending.methods}
      onAnswer={handleAnswer}
      onClose={handleClose}
      onSignInAgain={handleSignInAgain}
      testId="second-factor-step-up-dialog"
    />
  );
}
