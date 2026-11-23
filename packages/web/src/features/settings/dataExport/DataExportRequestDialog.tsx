/**
 * Asking for a data export (personal or server, by its mount): the scope step
 * (the caller's), then the proof the server asks for: step-up with two-step
 * verification (`withSecondFactorStepUp`, reason `dataExport`), the password,
 * or an emailed code. A refusal the steps don't answer shows as a banner.
 */
import { DialogDescription, TextLink } from "@botiverse/raft-ui";
import type { DataExportScope } from "@botiverse/raft-shared";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

import { secondFactorFailureOf, normalizeEnteredCode } from "../../../components/settings/secondFactorApi";
import { useAnswer, useFailureCopy } from "../../../components/settings/secondFactorAnswer";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../../../components/settings/secondFactorStepUp";
import { AnswerField, CancelButton, CommitButton, StepDialog } from "../../../components/settings/TwoStepVerificationSection";
import Banner from "../../../components/ui/Banner";
import { useAuthStore } from "../../../store/authStore";
import { dataExportRefusalOf, requestDataExport, sendDataExportEmailCode } from "./dataExportApi";
import type { DataExportMount, DataExportProof, DataExportRefusal } from "./dataExportApi";
import { useDay } from "./dataExportHooks";

type Step = "scope" | "password" | "email_code";

type RefusalCopyId =
  | "dataExport.sessionTooNew" | "dataExport.signInAgain" | "dataExport.inFlight" | "dataExport.cooldown" | "dataExport.serverNotFound" | "dataExport.failed"
  | "serverDataExport.cooldown" | "serverDataExport.ownerOnly" | "serverDataExport.windowOver";

/** What a refused request shows in the dialog's banner (the reauth steps are steps, not banners). */
function refusalCopyId(mount: DataExportMount, refusal: DataExportRefusal): RefusalCopyId {
  switch (refusal.kind) {
    case "server_not_found": return "dataExport.serverNotFound";
    case "session_too_new": return "dataExport.sessionTooNew";
    case "sign_in_again": return "dataExport.signInAgain";
    case "in_flight": return "dataExport.inFlight";
    case "cooldown": return mount.kind === "server" ? "serverDataExport.cooldown" : "dataExport.cooldown";
    case "owner_only": return "serverDataExport.ownerOnly";
    case "window_over": return "serverDataExport.windowOver";
    default: return "dataExport.failed";
  }
}

/** Password and code failures the step-up copy words (a wrong password, a lock). */
const ANSWER_FAILURE_CODES = new Set(["password_incorrect", "reauth_locked", "second_factor_locked"]);

export function DataExportRequestDialog({ mount, title, scope, validate, scopeStep, onClose, onCreated }: {
  mount: DataExportMount;
  title: string;
  scope: DataExportScope;
  /** Before the scope step submits: false keeps the dialog on it (the caller shows why). */
  validate?: () => boolean;
  /** The scope step's fields; `busy` while a request is out. */
  scopeStep: (busy: boolean) => ReactNode;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { formatMessage } = useIntl();
  const day = useDay();
  const email = useAuthStore((state) => state.user?.email ?? "");
  const describeAnswer = useFailureCopy();
  const answer = useAnswer();
  const { setBusy, setFailure, reset } = answer;
  const [step, setStep] = useState<Step>("scope");
  const [codeSent, setCodeSent] = useState(false);
  const [sending, setSending] = useState(false);

  const submit = useCallback((proof: DataExportProof) => {
    setBusy(true);
    setFailure({});
    void withSecondFactorStepUp(() => requestDataExport(mount, scope, proof), "dataExport").then(onCreated, (err: unknown) => {
      setBusy(false);
      if (isSecondFactorStepUpCancelled(err)) return;
      const code = secondFactorFailureOf(err).code;
      if (code && ANSWER_FAILURE_CODES.has(code)) {
        setFailure(describeAnswer(err, step === "email_code" ? "totp" : "password"));
        return;
      }
      const refusal = dataExportRefusalOf(err);
      if (refusal.kind === "reauth") {
        reset();
        setStep(refusal.method);
        return;
      }
      if (refusal.kind === "email_code_invalid") {
        setFailure({ field: formatMessage({ id: "dataExport.emailCodeInvalid" }) });
        return;
      }
      const date = refusal.kind === "cooldown" && refusal.retryAt ? day(refusal.retryAt.toISOString()) : "";
      setFailure({ banner: formatMessage({ id: refusalCopyId(mount, refusal) }, { date }) });
    });
  }, [day, describeAnswer, formatMessage, mount, onCreated, reset, scope, setBusy, setFailure, step]);

  const sendCode = useCallback(() => {
    setSending(true);
    setFailure({});
    void sendDataExportEmailCode(mount).then(() => {
      reset();
      setCodeSent(true);
    }, (err: unknown) => {
      // One went out a moment ago: it still works.
      if (secondFactorFailureOf(err).code === "email_code_recently_sent") setCodeSent(true);
      else setFailure({ banner: formatMessage({ id: "dataExport.failed" }) });
    }).finally(() => setSending(false));
  }, [formatMessage, mount, reset, setFailure]);

  const handleSubmit = useCallback(() => {
    if (step === "scope") {
      if (validate && !validate()) return;
      submit({});
    } else if (step === "password") {
      if (answer.value) submit({ password: answer.value });
    } else if (!codeSent) {
      sendCode();
    } else {
      const code = normalizeEnteredCode(answer.value);
      if (code) submit({ emailCode: code });
    }
  }, [answer.value, codeSent, sendCode, step, submit, validate]);

  const busy = answer.busy || sending;
  const commitLabel = step === "email_code" && !codeSent
    ? formatMessage({ id: "dataExport.emailSendCode" })
    : formatMessage({ id: "dataExport.submit" });
  return (
    <StepDialog
      title={title}
      narrow="centered"
      size="md"
      busy={busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId={`data-export-dialog-${step}`}
      footer={(
        <>
          <CancelButton busy={busy} onClose={onClose} />
          <CommitButton label={commitLabel} busy={busy} disabled={step === "password" && !answer.value} testId="data-export-submit" />
        </>
      )}
    >
      {step === "scope" ? scopeStep(busy) : null}
      {step === "password" ? (
        <AnswerField kind="password" label={formatMessage({ id: "dataExport.passwordLabel" })} value={answer.value} onChange={answer.change} error={answer.failure.field} />
      ) : null}
      {step === "email_code" && !codeSent ? (
        <DialogDescription>{formatMessage({ id: "dataExport.emailBeforeSend" }, { email })}</DialogDescription>
      ) : null}
      {step === "email_code" && codeSent ? (
        <>
          <AnswerField kind="totp" label={formatMessage({ id: "dataExport.emailCodeSentLabel" }, { email })} value={answer.value} onChange={answer.change} error={answer.failure.field} />
          <div>
            <TextLink type="button" onClick={sendCode} disabled={busy}>{formatMessage({ id: "dataExport.emailResend" })}</TextLink>
          </div>
        </>
      ) : null}
      {answer.failure.banner ? <Banner intent="warning" density="sm" data-testid="data-export-dialog-banner">{answer.failure.banner}</Banner> : null}
    </StepDialog>
  );
}
