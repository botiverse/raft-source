/**
 * Right after this tab requested the account deletion (DeleteAccountPage):
 * every sign-in, this one too, is already gone. AccountDeletionGate shows
 * this in place of the whole app shell, so nothing in the shell keeps asking
 * (and getting 401s) meanwhile. v7: "Deletion scheduled", the date it takes
 * effect, how to cancel (and that cancelling means signing in again on each
 * device and reconnecting the computers: every Computer and agent key was
 * revoked), that every device is signed out; OK signs out the
 * way Sign Out does, which also tells a host shell (`session:logout`).
 */
import { Button, Card } from "@botiverse/raft-ui";
import { CalendarCheck, LogIn } from "lucide-react";
import { useIntl } from "react-intl";

import { signOutAfterDeletion, useDeletionDate } from "../features/settings/account/deleteAccountFlow";
import { AccountDeletionFrame, AccountDeletionHeading } from "./AccountDeletionFrame";

export function AccountDeletionRequestedPage({ scheduledFor }: { scheduledFor: string | null }) {
  const { formatMessage } = useIntl();
  const dateText = useDeletionDate()(scheduledFor);
  // The date stays on one line, and reads stronger than the words around it.
  const date = dateText ? <b className="whitespace-nowrap font-semibold text-foreground">{dateText}</b> : null;
  return (
    <AccountDeletionFrame>
      <div className="w-full" data-testid="account-deletion-scheduled" role="status">
        <AccountDeletionHeading icon={<CalendarCheck />} title={formatMessage({ id: "accountDeletion.scheduledTitle" })}>
          {date ? formatMessage({ id: "accountDeletion.scheduledEffective" }, { date }) : null}
        </AccountDeletionHeading>
        <Card className="mb-5 stack-y-2.5 p-4 text-left" data-testid="account-deletion-how-to-cancel">
          <h2 className="m-0 text-callout font-semibold text-foreground-hint">{formatMessage({ id: "accountDeletion.howToCancel" })}</h2>
          <p className="m-0 grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 text-subhead text-foreground">
            <LogIn aria-hidden className="mt-0.5 size-5 text-foreground-muted" />
            <span>
              {date
                ? formatMessage({ id: "accountDeletion.cancelBySignIn" }, { date })
                : formatMessage({ id: "accountDeletion.effectGrace" })}
            </span>
          </p>
          <p className="m-0 text-callout text-foreground-muted" data-testid="account-deletion-reconnect">
            {formatMessage({ id: "accountDeletion.afterCancelReconnect" })}
          </p>
        </Card>
        <p className="mb-5 text-center text-callout text-foreground-muted">{formatMessage({ id: "accountDeletion.signedOutEverywhere" })}</p>
        <Button type="button" size="xl" variant="accent" className="w-full" onClick={signOutAfterDeletion}>
          {formatMessage({ id: "common.ok" })}
        </Button>
      </div>
    </AccountDeletionFrame>
  );
}
