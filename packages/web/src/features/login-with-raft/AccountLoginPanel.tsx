import { Button, Card, ScrollArea } from "@botiverse/raft-ui";
import type { ReactNode, RefCallback } from "react";
import { useIntl } from "react-intl";
import SignedInAs from "../../components/auth/SignedInAs";
import RequestedScopeConsent from "../../components/oauth/RequestedScopeConsent";
import { useAuthStore } from "../../store/authStore";
import Banner from "../../components/ui/Banner";
import { AccountLoginRefusalBanner } from "./AccountLoginRefusalBanner";
import { LoginAppDetailsCard } from "./LoginAppDetailsCard";
import { LoginScopeConfigurationAlert } from "./LoginScopeConfigurationAlert";
import type { LoginClientSummary } from "./loginClientSummary";
import type { AccountLoginRefusal } from "./loginErrors";
import { FIELD_HELP_CLASS, FIELD_LABEL_CLASS, LOGIN_STATUS_CLASS, TITLE_CLASS } from "./loginSetupClassNames";

/**
 * RFC 079 phase 3a (design §4.1): the setup page's card for an App that signs
 * people in with their Raft account. In place of the Server picker, one
 * sentence saying there is no Server to choose; the requested scopes as
 * always; then Login with Raft, which names no Server. A refusal (suspended,
 * a Server-scoped sign-in address) is the card's first notice, under the
 * title, and takes the place of that sentence and of the button.
 */
export function AccountLoginPanel({
  serviceName,
  client,
  scopes,
  refusal,
  refusalAfterLogin,
  error,
  loginModeChanged,
  titleRef,
  canLogin,
  submitting,
  status,
  notice,
  onLogin,
}: {
  serviceName: string;
  /** The App's details, from a Server where it is ready (else wherever it was found). */
  client: LoginClientSummary | null;
  scopes: string[];
  /** A refusal the page words itself: no Login button. */
  refusal: AccountLoginRefusal | null;
  /**
   * The refusal answered a press of Login with Raft: focus moves to it, since
   * the button the person pressed goes and the reason is at the top of the
   * card, off screen on a phone. A refusal known when the page loads doesn't
   * take focus.
   */
  refusalAfterLogin: boolean;
  /** Why the lookups leave nothing to sign in to (suspended everywhere, an outage). */
  error: string;
  /** The page was opened before the App switched to account mode and looked it up again. */
  loginModeChanged: boolean;
  /**
   * The page's one-shot request that this card's title take focus as it
   * mounts: the card replaced the one the person was on (409). Undefined
   * otherwise, so a later remount doesn't take focus again.
   */
  titleRef?: RefCallback<HTMLHeadingElement>;
  canLogin: boolean;
  submitting: boolean;
  /** A failure the server worded. */
  status: string;
  /** Something the step before (Install and Continue) wants said, e.g. the App's bot didn't join. */
  notice?: ReactNode;
  onLogin: () => void;
}) {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const scopeValidation = client?.scopeValidation;
  const disallowedScopes = scopeValidation?.disallowedScopes ?? [];
  // A refusal, or nothing to sign in to: no Login button.
  const refused = refusal !== null || !!error;

  return (
    <Card render={<section />} className="p-4 sm:p-6" data-testid="account-login-panel">
      <h1 ref={titleRef} tabIndex={-1} className={TITLE_CLASS}>
        <span className="block text-headline sm:text-title">{formatMessage({ id: "pages.humanLogin.account.title" }, { serviceName })}</span>
        <span className="mt-1 block break-words text-display sm:text-hero">{serviceName}</span>
      </h1>

      {/* Why this sign-in can't go ahead comes first, before what it would
          have done: on a phone the bottom of the card is below the fold. */}
      <AccountLoginRefusalBanner refusal={refusal} error={error} takeFocus={refusalAfterLogin} />
      <p className="text-callout text-foreground-muted">
        {formatMessage({ id: "pages.humanLogin.account.body" }, { serviceName, b: (chunks) => <strong key="service">{chunks}</strong> })}
      </p>
      <p className="mt-2 text-caption text-foreground-hint">
        <SignedInAs user={user} prefix={formatMessage({ id: "pages.humanLogin.signedInAsPrefix" })} />
      </p>

      {loginModeChanged ? (
        <Banner intent="info" density="sm" role="status" className="mt-4" data-testid="account-login-mode-changed">
          {formatMessage({ id: "pages.humanLogin.account.loginModeChanged" }, { serviceName })}
        </Banner>
      ) : null}

      {client ? (
        <div className="mt-5">
          <div className={FIELD_LABEL_CLASS}>{formatMessage({ id: "pages.humanLogin.appDetailsLabel" })}</div>
          <LoginAppDetailsCard client={client} />
          <p className={FIELD_HELP_CLASS}>
            {formatMessage({ id: "pages.humanLogin.appDetailsHelp" })}
          </p>
        </div>
      ) : null}

      <RequestedScopeConsent scopes={scopes} />

      {disallowedScopes.length > 0 ? (
        <LoginScopeConfigurationAlert
          reason={scopeValidation?.reason ?? null}
          appName={serviceName}
          scopeList={disallowedScopes.join(", ")}
        />
      ) : null}

      {notice ? <div className="mt-4">{notice}</div> : null}

      {refused ? null : (
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          {/* raft-ui Button `loading`: the spinner, as Install and Continue has. */}
          <Button
            disabled={!canLogin}
            loading={submitting}
            loadingLabel={formatMessage({ id: "pages.humanLogin.continuing" })}
            onClick={onLogin}
            size="lg"
            variant="accent"
            className="w-full sm:w-auto"
          >
            {formatMessage({ id: "pages.humanLogin.loginWithRaft" })}
          </Button>
        </div>
      )}

      {status && <ScrollArea render={<pre />} orientation="horizontal" overscroll="auto" role="region" aria-label={formatMessage({ id: "pages.humanLogin.loginStatus" })} className={LOGIN_STATUS_CLASS}>{status}</ScrollArea>}
    </Card>
  );
}
