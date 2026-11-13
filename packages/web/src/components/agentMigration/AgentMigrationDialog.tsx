import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { useIntl } from "react-intl";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  TextLink,
} from "@botiverse/raft-ui";
import { Link } from "react-router-dom";
import api from "../../api/client";
import { useServerStore } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { runtimeAccountUsageClient } from "../../utils/runtimeAccountUsageClient";
import type { RuntimeAccountUsageReadResult } from "../../utils/runtimeAccountUsageClient";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import { usageProviderForRuntime } from "../../utils/runtimeUsageProvider";
import { runtimeUsageWindowsLine } from "../machine/runtimeUsageText";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import type { Machine } from "../../store/machineStore";
import { orderMachinesLikeSidebar } from "../layout/sidebarMachineOrder";
import { HostedModelChoice, hostedModelPickerShown, initialHostedModel, useHostedRuntimeModels } from "../agent/HostedModelChoice";
import { isMigrationProPlanRequiredError } from "./billing";
import type { MigrationErrorPresentation } from "./errors";
import { migrationStartErrorPresentation, migrationTargetLabel } from "./presentation";
import { MigrationErrorContent } from "./MigrationErrorContent";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../ui/NarrowDialog";
import { TargetComputerDetails } from "./TargetComputerDetails";
import type { TargetComputerUsageDetails } from "./TargetComputerDetails";
import { targetComputerInfoLine } from "./targetComputerInfo";
import { TargetComputerList } from "./TargetComputerList";
import type { TargetOption } from "./TargetComputerList";
import { useLocalComputerIdentity } from "../machine/localComputer/localComputerStore";
import { correlateSelfMachine } from "../machine/localComputer/localComputerLogic";

export interface MigrationStartResponse {
  /** null when an agent on no Computer was placed on the target at once (no migration to follow). */
  migrationRef: string | null;
  state: string;
  sourceMachineId: string | null;
  // null for a move to the cloud.
  targetMachineId: string | null;
  /** `placed_without_source`: the agent had no Computer and is now on the target. */
  outcome?: "placed_without_source";
  deadlines?: Record<string, string>;
}

/** A move needs the target online; the server refuses any other (TARGET_COMPUTER_OFFLINE). */
function isTargetComputerSelectable(machine: Machine): boolean {
  return machine.status === "online";
}

/** The target option for the cloud; never a machine id. */
const HOSTED_TARGET_CHOICE = "__cloud__";

