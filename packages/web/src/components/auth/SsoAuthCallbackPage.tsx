import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { AxiosResponse } from "axios";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { Button } from "@botiverse/raft-ui";
import api from "../../api/client";
import type { MessageId } from "../../i18n/messages/en";
import { useAuthStore } from "../../store/authStore";
import { PENDING_INVITE_STORAGE_KEY, sanitizeReturnTo, takePendingInviteRedirectPath } from "../../utils/socialAuth";
import Banner from "../ui/Banner";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";
import LegalAcceptanceCheckbox, { LegalAcceptanceUsageDataNotice } from "./LegalAcceptanceCheckbox";
import SecondFactorSignInStep from "./SecondFactorSignInStep";
import { readSecondFactorChallenge } from "./secondFactorSignIn";
import type { SecondFactorChallenge } from "./secondFactorSignIn";

/**
 * `?auth_callback=sso`: back from a Server's identity provider
 * (rfcs/083-server-sso.md §5.1). The one-time `code` is exchanged at
 * POST /auth/sso/complete for a session, the second step, or a refusal; a new
 * account first asks for the terms (409, the same code again). An `error`
 * means the round-trip itself failed. Unlike a social sign-in there is no
 * account to link: SSO links by the IdP's subject and the Server's verified
 * domain on the server.
 */

interface SsoCompletionData {
  accessToken?: string;
  refreshToken?: string;
  returnTo?: string | null;
}

/** What the person is told for each reason the server gives; anything else is the generic failure. */
const REASON_MESSAGE_IDS: Record<string, MessageId> = {
  sso_link_expired: "pages.ssoCallback.expired",
  invalid_code: "pages.ssoCallback.expired",
  sso_state_mismatch: "pages.ssoCallback.otherBrowser",
  sso_cookie_missing: "pages.ssoCallback.otherBrowser",
  browser_mismatch: "pages.ssoCallback.otherBrowser",
  sso_rate_limited: "pages.ssoCallback.rateLimited",
  sso_unavailable: "pages.ssoCallback.unavailable",
  connection_inactive: "pages.ssoCallback.unavailable",
  idp_refused: "pages.ssoCallback.idpRefused",
  idp_answer_refused: "pages.ssoCallback.idpAnswerRefused",
  email_unverified: "pages.ssoCallback.emailUnverified",
  email_not_canonical: "pages.ssoCallback.domainNotVerified",
  domain_not_verified: "pages.ssoCallback.domainNotVerified",
  account_email_unverified: "pages.ssoCallback.accountEmailUnverified",
  email_link_not_attested: "pages.ssoCallback.existingAccountNotLinked",
  identity_subject_changed: "pages.ssoCallback.existingAccountNotLinked",
  account_unavailable: "pages.ssoCallback.accountUnavailable",
  registration_closed: "pages.ssoCallback.registrationClosed",
};

function reasonMessageId(reason: unknown): MessageId {
  return (typeof reason === "string" && REASON_MESSAGE_IDS[reason]) || "pages.ssoCallback.failed";
}

function navigateHome() {
  window.location.replace("/");
}

async function enterSsoSignIn(
  data: SsoCompletionData & { accessToken: string; refreshToken: string },
  fallbackReturnTo: string,
  session: { setTokens: (accessToken: string, refreshToken: string) => void; loadUser: () => Promise<void> },
): Promise<void> {
  session.setTokens(data.accessToken, data.refreshToken);
  // As a social sign-in: a pending invite's page takes it from here.
  const pendingInviteRedirect = takePendingInviteRedirectPath();
  if (pendingInviteRedirect) {
    window.location.replace(pendingInviteRedirect);
    return;
  }
  await session.loadUser();
  window.location.replace(sanitizeReturnTo(data.returnTo ?? fallbackReturnTo));
}

