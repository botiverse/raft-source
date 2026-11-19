import { Button, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogTitle, ScrollArea } from "@botiverse/raft-ui";
import type { ComponentProps, ReactNode, RefCallback } from "react";
import { useIntl } from "react-intl";
import SignedInAs from "../../components/auth/SignedInAs";
import RequestedScopeConsent from "../../components/oauth/RequestedScopeConsent";
import Banner from "../../components/ui/Banner";
import { useAuthStore } from "../../store/authStore";
import { AccountLoginRefusalBanner } from "./AccountLoginRefusalBanner";
import type { AccountLoginPanelProps } from "./AccountLoginPanel";
import { LoginAppDetailsCard } from "./LoginAppDetailsCard";
import { LoginLookupLoadingCard } from "./LoginLookupLoadingCard";
import { LoginScopeConfigurationAlert } from "./LoginScopeConfigurationAlert";
import type { LoginClientSummary } from "./loginClientSummary";
import type { AccountLoginRefusal } from "./loginErrors";
import { FIELD_HELP_CLASS, FIELD_LABEL_CLASS, LOGIN_STATUS_CLASS } from "./loginSetupClassNames";

/** The approving button as the setup worded and wired it; where it is drawn is the layout's. */
export type LoginSetupCommit = Pick<ComponentProps<typeof Button>, "disabled" | "loading" | "loadingLabel" | "onClick" | "children"> & { "data-testid"?: string };

/**
 * The Login with Raft setup (pages/HumanLoginSetupPage.tsx) inside a raft-ui
 * Dialog (loginSetupHost.ts `embedded`: Raft Desktop's sheet): the dialog's
 * own parts, written straight into its `DialogContent`.
 *
 * - Header: the App's name, once, as the dialog's title, and ×.
 * - Body (it scrolls when the window is short): the host's notice (where the
 *   answer goes), who is signed in, the App's card, the Server, what is asked
 *   for, and anything that stops or failed. No sentence that only explains
 *   the page: the web page keeps those.
 * - Footer (always in view): Cancel, then the one approving button, when
 *   there is one to press.
 *
 * The page decides everything shown here and owns the button's state (the
 * approve lock, `disabled`, `loading`); this is layout only.
 */
