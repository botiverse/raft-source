/**
 * Delete Account's proof that it's the person (design §4), as the server's
 * `methods` ask, over the Delete Account page:
 *   - two-step verification: the app's "Verify it's you" (VerifyItsYouDialog:
 *     authenticator code, passkey, backup code), sent as `secondFactor`;
 *   - a password: `password`, in the same request;
 *   - neither (social sign-in only): an emailed 6-digit code, `emailCode`.
 * One field each: a small dialog, centred on a phone too (DS: Dialog).
 */
import { DialogDescription, TextLink } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";

import type { SignInSecondFactorMethod } from "../../../components/auth/secondFactorSignIn";
import { normalizeEnteredCode, secondFactorFailureOf } from "../../../components/settings/secondFactorApi";
import type { StepUpAnswer } from "../../../components/settings/secondFactorApi";
import { AnswerField, CancelButton, CommitButton, StepDialog } from "../../../components/settings/TwoStepVerificationSection";
import { useAnswer } from "../../../components/settings/secondFactorAnswer";
import VerifyItsYouDialog from "../../../components/settings/VerifyItsYouDialog";
import Banner from "../../../components/ui/Banner";
import { useAuthStore } from "../../../store/authStore";
import { accountDeletionRefusalOf, sendAccountDeletionEmailCode } from "./accountDeletionApi";
import type { AccountDeletionReauth } from "./accountDeletionApi";
import { DeleteAccountSignInAgainBanner } from "./DeleteAccountSignInAgainBanner";
import { signOutAfterDeletion, useStepFailure } from "./deleteAccountFlow";
import type { Submit } from "./deleteAccountFlow";

export function DeleteAccountVerifyDialog({ reauth, submit, moveToReauth, onClose }: {
  reauth: AccountDeletionReauth;
  submit: Submit;
  /** To the proof a refusal names instead (Send Code's 409 email_code_not_available); sends nothing. */
  moveToReauth: (reauth: AccountDeletionReauth) => void;
  onClose: () => void;
}) {
  switch (reauth.kind) {
    case "second_factor":
      return <SecondFactorStep methods={reauth.methods} submit={submit} onClose={onClose} />;
    case "password":
      return <PasswordStep submit={submit} onClose={onClose} />;
    case "email_code":
      return <EmailCodeStep submit={submit} moveToReauth={moveToReauth} onClose={onClose} />;
  }
}

/**
 * Two-step verification on: the app's one "Verify it's you", answering in the
 * request itself. Its own failures (a wrong code, a lock, a closed passkey
 * prompt, Sign In Again) stay in it.
 */
