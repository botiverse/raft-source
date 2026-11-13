import { useState, useEffect, useEffectEvent, useCallback, useRef } from "react";
import { Input, Button, TextLink } from "@botiverse/raft-ui";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuthStore } from "../../store/authStore";
import { RefreshCw, LogOut, Link } from "lucide-react";
import Banner from "../ui/Banner";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";
import { getCurrentReturnTo, sanitizeReturnTo } from "../../utils/socialAuth";
import { continueAfterVerify, verificationTokenFromInput } from "./verificationLanding";

interface EmailVerificationPageProps {
  initialToken?: string | null;
  /** The verification link's `returnTo` (#88): the page signed up from, where Continue lands. */
  initialReturnTo?: string | null;
  /** Verified: the server-validated page to land on ("/" for none). The app goes there (it no longer shows this page). */
  onVerified?: (landing: string) => void;
}

export default function EmailVerificationPage({ initialToken, initialReturnTo, onVerified }: EmailVerificationPageProps) {
  const { formatMessage } = useIntl();
  const verifyEmail = useAuthStore((s) => s.verifyEmail);
  const resendVerification = useAuthStore((s) => s.resendVerification);
  const checkEmailVerified = useAuthStore((s) => s.checkEmailVerified);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [resendSuccess, setResendSuccess] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualToken, setManualToken] = useState("");
  // Where verifying should land (#88): from the email's link, the page it names; here at the page signed up
  // from (an Artifact link), this page. Sent to the server, which validates it and hands it back on verify.
  const [returnTo] = useState(() => (initialToken ? initialReturnTo ?? null : getCurrentReturnTo()));
  // Set once verified: the server-validated page to land on, "/" when there is none.
  const [landing, setLanding] = useState("/");

  const handleVerify = useCallback(async (token: string) => {
    setVerifying(true);
    setError("");
    try {
      const next = sanitizeReturnTo(await verifyEmail(token, returnTo));
      setLanding(next);
      setVerified(true);
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete("verify");
      window.history.replaceState({}, "", url.pathname + url.hash);
      onVerified?.(next);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "pages.emailVerification.verifyFailed" }));
    } finally {
      setVerifying(false);
    }
  }, [verifyEmail, formatMessage, returnTo, onVerified]);

  // Auto-verify if token provided via URL. useEffectEvent: only a NEW
  // initialToken may trigger verification — a locale switch (new formatMessage
  // → new handleVerify identity) must not re-verify an already-consumed token
  // (Josh, task #709).
  const verifyOnLoad = useEffectEvent((token: string) => {
    void handleVerify(token);
  });
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (initialToken) {
      // oxlint-disable-next-line react-doctor/no-pass-live-state-to-parent -- the link's one verification (a request), not state synced up: its answer, where to land, goes to the app once (onVerified)
      verifyOnLoad(initialToken);
    }
  }, [initialToken]);

  // The link opened somewhere else (another tab, the phone's mail app): coming back to this page re-checks the
  // account, so the app moves on by itself instead of waiting for a reload.
  const checking = useRef(false);
  const recheckVerified = useEffectEvent(() => {
    if (document.visibilityState !== "visible" || checking.current) return;
    checking.current = true;
    void checkEmailVerified().catch(() => false).finally(() => { checking.current = false; });
  });
  useEffect(() => {
    const onReturn = () => recheckVerified();
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  const handleResend = useCallback(async () => {
    setResending(true);
    setError("");
    setResendSuccess(false);
    try {
      await resendVerification(returnTo);
      setResendSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "pages.emailVerification.resendFailed" }));
    } finally {
      setResending(false);
    }
  }, [resendVerification, formatMessage, returnTo]);

  const handleManualSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    const token = verificationTokenFromInput(manualToken);
    if (token) {
      void handleVerify(token);
    }
  }, [manualToken, handleVerify]);

  const handleManualTokenChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setManualToken(e.target.value);
  }, []);

  const handleLogout = useCallback(() => {
    void logout();
  }, [logout]);
  // Paste Link opens the box; Cancel closes it and drops what was typed.
  const toggleManualInput = useCallback(() => {
    setShowManualInput((open) => !open);
    setManualToken("");
  }, []);
  const handleContinue = useCallback(() => continueAfterVerify(landing), [landing]);

  if (verified) {
    return (
      <CenteredCardFrame>
        <div className="w-full">
          <AuthPageIntro
            title={formatMessage({ id: "pages.emailVerification.verifiedTitle" })}
            description={formatMessage({ id: "pages.emailVerification.verifiedDescription" })}
          />
          <Button
            onClick={handleContinue}
            size="xl"
            variant="accent"
            className="w-full"
          >
            {formatMessage({ id: "pages.emailVerification.continueToRaft" })}
          </Button>
        </div>
      </CenteredCardFrame>
    );
  }

  return (
    <CenteredCardFrame>
      <div className="w-full">
        <AuthPageIntro title={formatMessage({ id: "pages.emailVerification.checkEmailTitle" })}>
          <p className="mt-2 text-callout text-foreground-muted">
            {formatMessage({ id: "pages.emailVerification.sentLinkTo" })}
          </p>
          <p className="mt-1 font-mono text-mono-code font-bold text-foreground">{user?.email}</p>
          <p className="mt-2 text-footnote text-foreground-muted">
            {formatMessage({ id: "pages.emailVerification.checkSpam" })}
          </p>
        </AuthPageIntro>

        {error && (
          <Banner intent="warning" className="mb-4">
            {error}
          </Banner>
        )}

        {resendSuccess && (
          <Banner intent="success" className="mb-4">
            {formatMessage({ id: "pages.emailVerification.resent" })}
          </Banner>
        )}

        {verifying && (
          <div className="mb-4 text-center text-callout text-foreground-muted">
            {formatMessage({ id: "pages.emailVerification.verifying" })}
          </div>
        )}

        <div className="stack-y-3">
          <Button
            onClick={handleResend}
            disabled={resending}
            size="xl"
            variant="accent"
            className="w-full"
          >
            <RefreshCw size={16} className={resending ? "animate-spin" : ""} />
            {resending
              ? formatMessage({ id: "pages.emailVerification.sending" })
              : formatMessage({ id: "pages.emailVerification.resendAction" })}
          </Button>

          {/* Manual token entry */}
          <div className="text-center">
            <TextLink
              onClick={toggleManualInput}
              className="inline-flex items-center gap-1 text-footnote"
            >
              {showManualInput ? null : <Link size={14} className="shrink-0 text-foreground-muted" />}
              {showManualInput
                ? formatMessage({ id: "pages.emailVerification.cancelPasteLink" })
                : formatMessage({ id: "pages.emailVerification.pasteLinkAction" })}
            </TextLink>
          </div>

          {showManualInput && (
            // mb-1.5: the text-link rows above read ~18px apart; the box row matches them.
            <form onSubmit={handleManualSubmit} className="mb-1.5 flex gap-2">
              <Input
                type="text"
                className="flex-1"
                value={manualToken}
                onChange={handleManualTokenChange}
                placeholder={formatMessage({ id: "pages.emailVerification.linkPlaceholder" })}
              />
              <Button size="lg"
                type="submit"
                variant="outline"
                disabled={verifying || !manualToken.trim()}
              >
                {verifying ? "…" : formatMessage({ id: "pages.emailVerification.verifyAction" })}
              </Button>
            </form>
          )}

          <Button
            variant="default"
            size="lg"
            className="w-full"
            onClick={handleLogout}
          >
            <LogOut size={18} />
            {formatMessage({ id: "pages.emailVerification.logOut" })}
          </Button>
        </div>
      </div>
    </CenteredCardFrame>
  );
}
