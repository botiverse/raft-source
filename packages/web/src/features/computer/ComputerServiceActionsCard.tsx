import { Banner, BannerDescription, Card, Button, CopyableCode, CopyableCodeAction, Separator, Spinner } from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { RotateCcw, CircleCheck, TriangleAlert, Terminal, CircleArrowUp } from "lucide-react";
import ProgressBar from "../../components/ui/ProgressBar";
import type { Machine } from "../../store/machineStore";
import type { ComputerReleaseNotes } from "@botiverse/raft-shared";
import type { ComputerCommands } from "../../utils/computerSetupCommand";
import type { useComputerRestart, useComputerUpgradeCard } from "../../components/machine/useComputerUpgradeCard";
import Tooltip from "../../components/ui/Tooltip";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import ComputerReleaseNotesAffordance from "../../components/machine/ComputerReleaseNotesAffordance";
import { ComputerManualInstall } from "../../components/machine/ComputerManualInstall";
import { ComputerUpgradeFailureHintText } from "../../components/machine/ComputerUpgradeFailureHint";
import { CommandCopyRoot } from "../../components/machine/CommandCopyRoot";
import { DETAIL_HELP_CLASS_NAME, DETAIL_PROBLEM_CLASS_NAME, DETAIL_STEP_LABEL_CLASS_NAME, COMMAND_LINE_CLASS_NAME } from "./machineDetailClassNames";
import type { CommandCopyTarget } from "./machineDetailTypes";
import { terminalStatusCommandsFor } from "./machineDetailCommands";

type UpgradeCard = ReturnType<typeof useComputerUpgradeCard>;

/** The online Computer's service card in Actions: restart / upgrade
 *  progress or status + next step, then the terminal verification. */
