import { TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { COMPUTER_INSTALL_DOCS_URL } from "../../utils/computerSetupCommand";
import type { ComputerCommandPlatform, ComputerCommands } from "../../utils/computerSetupCommand";
import { getComputerSteps } from "./ComputerCommandGuide";
import type { CopyTarget } from "./ComputerCommandGuide";
import { CommandRow } from "./CommandRow";

/**
 * The manual install for an existing Computer, when the web cannot (or must
 * not) upgrade it: exactly the Add Computer dialog's command(s) for this
 * machine's platform (one copyable line on mac/Linux production, the two
 * Windows steps otherwise), then the install guide.
 */
export function ComputerManualInstall({
  platform,
  commands,
  testId,
}: {
  platform: ComputerCommandPlatform;
  /** getComputerCommands for this machine's platform (what Add Computer shows). */
  commands: ComputerCommands | null;
  testId: string;
}) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const handleCopy = useCallback((target: CopyTarget) => {
    setCopied(target);
    setTimeout(() => setCopied((current) => (current === target ? null : current)), 2000);
  }, []);

  const steps = useMemo(() => {
    if (!commands) return [];
    const isWindows = platform === "windows";
    const found = getComputerSteps(
      platform,
      isWindows ? null : commands.install,
      isWindows ? null : commands.setup,
      isWindows ? null : commands.installAndSetup,
      isWindows ? commands.install : null,
      isWindows ? commands.setup : null,
      {
        install: formatMessage({ id: "machine.commandGuide.installStep" }),
        setup: formatMessage({ id: "machine.commandGuide.setupStep" }),
        copyInstall: formatMessage({ id: "machine.commandGuide.copyInstallCommand" }),
        copySetup: formatMessage({ id: "machine.commandGuide.copySetupCommand" }),
      },
    );
    // One line needs no step label (same as the Add Computer dialog).
    return found.length === 1
      ? [{ ...found[0], label: undefined, copyAriaLabel: formatMessage({ id: "machine.commandGuide.copyComputerCliCommand" }) }]
      : found;
  }, [commands, formatMessage, platform]);

  const installGuideLabel = formatMessage({ id: "machine.versionNotice.installGuide" });
  const opensInNewTab = formatMessage({ id: "common.opensInNewTab" });
  return (
    <div className="mt-2 stack-y-2" data-testid={testId}>
      {steps.length > 0 && (
        <div className="stack-y-2">
          {steps.map((step) => (
            <CommandRow key={step.target} step={step} copied={copied === step.target} onCopy={handleCopy} />
          ))}
        </div>
      )}
      <TextLink
        render={<a href={COMPUTER_INSTALL_DOCS_URL} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, installGuideLabel)} />}
        variant="strong"
        data-testid={`${testId}-docs`}
      >
        {installGuideLabel}
        <TextLinkExternalIcon label={opensInNewTab} />
      </TextLink>
    </div>
  );
}
