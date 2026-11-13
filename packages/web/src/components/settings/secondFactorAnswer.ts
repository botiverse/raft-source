/**
 * The answer state and failure wording every second-step and re-verification
 * dialog shares: Two-step verification, Passkeys, Verify it's you
 * (VerifyItsYouDialog) and Delete Account (features/settings/account).
 */
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";

import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { secondFactorFailureOf } from "./secondFactorApi";

/** What a failed call says, and where: under the field, or in a banner above the buttons. */
export type FailureCopy = { field?: string; banner?: string };
export type AnswerKind = "totp" | "backup_code" | "password";
/** What the person answered with: something typed, or a passkey. */
export type FailureKind = AnswerKind | "passkey";

/** A failed call's copy for `answer`: a wrong code or password under the field, a lock or anything else in a banner. */
export function useFailureCopy() {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  return useCallback((err: unknown, answer: FailureKind): FailureCopy => {
    const failure = secondFactorFailureOf(err);
    const time = failure.lockedUntil ? formatClock(failure.lockedUntil) : "";
    switch (failure.code) {
      case "second_factor_code_invalid":
        if (answer === "passkey") return { banner: formatMessage({ id: "auth.secondFactor.passkeyInvalid" }) };
        return {
          field: formatMessage({
            id: answer === "backup_code" ? "settings.twoStep.backupCodeInvalid" : "settings.twoStep.codeInvalid",
          }),
        };
      case "passkey_not_found":
        // The passkey answered with was removed meanwhile.
        return {
          banner: formatMessage({ id: answer === "passkey" ? "auth.secondFactor.passkeyInvalid" : "common.confirm.somethingWentWrong" }),
        };
      case "passkeys_unavailable":
        return { banner: formatMessage({ id: "settings.passkeys.unavailable" }) };
      case "backup_code_used":
        return { field: formatMessage({ id: "settings.twoStep.backupCodeUsed" }) };
      case "password_incorrect":
        return { field: formatMessage({ id: "settings.twoStep.passwordIncorrect" }) };
      case "second_factor_locked":
        return { banner: formatMessage({ id: "settings.twoStep.codeLocked" }, { time }) };
      case "reauth_locked":
        return { banner: formatMessage({ id: "settings.twoStep.reauthLocked" }, { time }) };
      case "totp_setup_required":
        return { banner: formatMessage({ id: "settings.twoStep.setupExpired" }) };
      case "second_factor_unavailable":
        return { banner: formatMessage({ id: "settings.twoStep.unavailable" }) };
      case "session_family_required":
        return { banner: formatMessage({ id: "settings.twoStep.signInAgain" }) };
      default:
        return { banner: formatMessage({ id: "common.confirm.somethingWentWrong" }) };
    }
  }, [formatClock, formatMessage]);
}

/** The answer state every step shares: what is typed, and the last failure. */
export function useAnswer() {
  const [value, setValue] = useState("");
  const [failure, setFailure] = useState<FailureCopy>({});
  const [busy, setBusy] = useState(false);
  const change = useCallback((next: string) => {
    setValue(next);
    setFailure((current) => (current.field ? { ...current, field: undefined } : current));
  }, []);
  const reset = useCallback(() => {
    setValue("");
    setFailure({});
  }, []);
  return { value, change, reset, failure, setFailure, busy, setBusy };
}
