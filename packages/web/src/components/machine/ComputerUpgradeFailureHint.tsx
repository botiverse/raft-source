import { InlineCode } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import type { ComputerUpgradeFailureHint } from "@botiverse/raft-shared";

/**
 * What to do on the machine after a web upgrade failed because of the
 * systemd unit the Computer runs under (`upgradeRequest.failureHint`): stop
 * the unit, run the install command once, start the unit again. Names the
 * unit and its commands when the failure did.
 */
export function ComputerUpgradeFailureHintText({ hint }: { hint: ComputerUpgradeFailureHint }) {
  const { formatMessage } = useIntl();
  const killModeReason = hint.reason === "unsafe_kill_mode";
  if (!hint.unit || (killModeReason && !hint.killMode)) {
    return formatMessage({
      id: killModeReason
        ? "machine.detail.upgradeFailureHint.unsafeKillModeGeneric"
        : "machine.detail.upgradeFailureHint.installationHeldGeneric",
    });
  }
  // The KillMode refusal does not say whether the unit is a user one.
  const systemctl = hint.scope === "user" ? "systemctl --user" : hint.scope === "system" ? "systemctl" : "systemctl [--user]";
  // Commands, not copy: the same in every language.
  const stopCommand = `${systemctl} stop ${hint.unit}`;
  const startCommand = `${systemctl} start ${hint.unit}`;
  return formatMessage(
    {
      id: killModeReason
        ? "machine.detail.upgradeFailureHint.unsafeKillMode"
        : "machine.detail.upgradeFailureHint.installationHeld",
    },
    {
      unit: <InlineCode key="unit">{hint.unit}</InlineCode>,
      killMode: hint.killMode ?? "",
      stopCommand: <InlineCode key="stop">{stopCommand}</InlineCode>,
      startCommand: <InlineCode key="start">{startCommand}</InlineCode>,
    },
  );
}
