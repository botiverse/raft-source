import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Button, TextSans } from "@botiverse/raft-ui";
import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import SignedInAs from "../components/auth/SignedInAs";
import Banner from "../components/ui/Banner";
import { StepUpBeforeApproval } from "../components/auth/SecondFactorCodeEntry";
import { parseMethods } from "../components/auth/secondFactorSignIn";
import type { SignInSecondFactorMethod } from "../components/auth/secondFactorSignIn";
import { stepUpBeforeApproval } from "../components/settings/secondFactorApi";
import { useTimeFormatter } from "../hooks/useTimeFormatter";

// App login handoff (HarmonyOS web login): a native app opened this page with
// `?request=<id>`. The ordinary login has already run (this route is only
// reachable signed in); the user must explicitly confirm the account before
// the app gets a one-time code. The return address is fixed server-side.
// The confirmation names the app from the server's client registry (never
// what the app says about itself) and when it asked, so a request someone
// else started stands out (Raft Desktop's passkey sign-in, design A5); an
// older server sends neither and the page is as before.

type UnusableMessageId = "pages.appLogin.expired" | "pages.appLogin.alreadyUsed" | "pages.appLogin.invalid";

/** What the server says about the request: the app's registered name and when it asked; null when not sent. */
interface RequestDetails {
  appName: string | null;
  createdAt: string | null;
}

const NO_DETAILS: RequestDetails = { appName: null, createdAt: null };

type PageState =
  | { kind: "loading" }
  | { kind: "ready" }
  // Two-step verification is on and this sign-in hasn't passed it: verify
  // first (design v2 applogin-stepup). `upFront`: the status said so on load,
  // and the confirmation page follows; otherwise Confirm Sign-In answered 403
  // and the confirmation goes through.
  | { kind: "stepUp"; methods: SignInSecondFactorMethod[]; upFront?: boolean }
  | { kind: "unusable"; messageId: UnusableMessageId; redirectUrl?: string }
  | { kind: "returned"; redirectUrl: string };

/** Leaving for the app's custom scheme; replaceable in tests. */
export const appLoginRedirect = {
  assign: (url: string) => window.location.assign(url),
};

function requestIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("request") || "";
}

function unusableMessageId(code: string | undefined): UnusableMessageId {
  if (code === "request_expired") return "pages.appLogin.expired";
  if (code === "request_already_resolved") return "pages.appLogin.alreadyUsed";
  return "pages.appLogin.invalid";
}

function unusableState(err: unknown): PageState {
  const data = (err as { response?: { data?: { code?: string; redirectUrl?: string } } })?.response?.data ?? {};
  return { kind: "unusable", messageId: unusableMessageId(data.code), redirectUrl: data.redirectUrl };
}

function requestDetailsOf(data: unknown): RequestDetails {
  const body = (data && typeof data === "object" ? data : {}) as { client?: { name?: unknown } | null; createdAt?: unknown };
  const name = typeof body.client?.name === "string" ? body.client.name.trim() : "";
  const createdAt = typeof body.createdAt === "string" && Number.isFinite(Date.parse(body.createdAt)) ? body.createdAt : null;
  return { appName: name || null, createdAt };
}

async function loadRequestState(requestId: string): Promise<{ state: PageState; details: RequestDetails }> {
  if (!requestId) return { state: { kind: "unusable", messageId: "pages.appLogin.invalid" }, details: NO_DETAILS };
  try {
    const { data } = await api.get(`/auth/app-login/requests/${encodeURIComponent(requestId)}`);
    return { state: { kind: "ready" }, details: requestDetailsOf(data) };
  } catch (err) {
    return { state: unusableState(err), details: NO_DETAILS };
  }
}

