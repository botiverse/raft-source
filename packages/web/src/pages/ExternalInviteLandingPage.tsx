import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import { LogIn, UserPlus } from "lucide-react";
import CenteredCardFrame from "../components/auth/CenteredCardFrame";
import { AuthPageIntro } from "../components/auth/AuthPageFrame";
import { apiErrorStatus, getExternalInvitePreview } from "../components/externalInvite/externalInviteAccept";
import type { ExternalInviteLinkPreview } from "../components/externalInvite/externalInviteAccept";

interface ExternalInviteLandingPageProps {
  token: string;
  /** Sign-in or sign-up at the link's own address: once signed in, the app opens the invite there (ExternalInvitePage). */
  onChoose: (view: "login" | "register") => void;
}

type LandingState =
  | { kind: "loading" }
  | { kind: "valid"; preview: ExternalInviteLinkPreview }
  | { kind: "invalid" }
  | { kind: "loadFailed" };

/**
 * An external channel invite link opened signed out (#wg-rbac:#39): that it
 * is an invite to a channel, the address it was sent to (masked) and why to
 * sign in with it, and Sign In / Create Account, from the link's preview (no
 * auth). A forwarded link must not reveal the channel, who sent it or from
 * where, so nothing else is shown. Every unavailable invite (expired too) is
 * the preview's one 404, so the page gives no reason.
 */
export function ExternalInviteLandingPage({ token, onChoose }: ExternalInviteLandingPageProps) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<LandingState>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getExternalInvitePreview(token)
      .then((preview) => {
        if (!cancelled) setState({ kind: "valid", preview });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState(apiErrorStatus(err) === 404 ? { kind: "invalid" } : { kind: "loadFailed" });
      });
    return () => {
      cancelled = true;
    };
  }, [token, reload]);

  const handleSignIn = useCallback(() => onChoose("login"), [onChoose]);
  const handleRegister = useCallback(() => onChoose("register"), [onChoose]);
  const handleRetry = useCallback(() => {
    setState({ kind: "loading" });
    setReload((count) => count + 1);
  }, []);

  if (state.kind === "loading") {
    return (
      <CenteredCardFrame>
        <div className="w-full" data-testid="external-invite-landing-loading">
          <AuthPageIntro title={formatMessage({ id: "pages.invite.loadingTitle" })} />
        </div>
      </CenteredCardFrame>
    );
  }

  if (state.kind === "invalid" || state.kind === "loadFailed") {
    const invalid = state.kind === "invalid";
    return (
      <CenteredCardFrame>
        <div className="w-full" data-testid={invalid ? "external-invite-landing-invalid" : "external-invite-landing-load-failed"}>
          <AuthPageIntro
            title={formatMessage({ id: invalid ? "externalInvite.invalid.title" : "externalInvite.loadFailed.title" })}
            description={formatMessage({ id: invalid ? "externalInvite.invalid.description" : "externalInvite.loadFailed.description" })}
          />
          <Button size="lg" variant="outline" className="w-full" onClick={invalid ? handleSignIn : handleRetry}>
            {formatMessage({ id: invalid ? "pages.invite.signIn" : "externalInvite.retry" })}
          </Button>
        </div>
      </CenteredCardFrame>
    );
  }

  const { preview } = state;
  return (
    <CenteredCardFrame>
      <div className="w-full" data-testid="external-invite-landing">
        <AuthPageIntro title={formatMessage({ id: "externalInvite.landing.title" })}>
          <p className="mt-2 text-callout text-foreground-muted" data-testid="external-invite-landing-sent-to">
            {formatMessage({ id: "externalInvite.landing.sentToNext" }, { email: preview.invitedEmailMasked })}
          </p>
        </AuthPageIntro>
        <div className="stack-y-3">
          <Button onClick={handleSignIn} size="xl" variant="accent" className="w-full">
            <LogIn size={16} />
            {formatMessage({ id: "pages.invite.signIn" })}
          </Button>
          <Button onClick={handleRegister} size="lg" variant="outline" className="w-full">
            <UserPlus size={18} />
            {formatMessage({ id: "pages.invite.createAccount" })}
          </Button>
        </div>
      </div>
    </CenteredCardFrame>
  );
}
