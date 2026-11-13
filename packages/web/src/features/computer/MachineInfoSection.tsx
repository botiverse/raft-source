import { Button, Spinner } from "@botiverse/raft-ui";
import { computerPlatformName } from "../../utils/computerDevice";
import { useIntl } from "react-intl";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { isRuntimeDeprecatedOnServer, useServerRuntimeCatalog } from "../../hooks/useServerRuntimeCatalog";
import type { Machine } from "../../store/machineStore";
import type { useProfileStore } from "../../store/profileStore";
import type { ComputerReleaseNotes } from "@botiverse/raft-shared";
import type { useComputerUpgradeCard } from "../../components/machine/useComputerUpgradeCard";
import type { RuntimeRescanState } from "../../components/machine/useRuntimeRescan";
import KeyValueRow from "../../components/ui/KeyValueRow";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import AvatarSlot from "../../components/ui/AvatarSlot";
import ComputerReleaseNotesAffordance from "../../components/machine/ComputerReleaseNotesAffordance";
import MachineRuntimeChips from "../../components/machine/MachineRuntimeChips";
import type { MachineRuntimeChipsUpgradeAction } from "../../components/machine/MachineRuntimeChips";
import { DETAIL_HELP_CLASS_NAME } from "./machineDetailClassNames";
import { ComputerOwnerField } from "./ComputerOwnerField";

type UpgradeCard = ReturnType<typeof useComputerUpgradeCard>;

/** The Computer page's Info section: OS, version, runtime detection,
 *  detected runtimes, created date, creator and owner. */
