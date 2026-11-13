import { CopyableCode, CopyableCodeAction, Separator, TextLink } from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Terminal } from "lucide-react";
import type { Machine } from "../../store/machineStore";
import type { ComputerCommands } from "../../utils/computerSetupCommand";
import type { useComputerUpgradeCard } from "../../components/machine/useComputerUpgradeCard";
import Tooltip from "../../components/ui/Tooltip";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { ComputerManualInstall } from "../../components/machine/ComputerManualInstall";
import { CommandCopyRoot } from "../../components/machine/CommandCopyRoot";
import { DETAIL_HELP_CLASS_NAME, DETAIL_PROBLEM_CLASS_NAME, DETAIL_STEP_LABEL_CLASS_NAME, COMMAND_LINE_CLASS_NAME } from "./machineDetailClassNames";
import type { CommandCopyTarget } from "./machineDetailTypes";
import { terminalStatusCommandsFor } from "./machineDetailCommands";

type UpgradeCard = ReturnType<typeof useComputerUpgradeCard>;

/** "Bring this Computer online": the offline Computer's recovery card. */
export function ComputerRecoveryCard({
  machine,
  canManageMachines,
  upgradeReconnectOverdue,
  upgradeInFlight,
  requestOutcomeStillTrue,
  upgradeRequest,
  statusCommand,
  noResponseLine,
  windowsMachine,
  computerFreshInstallCommands,
  computerRecoveryRestartCommand,
  serverSlug,
  copiedCommand,
  handleCopy,
  machineComputerCommands,
  lastHeartbeatText,
  lastHeartbeatParenthetical,
  showRecoverySetup,
  toggleRecoverySetup,
  computerInstall,
  computerSetupCommand,
}: {
  machine: Machine;
  canManageMachines: boolean;
  upgradeReconnectOverdue: UpgradeCard["upgradeReconnectOverdue"];
  upgradeInFlight: UpgradeCard["upgradeInFlight"];
  requestOutcomeStillTrue: UpgradeCard["requestOutcomeStillTrue"];
  upgradeRequest: UpgradeCard["upgradeRequest"];
  statusCommand: ReactNode;
  noResponseLine: ReactNode;
  windowsMachine: boolean;
  computerFreshInstallCommands: ComputerCommands | null;
  computerRecoveryRestartCommand: string | null;
  serverSlug: string | undefined;
  copiedCommand: CommandCopyTarget | null;
  handleCopy: (target: CommandCopyTarget) => void;
  machineComputerCommands: ComputerCommands | null;
  lastHeartbeatText: string | null;
  lastHeartbeatParenthetical: string;
  showRecoverySetup: boolean;
  toggleRecoverySetup: () => void;
  computerInstall: string | null;
  computerSetupCommand: string | null;
}) {
  const { formatMessage } = useIntl();
  const terminalStatusCommands = terminalStatusCommandsFor(machineComputerCommands);
  return (
    <div data-testid="computer-recovery-card">
      <div className="mb-2 flex items-center gap-2">
        <Terminal size={16} className="text-foreground-muted" aria-hidden="true" />
        <SectionEyebrow as="div">{formatMessage({ id: "machine.detail.bringComputerOnline" })}</SectionEyebrow>
      </div>

      {upgradeReconnectOverdue && (
        <p className={`mb-2 ${DETAIL_PROBLEM_CLASS_NAME}`} data-testid="computer-upgrade-reconnect-overdue">
          {formatMessage(
            { id: "machine.detail.upgradeStatus.reconnectOverdue" },
            { version: upgradeInFlight?.targetVersion ?? "" },
          )}
        </p>
      )}

      {canManageMachines ? (
        <div className="stack-y-4">
          {/* The server already settled the last web upgrade as
              failed / no response: say so here too, not only on the
              online card. */}
          {requestOutcomeStillTrue && (
            <p className={DETAIL_PROBLEM_CLASS_NAME} data-testid="computer-upgrade-request-outcome">
              {upgradeRequest?.state === "failed"
                ? formatMessage(
                    { id: "machine.detail.upgradeStatus.failed" },
                    { version: machine.computerVersion, command: statusCommand },
                  )
                : noResponseLine}
            </p>
          )}
          {/* The last web upgrade failed, got no answer or never
              reconnected: the manual upgrade as a way out. */}
          {(requestOutcomeStillTrue || upgradeReconnectOverdue) && (
            <div>
              <p className={DETAIL_HELP_CLASS_NAME}>
                {formatMessage({ id: "machine.detail.upgradeStatus.manualFallback" })}
              </p>
              <ComputerManualInstall
                platform={windowsMachine ? "windows" : "mac-linux"}
                commands={computerFreshInstallCommands}
                testId="computer-recovery-upgrade-manual"
              />
            </div>
          )}
          {/* Primary remedy — a local command, platform-independent.
              Web remote restart/upgrade only works while online (live
              WS relay), so an offline Computer cannot get a web button. */}
          {computerRecoveryRestartCommand && (
            <div>
              <p className={`mb-2 ${DETAIL_HELP_CLASS_NAME}`}>
                {formatMessage({ id: "machine.detail.recoveryRestartDescription" }, { serverSlug })}
              </p>
              <CommandCopyRoot target="terminal-restart" copied={copiedCommand === "terminal-restart"} onCopy={handleCopy}>
                <CopyableCode
                  className={COMMAND_LINE_CLASS_NAME}
                  data-testid="computer-recovery-restart"
                >
                  {computerRecoveryRestartCommand}
                </CopyableCode>
                <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                  <CopyableCodeAction
                    aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                    className="shrink-0"
                  />
                </Tooltip>
              </CommandCopyRoot>
            </div>
          )}

          {/* Diagnostics — reuse the existing status/doctor commands. */}
          <div>
            <p className={`mb-2 ${DETAIL_HELP_CLASS_NAME}`}>
              {formatMessage({ id: "machine.detail.offlineDiagnosticsPrompt" })}
            </p>
            <div className="stack-y-2">
              {terminalStatusCommands.map(({ command, target }) => (
                <CommandCopyRoot key={command} target={target} copied={copiedCommand === target} onCopy={handleCopy}>
                  <CopyableCode
                    className={COMMAND_LINE_CLASS_NAME}
                    data-testid={`computer-recovery-${target === "terminal-status" ? "status" : "doctor"}`}
                  >
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
          </div>

          {/* last-seen — let the user judge if the machine is just
              off; no offline-reason guessing (frontend can't tell). */}
          {machine.lastHeartbeat && (
            <p className={DETAIL_HELP_CLASS_NAME}>
              {formatMessage(
                { id: "machine.detail.lastSeen" },
                { time: lastHeartbeatText },
              )}
            </p>
          )}

          {/* Secondary: an explicit command-not-found path exposes
              install + setup without displacing the normal start path. */}
          <div>
            <Separator className="mb-3" />
            <TextLink
              onClick={toggleRecoverySetup}
              className="text-footnote"
              aria-expanded={showRecoverySetup}
              data-testid="computer-recovery-setup-toggle"
            >
              {showRecoverySetup
                ? formatMessage({ id: "machine.detail.hideInstallSetupCommands" })
                : formatMessage({ id: "machine.detail.commandNotFoundSetup" })}
            </TextLink>
            {showRecoverySetup && computerInstall && computerSetupCommand && (
              <div className="mt-2 stack-y-3">
                <p className={DETAIL_HELP_CLASS_NAME}>
                  {formatMessage({ id: "machine.detail.installSetupDescription" })}
                  {windowsMachine ? ` ${formatMessage({ id: "machine.detail.windowsInstallerX64Only" })}` : ""}
                </p>
                {([
                  ["computer-install", formatMessage({ id: "machine.detail.installStep" }), computerInstall],
                  ["computer-setup", formatMessage({ id: "machine.detail.setupStep" }), computerSetupCommand],
                ] as const).map(([target, label, command]) => (
                  <div key={target}>
                    <div className={`mb-1 ${DETAIL_STEP_LABEL_CLASS_NAME}`}>{label}</div>
                    <CommandCopyRoot target={target} copied={copiedCommand === target} onCopy={handleCopy}>
                      <CopyableCode
                        className={COMMAND_LINE_CLASS_NAME}
                        data-testid={target === "computer-install" ? "computer-recovery-install" : "computer-recovery-setup"}
                      >
                        {command}
                      </CopyableCode>
                      <Tooltip content={
                          target === "computer-install"
                            ? formatMessage({ id: "machine.detail.copyInstallCommand" })
                            : formatMessage({ id: "machine.detail.copySetupCommand" })
                        }>
                        <CopyableCodeAction
                          aria-label={
                            target === "computer-install"
                              ? formatMessage({ id: "machine.detail.copyInstallCommand" })
                              : formatMessage({ id: "machine.detail.copySetupCommand" })
                          }
                          className="shrink-0"
                        />
                      </Tooltip>
                    </CommandCopyRoot>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className={DETAIL_HELP_CLASS_NAME}>
          {formatMessage(
            { id: "machine.detail.offlineAdminOnly" },
            { time: lastHeartbeatParenthetical },
          )}
        </p>
      )}
    </div>
  );
}