export default function AppLoginPage() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const requestId = useMemo(() => requestIdFromUrl(), []);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [details, setDetails] = useState<RequestDetails>(NO_DETAILS);
  const [submitting, setSubmitting] = useState(false);
  const { formatClock } = useTimeFormatter();

  useEffect(() => {
    let cancelled = false;
    // With two-step verification on and this sign-in not past it (GET
    // /auth/second-factor/status), verify before confirming; a status that
    // can't be read leaves the page as before (the approval's 403 asks).
    void Promise.all([loadRequestState(requestId), stepUpBeforeApproval()]).then(([{ state: next, details: loaded }, stepUpMethods]) => {
      if (cancelled) return;
      setDetails(loaded);
      setState(next.kind === "ready" && stepUpMethods ? { kind: "stepUp", methods: stepUpMethods, upFront: true } : next);
    });
    return () => { cancelled = true; };
  }, [requestId]);

  const returnToApp = useCallback((redirectUrl: string) => {
    setState({ kind: "returned", redirectUrl });
    appLoginRedirect.assign(redirectUrl);
  }, []);

  const resolve = useCallback(async (action: "approve" | "deny") => {
    setSubmitting(true);
    try {
      const { data } = await api.post(`/auth/app-login/requests/${encodeURIComponent(requestId)}/${action}`);
      returnToApp(data.redirectUrl);
    } catch (err) {
      const data = (err as { response?: { data?: { code?: string; methods?: unknown } } })?.response?.data;
      if (action === "approve" && data?.code === "second_factor_step_up_required") {
        // Only for people with two-step verification on; the request stays pending.
        setState({ kind: "stepUp", methods: parseMethods(data.methods) });
        return;
      }
      setState(unusableState(err));
    } finally {
      setSubmitting(false);
    }
  }, [requestId, returnToApp]);

  const redirectUrl = state.kind === "returned" || state.kind === "unusable" ? state.redirectUrl : undefined;
  const openApp = useCallback(() => {
    if (redirectUrl) appLoginRedirect.assign(redirectUrl);
  }, [redirectUrl]);
  const backToApp = useCallback(() => {
    if (redirectUrl) returnToApp(redirectUrl);
  }, [redirectUrl, returnToApp]);
  const approve = useCallback(() => {
    void resolve("approve");
  }, [resolve]);
  const deny = useCallback(() => {
    void resolve("deny");
  }, [resolve]);
  const handleUseAnotherAccount = useCallback(() => logout(), [logout]);
  const confirmAfterStepUp = state.kind === "stepUp" && !state.upFront;
  const handleSteppedUp = useCallback(async () => {
    setState({ kind: "ready" });
    if (confirmAfterStepUp) await resolve("approve");
  }, [confirmAfterStepUp, resolve]);

  if (state.kind === "returned") {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="app-login-returned">
          <AuthPageIntro
            title={formatMessage({ id: "pages.appLogin.returnedTitle" })}
            description={formatMessage({ id: "pages.appLogin.returnedDescription" })}
          />
          {/* Some browsers drop the automatic custom-scheme jump because it
              runs after an async request; a tap here is a fresh user gesture. */}
          <Button
            type="button"
            onClick={openApp}
            size="xl"
            variant="accent"
            className="w-full"
            data-testid="app-login-open-app"
          >
            {formatMessage({ id: "pages.appLogin.openApp" })}
          </Button>
        </div>
      </AuthPageFrame>
    );
  }

  if (state.kind === "unusable") {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="app-login-unusable">
          <AuthPageIntro title={formatMessage({ id: "pages.appLogin.title" })} />
          <Banner intent="warning" className="mb-4">{formatMessage({ id: state.messageId })}</Banner>
          {redirectUrl ? (
            <Button type="button" onClick={backToApp} size="lg" variant="outline" className="w-full">
              {formatMessage({ id: "pages.appLogin.backToApp" })}
            </Button>
          ) : null}
        </div>
      </AuthPageFrame>
    );
  }

  if (state.kind === "stepUp") {
    return (
      <AuthPageFrame>
        <div className="w-full" data-testid="app-login-step-up">
          <AuthPageIntro
            title={formatMessage({ id: "pages.appLogin.title" })}
            description={<SignedInAs user={user} prefix={formatMessage({ id: "pages.appLogin.signedInAsPrefix" })} suffix="." />}
          />
          <StepUpBeforeApproval
            notice={formatMessage({ id: "pages.appLogin.stepUpNotice" })}
            methods={state.methods}
            onVerified={handleSteppedUp}
          />
          <Button
            type="button"
            onClick={handleUseAnotherAccount}
            size="lg"
            variant="outline"
            className="mt-3 w-full"
          >
            {formatMessage({ id: "pages.appLogin.useAnotherAccount" })}
          </Button>
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full" data-testid="app-login-confirm">
        <AuthPageIntro
          title={formatMessage({ id: "pages.appLogin.title" })}
          description={<SignedInAs user={user} prefix={formatMessage({ id: "pages.appLogin.signedInAsPrefix" })} suffix="." />}
        />
        {details.appName ? (
          <Banner intent="info" withIcon live={false} className="mb-4" data-testid="app-login-requester">
            {formatMessage({ id: "pages.appLogin.onlyIfYouStarted" }, { app: details.appName })}
          </Banner>
        ) : null}
        {details.createdAt ? (
          <TextSans size="small" variant="muted" className="mb-4 text-center" data-testid="app-login-requested-at">
            {formatMessage({ id: "pages.appLogin.requestedAt" }, { time: formatClock(details.createdAt) })}
          </TextSans>
        ) : null}
        <Button
          type="button"
          onClick={approve}
          disabled={state.kind !== "ready" || submitting}
          size="xl"
          variant="accent"
          className="w-full"
          data-testid="app-login-approve"
        >
          {formatMessage({ id: "pages.appLogin.approve" })}
        </Button>
        <Button
          type="button"
          onClick={handleUseAnotherAccount}
          disabled={submitting}
          size="lg"
          variant="outline"
          className="mt-3 w-full"
        >
          {formatMessage({ id: "pages.appLogin.useAnotherAccount" })}
        </Button>
        <Button
          type="button"
          onClick={deny}
          disabled={state.kind !== "ready" || submitting}
          size="lg"
          variant="default"
          className="mt-3 w-full"
          data-testid="app-login-deny"
        >
          {formatMessage({ id: "pages.appLogin.cancel" })}
        </Button>
      </div>
    </AuthPageFrame>
  );
}