export function ComputerServiceActionsCard({
  machine,
  computerOperationProgress,
  handleComputerRestartClick,
  cardState,
  versionTier,
  webUpgradeOn,
  upgradeRefusal,
  recommendRepair,
  upgradeRequest,
  requestOutcomeStillTrue,
  upgradeFailureHint,
  handleRemoteUpgradeV2Click,
  computerFreshInstallCommands,
  statusCommand,
  noResponseLine,
  releaseNotesForUpdate,
  windowsMachine,
  copiedCommand,
  handleCopy,
  machineComputerCommands,
  terminalRestartCommand,
}: {
  machine: Machine;
  computerOperationProgress: ReturnType<typeof useComputerRestart>["progress"];
  handleComputerRestartClick: ReturnType<typeof useComputerRestart>["restart"];
  cardState: UpgradeCard["cardState"];
  versionTier: UpgradeCard["versionTier"];
  webUpgradeOn: UpgradeCard["webUpgradeOn"];
  upgradeRefusal: UpgradeCard["upgradeRefusal"];
  recommendRepair: UpgradeCard["recommendRepair"];
  upgradeRequest: UpgradeCard["upgradeRequest"];
  requestOutcomeStillTrue: UpgradeCard["requestOutcomeStillTrue"];
  upgradeFailureHint: UpgradeCard["upgradeFailureHint"];
  handleRemoteUpgradeV2Click: UpgradeCard["startUpgrade"];
  computerFreshInstallCommands: ComputerCommands | null;
  statusCommand: ReactNode;
  noResponseLine: ReactNode;
  releaseNotesForUpdate: ComputerReleaseNotes | null;
  windowsMachine: boolean;
  copiedCommand: CommandCopyTarget | null;
  handleCopy: (target: CommandCopyTarget) => void;
  machineComputerCommands: ComputerCommands | null;
  terminalRestartCommand: string | null;
}) {
  const { formatMessage } = useIntl();
  const terminalStatusCommands = terminalStatusCommandsFor(machineComputerCommands);
  return (
    <Card className="p-4 mb-3" data-testid="computer-service-actions">
      <div className="mb-1 text-subhead font-bold text-foreground">
        {formatMessage({ id: "machine.detail.computer" })}
      </div>
      {computerOperationProgress ? (
        /* Progress mode — show bar instead of buttons */
        <div className="stack-y-2">
          {computerOperationProgress.done ? (
            <div className={`flex items-center gap-2 font-mono text-mono-meta ${computerOperationProgress.error ? "text-warning-strong" : "text-foreground-muted"}`}>
              {computerOperationProgress.error ? (
                <TriangleAlert size={14} className="shrink-0" />
              ) : (
                <CircleCheck size={14} className="shrink-0" />
              )}
              {computerOperationProgress.error
                ? (
                  computerOperationProgress.error === "restart_failed"
                    ? formatMessage({ id: "machine.restartFailed" })
                    : computerOperationProgress.error
                )
                : formatMessage({ id: "machine.detail.restarted" })}
            </div>
          ) : (
            <>
              <ProgressBar
                value={computerOperationProgress.progressValue ?? null}
                tone="cyan"
                label={computerOperationProgress.message ?? formatMessage({ id: "machine.detail.restarting" })}
              />
            </>
          )}
        </div>
      ) : (
        /* Default mode — one status sentence, then exactly one
           next step: a button, or the commands to run on that
           machine (never both). */
        (() => {
          const statusSentence = (() => {
            switch (cardState.kind) {
              case "reinstall":
                return formatMessage({ id: "machine.detail.upgradeStatus.reinstall" });
              case "reading":
                return formatMessage({ id: "machine.detail.upgradeStatus.readingVersion" });
              case "cannotCheck":
                return formatMessage({ id: "machine.detail.upgradeStatus.cannotCheck" });
              case "upToDate":
                return formatMessage({ id: "machine.detail.upgradeStatus.upToDate" });
              case "managedByDesktop":
                return formatMessage({ id: "machine.detail.upgradeStatus.managedByDesktop" });
              case "upgrading":
                // Reconciler step 13: the Computer first waits for agents to finish their work.
                return cardState.waitingAgents
                  ? formatMessage({ id: "machine.detail.upgradeStatus.draining" }, { version: cardState.version, count: cardState.waitingAgents })
                  : formatMessage({ id: "machine.detail.upgradeStatus.inProgress" }, { version: cardState.version });
              case "oneClick":
                return formatMessage({ id: "machine.detail.upgradeStatus.available" }, { version: cardState.version });
              case "manualUpgrade":
                // With the version notice up, its copy of the command is the one to use.
                return versionTier.kind === "none"
                  ? formatMessage({ id: "machine.detail.upgradeStatus.manualUpgrade" }, { version: cardState.version })
                  : formatMessage({ id: "machine.detail.upgradeStatus.manualUpgradeAbove" }, { version: cardState.version });
              case "commands":
                return formatMessage({ id: `machine.detail.upgradeStatus.${cardState.sentence}` }, { version: cardState.version });
            }
          })();
          // Install the latest release, then restart.
          const upgradeCommands = cardState.kind === "commands" ? computerFreshInstallCommands : null;
          const upgradeInstallCommand = upgradeCommands?.install ?? null;
          const upgradeRestartCommand = upgradeCommands?.restartService ?? null;
          // The last request's outcome only while the Computer is
          // still below that request's target: a later manual
          // upgrade makes a failure / no-response line stale.
          const machineVersion = machine.computerVersion ?? null;
          const outcomeLine = cardState.kind === "oneClick" && upgradeRefusal === "unknown"
            ? formatMessage({ id: "machine.detail.upgradeStatus.refusedUnknown" })
            : cardState.kind !== "upgrading" && cardState.kind !== "upToDate" && cardState.kind !== "managedByDesktop" && requestOutcomeStillTrue
              ? upgradeRequest?.state === "failed"
                ? formatMessage(
                    { id: "machine.detail.upgradeStatus.failed" },
                    { version: machineVersion, command: statusCommand },
                  )
                : noResponseLine
              : null;
          return (
            <>
              <p className={`mb-3 ${DETAIL_HELP_CLASS_NAME}`} data-testid="computer-upgrade-status">
                {statusSentence}
              </p>
              <div className="flex flex-wrap items-center gap-2" data-testid="computer-upgrade-actions">
                {cardState.kind !== "upgrading" && (
                  <Tooltip content={formatMessage({ id: "machine.detail.restartTooltip" })}>
                  <Button size="md"
                    variant="outline"
                    onClick={handleComputerRestartClick}
                  >
                    <RotateCcw size={16} />
                    {formatMessage({ id: "machine.detail.restart" })}
                  </Button>
                  </Tooltip>
                )}
                {cardState.kind === "upToDate" && webUpgradeOn && (
                  <Tooltip content={formatMessage({ id: "machine.detail.computerAlreadyLatest" })}>
                  <Button size="md"
                    variant="outline"
                    disabled
                  >
                    <CircleCheck size={16} />
                    {formatMessage({ id: "machine.detail.upToDate" })}
                  </Button>
                  </Tooltip>
                )}
                {/* The one pink action on this page: the upgrade the
                    computer is waiting for. */}
                {cardState.kind === "oneClick" && (
                  <Tooltip content={formatMessage({ id: "machine.detail.upgradeToVersion" }, { version: cardState.version })}>
                  {/* With the repair recommended or the failure's steps
                      below, the web upgrade stays, as the secondary way. */}
                  <Button size="md"
                    variant={recommendRepair || upgradeFailureHint ? "outline" : "accent"}
                    onClick={handleRemoteUpgradeV2Click}
                  >
                    <CircleArrowUp size={16} />
                    {upgradeFailureHint
                      ? formatMessage({ id: "machine.detail.upgradeFailureHint.retryFromWeb" })
                      : recommendRepair
                        ? formatMessage({ id: "machine.detail.upgradeFromWebAnyway" })
                        : formatMessage({ id: "machine.detail.upgradeToVersion" }, { version: cardState.version })}
                  </Button>
                  </Tooltip>
                )}
                {cardState.kind === "upgrading" && (
                  <Button size="md"
                    variant="outline"
                    disabled
                  >
                    <Spinner size="xs" aria-hidden="true" />
                    {formatMessage({ id: "machine.detail.upgradeV2.inProgress" })}
                  </Button>
                )}
                {releaseNotesForUpdate && <ComputerReleaseNotesAffordance notes={releaseNotesForUpdate} />}
              </div>
              {outcomeLine && (
                <p className={`mt-2 ${DETAIL_PROBLEM_CLASS_NAME}`} data-testid="computer-upgrade-request-outcome">
                  {outcomeLine}
                </p>
              )}
              {/* #proj-raft-computer task #34: the installer state looks
                  like it needs a repair on the machine. Advisory: the
                  install command first, Upgrade above still offered. */}
              {recommendRepair && !upgradeFailureHint && cardState.kind === "oneClick" && (
                <div className="mt-3">
                  <Banner status="warning" size="sm" data-testid="computer-upgrade-repair-hint">
                    <TriangleAlert />
                    <BannerDescription>
                      {formatMessage({ id: "machine.detail.upgradeStatus.installerRepairHint" }, { version: cardState.version })}
                    </BannerDescription>
                  </Banner>
                  <ComputerManualInstall
                    platform={windowsMachine ? "windows" : "mac-linux"}
                    commands={computerFreshInstallCommands}
                    testId="computer-upgrade-repair"
                  />
                </div>
              )}
              {/* One-click got stuck or refused: keep the retry, and
                  give the way out that does not depend on it (already
                  given above when only the repair is recommended). A
                  failure the web cannot get past (failureHint) says what
                  to do around that same command; its steps include the
                  install command, which is also the repair, so it
                  replaces the repair banner when both apply. */}
              {outcomeLine && cardState.kind === "oneClick" && (upgradeFailureHint || !recommendRepair) && (
                <div className="mt-3">
                  {upgradeFailureHint ? (
                    <Banner status="warning" size="sm" data-testid="computer-upgrade-failure-hint">
                      <TriangleAlert />
                      <BannerDescription>
                        <ComputerUpgradeFailureHintText hint={upgradeFailureHint} />
                      </BannerDescription>
                    </Banner>
                  ) : (
                    <p className={DETAIL_HELP_CLASS_NAME}>
                      {formatMessage({ id: "machine.detail.upgradeStatus.manualFallback" })}
                    </p>
                  )}
                  <ComputerManualInstall
                    platform={windowsMachine ? "windows" : "mac-linux"}
                    commands={computerFreshInstallCommands}
                    testId="computer-upgrade-failure-manual"
                  />
                </div>
              )}
              {cardState.kind === "manualUpgrade" && versionTier.kind === "none" && (
                <ComputerManualInstall
                  platform={windowsMachine ? "windows" : "mac-linux"}
                  commands={computerFreshInstallCommands}
                  testId="computer-upgrade-manual"
                />
              )}
              {cardState.kind === "commands" && upgradeInstallCommand && upgradeRestartCommand && (
                <ol className="mt-3 stack-y-3" data-testid="computer-upgrade-commands">
                  <li>
                    <div className={`mb-1 ${DETAIL_STEP_LABEL_CLASS_NAME}`}>
                      {formatMessage({ id: "machine.detail.upgradeCommands.installStep" })}
                    </div>
                    <CommandCopyRoot target="computer-install" copied={copiedCommand === "computer-install"} onCopy={handleCopy}>
                      <CopyableCode
                        className={COMMAND_LINE_CLASS_NAME}
                        data-testid="computer-upgrade-fresh-install"
                      >
                        {upgradeInstallCommand}
                      </CopyableCode>
                      <Tooltip content={formatMessage({ id: "machine.detail.copyInstallCommand" })}>
                        <CopyableCodeAction
                          aria-label={formatMessage({ id: "machine.detail.copyInstallCommand" })}
                          className="shrink-0"
                        />
                      </Tooltip>
                    </CommandCopyRoot>
                  </li>
                  <li>
                    <div className={`mb-1 ${DETAIL_STEP_LABEL_CLASS_NAME}`}>
                      {formatMessage({ id: "machine.detail.upgradeCommands.restartStep" })}
                    </div>
                    <CommandCopyRoot target="computer-install-restart" copied={copiedCommand === "computer-install-restart"} onCopy={handleCopy}>
                      <CopyableCode
                        className={COMMAND_LINE_CLASS_NAME}
                        data-testid="computer-upgrade-fresh-restart"
                      >
                        {upgradeRestartCommand}
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
              )}
            </>
          );
        })()
      )}
      <div className="mt-4" data-testid="computer-terminal-verification">
        <Separator className="mb-4" />
        <div className="mb-2 flex items-center gap-2">
          <Terminal size={16} className="text-foreground-muted" aria-hidden="true" />
          <SectionEyebrow as="div">
            {formatMessage({ id: "machine.detail.verifyFromTerminal" })}
          </SectionEyebrow>
        </div>
        <p className={`mb-2 ${DETAIL_HELP_CLASS_NAME}`}>
          {formatMessage({ id: "machine.detail.verifyFromTerminalDescription" })}
        </p>
        <div className="stack-y-2">
          {terminalStatusCommands.map(({ command, target }) => (
            <CommandCopyRoot key={command} target={target} copied={copiedCommand === target} onCopy={handleCopy}>
              <CopyableCode className={COMMAND_LINE_CLASS_NAME}>
                {command}
              </CopyableCode>
              <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                <CopyableCodeAction
                  aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                  className="shrink-0"
                />
              </Tooltip>
            </CommandCopyRoot>
          ))}
        </div>
        {terminalRestartCommand && (
          <>
            <p className={`mb-2 mt-3 ${DETAIL_HELP_CLASS_NAME}`}>
              {formatMessage({ id: "machine.detail.webButtonsNotResponding" })}
            </p>
            <CommandCopyRoot target="terminal-restart" copied={copiedCommand === "terminal-restart"} onCopy={handleCopy}>
              <CopyableCode className={COMMAND_LINE_CLASS_NAME}>
                {terminalRestartCommand}
              </CopyableCode>
              <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                <CopyableCodeAction
                  aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                  className="shrink-0"
                />
              </Tooltip>
            </CommandCopyRoot>
          </>
        )}
      </div>
    </Card>
  );
}
