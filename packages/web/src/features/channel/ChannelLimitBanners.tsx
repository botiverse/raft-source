import { useCallback } from "react";
import { useServerStore } from "../../store/serverStore";
import { useIntl } from "react-intl";
import { TextLink } from "@botiverse/raft-ui";
import type { ServerPlan } from "@botiverse/raft-shared";
import Banner from "../../components/ui/Banner";
import { COMPOSER_EDGE_CLASS } from "../../components/message/composerHost";
import { PaywallShown, usePaywallShown } from "../../analytics/paywall";
import { usePaywallUpgrade } from "../../hooks/usePaywallUpgrade";
import type { Channel } from "../../store/channelStore";
import { channelLimitLockedMessageId, externalFreezeUpcomingAt, isExternalFreezeActive } from "../../utils/jointChannelLimit";

/**
 * The free plan's external channel freeze, before its time: this server is
 * over the limit and will be read-only here from then on. Shown instead of
 * the joint grace notice when both apply (jointChannelGraceEndsAt).
 */
export function ExternalFreezeNotice({ channel }: { channel: Pick<Channel, "externalFreezeAt"> }) {
  const { formatMessage, formatDate } = useIntl();
  const deadline = externalFreezeUpcomingAt(channel);
  if (!deadline) return null;
  return (
    <div className={`bg-layer-canvas ${COMPOSER_EDGE_CLASS} pt-2`}>
      <Banner intent="warning" className="justify-center text-center font-bold" data-testid="external-freeze-notice-banner">
        {formatMessage(
          { id: "message.chatPanel.externalLimitFreezeNotice" },
          { deadline: formatDate(new Date(deadline), { dateStyle: "medium", timeStyle: "short" }) },
        )}
      </Banner>
    </div>
  );
}

/**
 * The composer's place in an external channel this Free server is frozen out
 * of (over its one external channel; Warden's v4 G, cindyz): a titled warning
 * Banner saying how to post again, by role. An owner upgrades; an admin may
 * also leave the extra channels, and asks an owner to upgrade; anyone else
 * asks an owner. Every button opens the upgrade dialog for
 * `external_channel_frozen` (an owner pays, anyone else messages an owner).
 * Off Free (a paid plan's own limit) the button opens billing as before.
 */
export function ExternalFrozenBanner({ plan, onUpgrade, testId }: { plan: ServerPlan | string | undefined; onUpgrade: () => void; testId?: string }) {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const role = server?.role;
  const name = server?.name ?? "";
  const free = plan === "free";
  const body = role === "owner" || role === "admin" ? "message.externalFrozen.bodyManager" : "message.externalFrozen.bodyMember";
  const button = !free ? "message.chatPanel.viewBilling" : role === "owner" ? "billing.upgradeToPro" : "planBilling.upgrade.askOwner";
  usePaywallShown(free ? "external_channel_frozen" : null, "channel_banner");
  return (
    <div className="bg-layer-canvas p-3">
      <Banner
        intent="warning"
        title={formatMessage({ id: "message.externalFrozen.title" }, { server: name })}
        data-testid={testId}
        actions={(
          <TextLink onClick={onUpgrade} variant="strong" data-testid="external-frozen-upgrade">
            {formatMessage({ id: button })}
          </TextLink>
        )}
      >
        {formatMessage({ id: body })}
      </Banner>
    </div>
  );
}

/**
 * The composer's place in a channel a plan limit makes read-only
 * (isJointChannelReadOnly): a joint past its over-limit grace, or a channel
 * this server is frozen out of (ExternalFrozenBanner).
 */
export function ChannelLimitLockedBanner({ channel, plan }: { channel: Channel; plan: ServerPlan }) {
  const { formatMessage } = useIntl();
  const paywallUpgrade = usePaywallUpgrade();
  const externalFrozen = isExternalFreezeActive(channel);
  const openUpgrade = useCallback(
    () => paywallUpgrade(externalFrozen ? "external_channel_frozen" : "joint_channel_read_only", externalFrozen ? "channel_banner" : undefined),
    [paywallUpgrade, externalFrozen],
  );
  if (externalFrozen) return <ExternalFrozenBanner plan={plan} onUpgrade={openUpgrade} testId="external-freeze-locked-banner" />;
  return (
    <div className="bg-layer-canvas p-3">
      <Banner intent="warning" className="justify-center text-center font-bold" data-testid={externalFrozen ? "external-freeze-locked-banner" : undefined}>
        <span className="mr-1">{formatMessage({ id: channelLimitLockedMessageId(channel) })}</span>
        {!externalFrozen && <PaywallShown gate="joint_channel_read_only" />}
        <TextLink onClick={openUpgrade} variant="strong" data-testid="joint-locked-upgrade">
          {formatMessage({ id: plan === "free" ? "billing.upgradeToPro" : "message.chatPanel.viewBilling" })}
        </TextLink>
      </Banner>
    </div>
  );
}
