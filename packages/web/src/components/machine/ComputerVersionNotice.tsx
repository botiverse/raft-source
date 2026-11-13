import { Button } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import type { ComputerCommandPlatform, ComputerCommands } from "../../utils/computerSetupCommand";
import type { ResolvedComputerVersionTier } from "../../hooks/useComputerVersionTier";
import { ComputerManualInstall } from "./ComputerManualInstall";

type NoticeTier = Exclude<ResolvedComputerVersionTier, { kind: "none" }>;

/**
 * The always-on notice at the top of a Computer's page when its version is
 * below the floor (computerVersionTier). Raft DS Banner, warning: something to
 * fix that can be recovered from, part of the page rather than news.
 *
 * - upgrade: please upgrade, with the same one-click upgrade the Computer card
 *   offers (only when the card offers it), or the manual install where the
 *   card gives that instead (server remoteUpgradeSupported: false).
 * - reinstall: the web cannot upgrade it, because it is too old
 *   (computer_version_unsupported) or reports no version
 *   (computer_version_unknown); each says why, and both give the Add Computer
 *   dialog's install command for this machine's platform and the install guide.
 *
 * The Upgrade button stays after enforcement: a quarantined Computer still
 * takes web upgrade commands.
 */
export default function ComputerVersionNotice({
  tier,
  computerVersion,
  canManage,
  platform,
  commands,
  upgradeTargetVersion,
  manualUpgrade,
  onUpgrade,
}: {
  tier: NoticeTier;
  computerVersion: string | null;
  canManage: boolean;
  platform: ComputerCommandPlatform;
  /** getComputerCommands for this machine's platform (what Add Computer shows). */
  commands: ComputerCommands | null;
  /** Set when the Computer card offers its one-click upgrade. */
  upgradeTargetVersion: string | null;
  /** The Computer card gives the manual install instead of one-click (the
   *  server says remoteUpgradeSupported: false): the notice shows it too. */
  manualUpgrade: boolean;
  onUpgrade: () => void;
}) {
  const { formatDate, formatMessage } = useIntl();
  const date = tier.enforcedAt
    ? formatDate(tier.enforcedAt, { year: "numeric", month: "short", day: "numeric" })
    : null;
  const unknown = tier.reason === "computer_version_unknown";
  const title = tier.enforced
    ? formatMessage({ id: unknown ? "machine.versionNotice.enforcedTitleUnknown" : "machine.versionNotice.enforcedTitle" })
    : tier.kind === "upgrade"
      ? date
        ? formatMessage({ id: "machine.versionNotice.upgradeTitleScheduled" }, { date })
        : formatMessage({ id: "machine.versionNotice.upgradeTitle" })
      : date
        ? formatMessage({ id: "machine.versionNotice.reinstallTitleScheduled" }, { date })
        : formatMessage({ id: unknown ? "machine.versionNotice.unknownTitle" : "machine.versionNotice.reinstallTitle" });

  const body = tier.kind === "upgrade"
    ? formatMessage(
      { id: "machine.versionNotice.upgradeBody" },
      { version: computerVersion ?? "", floor: tier.minVersion },
    )
    : unknown || !computerVersion
      ? formatMessage({ id: "machine.versionNotice.unknownBody" })
      : formatMessage({ id: "machine.versionNotice.reinstallBody" }, { version: computerVersion });

  const showUpgradeButton = tier.kind === "upgrade" && canManage && upgradeTargetVersion !== null;

  return (
    <Banner
      intent="warning"
      live={false}
      withIcon
      title={title}
      data-testid="computer-version-notice"
      data-tier={tier.kind}
      data-reason={tier.reason}
      actions={showUpgradeButton ? (
        <Button size="md" variant="default" onClick={onUpgrade} data-testid="computer-version-notice-upgrade">
          {formatMessage({ id: "machine.detail.upgradeToVersion" }, { version: upgradeTargetVersion })}
        </Button>
      ) : undefined}
    >
      <p>{body}</p>
      {!canManage && (
        <p>
          {formatMessage({
            id: tier.kind === "upgrade" ? "machine.versionNotice.askAdminUpgrade" : "machine.versionNotice.askAdminReinstall",
          })}
        </p>
      )}
      {canManage && (tier.kind === "reinstall" || manualUpgrade) && (
        <ComputerManualInstall platform={platform} commands={commands} testId="computer-version-notice-reinstall" />
      )}
    </Banner>
  );
}
