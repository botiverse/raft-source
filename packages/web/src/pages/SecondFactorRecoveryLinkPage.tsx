import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";

import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import ForgotPasswordPage from "../components/auth/ForgotPasswordPage";
import {
  RECOVERY_CANCEL_PARAM,
  RECOVERY_CONFIRM_PARAM,
  cancelSecondFactorRecoveryByLink,
  confirmSecondFactorRecovery,
} from "../components/auth/secondFactorRecovery";
import type { SecondFactorRecovery, SecondFactorRecoveryLinkToken } from "../components/auth/secondFactorRecovery";
import { secondFactorFailureOf } from "../components/settings/secondFactorApi";
import Banner from "../components/ui/Banner";
import { useTimeFormatter } from "../hooks/useTimeFormatter";

// Where the two-step verification reset emails land (#triage:#135, design v2
// reset-status; server: routes/secondFactor.ts "Email recovery"):
//   - `?second_factor_recovery=<token>` (confirm): starts the 72-hour wait,
//     then says from when a sign-in can finish it.
//   - `?cancel_second_factor_recovery=<token>` (cancel): ends the request.
// Signed in or not: the token alone decides. Both act only on a click, never
// the page load, so a mail scanner that opens the link changes nothing
// (like DeviceLoginRevokePage). A used, expired or unknown link (also the
// flag off: 400 recovery_token_invalid) says so and offers no second try.

type Mode = "confirm" | "cancel";

type State =
  | { kind: "ready" }
  | { kind: "working" }
  | { kind: "started"; recovery: SecondFactorRecovery | null }
  | { kind: "cancelled" }
  | { kind: "failed"; final: boolean };

export default function SecondFactorRecoveryLinkPage({ mode, token }: { mode: Mode; token: SecondFactorRecoveryLinkToken | null }) {
  const { formatMessage } = useIntl();
  const { formatMediumDateTime } = useTimeFormatter();
  const [state, setState] = useState<State>(token ? { kind: "ready" } : { kind: "failed", final: true });
  const [settingPassword, setSettingPassword] = useState(false);

  // The token stays out of the address bar and history once read.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(RECOVERY_CONFIRM_PARAM) && !url.searchParams.has(RECOVERY_CANCEL_PARAM)) return;
    url.searchParams.delete(RECOVERY_CONFIRM_PARAM);
    url.searchParams.delete(RECOVERY_CANCEL_PARAM);
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, []);

  const handleAct = useCallback(async () => {
    if (!token) return;
    setState({ kind: "working" });
    try {
      if (mode === "confirm") {
        setState({ kind: "started", recovery: await confirmSecondFactorRecovery(token) });
      } else {
        await cancelSecondFactorRecoveryByLink(token);
        setState({ kind: "cancelled" });
      }
    } catch (err) {
      setState({ kind: "failed", final: secondFactorFailureOf(err).code === "recovery_token_invalid" });
    }
  }, [mode, token]);
  const handleGoToRaft = useCallback(() => {
    window.location.assign("/");
  }, []);
  const showSetPassword = useCallback(() => setSettingPassword(true), []);
  const hideSetPassword = useCallback(() => setSettingPassword(false), []);

  if (settingPassword) return <ForgotPasswordPage onBack={hideSetPassword} />;

  const goToRaft = (
    <Button type="button" onClick={handleGoToRaft} size="xl" variant="accent" className="w-full">
      {formatMessage({ id: "auth.recovery.goToRaft" })}
    </Button>
  );

  if (state.kind === "started") {
    const { recovery } = state;
    const needsPassword = recovery?.firstFactorRequired === "set_password";
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="second-factor-recovery-started">
          <AuthPageIntro
            title={formatMessage({ id: "auth.recovery.statusPending" })}
            description={recovery
              ? formatMessage(
                { id: "auth.recovery.statusPendingDescription" },
                { eligibleAt: formatMediumDateTime(recovery.eligibleAt), expiresAt: formatMediumDateTime(recovery.expiresAt) },
              )
              : formatMessage({ id: "auth.recovery.statusPendingNoTime" })}
          />
          <Banner intent="info" live={false} className="mb-4">{formatMessage({ id: "auth.recovery.statusPendingNotYou" })}</Banner>
          {needsPassword ? (
            <>
              <Banner intent="warning" withIcon live={false} className="mb-4">
                {formatMessage({ id: "auth.recovery.setPasswordFirst" })}
              </Banner>
              <Button type="button" onClick={showSetPassword} size="xl" variant="accent" className="mb-3 w-full">
                {formatMessage({ id: "auth.recovery.setPassword" })}
              </Button>
              <Button type="button" onClick={handleGoToRaft} size="xl" variant="outline" className="w-full">
                {formatMessage({ id: "auth.recovery.goToRaft" })}
              </Button>
            </>
          ) : goToRaft}
        </div>
      </AuthPageFrame>
    );
  }

  if (state.kind === "cancelled") {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="second-factor-recovery-cancelled">
          <AuthPageIntro
            title={formatMessage({ id: "auth.recovery.cancelledTitle" })}
            description={formatMessage({ id: "auth.recovery.cancelledDescription" })}
          />
          {goToRaft}
        </div>
      </AuthPageFrame>
    );
  }

  const confirm = mode === "confirm";
  const failed = state.kind === "failed" ? state : null;
  return (
    <AuthPageFrame>
      <div className="w-full" data-testid={confirm ? "second-factor-recovery-confirm" : "second-factor-recovery-cancel"}>
        <AuthPageIntro
          title={formatMessage({ id: confirm ? "auth.recovery.confirmTitle" : "auth.recovery.cancelTitle" })}
          description={formatMessage({ id: confirm ? "auth.recovery.confirmDescription" : "auth.recovery.cancelDescription" })}
        />
        {failed ? (
          <Banner intent="warning" className="mb-4">
            {formatMessage({
              id: failed.final
                ? (confirm ? "auth.recovery.confirmLinkInvalid" : "auth.recovery.cancelLinkInvalid")
                : "auth.recovery.linkFailed",
            })}
          </Banner>
        ) : null}
        {failed?.final ? goToRaft : (
          <Button
            type="button"
            onClick={handleAct}
            disabled={state.kind === "working"}
            loading={state.kind === "working"}
            size="xl"
            variant="accent"
            className="w-full"
          >
            {formatMessage({ id: confirm ? "auth.recovery.startReset" : "auth.recovery.cancelReset" })}
          </Button>
        )}
      </div>
    </AuthPageFrame>
  );
}
