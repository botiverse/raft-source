import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  Card,
  CardContent,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
} from "@botiverse/raft-ui";
import api from "../api/client";
import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import Banner from "../components/ui/Banner";
import { canUsePasskeys, getPasskeyAssertion, isPasskeyCancel } from "../components/auth/webauthn";
import type { PasskeyRequestOptionsJSON } from "../components/auth/webauthn";
import type { MessageId } from "../i18n/messages";
import { useTimeFormatter } from "../hooks/useTimeFormatter";
import { getApiErrorResponse } from "../utils/apiErrorResponse";
import { appStepUpRedirect } from "./appStepUpRedirect";

// App step-up on the web (docs/contracts/app-web-step-up.md): the Raft app
// opened /login/app/verify?request=<id> because the person's passkey is under
// the earlier RP ID, which the app can't ask for. No web sign-in is needed or
// read: the request names the account, and only that account's passkey
// answers. The page first shows what is being approved (account, change,
// app, when), and asks for the passkey only after Continue. Success hands a
// one-time code to the app's callback; only the app that started the request
// can use it. No passkey swap is offered here.

type UnusableMessageId = "pages.appStepUp.expired" | "pages.appStepUp.alreadyUsed" | "pages.appStepUp.invalid";
type NoticeMessageId =
  | "pages.appStepUp.passkeyCancelled"
  | "pages.appStepUp.passkeyInvalid"
  | "pages.appStepUp.passkeyNotFound"
  | "pages.appStepUp.locked"
  | "pages.appStepUp.failed";

/** What the server says about the request. */
interface StepUpDetails {
  appName: string;
  action: string | null;
  accountName: string;
  maskedEmail: string;
  createdAt: string | null;
}

type PageState =
  | { kind: "loading" }
  | { kind: "ready"; details: StepUpDetails; notice?: NoticeMessageId }
  | { kind: "unusable"; messageId: UnusableMessageId; redirectUrl?: string }
  | { kind: "returned"; outcome: "verified" | "cancelled"; redirectUrl: string };


const ACTION_LABELS: Record<string, MessageId> = {
  password_change: "pages.appStepUp.action.passwordChange",
  identity_link: "pages.appStepUp.action.identityLink",
  identity_unlink: "pages.appStepUp.action.identityUnlink",
  agent_credential_mint: "pages.appStepUp.action.agentCredentialMint",
  agent_bootstrap_token: "pages.appStepUp.action.agentBootstrapToken",
  computer_attach: "pages.appStepUp.action.computerAttach",
  computer_adopt: "pages.appStepUp.action.computerAdopt",
  machine_key_register: "pages.appStepUp.action.machineKeyRegister",
  machine_key_rotate: "pages.appStepUp.action.machineKeyRotate",
  integration_client_secret_regenerate: "pages.appStepUp.action.integrationClientSecretRegenerate",
  integration_webhook_secret_rotate: "pages.appStepUp.action.integrationWebhookSecretRotate",
  integration_app_register: "pages.appStepUp.action.integrationAppRegister",
  session_revoke: "pages.appStepUp.action.sessionRevoke",
  data_export: "pages.appStepUp.action.dataExport",
};

function actionLabel(action: string | null): MessageId {
  return (action && Object.prototype.hasOwnProperty.call(ACTION_LABELS, action) ? ACTION_LABELS[action] : undefined)
    ?? "pages.appStepUp.action.other";
}

function requestIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("request") || "";
}

function requestPath(requestId: string, rest = ""): string {
  return `/auth/app-login/step-up/requests/${encodeURIComponent(requestId)}${rest}`;
}

function unusableMessageId(code: string | undefined): UnusableMessageId {
  if (code === "request_expired") return "pages.appStepUp.expired";
  if (code === "request_already_resolved") return "pages.appStepUp.alreadyUsed";
  return "pages.appStepUp.invalid";
}

function redirectUrlOf(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { redirectUrl?: unknown } } })?.response?.data;
  return typeof data?.redirectUrl === "string" ? data.redirectUrl : undefined;
}

/** A refusal about the request itself (gone, expired, handled): the page can't go on. */
function isRequestRefusal(code: string | undefined): boolean {
  return code === "request_not_found" || code === "request_expired" || code === "request_already_resolved";
}