export function MachineInfoSection({
  machine,
  computerVersionFact,
  releaseNotesForUpdate,
  versionTier,
  canManageMachines,
  runtimeDetection,
  canRescanRuntimes,
  rescanState,
  onRescanRuntimes,
  serverId,
  canViewRuntimeAccountUsage,
  runtimeChipsUpgradeAction,
  createdDate,
  openProfile,
}: {
  machine: Machine;
  computerVersionFact: UpgradeCard["computerVersionFact"];
  releaseNotesForUpdate: ComputerReleaseNotes | null;
  versionTier: UpgradeCard["versionTier"];
  canManageMachines: boolean;
  runtimeDetection: NonNullable<Machine["runtimeDetection"]> | null;
  canRescanRuntimes: boolean;
  rescanState: RuntimeRescanState;
  onRescanRuntimes: () => void;
  serverId: string | null;
  canViewRuntimeAccountUsage: boolean;
  runtimeChipsUpgradeAction: MachineRuntimeChipsUpgradeAction | null;
  createdDate: string;
  openProfile: ReturnType<typeof useProfileStore.getState>["openProfile"];
}) {
  const { formatMessage } = useIntl();
  // "(deprecated)" is this server's answer, as in the Detected runtimes chips below.
  const runtimeCatalog = useServerRuntimeCatalog(serverId);
  const detectionReasonLabel = (reason: "deadline" | "child_failed" | "cancelled" | undefined) =>
    formatMessage({ id: `machine.detail.runtimeDetection.reason.${reason ?? "child_failed"}` });
  return (
    <div className="px-(--surface-inset) py-4">
      <SectionEyebrow as="div" className="mb-3">
        {formatMessage({ id: "machine.detail.info" })}
      </SectionEyebrow>
      {/* Raft DS PropertyList (stacked): label 13/18 500 ink-3 above each
          value; what machines write (OS, versions, runtimes, dates) in
          Space Mono. KeyValueRow owns the label/value type. */}
      <div className="stack-y-3">
        {/* OS */}
        {machine.os && <KeyValueRow label={formatMessage({ id: "machine.detail.osLabel" })} value={computerPlatformName(machine.os)} mono />}
        {/* Version — a managed Computer shows its `@botiverse/raft-computer`
            version (computerVersion), which is the one release number
            (docs/operations/computer-release-version.md). Rows connected
            with the retired standalone daemon show no version: there is no
            daemon release line left to compare against. */}
        {machine.isComputer && (
          <KeyValueRow
            label={formatMessage({ id: "machine.detail.computerVersion" })}
            value={
              machine.computerVersion ? (
                <div>
                  {/* An update needs handling, so both are orange; the words
                      keep them apart: "Update required" below the version
                      floor (what it takes is in the notice above), else
                      "Update available" (its target in the title). */}
                  <span className={`font-mono ${versionTier.kind !== "none" || computerVersionFact.kind === "outdated" ? "font-bold text-warning-strong" : "text-foreground"}`}>
                    v{machine.computerVersion}
                  </span>
                  {versionTier.kind !== "none" ? (
                    <>
                      {" "}
                      <span className="text-caption font-bold text-warning-strong" data-testid="computer-version-update-required">
                        · {formatMessage({ id: "machine.versionNotice.chipRequired" })}
                      </span>
                    </>
                  ) : computerVersionFact.kind === "current" && (
                    <>
                      {" "}
                      <span className="text-caption text-foreground-hint">
                        · {formatMessage({ id: "machine.detail.upToDate" })}
                      </span>
                    </>
                  )}
                  {versionTier.kind === "none" && computerVersionFact.kind === "outdated" && (
                    <>
                      {" "}
                      <span
                        className="text-caption font-bold text-warning-strong"
                        data-testid="computer-version-update-available"
                        title={formatMessage({ id: "machine.rack.version" }, { version: computerVersionFact.availableVersion })}
                      >
                        · {formatMessage({ id: "machine.detail.updateAvailable" })}
                      </span>
                    </>
                  )}
                  {releaseNotesForUpdate && machine.status !== "online" && (
                    <>
                      {" "}
                      <ComputerReleaseNotesAffordance notes={releaseNotesForUpdate} />
                    </>
                  )}
                </div>
              ) : machine.status === "online" && versionTier.kind !== "none" ? (
                /* Still silent after the wait: the version notice above
                   says it doesn't report one, so this line agrees. */
                <span className="text-foreground-hint" data-testid="computer-version-not-reported">
                  {formatMessage({ id: "machine.detail.versionNotReported" })}
                </span>
              ) : machine.status === "online" ? (
                <span className="text-foreground-hint">
                  {formatMessage({ id: "machine.detail.readingVersion" })}
                </span>
              ) : (
                <span className="text-foreground-hint">—</span>
              )
            }
          />
        )}
        {/* Online, not a manager, newer version exists: say who can act
            (the offline card has its own admin-only line). */}
        {machine.isComputer && !canManageMachines && machine.status === "online" && computerVersionFact.kind === "outdated" && (
          <p className={DETAIL_HELP_CLASS_NAME} data-testid="computer-upgrade-ask-admin">
            {formatMessage(
              { id: "machine.detail.upgradeStatus.askAdmin" },
              { version: computerVersionFact.availableVersion },
            )}
          </p>
        )}
        {/* task #1268: detection state. pending / incomplete keep the last confirmed list below. */}
        {machine.status === "online" && runtimeDetection && runtimeDetection.status !== "complete" && (
          <div className={`flex flex-wrap items-center gap-2 ${DETAIL_HELP_CLASS_NAME}`} data-testid="machine-runtime-detection">
            {runtimeDetection.status === "pending" && <Spinner size="sm" aria-hidden="true" />}
            <span>
              {runtimeDetection.status === "pending"
                ? formatMessage({ id: "machine.detail.runtimeDetection.pending" })
                : (runtimeDetection.unfinishedRuntimes ?? []).length > 0
                  ? formatMessage(
                      { id: "machine.detail.runtimeDetection.incomplete" },
                      { reason: detectionReasonLabel(runtimeDetection.reason), runtimes: (runtimeDetection.unfinishedRuntimes ?? []).map((id) => formatRuntimeLabelWithStatus(id, formatMessage, isRuntimeDeprecatedOnServer(id, runtimeCatalog))).join(", ") },
                    )
                  : formatMessage({ id: "machine.detail.runtimeDetection.incompleteNone" }, { reason: detectionReasonLabel(runtimeDetection.reason) })}
            </span>
            {runtimeDetection.status === "incomplete" && canRescanRuntimes && (
              <Button size="md" variant="outline" disabled={rescanState.status === "running"} onClick={onRescanRuntimes} data-testid="machine-runtime-detection-rescan">
                {formatMessage({ id: rescanState.status === "running" ? "machine.detail.runtimeDetection.rescanning" : "machine.detail.runtimeDetection.rescan" })}
              </Button>
            )}
            {runtimeDetection.status === "incomplete" && !canRescanRuntimes && (
              <span data-testid="machine-runtime-detection-rescan-hint">{formatMessage({ id: "machine.detail.runtimeDetection.rescanNotAllowed" })}</span>
            )}
            {rescanState.status === "failed" && (
              <span className="text-warning-strong" data-testid="machine-runtime-detection-rescan-error">
                {formatMessage({ id: `machine.detail.runtimeDetection.rescanFailed.${rescanState.error === "forbidden" ? "forbidden" : "generic"}` })}
              </span>
            )}
          </div>
        )}
        {/* Detected Runtimes — Raft DS runtime tags drawn by the badge
            recipe: cyan-soft when detected, warning-soft when the computer
            predates an in-process runtime, stone-soft (on request) when
            not installed. */}
        <KeyValueRow
          label={formatMessage({ id: "machine.detail.detectedRuntimes" })}
          value={
            <MachineRuntimeChips
              // A Show All choice belongs to the Computer it was made on.
              key={machine.id}
              machineId={machine.id}
              machineRuntimeIds={machine.runtimes}
              runtimeVersions={machine.runtimeVersions}
              serverId={serverId}
              canViewRuntimeAccountUsage={canViewRuntimeAccountUsage}
              upgradeAction={runtimeChipsUpgradeAction}
              testId="machine-detected-runtimes"
            />
          }
        />
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {/* Created */}
          <KeyValueRow
            label={formatMessage({ id: "machine.detail.created" })}
            value={createdDate}
            mono
          />
          {/* Creator — managed Computers only; raw daemon rows preserve
              their existing Created-only presentation. */}
          {machine.isComputer && (
            <KeyValueRow
              label={formatMessage({ id: "agent.detail.creator" })}
              valueClassName="flex items-center gap-2"
              value={
                machine.creator ? (
                  <button
                    type="button"
                    onClick={() => openProfile("human", machine.creator!.id)}
                    className="-mx-1.5 flex min-w-0 items-center gap-1.5 rounded-chip px-1.5 py-0.5 text-callout text-foreground outline-none hover:bg-fill-medium focus-visible:shadow-focus"
                  >
                    <AvatarSlot
                      context="creator-link"
                      type="human"
                      humanAvatarUrl={machine.creator.avatarUrl}
                    />
                    <span className="truncate font-semibold">{machine.creator.displayName || machine.creator.name}</span>
                    <span className="font-mono text-mono-meta text-foreground-hint">
                      {formatMessage({ id: "common.handle" }, { name: machine.creator.name })}
                    </span>
                  </button>
                ) : (
                  <span className="text-foreground-hint">
                    {formatMessage({ id: "agent.detail.noCreatorAssigned" })}
                  </span>
                )
              }
            />
          )}
          {/* Owner (Computer owner v1): who Raft records as its owner, or Public. */}
          <ComputerOwnerField machine={machine} openProfile={openProfile} />
        </div>
      </div>
    </div>
  );
}