export function EmbeddedLoginSetup({
  notice,
  loading,
  notAvailable,
  serviceName,
  account,
  accountRefusal,
  client,
  clientError,
  serverChoice,
  onlyServer,
  serverHelp,
  scopes,
  scopeAlert,
  commitBody,
  commitBusy,
  commit,
  status,
  titleRef,
}: {
  notice: ReactNode;
  /** The App is still looked up: its mode is unknown, so neither layout below. */
  loading: boolean;
  /** The App isn't open to this person: one sentence, nothing to approve. */
  notAvailable: boolean;
  /** The App's registered name, once the lookup has it. */
  serviceName: string | null;
  /** An App that signs in with the Raft account (no Server chosen): what its panel on the page is given. */
  account: AccountLoginPanelProps | null;
  /** A press's refusal in account mode while the Server rows show (the install step). */
  accountRefusal: AccountLoginRefusal | null;
  client: LoginClientSummary | null;
  clientError: string;
  /** The rows or the picker, as on the page. */
  serverChoice: ReactNode;
  /** The one Server the App can be used on, when there is no choice to make: said in a line, no picker. */
  onlyServer: string | null;
  /** Help the person can act on (install it on a Server to go on); null: none. */
  serverHelp: string | null;
  scopes: string[];
  scopeAlert: ReactNode;
  /** What the Marketplace commit says about the Server picked; null for an App with no install step. */
  commitBody: ReactNode;
  commitBusy: boolean;
  commit: LoginSetupCommit | null;
  /** A failure the server worded. */
  status: string;
  titleRef?: RefCallback<HTMLHeadingElement>;
}) {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const signedInAs = (
    <p className="text-caption text-foreground-hint">
      <SignedInAs user={user} prefix={formatMessage({ id: "pages.humanLogin.signedInAsPrefix" })} />
    </p>
  );
  const statusLine = (text: string) => (text ? (
    <ScrollArea render={<pre />} orientation="horizontal" overscroll="auto" role="region" aria-label={formatMessage({ id: "pages.humanLogin.loginStatus" })} className={LOGIN_STATUS_CLASS.replace("mt-4 ", "")}>{text}</ScrollArea>
  ) : null);
  const ready = !loading && !notAvailable;
  const accountRefused = account !== null && (account.refusal !== null || !!account.error);
  const accountDisallowed = account?.client?.scopeValidation?.disallowedScopes ?? [];
  // The approving button: the account's own in account mode (none once refused), else the setup's.
  const approve: LoginSetupCommit | null = !ready ? null : account ? (accountRefused ? null : {
    disabled: !account.canLogin,
    loading: account.submitting,
    loadingLabel: formatMessage({ id: "pages.humanLogin.continuing" }),
    onClick: account.onLogin,
    children: formatMessage({ id: "pages.humanLogin.loginWithRaft" }),
  }) : commit;
  const title = ready && (account?.serviceName || serviceName)
    ? formatMessage({ id: "pages.humanLogin.sheetTitle" }, { serviceName: account?.serviceName || serviceName })
    : formatMessage({ id: "pages.humanLogin.loginWithRaft" });

  return (
    <>
      <DialogHeader>
        <DialogTitle ref={titleRef} tabIndex={-1} className="break-words outline-none">{title}</DialogTitle>
        <DialogClose aria-label={formatMessage({ id: "common.confirm.closeDialog" })} />
      </DialogHeader>
      <DialogBody data-testid="login-setup-sheet-body">
        <div className="stack-y-4 font-display text-foreground" data-testid="human-login-setup-embedded" aria-busy={loading}>
          {notice}
          {loading ? (
            <LoginLookupLoadingCard />
          ) : notAvailable ? (
            <div className="stack-y-2" data-testid="app-not-available">
              <p className="text-callout text-foreground">{formatMessage({ id: "pages.humanLogin.appNotAvailable" })}</p>
              {signedInAs}
            </div>
          ) : account ? (
            <>
              <AccountLoginRefusalBanner refusal={account.refusal} error={account.error} takeFocus={account.refusalAfterLogin} />
              {account.loginModeChanged ? (
                <Banner intent="info" density="sm" role="status" data-testid="account-login-mode-changed">
                  {formatMessage({ id: "pages.humanLogin.account.loginModeChanged" }, { serviceName: account.serviceName })}
                </Banner>
              ) : null}
              {signedInAs}
              {account.client ? <LoginAppDetailsCard client={account.client} /> : null}
              {/* Account mode names no Server: what the App learns, and who decides the rest, is said instead. */}
              <p className="text-callout text-foreground-muted">
                {formatMessage({ id: "pages.humanLogin.account.body" }, { serviceName: account.serviceName, b: (chunks) => <strong key="service">{chunks}</strong> })}
              </p>
              <RequestedScopeConsent scopes={account.scopes} className="" intro={false} />
              {accountDisallowed.length > 0 ? (
                <LoginScopeConfigurationAlert reason={account.client?.scopeValidation?.reason ?? null} appName={account.serviceName} scopeList={accountDisallowed.join(", ")} />
              ) : null}
              {account.notice}
              {statusLine(account.status)}
            </>
          ) : (
            <>
              <AccountLoginRefusalBanner refusal={accountRefusal} error="" takeFocus />
              {signedInAs}
              {client ? <LoginAppDetailsCard client={client} /> : (
                <p className="text-callout text-foreground-muted">{clientError || formatMessage({ id: "pages.humanLogin.selectServerFallback" })}</p>
              )}
              <div>
                <div className={FIELD_LABEL_CLASS} id="slock-login-server-label">
                  {formatMessage({ id: "pages.humanLogin.raftServerLabel" })}
                </div>
                {onlyServer ? (
                  <p className="mt-1 break-words text-callout text-foreground" data-testid="login-setup-only-server">{onlyServer}</p>
                ) : (
                  <div id="slock-login-server" className="mt-1.5">{serverChoice}</div>
                )}
                {serverHelp ? <p className={FIELD_HELP_CLASS}>{serverHelp}</p> : null}
              </div>
              <RequestedScopeConsent scopes={scopes} className="" intro={false} />
              {scopeAlert}
              {commitBody ? (
                <div className="rounded-container border border-line-hairline bg-fill-muted p-4" data-testid="marketplace-login-commit-zone" aria-busy={commitBusy}>
                  {commitBody}
                </div>
              ) : null}
              {statusLine(status)}
            </>
          )}
        </div>
      </DialogBody>
      <DialogFooter data-testid="login-setup-sheet-footer">
        <DialogClose render={<Button variant="ghost" size="lg" />}>{formatMessage({ id: "common.confirm.cancel" })}</DialogClose>
        {approve ? <Button {...approve} size="lg" variant="accent" /> : null}
      </DialogFooter>
    </>
  );
}