function unusableState(err: unknown): PageState {
  return { kind: "unusable", messageId: unusableMessageId(getApiErrorResponse(err)?.code), redirectUrl: redirectUrlOf(err) };
}

function detailsOf(data: unknown): StepUpDetails | null {
  const body = (data && typeof data === "object" ? data : {}) as {
    client?: { name?: unknown } | null;
    action?: unknown;
    account?: { name?: unknown; maskedEmail?: unknown } | null;
    createdAt?: unknown;
  };
  const accountName = typeof body.account?.name === "string" ? body.account.name.trim() : "";
  const maskedEmail = typeof body.account?.maskedEmail === "string" ? body.account.maskedEmail : "";
  if (!maskedEmail) return null;
  return {
    appName: typeof body.client?.name === "string" && body.client.name.trim() ? body.client.name.trim() : "Raft",
    action: typeof body.action === "string" ? body.action : null,
    accountName,
    maskedEmail,
    createdAt: typeof body.createdAt === "string" && Number.isFinite(Date.parse(body.createdAt)) ? body.createdAt : null,
  };
}

async function loadRequestState(requestId: string): Promise<PageState> {
  if (!requestId) return { kind: "unusable", messageId: "pages.appStepUp.invalid" };
  try {
    const { data } = await api.get(requestPath(requestId));
    const details = detailsOf(data);
    return details ? { kind: "ready", details } : { kind: "unusable", messageId: "pages.appStepUp.invalid" };
  } catch (err) {
    return unusableState(err);
  }
}

function noticeFor(err: unknown): NoticeMessageId {
  if (isPasskeyCancel(err)) return "pages.appStepUp.passkeyCancelled";
  const code = getApiErrorResponse(err)?.code;
  if (code === "second_factor_code_invalid") return "pages.appStepUp.passkeyInvalid";
  if (code === "passkey_not_found") return "pages.appStepUp.passkeyNotFound";
  if (code === "second_factor_locked") return "pages.appStepUp.locked";
  return "pages.appStepUp.failed";
}

