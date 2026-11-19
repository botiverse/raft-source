/**
 * "Verify it's you" (design dlg-stepup, #triage:#135): the one step-up dialog
 * of Settings and of every sensitive action, for people with two-step
 * verification on. Used by the Passkeys section (adding and deleting answer
 * in the same request) and by SecondFactorStepUpHost (POST /step-up, then the
 * refused request again: secondFactorStepUp.ts).
 */
import { Button, DialogDescription, TextLink } from "@botiverse/raft-ui";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

import { initialMethod, rememberSecondFactorMethod, usableMethodsOf } from "../auth/secondFactorSignIn";
import type { SignInSecondFactorMethod } from "../auth/secondFactorSignIn";
import { requestSecondFactorRecovery } from "../auth/secondFactorRecovery";
import type { LostDeviceStepUp } from "./secondFactorStepUp";
import { useAuthStore } from "../../store/authStore";
import { isPasskeyCancel } from "../auth/webauthn";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import Banner from "../ui/Banner";
import { normalizeEnteredCode, secondFactorFailureOf } from "./secondFactorApi";
import type { StepUpAnswer } from "./secondFactorApi";
import { AnswerField, CancelButton, CommitButton, DoneButton, MethodLink, StepDialog, stepUpAnswerFor } from "./TwoStepVerificationSection";
import { useAnswer, useFailureCopy } from "./secondFactorAnswer";
import type { FailureCopy } from "./secondFactorAnswer";

/**
 * A code, a backup code or a passkey, among the `methods` the server listed
 * (a passkey only where this browser can use one), starting with the one
 * this device used last. `onAnswer` sends it; what it refuses stays here
 * (a wrong or used code under the field, a lock or anything else in a
 * banner). `onSignInAgain`: this sign-in can't step up at all (403
 * `session_family_required`), so the banner offers Sign In Again instead.
 *
 * `recoveryEmail` (signing out a lost device: the authenticator may have
 * gone with it) adds "Lost the device with your authenticator?": the
 * sign-in's own way out, Can't verify? (a backup code first, else the reset
 * by email, auth/secondFactorRecovery.ts) in this dialog, for the person's
 * own address.
 *
 * `lostDevice` (with `recoveryEmail`: a lost device's revoke, #triage:#386):
 * Can't verify? offers, first, Reset your password by email (POST
 * /auth/forgot-password for the person's own address; Set a password by
 * email without one): setting it revokes every sign-in at once, this one
 * too, with what they approved. Then, with `signOut`, Sign it (them) out now
 * with your password (`onSignOutInstead`; the caller sends `sign_out`, which
 * needs no second step). The two-step reset by email stays as a link, the
 * way back in afterwards. With a passkey among the methods (the person has
 * one), a warning: a passkey on the lost device still signs in until it is
 * removed.
 */
