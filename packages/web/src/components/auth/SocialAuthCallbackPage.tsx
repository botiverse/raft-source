import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { getExternalBrowserLoginUrl, isEmbeddedUserAgentProviderError, PENDING_INVITE_STORAGE_KEY, sanitizeReturnTo, takePendingInviteRedirectPath } from "../../utils/socialAuth";
import { completeSocialAuthWithOneLinkRefresh } from "../../utils/socialAuthCompletion";
import { refreshTokensWithDedupe } from "../../utils/refreshCoordinator";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";
import LegalAcceptanceCheckbox from "./LegalAcceptanceCheckbox";
import OpenInBrowserSignInGuide from "./OpenInBrowserSignInGuide";

function isSocialAuthProviderId(value: string | null): value is SocialAuthProviderId {
  return value === "google" || value === "github" || value === "apple";
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

export default function SocialAuthCallbackPage() {
  const { formatMessage } = useIntl();
  const setTokens = useAuthStore((state) => state.setTokens);
  const loadUser = useAuthStore((state) => state.loadUser);
  const [error, setError] = useState("");
  const [needsLegalAcceptance, setNeedsLegalAcceptance] = useState(false);
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [finishing, setFinishing] = useState(false);

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
    setFinishing(true);
    setError("");
    try {
      if (callbackParams.error) {
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

      const completionBody = {
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
      const { data } = await completeSocialAuthWithOneLinkRefresh({
        mode: callbackParams.mode,
        complete: () => api.post(`/auth/${callbackParams.provider}/complete`, completionBody),
        refresh: refreshTokensWithDedupe,
      });

      if (data.mode === "login") {
        if (!data.accessToken || !data.refreshToken) {
          setError(formatMessage(
          { id: "pages.socialCallback.noSession" },
          { provider: getProviderLabel(callbackParams.provider, formatMessage) },
        ));
          return;
        }
        setTokens(data.accessToken, data.refreshToken);

        const pendingInviteRedirect = takePendingInviteRedirectPath();
        if (pendingInviteRedirect) {
          // Let the normal invite page consume the token after the OAuth round-trip.
          // Loading the user here would race App's pending-invite effect with this
          // callback redirect and can drop the invite before it is accepted.
          window.location.replace(pendingInviteRedirect);
          return;
        }

        await loadUser();
        window.location.replace(sanitizeReturnTo(data.returnTo ?? callbackParams.returnTo));
        return;
      }

      if (data.mode === "link") {
        window.location.replace(sanitizeReturnTo(data.returnTo ?? callbackParams.returnTo));
        return;
      }

      setError(formatMessage({ id: "pages.socialCallback.invalidCallback" }));
    } catch (err: any) {
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
      setFinishing(false);
    }
  }, [callbackParams, loadUser, setTokens, formatMessage]);

  useLayoutEffect(() => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (!needsLegalAcceptance) {
      void finishSignIn(false);
    }
  }, [finishSignIn, needsLegalAcceptance]);

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
            { id: "pages.socialCallback.providerSignInTitle" },
            { provider: getProviderLabel(callbackParams.provider, formatMessage) },
          )}
        />
        {needsLegalAcceptance ? (
          <div className="space-y-4">
            {error && (
              <Banner intent="warning" className="font-bold">
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
              onClick={() => void finishSignIn(true)}
              size="lg"
              tone="pink"
              className="w-full"
            >
              {finishing ? formatMessage({ id: "pages.socialCallback.finishing" }) : formatMessage({ id: "pages.socialCallback.continue" })}
            </Button>
          </div>
        ) : error ? (
          <div className="space-y-3">
            <Banner intent="warning" className="font-bold">
              {error}
            </Banner>
            <button
              type="button"
              onClick={() => window.location.replace("/")}
              className="btn-brutal bg-white px-4 py-2 text-sm"
            >
              {formatMessage({ id: "auth.backToSignIn.button" })}
            </button>
          </div>
        ) : (
          <div className="text-sm font-bold text-black/70">{formatMessage({ id: "pages.socialCallback.finishingSignIn" })}</div>
        )}
      </div>
    </CenteredCardFrame>
  );
}