export function AppStepUpPage() {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  const requestId = useMemo(() => requestIdFromUrl(), []);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [busy, setBusy] = useState<"passkey" | "cancel" | null>(null);
  const passkeysUsable = useMemo(() => canUsePasskeys(), []);

  useEffect(() => {
    let cancelled = false;
    void loadRequestState(requestId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => { cancelled = true; };
  }, [requestId]);

  const returnToApp = useCallback((outcome: "verified" | "cancelled", redirectUrl: string) => {
    setState({ kind: "returned", outcome, redirectUrl });
    appStepUpRedirect.assign(redirectUrl);
  }, []);

  const details = state.kind === "ready" ? state.details : null;

  const verify = useCallback(async () => {
    if (!details) return;
    setBusy("passkey");
    try {
      const { data: started } = await api.post(requestPath(requestId, "/options"), {});
      const webauthn = await getPasskeyAssertion((started as { options: PasskeyRequestOptionsJSON }).options);
      const { data } = await api.post(requestPath(requestId, "/verify"), { webauthn });
      returnToApp("verified", (data as { redirectUrl: string }).redirectUrl);
    } catch (err) {
      if (isRequestRefusal(getApiErrorResponse(err)?.code)) setState(unusableState(err));
      else setState({ kind: "ready", details, notice: noticeFor(err) });
    } finally {
      setBusy(null);
    }
  }, [details, requestId, returnToApp]);

  const cancel = useCallback(async () => {
    setBusy("cancel");
    try {
      const { data } = await api.post(requestPath(requestId, "/cancel"), {});
      returnToApp("cancelled", (data as { redirectUrl: string }).redirectUrl);
    } catch (err) {
      setState(unusableState(err));
    } finally {
      setBusy(null);
    }
  }, [requestId, returnToApp]);

  const redirectUrl = state.kind === "returned" || state.kind === "unusable" ? state.redirectUrl : undefined;
  const openApp = useCallback(() => {
    if (redirectUrl) appStepUpRedirect.assign(redirectUrl);
  }, [redirectUrl]);
  const handleContinue = useCallback(() => { void verify(); }, [verify]);
  const handleCancel = useCallback(() => { void cancel(); }, [cancel]);

  if (state.kind === "returned") {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="app-step-up-returned">
          <AuthPageIntro
            title={formatMessage({ id: state.outcome === "verified" ? "pages.appStepUp.verifiedTitle" : "pages.appStepUp.cancelledTitle" })}
            description={formatMessage({ id: "pages.appLogin.returnedDescription" })}
          />
          {/* A custom-scheme jump after an async request may be dropped; a tap is a fresh gesture. */}
          <Button type="button" onClick={openApp} size="xl" variant="accent" className="w-full" data-testid="app-step-up-open-app">
            {formatMessage({ id: "pages.appLogin.openApp" })}
          </Button>
        </div>
      </AuthPageFrame>
    );
  }

  if (state.kind === "unusable") {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="app-step-up-unusable">
          <AuthPageIntro title={formatMessage({ id: "pages.appStepUp.title" })} />
          <Banner intent="warning" className="mb-4">{formatMessage({ id: state.messageId })}</Banner>
          {redirectUrl ? (
            <Button type="button" onClick={openApp} size="lg" variant="outline" className="w-full">
              {formatMessage({ id: "pages.appLogin.backToApp" })}
            </Button>
          ) : null}
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full" data-testid="app-step-up-confirm">
        <AuthPageIntro
          title={formatMessage({ id: "pages.appStepUp.title" })}
          description={details ? formatMessage({ id: "pages.appStepUp.description" }, { app: details.appName }) : undefined}
        />
        {details ? (
          <Card className="mb-4" data-testid="app-step-up-details">
            <CardContent>
              <DescriptionList direction="horizontal" className="w-full">
                <DescriptionItem>
                  <DescriptionTerm>{formatMessage({ id: "pages.appStepUp.account" })}</DescriptionTerm>
                  <DescriptionDetails className="break-words [overflow-wrap:anywhere]" data-testid="app-step-up-account">
                    {details.accountName ? formatMessage({ id: "pages.appStepUp.accountValue" }, { name: details.accountName, email: details.maskedEmail }) : details.maskedEmail}
                  </DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem>
                  <DescriptionTerm>{formatMessage({ id: "pages.appStepUp.change" })}</DescriptionTerm>
                  <DescriptionDetails data-testid="app-step-up-action">
                    {formatMessage({ id: actionLabel(details.action) }, { app: details.appName })}
                  </DescriptionDetails>
                </DescriptionItem>
                {details.createdAt ? (
                  <DescriptionItem>
                    <DescriptionTerm>{formatMessage({ id: "pages.appStepUp.requested" })}</DescriptionTerm>
                    <DescriptionDetails>{formatClock(details.createdAt)}</DescriptionDetails>
                  </DescriptionItem>
                ) : null}
              </DescriptionList>
            </CardContent>
          </Card>
        ) : null}
        {details && !passkeysUsable ? (
          <Banner intent="warning" className="mb-4" data-testid="app-step-up-unsupported">
            {formatMessage({ id: "pages.appStepUp.passkeyUnsupported" })}
          </Banner>
        ) : state.kind === "ready" && state.notice ? (
          <Banner intent="warning" className="mb-4" data-testid="app-step-up-notice">
            {formatMessage({ id: state.notice })}
          </Banner>
        ) : null}
        <Button
          type="button"
          onClick={handleContinue}
          disabled={!details || !passkeysUsable || busy !== null}
          size="xl"
          variant="accent"
          className="w-full"
          data-testid="app-step-up-continue"
        >
          {formatMessage({ id: busy === "passkey" ? "pages.appStepUp.waiting" : "pages.appStepUp.continue" })}
        </Button>
        <Button
          type="button"
          onClick={handleCancel}
          disabled={!details || busy !== null}
          size="lg"
          variant="default"
          className="mt-3 w-full"
          data-testid="app-step-up-cancel"
        >
          {formatMessage({ id: "pages.appStepUp.cancel" })}
        </Button>
      </div>
    </AuthPageFrame>
  );
}
