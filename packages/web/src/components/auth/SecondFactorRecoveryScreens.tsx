/**
 * The sign-in's second step when the person can't answer it (#triage:#135,
 * design v2 group d, D6 option A; server contract in secondFactorRecovery.ts):
 *
 *   - RecoveryRequestScreen (design step-lost, step-reset-sent): "Can't
 *     verify?". Backup codes first when the account has them; otherwise (or
 *     "No backup codes?") ask for the emailed reset link. The answer is the
 *     same for every address, so the page never says whether the account
 *     exists. The field holds the email typed at a password sign-in; a
 *     third-party sign-in only knows the masked address, so it starts empty
 *     (the server takes `{ email }` only: design Q3 asked for `{ challenge }`
 *     too).
 *   - FinishRecoveryScreen: the request is past its 72-hour wait and the
 *     challenge lists `recovery`. It says what finishing removes and that every
 *     other sign-in signs out, and only then answers the step with
 *     `{ recovery: true }`.
 */
import { Button, Input, Separator, TextLink, TextSans } from "@botiverse/raft-ui";
import { ArrowLeft, Ticket } from "lucide-react";
import { useCallback, useId, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";

import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import { AUTH_MESSAGE_IDS, isValidEmailFormat } from "./authErrors";
import { requestSecondFactorRecovery } from "./secondFactorRecovery";

export function RecoveryRequestScreen({ initialEmail, onUseBackupCode, onBack, onBackToSignIn }: {
  /** The email typed at the first step, if any. */
  initialEmail?: string;
  /** Present when the account has backup codes: offered before the email reset (design step-lost). */
  onUseBackupCode?: () => void;
  /** Back to the second step. */
  onBack: () => void;
  /** After the email is sent: this sign-in is done with. */
  onBackToSignIn: () => void;
}) {
  const { formatMessage } = useIntl();
  const fieldId = useId();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [fieldError, setFieldError] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const handleEmailChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
    setFieldError("");
  }, []);

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!isValidEmailFormat(email)) {
      setFieldError(formatMessage({ id: AUTH_MESSAGE_IDS.invalidEmail }));
      return;
    }
    setBusy(true);
    setFailure("");
    try {
      await requestSecondFactorRecovery(email);
      setSent(true);
    } catch (err) {
      // 429 comes the same for every address too, so saying so tells nothing about the account.
      setFailure(formatMessage({ id: getApiErrorResponse(err)?.status === 429 ? "auth.recovery.tooManyRequests" : "auth.recovery.requestFailed" }));
    } finally {
      setBusy(false);
    }
  }, [busy, email, formatMessage]);

  if (sent) {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="second-factor-recovery-sent">
          <AuthPageIntro
            title={formatMessage({ id: "pages.forgotPassword.checkEmailTitle" })}
            description={formatMessage({ id: "auth.recovery.sentDescription" })}
          />
          <Banner intent="info" live={false} className="mb-4">{formatMessage({ id: "auth.recovery.sentNotice" })}</Banner>
          <Button type="button" size="xl" variant="accent" className="w-full" onClick={onBackToSignIn}>
            <ArrowLeft size={16} aria-hidden="true" />
            {formatMessage({ id: "auth.backToSignIn.button" })}
          </Button>
        </div>
      </AuthPageFrame>
    );
  }

  const form = (
    <form onSubmit={submit} className="stack-y-4 md:pointer-fine:stack-y-3" noValidate>
      <FormField label={formatMessage({ id: "pages.login.emailLabel" })} error={fieldError || undefined} htmlFor={fieldId}>
        <Input
          id={fieldId}
          type="email"
          autoComplete="email"
          value={email}
          onChange={handleEmailChange}
          disabled={busy}
          data-invalid={fieldError ? true : undefined}
          className="w-full"
        />
      </FormField>
      {failure ? <Banner intent="warning">{failure}</Banner> : null}
      <Button type="submit" size="xl" variant={onUseBackupCode ? "outline" : "accent"} className="w-full" loading={busy} disabled={!email.trim()}>
        {formatMessage({ id: "auth.recovery.resetByEmail" })}
      </Button>
    </form>
  );

  return (
    <AuthPageFrame>
      <div className="w-full" data-testid="second-factor-recovery-request">
        <AuthPageIntro
          title={formatMessage({ id: "auth.recovery.title" })}
          description={onUseBackupCode ? formatMessage({ id: "auth.recovery.backupCodesFirst" }) : formatMessage({ id: "auth.recovery.emailDescription" })}
        />
        {onUseBackupCode ? (
          <>
            <Button type="button" size="xl" variant="accent" className="w-full gap-3" onClick={onUseBackupCode} disabled={busy}>
              <Ticket aria-hidden="true" />
              <span>{formatMessage({ id: "auth.secondFactor.useBackupCode" })}</span>
            </Button>
            <Separator className="my-4" />
            <h2 className="text-headline text-foreground">{formatMessage({ id: "auth.recovery.noCodes" })}</h2>
            <TextSans size="small" variant="muted" className="mb-4 mt-1">
              {formatMessage({ id: "auth.recovery.emailDescription" })}
            </TextSans>
          </>
        ) : null}
        {form}
        <div className="mt-4 text-center">
          <TextLink variant="strong" onClick={onBack} disabled={busy}>
            {formatMessage({ id: "auth.recovery.back" })}
          </TextLink>
        </div>
      </div>
    </AuthPageFrame>
  );
}

export function FinishRecoveryScreen({ email, busy, failure, onFinish, onBack }: {
  /** Who is signing in (the masked address, bold). */
  email: ReactNode;
  busy: boolean;
  /** Why the last try didn't finish, if it didn't. */
  failure: string | null;
  onFinish: () => void;
  /** Back to the second step. */
  onBack: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <AuthPageFrame>
      <div className="w-full" data-testid="second-factor-recovery-finish">
        <AuthPageIntro
          title={formatMessage({ id: "auth.recovery.finishTitle" })}
          description={formatMessage({ id: "auth.secondFactor.signingInAs" }, { email })}
        />
        <Banner intent="warning" withIcon live={false} className="mb-4">
          {formatMessage({ id: "auth.recovery.finishWarning" })}
        </Banner>
        <TextSans size="small" variant="muted" className="mb-4">
          {formatMessage({ id: "auth.recovery.finishAfter" })}
        </TextSans>
        {failure ? <Banner intent="warning" className="mb-4">{failure}</Banner> : null}
        <Button type="button" size="xl" variant="danger" className="w-full" onClick={onFinish} loading={busy} disabled={busy}>
          {formatMessage({ id: "auth.recovery.finish" })}
        </Button>
        <div className="mt-4 text-center">
          <TextLink variant="strong" onClick={onBack} disabled={busy}>
            {formatMessage({ id: "auth.recovery.back" })}
          </TextLink>
        </div>
      </div>
    </AuthPageFrame>
  );
}
