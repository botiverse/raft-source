import { useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { Badge, SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
import { useIntl } from "react-intl";
import type { ComputerCommandPlatform } from "../../utils/computerSetupCommand";
import SectionEyebrow from "../ui/SectionEyebrow";

interface ComputerCommandGuideProps {
  computerCommand: string | null;
  computerInstallCommand: string | null;
  windowsComputerCommand?: string | null;
  windowsComputerInstallCommand?: string | null;
  className?: string;
  macLinuxDaemonCommand: string;
  windowsDaemonCommand: string;
  onPlatformChange?: (platform: ComputerCommandPlatform) => void;
  onRequestWindowsDaemonCommand?: () => void;
  windowsDaemonCommandPending?: boolean;
  /**
   * Offer the legacy Daemon path alongside the Computer one. Default true, because the
   * Computers page still has legitimate reasons to reach it.
   *
   * FRESH ONBOARDING PASSES FALSE (#5254 / task #197). A legacy daemon connect creates only a
   * raw `machines` row, which can never satisfy the managed `computers` attachment the setup
   * projection requires — so during onboarding it is not an alternative route, it is a
   * guaranteed dead end that leaves the person unable to finish setup. Removing it there stops
   * new arrivals walking into it; it does not repair anyone already in that state (Computer
   * tasks #399/#400 own the terminal failure signal and the raw-machine recovery).
   */
  showLegacyDaemon?: boolean;
}

type CopyTarget =
  | "mac-linux-install"
  | "mac-linux-setup"
  | "windows-install"
  | "windows-setup"
  | "mac-linux-daemon"
  | "windows-daemon";

interface CommandStep {
  target: CopyTarget;
  label?: string;
  command: string;
  copyCommand?: string;
  copyAriaLabel: string;
}

interface ComputerStepLabels {
  install: string;
  setup: string;
  copyInstall: string;
  copySetup: string;
}

function getComputerSteps(
  platform: ComputerCommandPlatform,
  macLinuxInstall: string | null,
  macLinuxSetup: string | null,
  windowsInstall: string | null,
  windowsSetup: string | null,
  labels: ComputerStepLabels,
): CommandStep[] {
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
  onCopy: (target: CopyTarget, command: string) => void;
}) {
  return (
    <div className="space-y-3">
      {steps.map(({ target, label, command, copyCommand, copyAriaLabel }) => (
        <div key={target}>
          {label ? <div className="mb-1 text-xs font-bold text-black/60">{label}</div> : null}
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all">
              {command}
            </code>
            <button
              type="button"
              onClick={() => onCopy(target, copyCommand ?? command)}
              className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
              title={copyAriaLabel}
              aria-label={copyAriaLabel}
            >
              {copiedCommand === target ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ComputerCommandGuide({
  computerCommand,
  computerInstallCommand,
  windowsComputerCommand = null,
  windowsComputerInstallCommand = null,
  className = "",
  macLinuxDaemonCommand,
  windowsDaemonCommand,
  onPlatformChange,
  onRequestWindowsDaemonCommand,
  windowsDaemonCommandPending = false,
  showLegacyDaemon = true,
}: ComputerCommandGuideProps) {
  const { formatMessage } = useIntl();
  const [platform, setPlatform] = useState<ComputerCommandPlatform>("mac-linux");
  const [copiedCommand, setCopiedCommand] = useState<CopyTarget | null>(null);

  const isComputerGuide = Boolean(
    computerCommand || computerInstallCommand || windowsComputerCommand || windowsComputerInstallCommand,
  );
  const selectedComputerSteps = getComputerSteps(
    platform,
    computerInstallCommand,
    computerCommand,
    windowsComputerInstallCommand,
    windowsComputerCommand,
    {
      install: formatMessage({ id: "machine.commandGuide.installStep" }),
      setup: formatMessage({ id: "machine.commandGuide.setupStep" }),
      copyInstall: formatMessage({ id: "machine.commandGuide.copyInstallCommand" }),
      copySetup: formatMessage({ id: "machine.commandGuide.copySetupCommand" }),
    },
  );
  const displayedComputerSteps = selectedComputerSteps.length === 1
    ? [{
      ...selectedComputerSteps[0],
      label: undefined,
      copyAriaLabel: formatMessage({ id: "machine.commandGuide.copyComputerCliCommand" }),
    }]
    : selectedComputerSteps;
  const selectedDaemonCommand = platform === "windows" ? windowsDaemonCommand : macLinuxDaemonCommand;
  const displayDaemonCommand = selectedDaemonCommand.replace(
    /--api-key\s+(sk_machine_\S+)/,
    (_, key: string) => `--api-key ${key.slice(0, 14)}••••${key.slice(-4)}`,
  );
  const daemonCopyTarget: CopyTarget = platform === "windows" ? "windows-daemon" : "mac-linux-daemon";

  const handleCopy = async (target: CopyTarget, command: string) => {
    await navigator.clipboard.writeText(command);
    setCopiedCommand(target);
    setTimeout(() => {
      setCopiedCommand((current) => (current === target ? null : current));
    }, 2000);
  };

  const requestWindowsDaemonCommand = () => onRequestWindowsDaemonCommand?.();

  const selectedDaemonStep: CommandStep = {
    target: daemonCopyTarget,
    command: displayDaemonCommand,
    copyCommand: selectedDaemonCommand,
    copyAriaLabel: platform === "windows"
      ? formatMessage({ id: "machine.commandGuide.copyWindowsDaemonCommand" })
      : formatMessage({ id: "machine.commandGuide.copyDaemonCommand" }),
  };

  return (
    <div className={className}>
      <div className="mb-2 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-black" />
          <SectionEyebrow as="div">{formatMessage({ id: "machine.commandGuide.connectCommand" })}</SectionEyebrow>
        </div>
        <SegmentedControl<ComputerCommandPlatform>
          value={platform}
          onValueChange={(next) => {
            setPlatform(next);
            onPlatformChange?.(next);
          }}
          aria-label={formatMessage({ id: "machine.commandGuide.choosePlatform" })}
          className="shrink-0"
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

      <p className="mb-2 text-xs leading-5 text-black/60">
        {isComputerGuide
          ? platform === "windows"
            ? formatMessage({ id: "machine.commandGuide.windowsComputerDescription" })
            : computerCommand
            ? formatMessage({ id: "machine.commandGuide.macLinuxComputerDescription" })
            : formatMessage({ id: "machine.commandGuide.generateFreshConnect" })
          : platform === "windows"
            ? formatMessage({ id: "machine.commandGuide.windowsDaemonDescription" })
            : formatMessage({ id: "machine.commandGuide.macLinuxDaemonDescription" })}
      </p>

      {isComputerGuide && platform === "windows" ? (
        <div className="space-y-4">
          <div className="space-y-3" data-testid="windows-computer-command-block">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs font-bold uppercase tracking-wide text-black/70">
                {formatMessage({ id: "machine.commandGuide.raftComputerWindowsX64" })}
              </div>
              <Badge.Experimental />
            </div>
            {displayedComputerSteps.length > 0 ? (
              <CommandRows
                steps={displayedComputerSteps}
                copiedCommand={copiedCommand}
                onCopy={(target, command) => void handleCopy(target, command)}
              />
            ) : (
              <div className="border-2 border-black/30 bg-white px-3 py-2 text-xs font-bold text-black/50">
                {formatMessage({ id: "machine.commandGuide.generateFreshComputerConnect" })}
              </div>
            )}
          </div>

          {!showLegacyDaemon ? null : (
            <div className="border-t-2 border-black/20 pt-3" data-testid="windows-daemon-command-block">
              <div className="mb-1 text-xs font-bold uppercase tracking-wide text-black/70">
                {formatMessage({ id: "machine.commandGuide.daemonLegacy" })}
              </div>
              <p className="mb-2 text-xs leading-5 text-black/55">
                {formatMessage({ id: "machine.commandGuide.daemonLegacyDescription" })}
              </p>
              {windowsDaemonCommand ? (
                <CommandRows
                  steps={[selectedDaemonStep]}
                  copiedCommand={copiedCommand}
                  onCopy={(target, command) => void handleCopy(target, command)}
                />
              ) : onRequestWindowsDaemonCommand ? (
                <button
                  type="button"
                  onClick={requestWindowsDaemonCommand}
                  disabled={windowsDaemonCommandPending}
                  className="btn-brutal-sm bg-white px-3 py-1.5 disabled:cursor-wait disabled:opacity-60"
                  data-testid="computer-windows-daemon-request"
                >
                  {windowsDaemonCommandPending
                    ? formatMessage({ id: "machine.commandGuide.preparing" })
                    : formatMessage({ id: "machine.commandGuide.showLegacyDaemonCommand" })}
                </button>
              ) : (
                <div className="border-2 border-black/30 bg-white px-3 py-2 text-xs font-bold text-black/50">
                  {formatMessage({ id: "machine.commandGuide.generateFreshDaemonConnect" })}
                </div>
              )}
            </div>
          )}
        </div>
      ) : isComputerGuide && displayedComputerSteps.length > 0 ? (
        <CommandRows
          steps={displayedComputerSteps}
          copiedCommand={copiedCommand}
          onCopy={(target, command) => void handleCopy(target, command)}
        />
      ) : selectedDaemonCommand && showLegacyDaemon ? (
        <CommandRows
          steps={[selectedDaemonStep]}
          copiedCommand={copiedCommand}
          onCopy={(target, command) => void handleCopy(target, command)}
        />
      ) : platform === "windows" && onRequestWindowsDaemonCommand && showLegacyDaemon ? (
        <button
          type="button"
          onClick={requestWindowsDaemonCommand}
          disabled={windowsDaemonCommandPending}
          className="btn-brutal-sm bg-white px-3 py-1.5 disabled:cursor-wait disabled:opacity-60"
          data-testid="computer-windows-daemon-request"
        >
          {windowsDaemonCommandPending
            ? formatMessage({ id: "machine.commandGuide.preparing" })
            : formatMessage({ id: "machine.commandGuide.generateLegacyDaemonCommand" })}
        </button>
      ) : (
        <div className="border-2 border-black/30 bg-white px-3 py-2 text-xs font-bold text-black/50">
          {formatMessage({ id: "machine.commandGuide.generateFreshConnect" })}
        </div>
      )}
    </div>
  );
}