export function SsoAuthCallbackPage() {
  const { formatMessage } = useIntl();
  const setTokens = useAuthStore((state) => state.setTokens);
  const loadUser = useAuthStore((state) => state.loadUser);
  const logout = useAuthStore((state) => state.logout);
  const completionEpoch = useRef(0);
  // StrictMode replays effect setup; both observers share the one exchange of the one-time code.
  const initialCompletion = useRef<Promise<AxiosResponse<SsoCompletionData>> | null>(null);
  const [errorId, setErrorId] = useState<MessageId | null>(null);
  const [needsLegalAcceptance, setNeedsLegalAcceptance] = useState(false);
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const usageDataNoticeId = useId();
  const [secondStep, setSecondStep] = useState<SecondFactorChallenge | null>(null);

  const callbackParams = useMemo(() => {
    const searchParams = new URLSearchParams(window.location.search);
    return {
      code: searchParams.get("code"),
      returnTo: sanitizeReturnTo(searchParams.get("returnTo")),
      error: searchParams.get("error"),
    };
  }, []);

  const finishSignIn = useCallback(async (includeLegalAcceptance: boolean) => {
    const epoch = ++completionEpoch.current;
    setFinishing(true);
    setErrorId(null);
    try {
      if (callbackParams.error || !callbackParams.code) {
        setErrorId(reasonMessageId(callbackParams.error ?? "sso_link_expired"));
        return;
      }
      const body = {
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
      // withCredentials: the code completes only with the cookie its callback left in this browser.
      const request = () => api.post<SsoCompletionData>("/auth/sso/complete", body, { withCredentials: true });
      if (!includeLegalAcceptance && !initialCompletion.current) initialCompletion.current = request();
      const { data } = await (includeLegalAcceptance ? request() : initialCompletion.current!);
      if (epoch !== completionEpoch.current) return;

      const challenge = readSecondFactorChallenge(data);
      if (challenge) {
        setSecondStep(challenge);
        return;
      }
      if (!data.accessToken || !data.refreshToken) {
        setErrorId("pages.ssoCallback.failed");
        return;
      }
      await enterSsoSignIn({ ...data, accessToken: data.accessToken, refreshToken: data.refreshToken }, callbackParams.returnTo, { setTokens, loadUser });
    } catch (err: unknown) {
      if (epoch !== completionEpoch.current) return;
      const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
      if (code === "legal_acceptance_required") {
        setNeedsLegalAcceptance(true);
        return;
      }
      setErrorId(reasonMessageId(code));
    } finally {
      if (epoch === completionEpoch.current) setFinishing(false);
    }
  }, [callbackParams, loadUser, setTokens]);

  const finishSecondStep = useCallback(async (body: unknown) => {
    const data = body as SsoCompletionData;
    if (!data.accessToken || !data.refreshToken) throw new Error("second_factor_no_session");
    await enterSsoSignIn({ ...data, accessToken: data.accessToken, refreshToken: data.refreshToken }, callbackParams.returnTo, { setTokens, loadUser });
  }, [callbackParams.returnTo, loadUser, setTokens]);

  // A refusal may come from a Server that requires SSO: signing out is the way back to the sign-in page,
  // never into a session that is sent straight back to the IdP.
  const handleBack = useCallback(() => {
    logout();
    navigateHome();
  }, [logout]);

  const handleFinishWithLegalAcceptance = useCallback(() => {
    void finishSignIn(true);
  }, [finishSignIn]);

  // The code is single use: off the address bar before anything else.
  useLayoutEffect(() => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, []);

  useEffect(() => {
    if (!needsLegalAcceptance) void finishSignIn(false);
    return () => { completionEpoch.current += 1; };
  }, [finishSignIn, needsLegalAcceptance]);

  if (secondStep) {
    return <SecondFactorSignInStep challenge={secondStep} onSignedIn={finishSecondStep} onBack={navigateHome} />;
  }

  if (!needsLegalAcceptance && !errorId) return null;

  return (
    <CenteredCardFrame>
      <div className="w-full">
        <AuthPageIntro title={formatMessage({ id: "pages.ssoCallback.title" })} />
        {needsLegalAcceptance ? (
          <div className="stack-y-4">
            <LegalAcceptanceCheckbox checked={acceptedLegal} onChange={setAcceptedLegal} disabled={finishing} />
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
        ) : (
          <div className="stack-y-3">
            <Banner intent="warning">{formatMessage({ id: errorId! })}</Banner>
            <Button size="lg" type="button" variant="outline" className="w-full" onClick={handleBack}>
              {formatMessage({ id: "auth.backToSignIn.button" })}
            </Button>
          </div>
        )}
      </div>
    </CenteredCardFrame>
  );
}
