/**
 * The "Two-step verification" page of a sign-in (#triage:#135, design v2
 * group b: step-code, step-code-wrong, step-code-totp-only, step-backup*,
 * step-expired, step-attempts, step-code-locked; desk-step-code is the same
 * page in Raft Desktop). Shown only when the first step answered
 * `secondFactorRequired` (secondFactorSignIn.ts): people who never turned
 * two-step verification on never see it.
 *
 * Title, then who is signing in and when this sign-in expires (no countdown;
 * at expiry the page turns into the expired state). The step starts with
 * the method this device used last, else passkey, authenticator code, backup
 * code (D4); the other listed methods sit under "or". A passkey is one
 * button that opens the browser's prompt (step-passkey; closing it says so,
 * step-passkey-cancel); a browser that can't use one says why
 * (step-passkey-unsupported). In Raft Desktop with the handoff (design
 * desk-step-code, Q1), codes stay here and "Use a Passkey" drops this
 * challenge for the browser's passkey sign-in instead, which counts as both
 * factors (desktopPasskeySignIn.ts). A wrong or used code says so under the field; an expired challenge,
 * five wrong answers or the person's lock end this sign-in with only Back to
 * Sign In left (the lock with its end time).
 *
 * "Can't Use Any of These?" leads to the email reset (design group d,
 * SecondFactorRecoveryScreens.tsx). Once a reset is past its 72-hour wait the
 * challenge lists `recovery`: the step then offers Finish Reset, which says
 * what it removes before it answers `{ recovery: true }`.
 */
import { Button, TextLink, TextSans } from "@botiverse/raft-ui";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";

import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { canUseDesktopPasskeyHandoff, runDesktopPasskeySignIn } from "../../utils/desktopPasskeySignIn";
import { secondFactorFailureOf } from "../settings/secondFactorApi";
import Banner from "../ui/Banner";
import { TraceIdNote } from "../errors/TraceIdNote";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import { CodeField, MethodSwitch, PasskeyPrompt, useCodeEntry, useCodeFailure } from "./SecondFactorCodeEntry";
import { FinishRecoveryScreen, RecoveryRequestScreen } from "./SecondFactorRecoveryScreens";
import {
  clearSecondFactorSignIn,
  rememberSecondFactorMethod,
  startSignInPasskeyStep,
  usableMethodsOf,
  useSecondFactorSignIn,
  verifySecondFactorSignIn,
} from "./secondFactorSignIn";
import type { SecondFactorChallenge, SecondFactorSignInAnswer, SignInSecondFactorMethod } from "./secondFactorSignIn";
import { noteSignInFailure, signInFailureTraceId } from "./signInFailure";
import { getPasskeyAssertion, isPasskeyCancel } from "./webauthn";

