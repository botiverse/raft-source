import { Suspense, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import { useAuthStore } from "../../store/authStore";
import { MAX_AUTH_RESTORE_MS } from "../../utils/authRestoreMachine";

/**
 * Auth bootstrap loading / restoring chrome (AppShell); its own module for the
 * zh-cn i18n behavior tests. Restoring for longer than MAX_AUTH_RESTORE_MS:
 * a timer never signs anyone out (restoreTimeoutPolicy) and App keeps
 * retrying, so the person gets the way out instead: reload (a fresh page and
 * bundle) or sign out (#triage:#393: the screen used to wait with no end
 * while /auth/me kept failing).
 */
export function AuthBootstrapStatus({ view, reload = reloadPage }: { view: "loading" | "restoring"; reload?: () => void }) {
  const { formatMessage } = useIntl();
  const logout = useAuthStore((s) => s.logout);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (view !== "restoring") return;
    const timer = window.setTimeout(() => setSlow(true), MAX_AUTH_RESTORE_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [view]);
  const retry = useCallback(() => reload(), [reload]);
  // Then a fresh page: a /auth/me or /auth/refresh still in flight from the
  // restore would otherwise land after the sign-out and bring the session back.
  const signOut = useCallback(() => {
    logout("explicit_user_logout");
    reload();
  }, [logout, reload]);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-layer-sidebar font-display safe-top">
      <div className="text-headline text-foreground-muted">
        {view === "restoring"
          ? formatMessage({ id: "auth.bootstrap.restoringSession" })
          : formatMessage({ id: "common.loading" })}
      </div>
      {view === "restoring" && slow && (
        <>
          <div className="text-body text-foreground-muted">{formatMessage({ id: "auth.bootstrap.restoreSlow" })}</div>
          <div className="flex items-center gap-2">
            <Button variant="default" onClick={signOut} data-testid="auth-restore-sign-out">
              {formatMessage({ id: "auth.bootstrap.signOut" })}
            </Button>
            <Button variant="primary" onClick={retry} data-testid="auth-restore-retry">
              {formatMessage({ id: "auth.bootstrap.retry" })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function reloadPage(): void {
  window.location.reload();
}

/** A landing page (pages/lazyLandingPages.ts) while its code loads: the line the auth bootstrap showed just before. */
export function Landing({ children }: { children: ReactNode }) {
  return <Suspense fallback={<AuthBootstrapStatus view="loading" />}>{children}</Suspense>;
}
