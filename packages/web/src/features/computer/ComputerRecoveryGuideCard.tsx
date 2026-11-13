import { Card, CopyableCode, CopyableCodeAction, Separator } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { Terminal, ChevronRight } from "lucide-react";
import Tooltip from "../../components/ui/Tooltip";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { CommandCopyRoot } from "../../components/machine/CommandCopyRoot";
import { DETAIL_HELP_CLASS_NAME, DETAIL_STEP_LABEL_CLASS_NAME, COMMAND_LINE_CLASS_NAME } from "./machineDetailClassNames";
import type { CommandCopyTarget } from "./machineDetailTypes";

/** The Computer's collapsible recovery guide in Actions: restart, fresh
 *  install, restart after install. */
export function ComputerRecoveryGuideCard({
  showRecoveryGuide,
  setRecoveryGuideDisclosure,
  recoveryGuideContentId,
  copiedCommand,
  handleCopy,
  terminalRestartCommand,
  windowsMachine,
  computerFreshInstall,
  computerInstallRestartCommand,
}: {
  showRecoveryGuide: boolean;
  setRecoveryGuideDisclosure: (open: boolean | null) => void;
  recoveryGuideContentId: string;
  copiedCommand: CommandCopyTarget | null;
  handleCopy: (target: CommandCopyTarget) => void;
  terminalRestartCommand: string;
  windowsMachine: boolean;
  computerFreshInstall: string;
  computerInstallRestartCommand: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <Card className="mb-3 p-4" data-testid="computer-recovery-guide">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={showRecoveryGuide}
        aria-controls={recoveryGuideContentId}
        aria-label={formatMessage(
          {
            id: showRecoveryGuide
              ? "machine.detail.hideRecoveryGuide"
              : "machine.detail.showRecoveryGuide",
          },
        )}
        onClick={() => setRecoveryGuideDisclosure(!showRecoveryGuide)}
      >
        <span className="flex items-center gap-2">
          <Terminal size={16} className="text-foreground-muted" aria-hidden="true" />
          <SectionEyebrow>{formatMessage({ id: "machine.detail.recoveryGuide" })}</SectionEyebrow>
        </span>
        <ChevronRight
          size={16}
          aria-hidden="true"
          className={`shrink-0 text-foreground-muted transition-transform motion-reduce:transition-none ${showRecoveryGuide ? "rotate-90" : ""}`}
          data-testid="computer-recovery-guide-chevron"
        />
      </button>
      {showRecoveryGuide && (
        <div
          id={recoveryGuideContentId}
          className="mt-3"
          data-testid="computer-recovery-guide-content"
        >
          <Separator className="mb-3" />
          <p className={`mb-4 ${DETAIL_HELP_CLASS_NAME}`}>
            {formatMessage({ id: "machine.detail.recoveryGuideDescription" })}
          </p>
          <ol className="stack-y-4">
            <li>
              <div className="mb-2">
                <div className={DETAIL_STEP_LABEL_CLASS_NAME}>
                  {formatMessage({ id: "machine.detail.restartStep" })}
                </div>
                <p className={DETAIL_HELP_CLASS_NAME}>
                  {formatMessage({ id: "machine.detail.restartStepDescription" })}
                </p>
              </div>
              <CommandCopyRoot target="terminal-restart" copied={copiedCommand === "terminal-restart"} onCopy={handleCopy}>
                <CopyableCode
                  className={COMMAND_LINE_CLASS_NAME}
                  data-testid="computer-recovery-guide-restart"
                >
                  {terminalRestartCommand}
                </CopyableCode>
                <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                  <CopyableCodeAction
                    aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                    className="shrink-0"
                  />
                </Tooltip>
              </CommandCopyRoot>
            </li>
            <li>
              <div className="mb-2">
                <div className={DETAIL_STEP_LABEL_CLASS_NAME}>
                  {formatMessage(
                    { id: "machine.detail.freshInstallStep" },
                    { platform: windowsMachine ? formatMessage({ id: "machine.detail.windowsX64Suffix" }) : "" },
                  )}
                </div>
                <p className={DETAIL_HELP_CLASS_NAME}>
                  {formatMessage({ id: "machine.computer.recovery.freshInstallDescription" })}
                </p>
              </div>
              <CommandCopyRoot target="computer-install" copied={copiedCommand === "computer-install"} onCopy={handleCopy}>
                <CopyableCode
                  className={COMMAND_LINE_CLASS_NAME}
                  data-testid="computer-recovery-guide-install"
                >
                  {computerFreshInstall}
                </CopyableCode>
                <Tooltip content={formatMessage({ id: "machine.detail.copyFreshInstallCommand" })}>
                  <CopyableCodeAction
                    aria-label={formatMessage({ id: "machine.detail.copyFreshInstallCommand" })}
                    className="shrink-0"
                  />
                </Tooltip>
              </CommandCopyRoot>
            </li>
            <li>
              <div className="mb-2">
                <div className={DETAIL_STEP_LABEL_CLASS_NAME}>
                  {formatMessage({ id: "machine.computer.recovery.restartAfterInstallStep" })}
                </div>
                <p className={DETAIL_HELP_CLASS_NAME}>
                  {formatMessage({ id: "machine.computer.recovery.restartAfterInstallDescription" })}
                </p>
              </div>
              <CommandCopyRoot target="computer-install-restart" copied={copiedCommand === "computer-install-restart"} onCopy={handleCopy}>
                <CopyableCode
                  className={COMMAND_LINE_CLASS_NAME}
                  data-testid="computer-recovery-guide-restart-after-install"
                >
                  {computerInstallRestartCommand}
                </CopyableCode>
                <Tooltip content={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}>
                  <CopyableCodeAction
                    aria-label={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}
                    className="shrink-0"
                  />
                </Tooltip>
              </CommandCopyRoot>
            </li>
          </ol>
        </div>
      )}
    </Card>
  );
}
