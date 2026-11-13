/**
 * Where the "your account will be deleted" email's cancel link lands,
 * `/?cancel_account_deletion=<token>` (Tenny, #triage:d10ace06 e3526c4e;
 * the proposed server contract is in accountDeletionApi.ts). Signed in or
 * not: the token alone decides, and it only cancels (it signs nobody in).
 * Like the two-step reset links (SecondFactorRecoveryLinkPage) it acts only
 * on a click, never the page load, so a mail scanner that opens the link
 * changes nothing. Then: cancelled (sign in again, reconnect the computers),
 * a used or expired link (the server answers
 * it as invalid), or a failure to try again. Each ends in Sign In (Go to
 * Raft when this browser is already signed in).
 */
import { Button } from "@botiverse/raft-ui";
import { CircleCheck, Link2Off, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";

import Banner from "../components/ui/Banner";
import { cancelAccountDeletionByLink } from "../features/settings/account/accountDeletionApi";
import type { AccountDeletionCancelToken } from "../features/settings/account/accountDeletionApi";
import { useAuthStore } from "../store/authStore";
import { AccountDeletionFrame, AccountDeletionHeading } from "./AccountDeletionFrame";
import { releaseAccountDeletionCancelLinkReferrer } from "./accountDeletionCancelLink";

type State = "ready" | "working" | "cancelled" | "cancelled_subscription_not_resumed" | "cancelled_subscription_unknown" | "invalid" | "failed";

export function AccountDeletionCancelLinkPage({ token }: { token: AccountDeletionCancelToken | null }) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<State>(token ? "ready" : "invalid");
  // Already signed in here (a pending sign-in included): the way on is Raft, not signing in.
  const signedIn = useAuthStore((auth) => auth.user !== null);

  // App's URL parse already took the token out of the address and set
  // no-referrer (accountDeletionCancelLink.ts); the tag goes when the page does.
  useEffect(() => releaseAccountDeletionCancelLinkReferrer, []);

  const handleCancel = useCallback(() => {
    if (!token) return;
    setState("working");
    void cancelAccountDeletionByLink(token).then(setState);
  }, [token]);
  const handleSignIn = useCallback(() => {
    window.location.assign("/");
  }, []);

  const cancelled = state === "cancelled" || state === "cancelled_subscription_not_resumed" || state === "cancelled_subscription_unknown";
  const signIn = (
    <Button type="button" size="xl" variant={cancelled ? "accent" : "outline"} className="w-full" onClick={handleSignIn}>
      {formatMessage({ id: signedIn ? "auth.recovery.goToRaft" : "pages.login.title" })}
    </Button>
  );

  if (cancelled) {
    return (
      <AccountDeletionFrame>
        <div className="w-full" data-testid="account-deletion-cancel-link-done" role="status">
          <AccountDeletionHeading icon={<CircleCheck />} title={formatMessage({ id: "accountDeletion.cancelLinkDoneTitle" })}>
            {formatMessage({ id: "accountDeletion.afterCancelReconnect" })}
          </AccountDeletionHeading>
          {state === "cancelled_subscription_not_resumed" || state === "cancelled_subscription_unknown" ? <Banner intent="warning" className="mb-4">{formatMessage({ id: state === "cancelled_subscription_not_resumed" ? "accountDeletion.subscriptionNotResumed" : "accountDeletion.subscriptionRestorationUnknown" })}</Banner> : null}
          {signIn}
        </div>
      </AccountDeletionFrame>
    );
  }

  if (state === "invalid") {
    return (
      <AccountDeletionFrame>
        <div className="w-full" data-testid="account-deletion-cancel-link-invalid">
          <AccountDeletionHeading icon={<Link2Off />} title={formatMessage({ id: "accountDeletion.cancelLinkInvalidTitle" })}>
            {formatMessage({ id: "accountDeletion.cancelLinkInvalid" })}
          </AccountDeletionHeading>
          {signIn}
        </div>
      </AccountDeletionFrame>
    );
  }

  const working = state === "working";
  return (
    <AccountDeletionFrame>
      <div className="w-full" data-testid="account-deletion-cancel-link">
        <AccountDeletionHeading icon={<Undo2 />} title={formatMessage({ id: "accountDeletion.cancelLinkTitle" })}>
          {formatMessage({ id: "accountDeletion.afterCancelReconnect" })}
        </AccountDeletionHeading>
        {state === "failed" ? <Banner intent="warning" className="mb-4">{formatMessage({ id: "accountDeletion.subscriptionRestorationUnknown" })}</Banner> : null}
        <div className="stack-y-3">
          <Button
            type="button"
            size="xl"
            variant="accent"
            className="w-full"
            onClick={handleCancel}
            loading={working}
            loadingLabel={formatMessage({ id: "accountDeletion.cancellingDeletion" })}
            disabled={working}
          >
            {formatMessage({ id: "accountDeletion.cancelDeletion" })}
          </Button>
          {signIn}
        </div>
      </div>
    </AccountDeletionFrame>
  );
}
