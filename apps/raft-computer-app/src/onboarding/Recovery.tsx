import React from "react";
import { Button, Pill, TextLink } from "./ui.js";
import {
  buildRecoveryDiagnostics,
  recoveryErrorCode,
  scrubRecoveryDetail,
} from "./recoveryDiagnostics.js";

const RECOVERY_TITLES: Record<string, string> = {
  "sign-in": "Couldn't sign in",
  connect: "Couldn't connect this Computer",
  "bring-online": "Couldn't bring this Computer online",
};

const RECOVERY_DESCRIPTIONS: Record<string, string> = {
  "sign-in":
    "Something went wrong during sign-in. Give it another try.",
  connect:
    "Something didn't complete. Your sign-in is saved — give it another try.",
  "bring-online":
    "Something didn't complete. Your connection is saved — give it another try.",
};

export function Recovery({
  failedStep,
  message,
  errorCode,
  actionId,
  onRetry,
  onClose,
}: {
  failedStep: "sign-in" | "connect" | "bring-online";
  message: string;
  errorCode?: string;
  actionId: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const detail = scrubRecoveryDetail(message);
  const code = recoveryErrorCode(errorCode);
  const diagnostics = buildRecoveryDiagnostics({
    failedStep,
    message,
    errorCode,
    actionId,
  });

  const handleCopyDiagnostics = () => {
    void window.onboardingApi.copyText(diagnostics).catch(() => {});
  };

  return (
    <div className="onb-card onb-card--center onb-card--recovery">
      <Pill>SETUP PAUSED</Pill>
      <h1 className="onb-title">{RECOVERY_TITLES[failedStep]}</h1>
      <p className="onb-desc">{RECOVERY_DESCRIPTIONS[failedStep]}</p>
      <p className="onb-error-detail">{detail}</p>
      <p className="onb-error-meta">
        Error {code} · Action {actionId}
      </p>
      <div className="onb-spacer" />
      <Button onClick={onRetry}>Try again</Button>
      <Button onClick={handleCopyDiagnostics} variant="dark">
        Copy diagnostics
      </Button>
      <TextLink onClick={onClose}>Close</TextLink>
    </div>
  );
}
