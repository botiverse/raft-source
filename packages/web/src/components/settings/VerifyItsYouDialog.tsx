/**
 * "Verify it's you" (design dlg-stepup, #triage:#135): the one step-up dialog
 * of Settings and of every sensitive action, for people with two-step
 * verification on. Used by the Passkeys section (adding and deleting answer
 * in the same request) and by SecondFactorStepUpHost (POST /step-up, then the
 * refused request again: secondFactorStepUp.ts).
 */
import { Button, DialogDescription } from "@botiverse/raft-ui";
import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";

import { initialMethod, rememberSecondFactorMethod, usableMethodsOf } from "../auth/secondFactorSignIn";
import type { SignInSecondFactorMethod } from "../auth/secondFactorSignIn";
import { isPasskeyCancel } from "../auth/webauthn";
import Banner from "../ui/Banner";
import { normalizeEnteredCode, secondFactorFailureOf } from "./secondFactorApi";
import type { StepUpAnswer } from "./secondFactorApi";
import { AnswerField, CancelButton, CommitButton, MethodLink, StepDialog, stepUpAnswerFor } from "./TwoStepVerificationSection";
import { useAnswer, useFailureCopy } from "./secondFactorAnswer";
import type { FailureCopy } from "./secondFactorAnswer";

/**
 * A code, a backup code or a passkey, among the `methods` the server listed
 * (a passkey only where this browser can use one), starting with the one
 * this device used last. `onAnswer` sends it; what it refuses stays here
 * (a wrong or used code under the field, a lock or anything else in a
 * banner). `onSignInAgain`: this sign-in can't step up at all (403
 * `session_family_required`), so the banner offers Sign In Again instead.
 */
export default function VerifyItsYouDialog({ description, methods: listed, onAnswer, onClose, onSignInAgain, testId }: {
  description: string;
  methods: readonly SignInSecondFactorMethod[];
  onAnswer: (answer: StepUpAnswer) => Promise<void>;
  onClose: () => void;
  onSignInAgain?: () => void;
  testId: string;
}) {
  const { formatMessage } = useIntl();
  const describeFailure = useFailureCopy();
  const { methods } = useMemo(() => usableMethodsOf(listed), [listed]);
  const [method, setMethod] = useState<SignInSecondFactorMethod | null>(() => initialMethod(methods));
  const answer = useAnswer();
  const { value, reset, setBusy, setFailure } = answer;
  const [infoBanner, setInfoBanner] = useState("");
  const [signInAgain, setSignInAgain] = useState(false);

  const switchTo = useCallback((next: SignInSecondFactorMethod) => {
    reset();
    setInfoBanner("");
    setMethod(next);
  }, [reset]);

  const submit = useCallback(async () => {
    if (!method) return;
    const entered = normalizeEnteredCode(value);
    if (method !== "passkey" && !entered) return;
    setBusy(true);
    setFailure({});
    setInfoBanner("");
    setSignInAgain(false);
    try {
      await onAnswer(await stepUpAnswerFor(method, entered));
      rememberSecondFactorMethod(method);
    } catch (err) {
      setBusy(false);
      if (isPasskeyCancel(err)) {
        setInfoBanner(formatMessage({ id: "auth.secondFactor.passkeyCancelled" }));
        return;
      }
      const code = secondFactorFailureOf(err).code;
      if (onSignInAgain && code === "session_family_required") {
        setSignInAgain(true);
        return;
      }
      let failure: FailureCopy;
      if (method === "passkey" && (code === "second_factor_code_invalid" || code === "passkey_not_found")) {
        failure = { banner: formatMessage({ id: "auth.secondFactor.passkeyInvalid" }) };
      } else if (code === "passkeys_unavailable") {
        failure = { banner: formatMessage({ id: "settings.passkeys.unavailable" }) };
      } else {
        failure = describeFailure(err, method === "backup_code" ? "backup_code" : "totp");
      }
      setFailure(failure);
    }
  }, [describeFailure, formatMessage, method, onAnswer, onSignInAgain, setBusy, setFailure, value]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  const others = methods.filter((other) => other !== method);

  return (
    <StepDialog
      title={formatMessage({ id: "settings.twoStep.reauthTitle" })}
      narrow="centered"
      size="sm"
      busy={answer.busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId={testId}
      footer={(
        <>
          <CancelButton busy={answer.busy} onClose={onClose} />
          {method ? (
            <CommitButton
              label={formatMessage({ id: method === "passkey" ? "auth.secondFactor.passkeyButton" : "settings.twoStep.verify" })}
              busy={answer.busy}
              disabled={method !== "passkey" && !normalizeEnteredCode(value)}
            />
          ) : null}
        </>
      )}
    >
      <DialogDescription>{description}</DialogDescription>
      {/* A passkey is its Use passkey button; a code its field (no instruction or format line: HelperText step 1). */}
      {method === "passkey" ? null : method ? (
        <AnswerField
          key={method}
          kind={method}
          label={formatMessage({
            id: method === "backup_code" ? "settings.twoStep.backupCodeLabel" : "settings.twoStep.authenticatorCodeLabel",
          })}
          value={value}
          onChange={answer.change}
          error={answer.failure.field}
        />
      ) : (
        <Banner intent="warning" density="sm">{formatMessage({ id: "auth.secondFactor.passkeyUnsupported" })}</Banner>
      )}
      {others.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {others.map((other) => (
            <MethodLink key={other} method={other} onSwitch={switchTo} disabled={answer.busy} />
          ))}
        </div>
      ) : null}
      {infoBanner ? <Banner intent="info" density="sm">{infoBanner}</Banner> : null}
      {answer.failure.banner ? <Banner intent="warning" density="sm">{answer.failure.banner}</Banner> : null}
      {signInAgain && onSignInAgain ? (
        <Banner
          intent="warning"
          density="sm"
          data-testid="step-up-sign-in-again"
          actions={(
            <Button type="button" size="md" variant="outline" onClick={onSignInAgain}>
              {formatMessage({ id: "settings.twoStep.signInAgainButton" })}
            </Button>
          )}
        >
          {formatMessage({ id: "settings.twoStep.stepUpSignInAgain" })}
        </Banner>
      ) : null}
    </StepDialog>
  );
}