export default function VerifyItsYouDialog({ description, methods: listed, onAnswer, onClose, onSignInAgain, recoveryEmail, lostDevice, onSignOutInstead, testId }: {
  description: string;
  methods: readonly SignInSecondFactorMethod[];
  onAnswer: (answer: StepUpAnswer) => Promise<void>;
  onClose: () => void;
  onSignInAgain?: () => void;
  recoveryEmail?: string | null;
  lostDevice?: LostDeviceStepUp;
  onSignOutInstead?: () => void;
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
  const [view, setView] = useState<"answer" | "lost" | "sent" | "passwordSent">("answer");
  const [recoveryFailure, setRecoveryFailure] = useState("");

  const switchTo = useCallback((next: SignInSecondFactorMethod) => {
    reset();
    setInfoBanner("");
    setMethod(next);
    setView("answer");
  }, [reset]);

  const showLost = useCallback(() => {
    setRecoveryFailure("");
    setView("lost");
  }, []);
  const showAnswer = useCallback(() => setView("answer"), []);

  const requestReset = useCallback(async () => {
    if (!recoveryEmail) return;
    setBusy(true);
    setRecoveryFailure("");
    try {
      await requestSecondFactorRecovery(recoveryEmail);
      setView("sent");
    } catch (err) {
      setRecoveryFailure(formatMessage({ id: getApiErrorResponse(err)?.status === 429 ? "auth.recovery.tooManyRequests" : "auth.recovery.requestFailed" }));
    } finally {
      setBusy(false);
    }
  }, [formatMessage, recoveryEmail, setBusy]);

  const handleRequestReset = useCallback(() => {
    void requestReset();
  }, [requestReset]);

  /** Reset (or set) the password by email: the forgot-password email, for the person's own address. */
  const requestPasswordEmail = useCallback(async () => {
    if (!recoveryEmail) return;
    setBusy(true);
    setRecoveryFailure("");
    try {
      await useAuthStore.getState().forgotPassword(recoveryEmail);
      setView("passwordSent");
    } catch (err) {
      setRecoveryFailure(formatMessage({ id: getApiErrorResponse(err)?.status === 429 ? "auth.recovery.tooManyRequests" : "auth.recovery.requestFailed" }));
    } finally {
      setBusy(false);
    }
  }, [formatMessage, recoveryEmail, setBusy]);

  const handleRequestPasswordEmail = useCallback(() => {
    void requestPasswordEmail();
  }, [requestPasswordEmail]);

  const twoStepResetLink = useCallback((chunks: ReactNode[]) => (
    <TextLink key="two-step-reset" type="button" onClick={handleRequestReset} disabled={answer.busy} data-testid="step-up-two-step-reset">
      {chunks}
    </TextLink>
  ), [answer.busy, handleRequestReset]);

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

  if (view === "sent" && recoveryEmail) {
    return (
      <StepDialog
        title={formatMessage({ id: "pages.forgotPassword.checkEmailTitle" })}
        narrow="centered"
        size="sm"
        busy={false}
        onClose={onClose}
        onSubmit={onClose}
        testId={testId}
        footer={<DoneButton onClose={onClose} />}
      >
        <DialogDescription>{formatMessage({ id: "settings.twoStep.recoverySent" }, { email: recoveryEmail })}</DialogDescription>
        <Banner intent="info" density="sm" live={false}>{formatMessage({ id: "auth.recovery.sentNotice" })}</Banner>
        <p className="text-footnote text-foreground-muted">{formatMessage({ id: "settings.twoStep.recoverySignsOutAll" })}</p>
      </StepDialog>
    );
  }

  if (view === "passwordSent" && recoveryEmail) {
    return (
      <StepDialog
        title={formatMessage({ id: "pages.forgotPassword.checkEmailTitle" })}
        narrow="centered"
        size="sm"
        busy={false}
        onClose={onClose}
        onSubmit={onClose}
        testId={testId}
        footer={<DoneButton onClose={onClose} />}
      >
        <DialogDescription>{formatMessage({ id: "settings.twoStep.passwordEmailSent" }, { email: recoveryEmail })}</DialogDescription>
      </StepDialog>
    );
  }

  if (view === "lost" && recoveryEmail && lostDevice) {
    const backupCode = methods.includes("backup_code");
    const many = lostDevice.signOut === "others";
    return (
      <StepDialog
        title={formatMessage({ id: "auth.recovery.title" })}
        narrow="centered"
        size="sm"
        busy={answer.busy}
        onClose={onClose}
        onSubmit={handleRequestPasswordEmail}
        testId={testId}
        footer={(
          <>
            <Button type="button" variant="ghost" size="lg" onClick={showAnswer} disabled={answer.busy}>
              {formatMessage({ id: "auth.recovery.back" })}
            </Button>
            <CommitButton
              label={formatMessage({ id: lostDevice.password ? "settings.twoStep.resetPasswordByEmail" : "settings.twoStep.setPasswordByEmail" })}
              busy={answer.busy}
              testId="step-up-password-email"
            />
          </>
        )}
      >
        {backupCode ? (
          <div className="grid gap-1">
            <DialogDescription>{formatMessage({ id: "auth.recovery.backupCodesFirst" })}</DialogDescription>
            <div>
              <MethodLink method="backup_code" onSwitch={switchTo} disabled={answer.busy} />
            </div>
          </div>
        ) : null}
        <p className="text-subhead text-foreground" data-testid="step-up-password-email-body">
          {formatMessage({ id: lostDevice.password ? "settings.twoStep.resetPasswordBody" : "settings.twoStep.setPasswordBody" })}
        </p>
        {lostDevice.signOut && onSignOutInstead ? (
          <div className="grid gap-2" data-testid="step-up-sign-out-instead-offer">
            <p className="text-subhead text-foreground">
              {formatMessage({ id: many ? "settings.twoStep.signOutAllWithPasswordBody" : "settings.twoStep.signOutWithPasswordBody" })}
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                size="md"
                onClick={onSignOutInstead}
                disabled={answer.busy}
                data-testid="step-up-sign-out-instead"
              >
                {formatMessage({ id: many ? "settings.twoStep.signOutAllWithPassword" : "settings.twoStep.signOutWithPassword" })}
              </Button>
            </div>
          </div>
        ) : null}
        {listed.includes("passkey") ? (
          <Banner intent="warning" density="sm" live={false} data-testid="step-up-lost-passkey">
            {formatMessage({ id: "settings.twoStep.lostPasskeyWarning" })}
          </Banner>
        ) : null}
        <p className="text-footnote text-foreground-muted">
          {formatMessage({ id: "settings.twoStep.lostTwoStepReset" }, { link: twoStepResetLink })}
        </p>
        {recoveryFailure ? <Banner intent="warning" density="sm">{recoveryFailure}</Banner> : null}
      </StepDialog>
    );
  }

  if (view === "lost" && recoveryEmail) {
    const backupCode = methods.includes("backup_code");
    return (
      <StepDialog
        title={formatMessage({ id: "auth.recovery.title" })}
        narrow="centered"
        size="sm"
        busy={answer.busy}
        onClose={onClose}
        onSubmit={handleRequestReset}
        testId={testId}
        footer={(
          <>
            <Button type="button" variant="ghost" size="lg" onClick={showAnswer} disabled={answer.busy}>
              {formatMessage({ id: "auth.recovery.back" })}
            </Button>
            <CommitButton label={formatMessage({ id: "auth.recovery.resetByEmail" })} busy={answer.busy} />
          </>
        )}
      >
        {backupCode ? (
          <div className="grid gap-1">
            <DialogDescription>{formatMessage({ id: "auth.recovery.backupCodesFirst" })}</DialogDescription>
            <div>
              <MethodLink method="backup_code" onSwitch={switchTo} disabled={answer.busy} />
            </div>
          </div>
        ) : null}
        {backupCode ? (
          <p className="text-footnote text-foreground-muted">{formatMessage({ id: "auth.recovery.emailDescription" })}</p>
        ) : (
          <DialogDescription>{formatMessage({ id: "auth.recovery.emailDescription" })}</DialogDescription>
        )}
        {recoveryFailure ? <Banner intent="warning" density="sm">{recoveryFailure}</Banner> : null}
      </StepDialog>
    );
  }

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
      {others.length > 0 || recoveryEmail ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {others.map((other) => (
            <MethodLink key={other} method={other} onSwitch={switchTo} disabled={answer.busy} />
          ))}
          {recoveryEmail ? (
            <TextLink type="button" onClick={showLost} disabled={answer.busy} data-testid="step-up-lost-authenticator">
              {formatMessage({ id: "settings.twoStep.lostAuthenticator" })}
            </TextLink>
          ) : null}
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