export function AgentMigrationDialog({
  agent,
  machines,
  sourceMachineId,
  placesWithoutSource: placesWithoutSourceProp = false,
  hostedAvailable = false,
  initialTarget,
  onClose,
  onProRequired,
  onStarted,
}: {
  agent: Agent;
  machines: Machine[];
  sourceMachineId: string | null;
  /** The source cannot bring anything over (its Computer's access was revoked): placed like an agent on no Computer. */
  placesWithoutSource?: boolean;
  /** Offer the cloud as a target (the server's hosted-migration gate; see useHostedMigrationAvailable). */
  hostedAvailable?: boolean;
  /** Preselected target computer (Try Again after a failure); ignored when it is not offered. */
  initialTarget?: string | null;
  onClose: () => void;
  onProRequired: () => void;
  onStarted: (result: MigrationStartResponse) => Promise<void>;
}) {
  const { formatMessage, locale } = useIntl();
  // An agent on no Computer is placed on the target: no files to bring over, and the cloud is
  // not offered (a move to the cloud uploads from a source).
  const placesWithoutSource = sourceMachineId === null || placesWithoutSourceProp;
  const offersHosted = hostedAvailable && !placesWithoutSource;
  const serverSlug = useServerStore((state) => state.current?.slug);
  const serverId = useServerStore((state) => state.current?.id);
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const { capabilities } = useServerPermissions();
  // This device among the computers given (the same match as the Computers list's).
  const localIdentity = useLocalComputerIdentity();
  const pinnedMachineId = useMemo(
    () => correlateSelfMachine(machines, localIdentity)?.id ?? null,
    [machines, localIdentity],
  );
  // Same order as the Computers list (this device, then mine, then the rest).
  const targetComputers = useMemo(() =>
    orderMachinesLikeSidebar(
      machines.filter((machine) =>
        machine.id !== sourceMachineId &&
        machine.isComputer === true
      ),
      pinnedMachineId,
      currentUserId,
    ),
  [machines, sourceMachineId, pinnedMachineId, currentUserId]);
  // What is left of the account the agent runs on, per target computer: the
  // same read, cache (60 s) and visibility rule as the runtime usage badge and
  // the bulk Change model picker. Reads run in parallel and never block the
  // picker; a missing snapshot or a failed read shows nothing.
  const usageProvider = usageProviderForRuntime(agent.runtime);
  const usageMachineKey = targetComputers
    .filter((machine) => canViewMachineRuntimeAccountUsage(machine, currentUserId, capabilities))
    .map((machine) => machine.id)
    .join("\n");
  // The whole read result per computer, not only its snapshot: the info
  // popover shows the computer page's usage card, which reads the state too.
  const [usageByMachine, setUsageByMachine] = useState<Record<string, RuntimeAccountUsageReadResult | "failed">>({});
  useEffect(() => {
    if (!usageProvider || !serverId || !usageMachineKey) return;
    let cancelled = false;
    for (const machineId of usageMachineKey.split("\n")) {
      void runtimeAccountUsageClient.read(serverId, machineId, usageProvider)
        .then((result) => {
          if (cancelled) return;
          setUsageByMachine((current) => ({ ...current, [machineId]: result }));
        })
        .catch(() => {
          if (cancelled) return;
          setUsageByMachine((current) => ({ ...current, [machineId]: "failed" }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [serverId, usageMachineKey, usageProvider]);
  // How many agents each computer already has, as its Computer page counts
  // them; unknown until the agent list has loaded.
  const allAgents = useAgentStore((state) => state.agents);
  const agentsLoading = useAgentStore((state) => state.loading);
  const agentCountByMachine = useMemo(() => {
    if (agentsLoading) return null;
    const counts = new Map<string, number>();
    for (const candidate of allAgents) {
      if (candidate.deletedAt || !candidate.machineId) continue;
      counts.set(candidate.machineId, (counts.get(candidate.machineId) ?? 0) + 1);
    }
    return counts;
  }, [allAgents, agentsLoading]);
  const targetComputerOptions = useMemo<TargetOption[]>(() => {
    const computers = targetComputers.map((machine): TargetOption => {
      const read = usageByMachine[machine.id];
      const usage = runtimeUsageWindowsLine(read && read !== "failed" ? read.snapshot : null, formatMessage, locale);
      const info = targetComputerInfoLine(
        machine,
        agentCountByMachine ? agentCountByMachine.get(machine.id) ?? 0 : null,
        formatMessage,
      );
      return {
        value: machine.id,
        label: machine.name,
        ...(usage ? { usage } : {}),
        ...(info ? { info } : {}),
        ...(isTargetComputerSelectable(machine) ? {} : { disabled: true }),
      };
    });
    return offersHosted
      ? [...computers, { value: HOSTED_TARGET_CHOICE, label: formatMessage({ id: "agent.migration.hosted.option" }) }]
      : computers;
  }, [targetComputers, offersHosted, formatMessage, locale, usageByMachine, agentCountByMachine]);
  // What the info popover shows of the usage: only where the badge would read it.
  const usageRuntimeName = getRuntimeDisplayName(agent.runtime);
  const usageDetailsFor = useCallback((machineId: string): TargetComputerUsageDetails | null => {
    if (!usageProvider || !serverId || !usageMachineKey.split("\n").includes(machineId)) return null;
    const read = usageByMachine[machineId];
    return {
      runtimeName: usageRuntimeName,
      result: read && read !== "failed" ? read : null,
      loading: read === undefined,
      loadError: read === "failed",
    };
  }, [usageProvider, serverId, usageMachineKey, usageByMachine, usageRuntimeName]);
  // Only an online computer can be chosen: the server refuses an offline
  // target (TARGET_COMPUTER_OFFLINE), so it stays listed, disabled, with its
  // "Offline" line. A target that goes offline while the dialog is open falls
  // back to the first online one.
  const selectableTargetComputers = useMemo(
    () => targetComputers.filter(isTargetComputerSelectable),
    [targetComputers],
  );
  const [targetComputer, setTargetComputer] = useState(
    selectableTargetComputers.find((machine) => machine.id === initialTarget)?.id ?? selectableTargetComputers[0]?.id ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MigrationErrorPresentation | null>(null);
  const hostedSelected = offersHosted
    && (targetComputer === HOSTED_TARGET_CHOICE || selectableTargetComputers.length === 0);
  const selectedTargetComputer = hostedSelected
    ? HOSTED_TARGET_CHOICE
    : selectableTargetComputers.some((machine) => machine.id === targetComputer)
      ? targetComputer
      : selectableTargetComputers[0]?.id ?? "";
  // The model the cloud agent starts on, as in the create-agent form: `null` is
  // the provider's default, and nothing is picked where the server decides.
  const hostedModels = useHostedRuntimeModels("antiproton", hostedSelected);
  const [hostedModelPick, setHostedModelPick] = useState<string | null | undefined>(undefined);
  const hostedModelsView = hostedModels.state.kind === "ready" ? hostedModels.state.view : null;
  const hostedModel = hostedModelsView === null || hostedModelsView.locked || !hostedModelPickerShown(hostedModelsView)
    ? null
    : hostedModelPick !== undefined ? hostedModelPick : initialHostedModel(hostedModelsView);
  const sourceComputerName = machines.find((machine) => machine.id === sourceMachineId)?.name;
  const source = migrationTargetLabel(formatMessage, machines, sourceMachineId);
  const targetComputerName = hostedSelected
    ? formatMessage({ id: "agent.migration.hosted.targetName" })
    : machines.find((machine) => machine.id === selectedTargetComputer)?.name;
  const recoveryComputerId = error?.recoveryComputerId;

  const handleTargetComputerChange = useCallback((value: string) => setTargetComputer(value), []);
  const renderTargetDetails = useCallback((option: TargetOption) => {
    const machine = targetComputers.find((candidate) => candidate.id === option.value);
    if (!machine) return null;
    const agentCount = agentCountByMachine ? agentCountByMachine.get(machine.id) ?? 0 : null;
    return <TargetComputerDetails machine={machine} usage={usageDetailsFor(machine.id)} agentCount={agentCount} />;
  }, [targetComputers, usageDetailsFor, agentCountByMachine]);
  // Recovery happens on the Computers page, inside Raft: an in-app link in
  // this tab (no ↗, no new tab; raft-design navigation.md "Links that leave
  // Raft"), rendered as the raft-ui TextLink. Following it closes the dialog.
  const recoveryComputersHref = serverSlug
    ? `/s/${serverSlug}/${recoveryComputerId ? `computer/${recoveryComputerId}` : "computers"}`
    : null;
  const recoveryComputersLabel = formatMessage({
    id: recoveryComputerId
      ? "agent.migration.error.openComputerSettings"
      : "agent.migration.error.openComputers",
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTargetComputer) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<MigrationStartResponse>(`/agents/${agent.id}/migrate`, hostedSelected
        ? { target: { kind: "hosted", ...(hostedModel ? { hostedModel } : {}) } }
        : { targetComputer: selectedTargetComputer });
      await onStarted(data);
    } catch (err: unknown) {
      if (isMigrationProPlanRequiredError(err)) {
        onProRequired();
        return;
      }
      setError(migrationStartErrorPresentation(err, formatMessage, {
        sourceComputerName,
        targetComputerName,
        sourceComputerId: sourceMachineId,
        targetComputerId: hostedSelected ? null : selectedTargetComputer,
      }));
    } finally {
      setSubmitting(false);
    }
  }

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !submitting) onClose();
  }, [onClose, submitting]);
  // The Computers link navigates in place; a modified click opens it in a new
  // tab and keeps this dialog (and the chosen target) open.
  const closeOnPlainClick = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    onClose();
  }, [onClose]);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      {/* Size follows the viewport: width about a third of it (28–40rem), both
          axes capped at 90% with a 16–32px gutter, no fixed height. raft-ui's
          DialogBody scrolls and the header/footer stay pinned when it overflows. */}
      <NarrowDialogContent
        narrow="sheet"
        className="w-[calc(100%_-_2*clamp(16px,3vw,32px))] max-w-[min(90vw,clamp(28rem,32vw,40rem))] max-h-[min(90dvh,calc(100dvh_-_2*clamp(16px,3vh,32px)))]"
        aria-busy={submitting}
        title={formatMessage({ id: offersHosted ? "agent.migration.hosted.dialogTitle" : "agent.detail.moveToAnotherComputer" })}
        closeLabel={formatMessage({ id: "common.close" })}
        closeDisabled={submitting}
        header={null}
      >
        <form onSubmit={handleSubmit} className="contents">
          {/* The head sits inside the form here; the phone's own head replaces it. */}
          <DialogActions as={DialogHeader}>
            <DialogTitle>
              {formatMessage({ id: offersHosted ? "agent.migration.hosted.dialogTitle" : "agent.detail.moveToAnotherComputer" })}
            </DialogTitle>
            <DialogClose disabled={submitting} aria-label={formatMessage({ id: "common.close" })} />
          </DialogActions>
          <DialogBody className="grid gap-4">
            <Field>
              <FieldLabel id="agent-migration-target-computer-label">
                {formatMessage({ id: offersHosted ? "agent.migration.hosted.targetLabel" : "agent.detail.targetComputer" })}
              </FieldLabel>
              {/* Always open, for any number of targets: the rows, their lines and
                  each computer's info button (see TargetComputerList). */}
              <TargetComputerList
                options={targetComputerOptions}
                value={selectedTargetComputer}
                onValueChange={handleTargetComputerChange}
                disabled={submitting}
                labelledBy="agent-migration-target-computer-label"
                renderDetails={renderTargetDetails}
              />
            </Field>
            {hostedSelected && hostedModelPickerShown(hostedModelsView) ? (
              <Field>
                <FieldLabel>{formatMessage({ id: "agent.detail.hostedModel.title" })}</FieldLabel>
                <HostedModelChoice
                  state={hostedModels.state}
                  value={hostedModel}
                  onChange={setHostedModelPick}
                  onReload={hostedModels.reload}
                  testId="agent-migration-hosted-model"
                />
              </Field>
            ) : null}
            {/* The one choice first; what happens next follows as the dialog's body text. */}
            {hostedSelected ? (
              // Said before starting: the move to the cloud is final once confirmed.
              <ul className="list-disc stack-y-2 pl-5" data-testid="agent-migration-hosted-notes">
                <li>{formatMessage({ id: "agent.migration.hosted.noteStopped" }, { source })}</li>
                <li>{formatMessage({ id: "agent.migration.hosted.noteFiles" }, { source })}</li>
                <li>{formatMessage({ id: "agent.migration.hosted.noteSession" })}</li>
                <li>{formatMessage({ id: "agent.migration.hosted.noteGithub" })}</li>
                <li>{formatMessage({ id: "agent.migration.hosted.noteFinal" })}</li>
              </ul>
            ) : placesWithoutSource ? (
              <p data-testid="agent-migration-place-note">
                {formatMessage({ id: sourceMachineId === null ? "agent.migration.placeWithoutSourceNote" : "agent.migration.placeFromRevokedComputerNote" })}
              </p>
            ) : (
              <div className="stack-y-2">
                <p>{formatMessage({ id: "agent.detail.migrationModeStopBeforeExport" })}</p>
                <p>{formatMessage({ id: "agent.detail.migrationSessionResetDetailed" })}</p>
              </div>
            )}
            {error ? (
              <Banner status="warning" size="sm" role="alert">
                <MigrationErrorContent presentation={error} />
              </Banner>
            ) : null}
            {error?.recovery === "open_computers_and_retry" && recoveryComputersHref ? (
              <TextLink
                render={<Link to={recoveryComputersHref} onClick={closeOnPlainClick} aria-label={recoveryComputersLabel} />}
                className="w-fit text-callout"
              >
                {recoveryComputersLabel}
              </TextLink>
            ) : null}
          </DialogBody>
          <DialogActions as={DialogFooter}>
            <Button variant="ghost" size="lg"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              {formatMessage({ id: "agent.detail.cancel" })}
            </Button>
            <DialogCommit>
              {(inHead) => (
                // Orange (DS button.md "Which color"): moving pauses the agent
                // but can be undone by moving it back, as Restart and Reset.
                <Button variant="warning" size={inHead ? "md" : "lg"}
                  type="submit"
                  disabled={submitting || !selectedTargetComputer || (hostedSelected && hostedModels.state.kind === "loading")}
                >
                  {submitting
                    ? formatMessage({ id: "agent.detail.starting" })
                    : error?.recovery === "open_computers_and_retry"
                      ? formatMessage({ id: "agent.migration.error.tryAgain" })
                      : hostedSelected
                        ? formatMessage({ id: "agent.migration.hosted.start" })
                        : formatMessage({ id: offersHosted ? "agent.detail.startMigration" : "agent.migration.moveConfirm" })}
                </Button>
              )}
            </DialogCommit>
          </DialogActions>
        </form>
      </NarrowDialogContent>
    </Dialog>
  );
}
