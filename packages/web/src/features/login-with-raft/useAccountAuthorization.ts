import { appendOAuthAuthorizationParams } from "@botiverse/raft-shared";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../../components/settings/secondFactorStepUp";
import { accountLoginRefusalOf, authorizationErrorRedirectUrl, isAppNotAvailableError } from "./loginErrors";
import type { AccountLoginRefusal } from "./loginErrors";

export type AccountAuthorizationRequest = {
  returnUrl: string;
  scopes: string[];
  /** The OAuth `state` handed back to the App with the code. */
  setupState: string;
  oidcFlow: boolean;
  oidcNonce: string;
  oidcCodeChallenge: string;
  oidcCodeChallengeMethod: string;
  /** The App is not open to this person (anymore): the page's one denial. */
  onNotAvailable: () => void;
  /**
   * installation_suspended: every installation went suspended after the
   * lookup. The page marks them so (the App's Suspended badge), as the
   * lookup would have.
   */
  onSuspended: () => void;
};

/**
 * RFC 079 phase 3a (design §4.1): Login with Raft for an account-mode App.
 * POST /oauth/authorize/account names no Server: no `serverId`, and never the
 * `server` hint (the server refuses it, root_issuer_required), then on to the
 * App with the code, as /authorize/human does.
 */
export function useAccountAuthorization({
  returnUrl,
  scopes,
  setupState,
  oidcFlow,
  oidcNonce,
  oidcCodeChallenge,
  oidcCodeChallengeMethod,
  onNotAvailable,
  onSuspended,
}: AccountAuthorizationRequest) {
  const { formatMessage } = useIntl();
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState("");
  const [refusal, setRefusal] = useState<AccountLoginRefusal | null>(null);

  const authorize = useCallback(async (clientId: string) => {
    setSubmitting(true);
    setStatus("");
    setRefusal(null);
    try {
      const { data } = await withSecondFactorStepUp(() => api.post("/oauth/authorize/account", {
        clientId,
        returnUrl,
        scopes,
        ...(oidcFlow ? {
          oidc: true,
          nonce: oidcNonce || undefined,
          codeChallenge: oidcCodeChallenge || undefined,
          codeChallengeMethod: oidcCodeChallengeMethod || undefined,
        } : {}),
      }), "appAccess");
      window.location.assign(appendOAuthAuthorizationParams(data.returnUrl, data.code, setupState));
    } catch (err: unknown) {
      // Closing "Verify it's you" cancels: stay on the page, nothing to report.
      if (isSecondFactorStepUpCancelled(err)) return;
      const body = (err as { response?: { data?: { error?: unknown; error_description?: unknown } } } | null)?.response?.data;
      const appErrorUrl = authorizationErrorRedirectUrl(body, setupState);
      if (appErrorUrl) {
        window.location.assign(appErrorUrl);
        return;
      }
      if (isAppNotAvailableError(err)) {
        onNotAvailable();
        return;
      }
      const accountRefusal = accountLoginRefusalOf(err);
      if (accountRefusal) {
        setRefusal(accountRefusal);
        if (accountRefusal === "installationSuspended") onSuspended();
        return;
      }
      const worded = [body?.error_description, body?.error].find((text): text is string => typeof text === "string" && !!text);
      setStatus(worded ?? formatMessage({ id: "pages.humanLogin.continueFailed" }));
    } finally {
      setSubmitting(false);
    }
  }, [
    formatMessage,
    oidcCodeChallenge,
    oidcCodeChallengeMethod,
    oidcFlow,
    oidcNonce,
    onNotAvailable,
    onSuspended,
    returnUrl,
    scopes,
    setupState,
  ]);

  // A fresh lookup of the App replaces the press's refusal (the page calls this).
  const clearRefusal = useCallback(() => setRefusal(null), []);

  return { authorize, submitting, status, refusal, clearRefusal };
}