function SecondFactorStep({ methods, submit, onClose }: {
  methods: SignInSecondFactorMethod[];
  submit: Submit;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const handleAnswer = useCallback(async (answer: StepUpAnswer) => {
    const outcome = await submit({ secondFactor: answer });
    if (outcome?.kind === "failed") throw outcome.err;
    if (outcome?.kind === "sign_in_again") {
      throw Object.assign(new Error("session_family_required"), {
        response: { status: 403, data: { code: "session_family_required" } },
      });
    }
  }, [submit]);

  return (
    <VerifyItsYouDialog
      description={formatMessage({ id: "accountDeletion.verifySecondFactor" })}
      methods={methods}
      onAnswer={handleAnswer}
      onClose={onClose}
      onSignInAgain={signOutAfterDeletion}
      testId="account-deletion-second-factor"
    />
  );
}

function PasswordStep({ submit, onClose }: { submit: Submit; onClose: () => void }) {
  const { formatMessage } = useIntl();
  const describe = useStepFailure();
  const answer = useAnswer();
  const { value, setBusy, setFailure } = answer;
  const [signInAgain, setSignInAgain] = useState(false);

  const handleSubmit = useCallback(() => {
    if (!value) return;
    setBusy(true);
    setFailure({});
    setSignInAgain(false);
    void submit({ password: value }).then((outcome) => {
      if (outcome?.kind === "moved") return;
      setBusy(false);
      const shown = describe(outcome, "password");
      setFailure(shown.failure);
      setSignInAgain(shown.signInAgain);
    });
  }, [describe, setBusy, setFailure, submit, value]);

  return (
    <StepDialog
      title={formatMessage({ id: "accountDeletion.verifyTitle" })}
      narrow="centered"
      size="sm"
      busy={answer.busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="account-deletion-password"
      footer={(
        <>
          <CancelButton busy={answer.busy} onClose={onClose} />
          <CommitButton
            label={formatMessage({ id: "accountDeletion.action" })}
            busy={answer.busy}
            disabled={!value}
            variant="danger"
          />
        </>
      )}
    >
      {/* No sentence restating the step: the title, the Password field and Delete account say it (HelperText step 1). */}
      <AnswerField
        kind="password"
        label={formatMessage({ id: "accountDeletion.passwordLabel" })}
        value={value}
        onChange={answer.change}
        error={answer.failure.field}
      />
      {answer.failure.banner ? <Banner intent="warning" density="sm">{answer.failure.banner}</Banner> : null}
      {signInAgain ? <DeleteAccountSignInAgainBanner /> : null}
    </StepDialog>
  );
}

/** No password and no two-step verification: send a code to the account's email, then type it. */
function EmailCodeStep({ submit, moveToReauth, onClose }: {
  submit: Submit;
  moveToReauth: (reauth: AccountDeletionReauth) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const email = useAuthStore((state) => state.user?.email ?? "");
  const describe = useStepFailure();
  const answer = useAnswer();
  const { value, setBusy, setFailure, reset } = answer;
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [signInAgain, setSignInAgain] = useState(false);
  const entered = normalizeEnteredCode(value);

  const sendCode = useCallback(() => {
    setSending(true);
    setNotice("");
    setSignInAgain(false);
    setFailure({});
    void sendAccountDeletionEmailCode().then(() => {
      reset();
      setSent(true);
    }, (err: unknown) => {
      const code = secondFactorFailureOf(err).code;
      // One went out a moment ago: it still works, so ask for it.
      if (code === "email_code_recently_sent") {
        setSent(true);
        setNotice(formatMessage({ id: "accountDeletion.emailRecentlySent" }));
        return;
      }
      // Never the deletion itself from here: a 409 email_code_not_available
      // names the proof to use instead, and the dialog only moves to it.
      const refusal = accountDeletionRefusalOf(err);
      if (refusal?.kind === "sign_in_again") setSignInAgain(true);
      else if (refusal?.kind === "reauth") moveToReauth(refusal.reauth);
      else setFailure({ banner: formatMessage({ id: "accountDeletion.failed" }) });
    }).finally(() => setSending(false));
  }, [formatMessage, moveToReauth, reset, setFailure]);

  const handleSubmit = useCallback(() => {
    if (!sent) {
      sendCode();
      return;
    }
    if (!entered) return;
    setBusy(true);
    setFailure({});
    setNotice("");
    setSignInAgain(false);
    void submit({ emailCode: entered }).then((outcome) => {
      if (outcome?.kind === "moved") return;
      setBusy(false);
      const shown = describe(outcome, "totp");
      setFailure(shown.failure);
      setSignInAgain(shown.signInAgain);
    });
  }, [describe, entered, sendCode, sent, setBusy, setFailure, submit]);

  const busy = answer.busy || sending;
  return (
    <StepDialog
      title={formatMessage({ id: "accountDeletion.verifyTitle" })}
      narrow="centered"
      size="sm"
      busy={busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="account-deletion-email-code"
      footer={(
        <>
          <CancelButton busy={busy} onClose={onClose} />
          {sent ? (
            <CommitButton
              label={formatMessage({ id: "accountDeletion.action" })}
              busy={answer.busy}
              disabled={!entered || sending}
              variant="danger"
            />
          ) : (
            <CommitButton label={formatMessage({ id: "accountDeletion.emailSendCode" })} busy={sending} />
          )}
        </>
      )}
    >
      {/* Before sending, one sentence: it will send an email, and where (a consequence, Kirby). After, the
          code field's label names where it went (the address is data, the label what the field takes). The
          expiry is cut: a code that no longer works says so, and Send a new code is beside it (HelperText step 1). */}
      {sent ? null : (
        <DialogDescription>{formatMessage({ id: "accountDeletion.emailBeforeSend" }, { email })}</DialogDescription>
      )}
      {sent ? (
        <>
          <AnswerField
            kind="totp"
            label={formatMessage({ id: "accountDeletion.emailCodeSentLabel" }, { email })}
            value={value}
            onChange={answer.change}
            error={answer.failure.field}
          />
          <div>
            <TextLink type="button" onClick={sendCode} disabled={busy}>
              {formatMessage({ id: "accountDeletion.emailResend" })}
            </TextLink>
          </div>
        </>
      ) : null}
      {notice ? <Banner intent="info" density="sm">{notice}</Banner> : null}
      {answer.failure.banner ? <Banner intent="warning" density="sm">{answer.failure.banner}</Banner> : null}
      {signInAgain ? <DeleteAccountSignInAgainBanner /> : null}
    </StepDialog>
  );
}
