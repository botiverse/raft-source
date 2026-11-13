import { Button, IconTile } from "@botiverse/raft-ui";
import { Mail, X } from "lucide-react";
import { currentTimeMs } from "@botiverse/raft-shared";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../ConfirmDialog";
import { showToast } from "../toastBridge";
import Tooltip from "../ui/Tooltip";
import { ChannelMemberRoleAndActions, ChannelMemberRow } from "./ChannelMemberList";
import {
  EXTERNAL_INVITE_MAX_EMAILS,
  externalInviteDaysLeft,
  externalInviteErrorMessageId,
  resendExternalInvite,
  revokeExternalInvite,
} from "./externalInvites";
import type { ChannelExternalInvite } from "./externalInvites";
import type { ServerRole } from "@botiverse/raft-shared";

/** The trailing slot's role tag: an invitee has no role yet, and "member" draws none. */
const NO_ROLE_TAG: ServerRole = "member";

/**
 * One open external invite in the channel's Invited group (design v5.0 A4):
 * the email, the days left (or where it is waiting), and Resend and Withdraw,
 * revealed on hover like the other member rows' actions (always shown on
 * touch). Only host owners and admins get this group at all.
 */
function ExternalInviteRow({
  channelId,
  invite,
  resendAvailable,
}: {
  channelId: string;
  invite: ChannelExternalInvite;
  /** Resending is a new send: external_channels_v1 must be on. */
  resendAvailable: boolean;
}) {
  const { formatMessage } = useIntl();
  const [busy, setBusy] = useState(false);
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const state = invite.connecting
    ? formatMessage({ id: "channel.externalInvite.connecting" })
    : invite.awaitingApproval
      ? formatMessage({ id: "channel.externalInvite.awaitingApproval" })
      : formatMessage(
        { id: "channel.externalInvite.daysLeft" },
        { count: externalInviteDaysLeft(invite.expiresAt, currentTimeMs()) },
      );
  // A resend replaces a plain pending invite; one that is waiting for an
  // approver or connecting a server belongs to that flow (the server refuses).
  const canResend = resendAvailable && !invite.connecting && !invite.awaitingApproval;
  // The server lists whether withdrawing is refused right now (a conversion
  // it started can't be interrupted); older servers don't say (revocable).
  const revocable = invite.revocable !== false;

  const run = useCallback(async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await action();
      showToast({ title: done, type: "success" });
    } catch (err) {
      showToast({ title: formatMessage({ id: externalInviteErrorMessageId(err) }, { max: EXTERNAL_INVITE_MAX_EMAILS }), type: "warning" });
    } finally {
      setBusy(false);
    }
  }, [formatMessage]);

  const handleResend = useCallback(() => {
    void run(
      () => resendExternalInvite(channelId, invite.id),
      formatMessage({ id: "channel.externalInvite.resent" }, { email: invite.email }),
    );
  }, [channelId, formatMessage, invite.email, invite.id, run]);

  // Withdrawing makes the link the invitee holds stop working, so it is
  // confirmed first (DS Feedback › Confirming); Resend stays one click.
  const openWithdraw = useCallback(() => setConfirmingWithdraw(true), []);
  const closeWithdraw = useCallback(() => setConfirmingWithdraw(false), []);
  // `revocable` turns Withdraw off up front; the server's 409 (`connecting`)
  // stays the fallback for a list read before the conversion started. The
  // dialog shows the error and stays open.
  const confirmWithdraw = useCallback(async () => {
    try {
      await revokeExternalInvite(channelId, invite.id);
    } catch (err) {
      throw new Error(formatMessage({ id: externalInviteErrorMessageId(err) }, { max: EXTERNAL_INVITE_MAX_EMAILS }));
    }
    showToast({ title: formatMessage({ id: "channel.externalInvite.withdrawn" }, { email: invite.email }), type: "success" });
  }, [channelId, formatMessage, invite.email, invite.id]);

  // Icon buttons revealed on row hover (always shown on touch), as the other
  // member rows' actions: Mail = Resend, X = Withdraw. Short tooltips; the
  // aria-labels name the email.
  const resendLabel = formatMessage({ id: "channel.externalInvite.resendAria" }, { email: invite.email });
  const withdrawLabel = formatMessage({ id: "channel.externalInvite.withdrawAria" }, { email: invite.email });
  const withdrawButton = (
    <Button
      type="button"
      size="icon-md"
      variant="ghost"
      className="text-foreground-muted hover:text-foreground"
      onClick={openWithdraw}
      disabled={busy || !revocable}
      focusableWhenDisabled
      aria-label={withdrawLabel}
      data-testid="external-invite-withdraw"
    >
      <X aria-hidden="true" />
    </Button>
  );
  const actions = (
    <span className="flex items-center gap-1" data-testid="external-invite-actions">
      {canResend && (
        <Tooltip content={formatMessage({ id: "channel.externalInvite.resendTooltip" })}>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            className="text-foreground-muted hover:text-foreground"
            onClick={handleResend}
            disabled={busy}
            aria-label={resendLabel}
            data-testid="external-invite-resend"
          >
            <Mail aria-hidden="true" />
          </Button>
        </Tooltip>
      )}
      {/* focusableWhenDisabled keeps a refused Withdraw in the tab order and
          hoverable, so its reason is reachable (DS Accessibility, Tooltip:
          the control's name, then the reason in muted text below). */}
      <Tooltip
        content={revocable ? formatMessage({ id: "channel.externalInvite.withdrawTooltip" }) : (
          <span data-testid="external-invite-withdraw-blocked">
            <span className="block">{formatMessage({ id: "channel.externalInvite.withdrawTooltip" })}</span>
            <span className="mt-1 block text-foreground-on-hud-muted">{formatMessage({ id: "channel.externalInvite.withdrawConnecting" })}</span>
          </span>
        )}
      >
        {withdrawButton}
      </Tooltip>
    </span>
  );

  return (
    <>
      <ChannelMemberRow
        type="human"
        media={(
          <IconTile size="md" aria-hidden="true" data-testid="external-invite-tile">
            <Mail />
          </IconTile>
        )}
        // The state follows the email on the title line, in hint ink, so an
        // invite row is as tall as a member row with no description.
        name={(
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 truncate" data-testid="external-invite-email">{invite.email}</span>
            <span className="shrink-0 text-caption font-normal text-foreground-hint" data-testid="external-invite-state">{state}</span>
          </span>
        )}
        trailing={<ChannelMemberRoleAndActions role={NO_ROLE_TAG} actions={actions} />}
      />
      {confirmingWithdraw && (
        <ConfirmDialog
          title={formatMessage({ id: "channel.externalInvite.withdrawConfirm.title" })}
          message={formatMessage({ id: "channel.externalInvite.withdrawConfirm.message" }, { email: invite.email })}
          confirmLabel={formatMessage({ id: "channel.externalInvite.withdrawConfirm.confirm" })}
          loadingLabel={formatMessage({ id: "channel.externalInvite.withdrawConfirm.loading" })}
          confirmTestId="external-invite-withdraw-confirm"
          layer={1}
          onConfirm={confirmWithdraw}
          onClose={closeWithdraw}
        />
      )}
    </>
  );
}

export default function ExternalInviteRows({
  channelId,
  invites,
  canResend,
}: {
  channelId: string;
  invites: readonly ChannelExternalInvite[];
  canResend: boolean;
}) {
  return (
    <>
      {invites.map((invite) => (
        <ExternalInviteRow key={invite.id} channelId={channelId} invite={invite} resendAvailable={canResend} />
      ))}
    </>
  );
}
