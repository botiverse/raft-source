/**
 * "Your account will be deleted" (design §6, #triage:c3d9bd7c): while a
 * deletion is scheduled only reading/cancelling the deletion and
 * sign-out answers 403 `account_deletion_pending`
 * (store/accountDeletionPending.ts). AccountDeletionGate.tsx then shows this page
 * in place of the whole app shell, so nothing in the shell (restore retries,
 * the socket, live data) keeps asking; the page reads the deletion once.
 *
 * v7: the date as the title, the days left under it, Cancel Deletion and
 * Sign Out; nothing else.
 *
 * Cancel Deletion: DELETE, then into Settings › Account with a full load
 * (accountDeletionReturn.ts), never back to this address, unless an App's
 * sign-in brought the person here: then back to its confirmation; a deletion already gone
 * is confirmed by a fresh GET returning "none" after any failed DELETE.
 * The request-bound DELETE uses a dedicated path: older rolling-release
 * backends refuse it rather than ignoring a query and cancelling a new request.
 * Sign Out: the app's own sign-out (POST /auth/logout is allowed), which
 * also tells a host shell (`session:logout`), then the sign-in page.
 */
import { currentDate } from "@botiverse/raft-shared";
import { Button } from "@botiverse/raft-ui";
import { CircleCheck, Clock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";

import { disconnectSocket } from "../api/socket";
import Banner from "../components/ui/Banner";
import { cancelAccountDeletion, fetchAccountDeletionStatus } from "../features/settings/account/accountDeletionApi";
import type { AccountDeletionRequestId, SubscriptionRestorationResult } from "../features/settings/account/accountDeletionApi";
import { daysUntilDeletion, useDeletionDate } from "../features/settings/account/deleteAccountFlow";
import { clearAccountDeletionPending, useAccountDeletionPendingStore } from "../store/accountDeletionPending";
import { useAuthStore } from "../store/authStore";
import { AccountDeletionFrame, AccountDeletionHeading } from "./AccountDeletionFrame";
import { accountSettingsAfterCancel, afterCancelRedirect, appLoginAfterCancel } from "./accountDeletionReturn";

export function AccountDeletionPendingPage() {
  const { formatMessage } = useIntl();
  const deletionDate = useDeletionDate();
  const noted = useAccountDeletionPendingStore((state) => state.scheduledFor);
  const [scheduledFor, setScheduledFor] = useState<string | null>(noted);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [restoration, setRestoration] = useState<SubscriptionRestorationResult | null>(null);
  const [requestId, setRequestId] = useState<AccountDeletionRequestId>();
  const [requestLoadFailed, setRequestLoadFailed] = useState(false);
  const [requestChanged, setRequestChanged] = useState(false);
  const [cancellationUnconfirmed, setCancellationUnconfirmed] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  // Async loader: one read's answer lands in several fields (same FP family as
  // the other async-loaders, see .oxlintrc.json).
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    // The socket is refused too; don't let it keep reconnecting behind the page.
    disconnectSocket();
    let live = true;
    fetchAccountDeletionStatus().then((status) => {
      if (!live) return;
      if (status.status === "scheduled") {
        setScheduledFor(status.scheduledFor); setRequestId(status.requestId);
        setRequestLoadFailed(!status.requestId);
        setCancellationUnconfirmed(status.subscriptionCancellationUnconfirmed === true);
      } else setRestoration(status.subscriptionRestoration ?? "unknown");
    }).catch(() => { if (live) setRequestLoadFailed(true); });
    return () => { live = false; };
  }, [refreshVersion]);

  const continueAfterCancel = useCallback(() => {
    const { pathname, search } = window.location;
    afterCancelRedirect.assign(appLoginAfterCancel(pathname, search) ?? accountSettingsAfterCancel(pathname));
  }, []);

  const handleCancel = useCallback(() => {
    if (!requestId || requestLoadFailed) return;
    setBusy(true);
    setFailed(false);
    setRequestChanged(false);
    // Reload with the page still up (clearing the pending state first would
    // flash the sign-in page). Only on this press, never by itself: a reload
    // while the API still refuses would come straight back here.
    cancelAccountDeletion(requestId).catch(async (err: unknown) => {
      // Every unsuccessful or lost response needs a current-state read. An
      // absent old request is not evidence that no newer deletion exists.
      const status = await fetchAccountDeletionStatus(requestId).catch(() => null);
      if (status?.status === "scheduled") {
        setScheduledFor(status.scheduledFor);
        setRequestChanged(Boolean(status.requestId && status.requestId !== requestId));
        setRequestId(status.requestId);
        setRequestLoadFailed(!status.requestId);
        setCancellationUnconfirmed(status.subscriptionCancellationUnconfirmed === true);
        if (status.requestId === requestId) setFailed(true);
        return null;
      }
      if (status?.status !== "none") throw err;
      return { subscriptionRestoration: status.subscriptionRestoration ?? "unknown" };
    }).then((result) => {
      if (result === null) { setBusy(false); return; }
      if (result.subscriptionRestoration !== "restored") {
        setBusy(false);
        setRestoration(result.subscriptionRestoration);
        return;
      }
      continueAfterCancel();
    }, () => {
      setBusy(false);
      setFailed(true);
    });
  }, [continueAfterCancel, requestId, requestLoadFailed]);

  // Forget the request that could not be read or cancelled and read it again.
  const handleRetry = useCallback(() => {
    setRequestId(undefined);
    setRequestLoadFailed(false);
    setFailed(false);
    setRequestChanged(false);
    setRefreshVersion((value) => value + 1);
  }, []);

  const handleSignOut = useCallback(() => {
    useAuthStore.getState().logout();
    clearAccountDeletionPending();
  }, []);

  const dateText = deletionDate(scheduledFor);
  // The date stays on one line (a phone broke "2026 / 年11月5日" once the title was balanced).
  const date = dateText ? <span className="whitespace-nowrap">{dateText}</span> : null;
  const days = daysUntilDeletion(scheduledFor, currentDate());

  if (restoration) {
    return (
      <AccountDeletionFrame>
        <div className="w-full" data-testid="account-deletion-cancel-warning">
          <AccountDeletionHeading icon={<CircleCheck />} title={formatMessage({ id: "accountDeletion.cancelLinkDoneTitle" })}>
            {formatMessage({ id: "accountDeletion.afterCancelReconnect" })}
          </AccountDeletionHeading>
          <Banner intent="warning" className="mb-4">{formatMessage({ id: restoration === "not_restored" ? "accountDeletion.subscriptionNotResumed" : "accountDeletion.subscriptionRestorationUnknown" })}</Banner>
          <Button type="button" size="xl" variant="accent" className="w-full" onClick={continueAfterCancel}>
            {formatMessage({ id: "auth.recovery.goToRaft" })}
          </Button>
        </div>
      </AccountDeletionFrame>
    );
  }

  return (
    <AccountDeletionFrame>
      <div className="w-full" data-testid="account-deletion-pending-page">
        <AccountDeletionHeading
          icon={<Clock />}
          title={date
            ? formatMessage({ id: "accountDeletion.pendingTitleDate" }, { date })
            : formatMessage({ id: "accountDeletion.pendingTitle" })}
        >
          {days !== null && days > 0
            ? formatMessage({ id: "accountDeletion.pendingDaysLeft" }, { count: days })
            : date ? null : formatMessage({ id: "accountDeletion.pendingDescriptionNoDate" })}
        </AccountDeletionHeading>
        {/* Every Computer and agent key was revoked at the request: cancelling doesn't bring them back. */}
        <p className="mb-5 text-center text-callout text-foreground-muted" data-testid="account-deletion-reconnect">
          {formatMessage({ id: "accountDeletion.afterCancelReconnect" })}
        </p>
        {cancellationUnconfirmed ? <Banner intent="warning" className="mb-4">{formatMessage({ id: "accountDeletion.subscriptionCancellationUnconfirmed" })}</Banner> : null}
        {requestChanged ? <Banner intent="warning" className="mb-4">{formatMessage({ id: "accountDeletion.requestChanged" })}</Banner> : null}
        {requestLoadFailed ? <Banner intent="warning" className="mb-4">{formatMessage({ id: "accountDeletion.requestUnconfirmed" })}</Banner> : null}
        {failed ? <Banner intent="warning" className="mb-4">{formatMessage({ id: "accountDeletion.cancelFailed" })}</Banner> : null}
        <div className="stack-y-3">
          <Button type="button" size="xl" variant="accent" className="w-full" onClick={handleCancel} loading={busy} loadingLabel={formatMessage({ id: "accountDeletion.cancellingDeletion" })} disabled={busy || !requestId || requestLoadFailed}>
            {formatMessage({ id: "accountDeletion.cancelDeletion" })}
          </Button>
          {requestLoadFailed || failed ? <Button type="button" size="xl" variant="outline" className="w-full" onClick={handleRetry}>
            {formatMessage({ id: "common.deferred.retry" })}
          </Button> : null}
          <Button type="button" size="xl" variant="outline" className="w-full" onClick={handleSignOut} disabled={busy}>
            {formatMessage({ id: "settings.session.logOutAction" })}
          </Button>
        </div>
      </div>
    </AccountDeletionFrame>
  );
}
