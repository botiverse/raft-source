import { assertAccountLinkCompleted, clearPendingAccountLink, failPendingAccountLink, pendingAccountLinkFromError, setPendingAccountLink, usePendingAccountLink } from "../../utils/pendingAccountLink";
import LoginPage from "./LoginPage";
import ForgotPasswordPage from "./ForgotPasswordPage";
import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { AxiosResponse } from "axios";
import type { PendingAccountLink } from "../../utils/pendingAccountLink";
import type { IntlShape } from "react-intl";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { getExternalBrowserLoginUrl, isEmbeddedUserAgentProviderError, PENDING_INVITE_STORAGE_KEY, sanitizeReturnTo, takePendingInviteRedirectPath } from "../../utils/socialAuth";
import { completeSocialAuthWithOneLinkRefresh } from "../../utils/socialAuthCompletion";
import { refreshTokensWithDedupe } from "../../utils/refreshCoordinator";
import Banner from "../ui/Banner";
import { Button } from "@botiverse/raft-ui";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";
import LegalAcceptanceCheckbox, { LegalAcceptanceUsageDataNotice } from "./LegalAcceptanceCheckbox";
import OpenInBrowserSignInGuide from "./OpenInBrowserSignInGuide";
import SecondFactorSignInStep from "./SecondFactorSignInStep";
import { readSecondFactorChallenge } from "./secondFactorSignIn";
import type { SecondFactorChallenge } from "./secondFactorSignIn";

function isSocialAuthProviderId(value: string | null): value is SocialAuthProviderId {
  return value === "google" || value === "github" || value === "apple";
}

function navigateHome() {
  window.location.replace("/");
}

// Settings "Connect" failures the user can act on. provider_conflict covers
// more than one situation and only the server's English message tells them
// apart, so match conservatively and fall back to generic copy; the raw server
// text is never shown, and no copy says which account holds anything.
function linkFailureMessageId(data: { code?: unknown; error?: unknown } | undefined) {
  if (data?.code === "email_verification_required") return "pages.socialCallback.linkEmailUnverified" as const;
  if (data?.code !== "provider_conflict") return null;
  const message = typeof data.error === "string" ? data.error : "";
  if (message.includes("already linked to another")) return "pages.socialCallback.linkConflictIdentity" as const;
  return "pages.socialCallback.linkConflictGeneric" as const;
}

function getProviderLabel(
  provider: SocialAuthProviderId | null,
  formatMessage: IntlShape["formatMessage"],
): string {
  switch (provider) {
    case "google":
      return "Google";
    case "github":
      return "GitHub";
    case "apple":
      return "Apple";
    default:
      return formatMessage({ id: "auth.social.providerFallback" });
  }
}

interface SocialAuthCompletionData {
  mode?: string;
  accessToken?: string;
  refreshToken?: string;
  returnTo?: string;
  linkedProvider?: string;
}

/**
 * Signed in with a provider (the completion's body, or its second step's,
 * which is the same): store the session, then land where the sign-in began.
 */
async function enterSocialSignIn(
  data: SocialAuthCompletionData & { accessToken: string; refreshToken: string },
  pendingLink: PendingAccountLink | null,
  fallbackReturnTo: string,
  session: { setTokens: (accessToken: string, refreshToken: string) => void; loadUser: () => Promise<void> },
): Promise<void> {
  if (pendingLink) {
    assertAccountLinkCompleted(data, pendingLink);
    clearPendingAccountLink(pendingLink.token);
  }
  session.setTokens(data.accessToken, data.refreshToken);

  const pendingInviteRedirect = takePendingInviteRedirectPath();
  if (pendingInviteRedirect) {
    // Let the normal invite page consume the token after the OAuth round-trip.
    // Loading the user here would race App's pending-invite effect with this
    // callback redirect and can drop the invite before it is accepted.
    window.location.replace(pendingInviteRedirect);
    return;
  }

  await session.loadUser();
  window.location.replace(sanitizeReturnTo(data.returnTo ?? fallbackReturnTo));
}

/** The provider sign-in's second step (two-step verification is on), and the link it may finish. */
type SocialSecondStep = { challenge: SecondFactorChallenge; pendingLink: PendingAccountLink | null };

