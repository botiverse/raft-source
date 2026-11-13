import { useIntl } from "react-intl";
import { Text, TextLink } from "@botiverse/raft-ui";
import { useServerPermissions } from "../../../hooks/useServerPermissions";

/**
 * A different machine (a server, another laptop): the command flow, as one
 * quiet line under onboarding's Add This Mac. Everywhere else Add Computer
 * itself asks which computer. Only for whoever may add computers.
 */
export function InstallOnAnotherComputer({ onOpen, className = "px-5 py-4" }: {
  /** Shows the command flow (onboarding: its own guide, in place). */
  onOpen: () => void;
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const canRegisterMachines = useServerPermissions().capabilities.registerMachines;
  if (!canRegisterMachines) return null;
  return (
    <div className={className} data-testid="this-device-install-another">
      <Text.Sans size="caption" variant="muted" className="block">
        {formatMessage({ id: "computerHost.thisDevice.installAnotherHint" })}
        <TextLink onClick={onOpen} className="ml-1" data-testid="this-device-install-another-link">
          {formatMessage({ id: "computerHost.thisDevice.installAnother" })}
        </TextLink>
      </Text.Sans>
    </div>
  );
}
