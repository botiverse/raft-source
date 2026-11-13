import { SegmentedControl, SegmentedControlItem, SegmentedControlLabel, TextLink } from "@botiverse/raft-ui";
import { useCallback, useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import { useIntl } from "react-intl";
import type { ComputerCommandPlatform } from "../../utils/computerSetupCommand";
import SectionEyebrow from "../ui/SectionEyebrow";
import { CommandRow } from "./CommandRow";

interface ComputerCommandGuideProps {
  computerCommand: string | null;
  computerInstallCommand: string | null;
  // When set, mac/Linux shows this single install-then-setup command instead
  // of the separate install and setup steps.
  computerInstallAndSetupCommand?: string | null;
  windowsComputerCommand?: string | null;
  windowsComputerInstallCommand?: string | null;
  className?: string;
  onPlatformChange?: (platform: ComputerCommandPlatform) => void;
  /** Told which command was copied (the setup step's funnel counts it). */
  onCopy?: (target: CopyTarget) => void;
}

/** Where a command line would be when there is none yet: a dashed seam box,
 *  like an empty board column (Raft DS), ink-3 text. */
const COMMAND_PLACEHOLDER_CLASS_NAME =
  "rounded-control border border-dashed border-line-seam px-3 py-2.5 text-footnote text-foreground-hint";

// Raft Computer is the only connect path. The standalone daemon connect
// command is retired: the daemon is no longer published on its own and this
// guide never offers it (docs/operations/computer-release-version.md).

export type CopyTarget =
  | "mac-linux-install"
  | "mac-linux-install-and-setup"
  | "mac-linux-setup"
  | "windows-install"
  | "windows-setup";

export interface CommandStep {
  target: CopyTarget;
  label?: string;
  command: string;
  copyCommand?: string;
  copyAriaLabel: string;
}

export interface ComputerStepLabels {
  install: string;
  setup: string;
  copyInstall: string;
  copySetup: string;
}

export function getComputerSteps(
  platform: ComputerCommandPlatform,
  macLinuxInstall: string | null,
  macLinuxSetup: string | null,
  macLinuxInstallAndSetup: string | null,
  windowsInstall: string | null,
  windowsSetup: string | null,
  labels: ComputerStepLabels,
): CommandStep[] {
  if (platform === "mac-linux" && macLinuxInstallAndSetup) {
    return [{ target: "mac-linux-install-and-setup", command: macLinuxInstallAndSetup, copyAriaLabel: labels.copySetup }];
  }
  const install = platform === "windows" ? windowsInstall : macLinuxInstall;
  const setup = platform === "windows" ? windowsSetup : macLinuxSetup;
  const prefix = platform === "windows" ? "windows" : "mac-linux";
  const steps: CommandStep[] = [];

  if (install) {
    steps.push({ target: `${prefix}-install`, label: labels.install, command: install, copyAriaLabel: labels.copyInstall });
  }
  if (setup) {
    steps.push({ target: `${prefix}-setup`, label: labels.setup, command: setup, copyAriaLabel: labels.copySetup });
  }
  return steps;
}

function CommandRows({
  steps,
  copiedCommand,
  onCopy,
}: {
  steps: readonly CommandStep[];
  copiedCommand: CopyTarget | null;
  onCopy: (target: CopyTarget) => void;
}) {
  return (
    <div className="stack-y-3">
      {steps.map((step) => (
        <CommandRow
          key={step.target}
          step={step}
          copied={copiedCommand === step.target}
          onCopy={onCopy}
        />
      ))}
    </div>
  );
}

export default function ComputerCommandGuide({
  computerCommand,
  computerInstallCommand,
  computerInstallAndSetupCommand = null,
  windowsComputerCommand = null,
  windowsComputerInstallCommand = null,
  className = "",
  onPlatformChange,
  onCopy,
}: ComputerCommandGuideProps) {
  const { formatMessage } = useIntl();
  const [platform, setPlatform] = useState<ComputerCommandPlatform>("mac-linux");
  const [copiedCommand, setCopiedCommand] = useState<CopyTarget | null>(null);
  const [showConnectOnly, setShowConnectOnly] = useState(false);

  const isComputerGuide = Boolean(
    computerCommand || computerInstallCommand || windowsComputerCommand || windowsComputerInstallCommand,
  );
  const displayedComputerSteps = useMemo(() => {
    const selectedComputerSteps = getComputerSteps(
      platform,
      computerInstallCommand,
      computerCommand,
      computerInstallAndSetupCommand,
      windowsComputerInstallCommand,
      windowsComputerCommand,
      {
        install: formatMessage({ id: "machine.commandGuide.installStep" }),
        setup: formatMessage({ id: "machine.commandGuide.setupStep" }),
        copyInstall: formatMessage({ id: "machine.commandGuide.copyInstallCommand" }),
        copySetup: formatMessage({ id: "machine.commandGuide.copySetupCommand" }),
      },
    );
    return selectedComputerSteps.length === 1
      ? [{
        ...selectedComputerSteps[0],
        label: undefined,
        copyAriaLabel: formatMessage({ id: "machine.commandGuide.copyComputerCliCommand" }),
      }]
      : selectedComputerSteps;
  }, [
    computerCommand,
    computerInstallAndSetupCommand,
    computerInstallCommand,
    formatMessage,
    platform,
    windowsComputerCommand,
    windowsComputerInstallCommand,
  ]);

  const connectOnlySteps = useMemo<CommandStep[]>(() => (computerCommand
    ? [{
      target: "mac-linux-setup",
      command: computerCommand,
      copyAriaLabel: formatMessage({ id: "machine.commandGuide.copySetupCommand" }),
    }]
    : []), [computerCommand, formatMessage]);

  const handleCopy = useCallback((target: CopyTarget) => {
    onCopy?.(target);
    setCopiedCommand(target);
    setTimeout(() => {
      setCopiedCommand((current) => (current === target ? null : current));
    }, 2000);
  }, [onCopy]);

  const toggleConnectOnly = useCallback(() => setShowConnectOnly((open) => !open), []);

  const handlePlatformChange = useCallback((next: ComputerCommandPlatform) => {
    setPlatform(next);
    onPlatformChange?.(next);
  }, [onPlatformChange]);

  return (
    <div className={className}>
      <div className="mb-2 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-foreground-muted" aria-hidden="true" />
          <SectionEyebrow as="div">{formatMessage({ id: "machine.commandGuide.connectCommand" })}</SectionEyebrow>
        </div>
        <SegmentedControl<ComputerCommandPlatform>
          value={platform}
          onValueChange={handlePlatformChange}
          aria-label={formatMessage({ id: "machine.commandGuide.choosePlatform" })}
        >
          <SegmentedControlItem value="mac-linux" data-testid="computer-command-platform-mac-linux">
            <SegmentedControlLabel>{formatMessage({ id: "machine.detail.macLinux" })}</SegmentedControlLabel>
          </SegmentedControlItem>
          <SegmentedControlItem value="windows" data-testid="computer-command-platform-windows">
            <SegmentedControlLabel>
              {isComputerGuide
                ? formatMessage({ id: "machine.commandGuide.windowsX64" })
                : formatMessage({ id: "machine.commandGuide.windows" })}
            </SegmentedControlLabel>
          </SegmentedControlItem>
        </SegmentedControl>
      </div>

      <p className="mb-3 text-footnote text-foreground-muted">
        {isComputerGuide && platform === "windows"
          ? formatMessage({ id: "machine.commandGuide.windowsComputerDescription" })
          : isComputerGuide && computerCommand
            ? formatMessage({ id: "machine.commandGuide.macLinuxComputerDescription" })
            : formatMessage({ id: "machine.commandGuide.generateFreshConnect" })}
      </p>

      {isComputerGuide && platform === "windows" ? (
        <div className="stack-y-3" data-testid="windows-computer-command-block">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-footnote font-bold text-foreground">
                {formatMessage({ id: "machine.commandGuide.raftComputerWindowsX64" })}
              </div>
            </div>
          {displayedComputerSteps.length > 0 ? (
            <CommandRows
              steps={displayedComputerSteps}
              copiedCommand={copiedCommand}
              onCopy={handleCopy}
            />
          ) : (
            <div className={COMMAND_PLACEHOLDER_CLASS_NAME}>
              {formatMessage({ id: "machine.commandGuide.generateFreshComputerConnect" })}
            </div>
          )}
        </div>
      ) : isComputerGuide && displayedComputerSteps.length > 0 ? (
        <>
          <CommandRows
            steps={displayedComputerSteps}
            copiedCommand={copiedCommand}
            onCopy={handleCopy}
          />
          {/* The one-line command installs first and only connects if that
              succeeds, so a machine that already runs Raft Computer could
              never get past "waiting" (bug-triage task #22, julie). Offer the
              connect-only command behind an explicit choice. */}
          {computerInstallAndSetupCommand && computerCommand && (
            <div className="mt-2">
              <TextLink
                aria-expanded={showConnectOnly}
                onClick={toggleConnectOnly}
                className="text-footnote"
                data-testid="computer-command-already-installed"
              >
                {formatMessage({ id: "machine.commandGuide.alreadyInstalled" })}
              </TextLink>
              {showConnectOnly && (
                <div className="mt-2" data-testid="computer-command-connect-only">
                  <p className="mb-2 text-footnote text-foreground-muted">
                    {formatMessage({ id: "machine.commandGuide.connectOnlyDescription" })}
                  </p>
                  <CommandRows
                    steps={connectOnlySteps}
                    copiedCommand={copiedCommand}
                    onCopy={handleCopy}
                  />
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className={COMMAND_PLACEHOLDER_CLASS_NAME}>
          {formatMessage({ id: "machine.commandGuide.generateFreshConnect" })}
        </div>
      )}
    </div>
  );
}