export default function SecondFactorSignInStep({ challenge, email: typedEmail, codeVerifier, onSignedIn, onBack }: {
  challenge: SecondFactorChallenge;
  /** The email typed at the first step (a password sign-in), for the reset request. */
  email?: string;
  codeVerifier?: string;
  /** Applies the verify answer (the first step's success body). */
  onSignedIn: (body: unknown) => Promise<void>;
  /** Back to Sign In: drop this sign-in. */
  onBack: () => void;
}) {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  const describeFailure = useCodeFailure();
  const { methods, passkeyUnsupported: noPasskeyHere } = useMemo(() => usableMethodsOf(challenge.methods), [challenge.methods]);
  // Raft Desktop: the listed passkey goes to the browser instead (Q1).
  const passkeyInBrowser = useMemo(() => noPasskeyHere && canUseDesktopPasskeyHandoff(), [noPasskeyHere]);
  const passkeyUnsupported = noPasskeyHere && !passkeyInBrowser;
  const entry = useCodeEntry(methods);
  const { method, entered, setFieldError, switchTo } = entry;
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ intent: "info" | "warning"; message: string; traceId?: string | null } | null>(null);
  // This sign-in is over: only Back to Sign In is left.
  const [ended, setEnded] = useState<string | null>(null);
  // "Can't Use Any of These?" (the email reset) and Finish Reset take the page.
  const [view, setView] = useState<"step" | "lost" | "finish">("step");
  const [recoveryFailure, setRecoveryFailure] = useState<string | null>(null);

  // No countdown: at expiry the page says so (design step-expired).
  useEffect(() => {
    // Already past: the timer fires at once (never a setState in the effect itself).
    const remaining = Math.max(0, Date.parse(challenge.expiresAt) - Date.now());
    const expire = () => setEnded((current) => current ?? formatMessage({ id: "auth.secondFactor.expired" }));
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [challenge.expiresAt, formatMessage]);

  const answerWith = useCallback(async (answer: () => Promise<SecondFactorSignInAnswer>, used: SignInSecondFactorMethod) => {
    setBusy(true);
    setBanner(null);
    let body: unknown;
    try {
      body = await verifySecondFactorSignIn(challenge.challenge, await answer(), codeVerifier);
    } catch (err) {
      setBusy(false);
      if (isPasskeyCancel(err)) {
        // Closing the prompt is not a failure: say what happened, offer it again (step-passkey-cancel).
        setBanner({ intent: "info", message: formatMessage({ id: "auth.secondFactor.passkeyCancelled" }) });
        return;
      }
      const failure = describeFailure(err, used);
      if (failure.kind === "field") setFieldError(failure.message);
      else if (failure.kind === "terminal") setEnded(failure.message);
      else setBanner({ intent: "warning", message: failure.message });
      return;
    }
    rememberSecondFactorMethod(used);
    try {
      await onSignedIn(body);
    } catch (err) {
      noteSignInFailure(err, "login.second_factor_answer");
      setBanner({ intent: "warning", message: formatMessage({ id: "pages.login.failed" }), traceId: signInFailureTraceId(err) });
    } finally {
      setBusy(false);
    }
  }, [challenge.challenge, codeVerifier, describeFailure, formatMessage, onSignedIn, setFieldError]);

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!method || method === "passkey" || !entered || busy) return;
    await answerWith(async () => (method === "totp" ? { code: entered } : { backupCode: entered }), method);
  }, [answerWith, busy, entered, method]);

  // A fresh assertion each time: its challenge is single use.
  const handleUsePasskey = useCallback(() => {
    if (busy) return;
    void answerWith(async () => ({ webauthn: await getPasskeyAssertion(await startSignInPasskeyStep(challenge.challenge)) }), "passkey");
  }, [answerWith, busy, challenge.challenge]);

  // Drop this challenge (Back to Sign In) and sign in with the passkey in the browser.
  const handlePasskeyInBrowser = useCallback(() => {
    if (busy) return;
    onBack();
    void runDesktopPasskeySignIn(formatMessage);
  }, [busy, formatMessage, onBack]);
  const handleSwitch = useCallback((next: SignInSecondFactorMethod) => {
    if (next === "passkey" && passkeyInBrowser) handlePasskeyInBrowser();
    else switchTo(next);
  }, [handlePasskeyInBrowser, passkeyInBrowser, switchTo]);
  // The switch lists the passkey first (D4 order) when it goes to the browser.
  const switchMethods = useMemo<SignInSecondFactorMethod[]>(() => (passkeyInBrowser ? ["passkey", ...methods] : methods), [methods, passkeyInBrowser]);

  // Finish Reset: the same success body as a code, with every factor removed
  // and every other sign-in signed out (the screen said so first).
  const handleFinishRecovery = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setRecoveryFailure(null);
    let body: unknown;
    try {
      body = await verifySecondFactorSignIn(challenge.challenge, { recovery: true }, codeVerifier);
    } catch (err) {
      setBusy(false);
      const { code } = secondFactorFailureOf(err);
      if (code === "challenge_expired") setEnded(formatMessage({ id: "auth.secondFactor.expired" }));
      else if (code === "recovery_not_ready" || code === "recovery_not_found") setRecoveryFailure(formatMessage({ id: "auth.recovery.finishUnavailable" }));
      else setRecoveryFailure(formatMessage({ id: "pages.login.failed" }));
      return;
    }
    try {
      await onSignedIn(body);
    } catch (err) {
      console.error("[second-factor] finishing the sign-in failed", err);
      setRecoveryFailure(formatMessage({ id: "pages.login.failed" }));
    } finally {
      setBusy(false);
    }
  }, [busy, challenge.challenge, codeVerifier, formatMessage, onSignedIn]);

  const showStep = useCallback(() => setView("step"), []);
  const showLost = useCallback(() => setView("lost"), []);
  const showFinish = useCallback(() => {
    setRecoveryFailure(null);
    setView("finish");
  }, []);
  const switchToBackupCode = useCallback(() => {
    switchTo("backup_code");
    setView("step");
  }, [switchTo]);

  const email = <strong key="email" className="font-semibold text-foreground">{challenge.maskedEmail}</strong>;

  if (view === "lost") {
    return (
      <RecoveryRequestScreen
        initialEmail={typedEmail}
        onUseBackupCode={!ended && methods.includes("backup_code") ? switchToBackupCode : undefined}
        onBack={showStep}
        onBackToSignIn={onBack}
      />
    );
  }

  if (view === "finish" && !ended) {
    return (
      <FinishRecoveryScreen
        email={email}
        busy={busy}
        failure={recoveryFailure}
        onFinish={handleFinishRecovery}
        onBack={showStep}
      />
    );
  }

  // The reset is ready: offered above whatever this step shows (design D6).
  const recoveryReadyBanner = challenge.recoveryReady && !ended ? (
    <Banner
      intent="info"
      withIcon
      live={false}
      className="mb-4"
      title={formatMessage({ id: "auth.recovery.readyTitle" })}
      actions={(
        <Button type="button" size="md" variant="default" onClick={showFinish} disabled={busy}>
          {formatMessage({ id: "auth.recovery.finish" })}
        </Button>
      )}
    >
      {formatMessage({ id: "auth.recovery.readyDescription" })}
    </Banner>
  ) : null;

  const lostLink = challenge.recoveryReady ? null : (
    <div className="mt-4 text-center">
      <TextLink variant="strong" onClick={showLost} disabled={busy}>
        {formatMessage({ id: "auth.secondFactor.cantVerify" })}
      </TextLink>
    </div>
  );

  if (ended || (!method && !passkeyInBrowser)) {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="second-factor-sign-in-ended">
          <AuthPageIntro
            title={formatMessage({ id: "auth.secondFactor.title" })}
            description={formatMessage({ id: "auth.secondFactor.signingInAs" }, { email })}
          />
          {recoveryReadyBanner}
          <Banner intent="warning" withIcon className="mb-4">
            {ended ?? formatMessage({ id: passkeyUnsupported ? "auth.secondFactor.passkeyUnsupported" : "auth.secondFactor.unavailable" })}
          </Banner>
          <Button type="button" size="xl" variant="accent" className="w-full" onClick={onBack}>
            {formatMessage({ id: "auth.backToSignIn.button" })}
          </Button>
          {lostLink}
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full" data-testid="second-factor-sign-in">
        <AuthPageIntro
          title={formatMessage({ id: "auth.secondFactor.title" })}
          description={formatMessage(
            { id: "auth.secondFactor.signingInAsUntil" },
            { email, time: formatClock(challenge.expiresAt) },
          )}
        />
        {recoveryReadyBanner}
        {passkeyUnsupported ? (
          <Banner intent="info" className="mb-4">{formatMessage({ id: "auth.secondFactor.passkeyUnsupported" })}</Banner>
        ) : null}
        {banner ? (
          <Banner intent={banner.intent} className="mb-4">
            {banner.message}
            {banner.traceId ? <span className="mt-1 block"><TraceIdNote traceId={banner.traceId} /></span> : null}
          </Banner>
        ) : null}
        {!method ? (
          // Only a passkey is set up: it is the one way on, in the browser.
          <div className="stack-y-3">
            <TextSans size="small" variant="muted" className="text-center">
              {formatMessage({ id: "auth.secondFactor.passkeyInBrowserHint" })}
            </TextSans>
            <Button type="button" size="xl" variant="accent" className="w-full gap-2" onClick={handlePasskeyInBrowser}>
              <KeyRound aria-hidden="true" />
              {formatMessage({ id: "auth.secondFactor.usePasskey" })}
            </Button>
          </div>
        ) : method === "passkey" ? (
          <PasskeyPrompt busy={busy} onUse={handleUsePasskey} />
        ) : (
          <form onSubmit={submit} className="stack-y-4 md:pointer-fine:stack-y-3" noValidate>
            <CodeField method={method} value={entry.value} onChange={entry.change} error={entry.fieldError} disabled={busy} />
            <Button type="submit" size="xl" variant="accent" className="w-full" loading={busy} disabled={!entered}>
              {formatMessage({ id: "auth.secondFactor.verify" })}
            </Button>
          </form>
        )}
        {method ? (
          <MethodSwitch methods={switchMethods} current={method} onSwitch={handleSwitch} disabled={busy} appearance="buttons" />
        ) : null}
        {lostLink}
        <div className="mt-4 text-center">
          <TextLink variant="strong" onClick={onBack} disabled={busy}>
            {formatMessage({ id: "auth.backToSignIn.link" })}
          </TextLink>
        </div>
      </div>
    </AuthPageFrame>
  );
}

/**
 * The second step a password or Raft Desktop sign-in is waiting on
 * (useSecondFactorSignIn), or null. The signed-out screens render this in
 * place of themselves while it is set.
 */
export function PendingSecondFactorSignInStep() {
  const pending = useSecondFactorSignIn((state) => state.pending);
  const finish = pending?.finish;
  const handleSignedIn = useCallback(async (body: unknown) => {
    if (!finish) return;
    await finish(body);
    clearSecondFactorSignIn();
  }, [finish]);
  if (!pending) return null;
  return (
    <SecondFactorSignInStep
      key={pending.challenge.challenge}
      challenge={pending.challenge}
      email={pending.email}
      codeVerifier={pending.codeVerifier}
      onSignedIn={handleSignedIn}
      onBack={clearSecondFactorSignIn}
    />
  );
}

/** Whether a second step is pending (the signed-out screens step aside for it). */
export function useSecondFactorSignInPending(): boolean {
  return useSecondFactorSignIn((state) => state.pending !== null);
}
