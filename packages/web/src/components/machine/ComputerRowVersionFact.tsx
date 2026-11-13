import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import type { Machine } from "../../store/machineStore";
import { useComputerVersionTier } from "../../hooks/useComputerVersionTier";
import type { ResolvedComputerVersionTier } from "../../hooks/useComputerVersionTier";
import {
  getComputerRowDotLight,
  getComputerRowDotStatus,
  getComputerRowDotTitleDescriptor,
} from "../../utils/computerUpgradeIndicator";
import StatusDot from "../ui/StatusDot";
import Tooltip from "../ui/Tooltip";
import { attentionItemLines } from "../../utils/readinessCopy";

type RowMachine = Pick<Machine, "id" | "isComputer" | "status" | "computerVersion" | "versionGate" | "attention">;

/** The version notice's title for a below-floor tier: the row chip's tooltip,
 *  and the row dot's when there is no newer version to name. */
function versionTierTitleId(tier: Exclude<ResolvedComputerVersionTier, { kind: "none" }>): MessageId {
  if (tier.reason === "computer_version_unknown") {
    return tier.enforced ? "machine.versionNotice.enforcedTitleUnknown" : "machine.versionNotice.unknownTitle";
  }
  if (tier.enforced) return "machine.versionNotice.enforcedTitle";
  return tier.kind === "upgrade" ? "machine.versionNotice.upgradeTitle" : "machine.versionNotice.reinstallTitle";
}

/**
 * The version fact on a Computer list row (desktop sidebar, rack, phone list):
 * below the version floor, a short orange "Update required" in the row's
 * machine type (the same treatment as "Low disk"; whether it takes an upgrade
 * or a reinstall is in its tooltip and on the detail page); otherwise the
 * available version (`→ v1.0.50`) when there is one, orange too: an update,
 * available or required, needs handling (the words keep them apart). One of the two, so the narrow sidebar row
 * keeps room for its run label. The detail page has the full notice.
 */
export function ComputerRowVersionFact({
  machine,
  availableVersion,
  arrowClassName,
  chipClassName,
}: {
  machine: RowMachine;
  availableVersion: string | null;
  arrowClassName: string;
  chipClassName: string;
}) {
  const { formatMessage } = useIntl();
  const tier = useComputerVersionTier(machine);
  if (tier.kind !== "none") {
    return (
      <span
        className={chipClassName}
        data-testid={`computer-version-chip-${machine.id}`}
        title={formatMessage({ id: versionTierTitleId(tier) })}
      >
        {formatMessage({ id: "machine.versionNotice.chipRequired" })}
      </span>
    );
  }
  if (!availableVersion) return null;
  return <span className={arrowClassName}>→ v{availableVersion}</span>;
}

/**
 * The status pixel on a Computer list row's icon (desktop sidebar, phone list):
 * orange when a newer version exists or the row says "Update required"
 * (so a Computer that does not report its version is pink like every other
 * outdated one), else its presence. `reconnecting`: its update is restarting
 * it ("Updating…" in the busy yellow, as on the Computer's page; cyan is only
 * for External agents).
 */
export function ComputerRowStatusDot({
  machine,
  availableVersion,
  className,
  reconnecting = false,
}: {
  machine: RowMachine;
  availableVersion: string | null;
  className: string;
  reconnecting?: boolean;
}) {
  const { formatMessage } = useIntl();
  const tier = useComputerVersionTier(machine);
  const status = getComputerRowDotStatus(machine, availableVersion, tier.kind !== "none");
  const descriptor = getComputerRowDotTitleDescriptor(status, machine.status, availableVersion);
  const title = reconnecting
    ? formatMessage({ id: "machine.detail.upgradeV2.inProgress" })
    : tier.kind !== "none" && availableVersion === null
      ? formatMessage({ id: versionTierTitleId(tier) })
      : formatMessage({ id: descriptor.id }, descriptor.values);
  // #68: the server says a person must act here: the orange light; its
  // tooltip lists each item (what, and who acts by name).
  const attention = machine.attention?.count ?? 0;
  if (!reconnecting && attention > 0) {
    const lines = attentionItemLines(formatMessage, machine.attention);
    return (
      <Tooltip content={<ul className="stack-y-0.5" data-testid={`computer-attention-items-${machine.id}`}>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>}>
        <StatusDot
          className={className}
          aria-label={lines.join("; ")}
          presence="error"
          data-testid={`computer-status-dot-${machine.id}`}
          data-needs-attention={String(attention)}
        />
      </Tooltip>
    );
  }
  return (
    <StatusDot
      className={className}
      title={title}
      {...(reconnecting ? { presence: "busy" as const } : getComputerRowDotLight(status))}
      data-testid={`computer-status-dot-${machine.id}`}
    />
  );
}