export default function SocialAuthCallbackPage() {
  const { formatMessage } = useIntl();
  const setTokens = useAuthStore((state) => state.setTokens);
  const loadUser = useAuthStore((state) => state.loadUser);
  const completionEpoch = useRef(0);
  // React StrictMode replays effect setup. Both observers must share the same
  // one-time exchange and its original continuation; only the live observer acts.
  const initialCompletion = useRef<{
    pendingLink: PendingAccountLink | null;
    result: Promise<AxiosResponse<SocialAuthCompletionData>>;
  } | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [forgotPassword, setForgotPassword] = useState(false);
  const [error, setError] = useState("");
  const [needsLegalAcceptance, setNeedsLegalAcceptance] = useState(false);
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const usageDataNoticeId = useId();
  const [secondStep, setSecondStep] = useState<SocialSecondStep | null>(null);

  const callbackParams = useMemo(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const provider = searchParams.get("provider");
    return {
      provider: isSocialAuthProviderId(provider) ? provider : null,
      mode: searchParams.get("mode"),
      code: searchParams.get("code"),
      returnTo: sanitizeReturnTo(searchParams.get("returnTo")),
      error: searchParams.get("error"),
    };
  }, []);

  const finishSignIn = useCallback(async (includeLegalAcceptance: boolean) => {
    const epoch = ++completionEpoch.current;
    setFinishing(true);
    setError("");
    try {
      if (callbackParams.error) {
        const pending = callbackParams.mode === "link" ? null : usePendingAccountLink.getState().pending;
        if (pending) {
          failPendingAccountLink(pending.token, { response: { data: { code: callbackParams.error } } });
          setRecovery(true);
          return;
        }
        setError(callbackParams.error);
        return;
      }

      if (!callbackParams.provider) {
        setError(formatMessage({ id: "pages.socialCallback.providerNotSupported" }));
        return;
      }

      if (!callbackParams.code) {
        setError(formatMessage(
          { id: "pages.socialCallback.noCode" },
          { provider: getProviderLabel(callbackParams.provider, formatMessage) },
        ));
        return;
      }

      let pendingLink = callbackParams.mode === "link" ? null : usePendingAccountLink.getState().pending;
      const completionBody = {
        ...(pendingLink ? { pendingLinkToken: pendingLink.token } : {}),
        code: callbackParams.code,
        ...(includeLegalAcceptance
          ? {
              acceptTerms: true,
              termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
              privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
              legalAcceptanceSource: window.localStorage.getItem(PENDING_INVITE_STORAGE_KEY) ? "invite" : "oauth",
            }
          : {}),
      };
      const requestCompletion = () => completeSocialAuthWithOneLinkRefresh({
        mode: callbackParams.mode,
        // withCredentials: the code completes only with the cookie its callback left in this browser.
        complete: () => api.post<SocialAuthCompletionData>(`/auth/${callbackParams.provider}/complete`, completionBody, { withCredentials: true }),
        refresh: refreshTokensWithDedupe,
      });
      if (!includeLegalAcceptance && !initialCompletion.current) {
        initialCompletion.current = { pendingLink, result: requestCompletion() };
      }
      const completion = includeLegalAcceptance ? requestCompletion() : initialCompletion.current!.result;
      if (!includeLegalAcceptance) pendingLink = initialCompletion.current!.pendingLink;
      const { data } = await completion;

      if (epoch !== completionEpoch.current) return;

      // Two-step verification is on for this account: no session yet, the
      // second step's answer carries it (design v2 step-code).
      const challenge = callbackParams.mode === "link" ? null : readSecondFactorChallenge(data);
      if (challenge) {
        setSecondStep({ challenge, pendingLink });
        return;
      }

      if (data.mode === "login") {
        if (!data.accessToken || !data.refreshToken) {
          setError(formatMessage(
          { id: "pages.socialCallback.noSession" },
          { provider: getProviderLabel(callbackParams.provider, formatMessage) },
        ));
          return;
        }
        await enterSocialSignIn(
          { ...data, accessToken: data.accessToken, refreshToken: data.refreshToken },
          pendingLink,
          callbackParams.returnTo,
          { setTokens, loadUser },
        );
        return;
      }

      if (data.mode === "link") {
        window.location.replace(sanitizeReturnTo(data.returnTo ?? callbackParams.returnTo));
        return;
      }

      setError(formatMessage({ id: "pages.socialCallback.invalidCallback" }));
    } catch (err: any) {
      if (epoch !== completionEpoch.current) return;
      const conflict = callbackParams.mode !== "link" && pendingAccountLinkFromError(err);
      if (conflict) {
        setPendingAccountLink(conflict);
        setRecovery(true);
        return;
      }
      const pending = usePendingAccountLink.getState().pending;
      if (callbackParams.mode !== "link" && pending) {
        failPendingAccountLink(pending.token, err);
        setRecovery(true);
        return;
      }
      const linkFailureId = callbackParams.mode === "link" ? linkFailureMessageId(err?.response?.data) : null;
      if (linkFailureId) {
        setError(formatMessage(
          { id: linkFailureId },
          { provider: getProviderLabel(callbackParams.provider, formatMessage) },
        ));
        return;
      }
      const errorCode = err?.response?.data?.error;
      if (errorCode === "LEGAL_ACCEPTANCE_REQUIRED" || errorCode === "TERMS_CHANGED") {
        setNeedsLegalAcceptance(true);
        setError(errorCode === "TERMS_CHANGED"
          ? formatMessage({ id: "pages.socialCallback.legalChanged" })
          : "");
        return;
      }
      setError(err?.response?.data?.error || err?.message || formatMessage({ id: "pages.socialCallback.finishFailed" }));
    } finally {
      if (epoch === completionEpoch.current) setFinishing(false);
    }
  }, [callbackParams, loadUser, setTokens, formatMessage]);

  const finishSecondStep = useCallback(async (body: unknown) => {
    const data = body as SocialAuthCompletionData;
    if (!data.accessToken || !data.refreshToken) throw new Error("second_factor_no_session");
    await enterSocialSignIn(
      { ...data, accessToken: data.accessToken, refreshToken: data.refreshToken },
      secondStep?.pendingLink ?? null,
      callbackParams.returnTo,
      { setTokens, loadUser },
    );
  }, [callbackParams.returnTo, loadUser, secondStep?.pendingLink, setTokens]);

  const isLinkMode = callbackParams.mode === "link";
  // A Settings connect returns to where it started (the link flow's returnTo), not to sign-in.
  const handleBack = useCallback(() => {
    if (isLinkMode) window.location.replace(callbackParams.returnTo);
    else navigateHome();
  }, [callbackParams.returnTo, isLinkMode]);

  const showRecoveryForgotPassword = useCallback(() => setForgotPassword(true), []);
  const showRecoveryLogin = useCallback(() => setForgotPassword(false), []);

  const handleFinishWithLegalAcceptance = useCallback(() => {
    void finishSignIn(true);
  }, [finishSignIn]);

  useLayoutEffect(() => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (!needsLegalAcceptance && !recovery) {
      void finishSignIn(false);
    }
    return () => { completionEpoch.current += 1; };
  }, [finishSignIn, needsLegalAcceptance, recovery]);

  if (recovery) {
    return forgotPassword
      ? <ForgotPasswordPage onBack={showRecoveryLogin} />
      : <LoginPage onForgotPassword={showRecoveryForgotPassword} />;
  }

  if (secondStep) {
    return (
      <SecondFactorSignInStep
        challenge={secondStep.challenge}
        onSignedIn={finishSecondStep}
        onBack={navigateHome}
      />
    );
  }

  if (isEmbeddedUserAgentProviderError(callbackParams.error)) {
    return <OpenInBrowserSignInGuide loginUrl={getExternalBrowserLoginUrl(callbackParams.returnTo)} />;
  }

  if (!needsLegalAcceptance && !error) {
    return null;
  }

  return (
    <CenteredCardFrame>
      <div className="w-full">
        <AuthPageIntro
          title={formatMessage(
            { id: isLinkMode ? "pages.socialCallback.providerLinkTitle" : "pages.socialCallback.providerSignInTitle" },
            { provider: getProviderLabel(callbackParams.provider, formatMessage) },
          )}
        />
        {needsLegalAcceptance ? (
          <div className="stack-y-4">
            {error && (
              <Banner intent="warning">
                {error}
              </Banner>
            )}
            <LegalAcceptanceCheckbox
              checked={acceptedLegal}
              onChange={setAcceptedLegal}
              disabled={finishing}
            />
            <Button
              type="button"
              disabled={!acceptedLegal || finishing}
              onClick={handleFinishWithLegalAcceptance}
              aria-describedby={usageDataNoticeId}
              size="xl"
              variant="accent"
              className="w-full"
            >
              {finishing ? formatMessage({ id: "pages.socialCallback.finishing" }) : formatMessage({ id: "pages.socialCallback.continue" })}
            </Button>
            <LegalAcceptanceUsageDataNotice id={usageDataNoticeId} />
          </div>
        ) : error ? (
          <div className="stack-y-3">
            <Banner intent="warning">
              {error}
            </Banner>
            <Button size="lg"
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleBack}
            >
              {formatMessage({ id: isLinkMode ? "pages.socialCallback.backToSettings" : "auth.backToSignIn.button" })}
            </Button>
          </div>
        ) : (
          <div className="text-center text-callout text-foreground-muted">{formatMessage({ id: "pages.socialCallback.finishingSignIn" })}</div>
        )}
      </div>
    </CenteredCardFrame>
  );
}
