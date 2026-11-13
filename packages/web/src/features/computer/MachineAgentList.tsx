import { Button, ListRowGroup, useLocated } from "@botiverse/raft-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Check, Play, Plus, X, Square, RotateCcw, ArrowLeftRight } from "lucide-react";
import DialogCard from "../../components/ui/DialogCard";
import { DialogCardFooter } from "../../components/ui/NarrowDialog";
import Banner from "../../components/ui/Banner";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { useBulkChangeModelReceiptStore } from "../../store/bulkChangeModelReceiptStore";
import type { BulkChangeReceipt, BulkUnfinishedAgent } from "../../store/bulkChangeModelReceiptStore";
import { formatBulkModelLabel } from "../../components/machine/bulkChangeModelPlan";
import type { BulkModelTarget } from "../../components/machine/bulkChangeModelPlan";
import BulkChangeModelDialog from "../../components/machine/BulkChangeModelDialog";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { computeAgentDisplayState, selectAgentActivitiesSlice, useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import ConfirmDialog from "../../components/ConfirmDialog";
import { trackAgentCreateOpened } from "../../analytics/journey";
import { CreateAgentDialog } from "../../components/agent/DeferredCreateAgentDialog";
import Tooltip from "../../components/ui/Tooltip";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import SectionHeader from "../../components/ui/SectionHeader";
import SurfaceListItem from "../../components/ui/SurfaceListItem";
import { BulkResetOptionCard } from "../../components/machine/BulkResetOptionCard";
import { MachineAgentRow } from "../../components/machine/MachineAgentRow";
import { DETAIL_EMPTY_NOTE_CLASS_NAME } from "./machineDetailClassNames";
import type { BulkAgentAction, BulkResetMode, BulkResetOption } from "./machineDetailTypes";

// Isolated component — subscribes to current display-state projections only for agents on this machine,
// preventing activity changes from re-rendering the entire MachineDetailPanel.
export function MachineAgentList({ machine, canManageMachines, canViewRuntimeAccountUsage }: { machine: Machine; canManageMachines: boolean; canViewRuntimeAccountUsage: boolean }) {
  const { formatMessage } = useIntl();
  const allAgents = useAgentStore((s) => s.agents);
  const startAgent = useAgentStore((s) => s.startAgent);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const resetAgent = useAgentStore((s) => s.resetAgent);
  const nav = useAppNavigate();
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<BulkAgentAction | null>(null);
  const [bulkError, setBulkError] = useState("");
  const [showResetOptions, setShowResetOptions] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [bulkResetMode, setBulkResetMode] = useState<BulkResetMode>("restart");
  const [bulkModelDialog, setBulkModelDialog] = useState<
    { agentIds: string[]; retry?: { target: BulkModelTarget; unfinished: BulkUnfinishedAgent[] } } | null
  >(null);
  const bulkReceipt = useBulkChangeModelReceiptStore((s) => s.receipts[machine.id]);
  const bulkHighlight = useBulkChangeModelReceiptStore((s) => s.highlights[machine.id]);
  const recordBulkReceipt = useBulkChangeModelReceiptStore((s) => s.record);
  const clearBulkReceipt = useBulkChangeModelReceiptStore((s) => s.clear);
  // One-shot deadline (success banner 5 s): re-render once when it passes; a
  // remount after it shows nothing.
  const [bulkClock, setBulkClock] = useState(() => currentTimeMs());
  const bulkBannerDeadline = bulkReceipt?.kind === "success" && bulkReceipt.bannerUntil > bulkClock
    ? bulkReceipt.bannerUntil
    : null;
  useEffect(() => {
    if (bulkBannerDeadline === null) return;
    const timer = setClockTimeout(() => setBulkClock(currentTimeMs()), Math.max(0, bulkBannerDeadline - currentTimeMs()) + 20);
    return () => clearClockTimeout(timer);
  }, [bulkBannerDeadline]);
  // The rows a bulk change just changed are located (states.md#located), with
  // the change's nonce as the request, so a second change restarts them. The
  // deadline only decides whether a change (or a mount) shows it at all; once
  // shown, it runs its whole LOCATED_MS and fades instead of being cut off at
  // the deadline. The panel holds the highlight, not the row: a row that
  // remounts after it has run stays unlit instead of starting its own.
  const locatedBulk = useMemo(
    () => (bulkHighlight && bulkHighlight.until > currentTimeMs() ? bulkHighlight : null),
    [bulkHighlight],
  );
  const bulkLocated = useLocated(locatedBulk ? `bulk:${locatedBulk.nonce}` : null);

  const machineAgents = useMemo(
    () => allAgents.filter((a) => !a.deletedAt && a.machineId === machine.id),
    [allAgents, machine.id],
  );
  // Subscribe via the store's named stable slice selector and compute display
  // states in render. Building this map inside a store selector returned
  // fresh objects per snapshot -> useShallow never equal -> React #185
  // (2026-07-07 prod incident). The slice values are store-held objects, so
  // this subscription only fires on real activity changes.
  const activitiesSlice = useAgentStore(selectAgentActivitiesSlice);
  const machines = useMachineStore((s) => s.machines);
  const displayStateFor = useCallback(
    (agent: Agent) => computeAgentDisplayState(allAgents, activitiesSlice, agent.id, agent, undefined, machines),
    [activitiesSlice, allAgents, machines],
  );
  const selectedAgents = useMemo(
    () => machineAgents.filter((a) => selectedAgentIds.has(a.id)),
    [machineAgents, selectedAgentIds],
  );
  const selectedOfflineAgents = useMemo(
    () => selectedAgents.filter((a) => !displayStateFor(a).isOnline),
    [displayStateFor, selectedAgents],
  );
  const selectedOnlineAgents = useMemo(
    () => selectedAgents.filter((a) => displayStateFor(a).isOnline),
    [displayStateFor, selectedAgents],
  );
  const machineAgentIdKey = machineAgents.map((a) => a.id).join("\0");
  const selectedCount = selectedAgents.length;
  const allSelected = machineAgents.length > 0 && selectedCount === machineAgents.length;
  const canStartLike = machine.status === "online";
  const bulkResetOptions = useMemo<BulkResetOption[]>(() => [
    {
      mode: "restart",
      label: formatMessage({ id: "machine.detail.bulkRestart" }),
      desc: formatMessage({ id: "machine.detail.bulkRestartDescription" }),
      selectedClass: "bg-info-soft",
    },
    {
      mode: "session",
      label: formatMessage({ id: "machine.detail.bulkResetSession" }),
      desc: formatMessage({ id: "machine.detail.bulkResetSessionDescription" }),
      selectedClass: "bg-warning-soft",
    },
    {
      mode: "full",
      label: formatMessage({ id: "machine.detail.bulkFullReset" }),
      desc: formatMessage({ id: "machine.detail.bulkFullResetDescription" }),
      selectedClass: "bg-danger-soft",
    },
  ], [formatMessage]);

  // `selectedAgentIds` is a user-driven multi-select Set; this effect cleans
  // stale ids when the underlying agent set shrinks (socket-pushed). The
  // functional updater reads `current` and computes the next Set against
  // `validIds` — NOT a mirror-prop pattern (no single source prop), it's a
  // stale-cleanup. react-doctor's no-derived-state suggested fix
  // (compute during render) can't express "drop ids that have disappeared
  // since last user selection."
  // Keyed on `machineAgentIdKey`, not `machineAgents`: the id key only changes when the
  // set of agents on this machine does, while the array follows every agent-store update.
  useEffect(() => {
    const validIds = new Set(machineAgentIdKey.split("\0"));
    // oxlint-disable-next-line react-doctor/no-derived-state
    setSelectedAgentIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [machineAgentIdKey]);

  const toggleAgentSelection = useCallback((agentId: string) => {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  const selectAllAgents = useCallback(() => {
    setSelectionMode(true);
    setSelectedAgentIds(new Set(machineAgents.map((a) => a.id)));
  }, [machineAgents]);

  const clearAllAgents = useCallback(() => setSelectedAgentIds(new Set()), []);

  const clearSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedAgentIds(new Set());
    setBulkError("");
  }, []);

  const runBulkAction = useCallback(async (action: BulkAgentAction) => {
    const targets =
      action === "start"
        ? selectedOfflineAgents
        : action === "stop"
          ? selectedOnlineAgents
          : selectedAgents;
    if (targets.length === 0) return;

    setBulkAction(action);
    setBulkError("");
    try {
      const results = await Promise.allSettled(
        targets.map((agent) => {
          if (action === "start") return startAgent(agent.id);
          if (action === "stop") return stopAgent(agent.id);
          return resetAgent(agent.id, action);
        })
      );
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) {
        setBulkError(formatMessage({ id: "machine.detail.bulkActionFailed" }, { failed, total: targets.length }));
      } else {
        clearSelection();
        setShowResetOptions(false);
      }
    } finally {
      setBulkAction(null);
    }
  }, [
    clearSelection,
    formatMessage,
    resetAgent,
    selectedAgents,
    selectedOfflineAgents,
    selectedOnlineAgents,
    startAgent,
    stopAgent,
  ]);
  const startSelectedAgents = useCallback(() => runBulkAction("start"), [runBulkAction]);
  const stopSelectedAgents = useCallback(() => runBulkAction("stop"), [runBulkAction]);
  const resetSelectedAgents = useCallback(() => runBulkAction(bulkResetMode), [bulkResetMode, runBulkAction]);
  const openAgent = useCallback((agentId: string) => nav.toAgent(agentId), [nav]);
  const enterSelectionMode = useCallback(() => setSelectionMode(true), []);
  const openCreateAgent = useCallback(() => {
    trackAgentCreateOpened("computer_detail");
    setShowCreateAgent(true);
  }, []);
  const closeCreateAgent = useCallback(() => setShowCreateAgent(false), []);
  const openStopConfirm = useCallback(() => setShowStopConfirm(true), []);
  const closeStopConfirm = useCallback(() => setShowStopConfirm(false), []);
  const openResetOptions = useCallback(() => setShowResetOptions(true), []);
  const closeResetOptions = useCallback(() => setShowResetOptions(false), []);
  const isAgentRunning = useCallback((agent: Agent) => displayStateFor(agent).isOnline, [displayStateFor]);
  const openBulkModel = useCallback(() => {
    setBulkModelDialog({ agentIds: selectedAgents.map((a) => a.id) });
  }, [selectedAgents]);
  const closeBulkModel = useCallback(() => setBulkModelDialog(null), []);
  const retryBulkModel = useCallback(() => {
    if (bulkReceipt?.kind !== "partial") return;
    setBulkModelDialog({
      agentIds: bulkReceipt.unfinished.map((item) => item.agentId),
      retry: { target: bulkReceipt.target, unfinished: bulkReceipt.unfinished },
    });
  }, [bulkReceipt]);
  const finishBulkModel = useCallback((receipt: BulkChangeReceipt, highlightedAgentIds: string[]) => {
    const now = currentTimeMs();
    recordBulkReceipt(machine.id, receipt, highlightedAgentIds, now);
    setBulkClock(now);
    setBulkModelDialog(null);
    clearSelection();
  }, [clearSelection, machine.id, recordBulkReceipt]);
  const dismissBulkReceipt = useCallback(() => clearBulkReceipt(machine.id), [clearBulkReceipt, machine.id]);
  const bulkModelAgents = useMemo(
    () => (bulkModelDialog ? machineAgents.filter((a) => bulkModelDialog.agentIds.includes(a.id)) : []),
    [bulkModelDialog, machineAgents],
  );
  const showBulkSuccess = bulkReceipt?.kind === "success" && bulkReceipt.bannerUntil > bulkClock;
  const bulkTargetLabel = bulkReceipt
    ? formatBulkModelLabel(bulkReceipt.target.runtime, bulkReceipt.target.model, true)
    : "";


  return (
    <>
      <div>
        <SectionHeader
          className="mb-3 flex-wrap gap-y-2"
          label={formatMessage({ id: "machine.detail.agentsOnComputer" })}
          count={machineAgents.length}
          action={
            <div className="flex items-center gap-1.5">
              {canManageMachines && machineAgents.length > 0 && (
                selectionMode ? (
                  <>
                    <Button size="md"
                      variant="outline"
                      type="button"
                      onClick={allSelected ? clearAllAgents : selectAllAgents}
                    >
                      <Check size={16} />
                      {allSelected
                        ? formatMessage({ id: "machine.detail.clearAll" })
                        : formatMessage({ id: "machine.detail.selectAll" })}
                    </Button>
                    <Button size="md"
                      variant="default"
                      type="button"
                      onClick={clearSelection}
                    >
                      <X size={16} />
                      {formatMessage({ id: "common.confirm.cancel" })}
                    </Button>
                  </>
                ) : (
                  <Button size="md"
                    variant="outline"
                    type="button"
                    onClick={enterSelectionMode}
                  >
                    <Check size={16} />
                    {formatMessage({ id: "machine.detail.select" })}
                  </Button>
                )
              )}
              {canManageMachines && !selectionMode && (
                // Not this page's single pink action (that is Upgrade): an ink-line
                // button, like New Task in a channel.
                <Button size="md"
                  variant="outline"
                  onClick={openCreateAgent}
                >
                  <Plus size={16} />
                  {formatMessage({ id: "machine.detail.create" })}
                </Button>
              )}
            </div>
          }
        />
        {machineAgents.length === 0 ? (
          <div className={DETAIL_EMPTY_NOTE_CLASS_NAME}>
            {formatMessage({ id: "machine.detail.noAgentsAssigned" })}
          </div>
        ) : (
          <div className="stack-y-2">
            {showBulkSuccess && bulkReceipt?.kind === "success" && (
              <Banner
                intent="success"
                density="sm"
                withIcon
                data-testid="bulk-model-success-banner"
                onClose={dismissBulkReceipt}
                closeLabel={formatMessage({ id: "machine.detail.bulkModel.dismiss" })}
              >
                <span className="font-bold">
                  {formatMessage({ id: "machine.detail.bulkModel.successBanner" }, { count: bulkReceipt.changedAgentIds.length, target: bulkTargetLabel })}
                </span>
                {bulkReceipt.skippedAgentIds.length > 0 && (
                  <> {formatMessage({ id: "machine.detail.bulkModel.successSkipped" }, { count: bulkReceipt.skippedAgentIds.length })}</>
                )}
              </Banner>
            )}
            {bulkReceipt?.kind === "partial" && (
              <Banner
                intent="warning"
                density="sm"
                withIcon
                data-testid="bulk-model-partial-banner"
                // With Try Again, the banner closes with a ghost Dismiss before
                // it; without a button, with the × (Raft Design System › Banner).
                actions={canManageMachines ? (
                  <>
                    <Button size="md" variant="ghost" type="button" onClick={dismissBulkReceipt} data-testid="bulk-model-dismiss">
                      {formatMessage({ id: "machine.detail.bulkModel.dismiss" })}
                    </Button>
                    <Button size="md" variant="default" type="button" onClick={retryBulkModel} data-testid="bulk-model-try-again">
                      {formatMessage({ id: "machine.detail.bulkModel.tryAgain" })}
                    </Button>
                  </>
                ) : undefined}
                onClose={canManageMachines ? undefined : dismissBulkReceipt}
                closeLabel={formatMessage({ id: "machine.detail.bulkModel.dismiss" })}
              >
                <span className="font-bold">
                  {formatMessage({ id: "machine.detail.bulkModel.partialBanner" }, { failed: bulkReceipt.unfinished.length, total: bulkReceipt.total })}
                </span>
              </Banner>
            )}
            {canManageMachines && selectedCount > 0 && (
              // The bulk toolbar is about the selected rows: the selection's
              // cyan-soft wash (SurfaceListItem selected).
              <SurfaceListItem selected interactive={false} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <SectionEyebrow tone="ink" className="mr-auto">
                    {formatMessage({ id: "machine.detail.selectedCount" }, { count: selectedCount })}
                  </SectionEyebrow>
                  <Tooltip content={
                      !canStartLike
                        ? formatMessage({ id: "machine.detail.mustBeOnlineToStartAgents" })
                        : formatMessage({ id: "machine.detail.startSelectedOfflineAgents" })
                    }>
                  <Button size="md"
                    variant="success"
                    type="button"
                    onClick={startSelectedAgents}
                    disabled={bulkAction !== null || selectedOfflineAgents.length === 0 || !canStartLike}
                  >
                    <Play size={16} />
                    {bulkAction === "start"
                      ? formatMessage({ id: "machine.detail.starting" })
                      : formatMessage({ id: "machine.detail.start" })}
                  </Button>
                  </Tooltip>
                  <Tooltip content={formatMessage({ id: "machine.detail.stopSelectedOnlineAgents" })}>
                  <Button size="md"
                    variant="outline"
                    type="button"
                    onClick={openStopConfirm}
                    disabled={bulkAction !== null || selectedOnlineAgents.length === 0}
                  >
                    <Square size={16} />
                    {formatMessage({ id: "machine.detail.stop" })}
                  </Button>
                  </Tooltip>
                  <Tooltip content={
                      !canStartLike
                        ? formatMessage({ id: "machine.detail.mustBeOnlineToRestartAgents" })
                        : formatMessage({ id: "machine.detail.restartOrResetSelectedAgents" })
                    }>
                  <Button size="md"
                    variant="outline"
                    type="button"
                    onClick={openResetOptions}
                    disabled={bulkAction !== null || !canStartLike}
                  >
                    <RotateCcw size={16} />
                    {formatMessage({ id: "machine.detail.restartReset" })}
                  </Button>
                  </Tooltip>
                  <Tooltip content={formatMessage({ id: "machine.detail.bulkModel.tooltip" })}>
                  <Button size="md"
                    variant="outline"
                    type="button"
                    onClick={openBulkModel}
                    disabled={bulkAction !== null || selectedCount === 0}
                    data-testid="bulk-change-model-button"
                  >
                    <ArrowLeftRight size={16} />
                    {formatMessage({ id: "machine.detail.bulkModel.button" })}
                  </Button>
                  </Tooltip>
                </div>
                {bulkError && (
                  <Banner intent="warning" density="sm" className="mt-2">
                    {bulkError}
                  </Banner>
                )}
              </SurfaceListItem>
            )}
            {/* DS ListRow › `rf-list--inset`: the agents are one card with
                hairlines between rows (AvatarListRow is a raft-ui ListRow). */}
            <ListRowGroup>
              {machineAgents.map((agent) => (
                <MachineAgentRow
                  key={agent.id}
                  agent={agent}
                  displayState={displayStateFor(agent)}
                  selectionMode={selectionMode}
                  selected={selectedAgentIds.has(agent.id)}
                  canManageMachines={canManageMachines}
                  onToggleSelection={toggleAgentSelection}
                  onOpenAgent={openAgent}
                  located={bulkLocated && !!locatedBulk?.agentIds.includes(agent.id)}
                />
              ))}
            </ListRowGroup>
          </div>
        )}
      </div>

      {canManageMachines && showCreateAgent && (
        <CreateAgentDialog
          defaultMachineId={machine.id}
          onClose={closeCreateAgent}
        />
      )}

      {bulkModelDialog && bulkModelAgents.length > 0 && (
        <BulkChangeModelDialog
          machine={machine}
          agents={bulkModelAgents}
          isRunning={isAgentRunning}
          canViewUsage={canViewRuntimeAccountUsage}
          retry={bulkModelDialog.retry}
          onClose={closeBulkModel}
          onOpenAgent={openAgent}
          onFinished={finishBulkModel}
        />
      )}

      {showResetOptions && (
        <DialogCard title={formatMessage({ id: "machine.detail.restartAgentCount" }, { count: selectedCount })} onClose={closeResetOptions}>
            <div className="stack-y-3">
              {bulkResetOptions.map((opt) => (
                <BulkResetOptionCard
                  key={opt.mode}
                  option={opt}
                  selected={bulkResetMode === opt.mode}
                  disabled={bulkAction !== null}
                  onSelect={setBulkResetMode}
                />
              ))}
            </div>
            {bulkResetMode === "full" && (
              <Banner intent="destructive" density="sm" withIcon className="mt-3">
                {formatMessage({ id: "machine.detail.fullResetWarning" })}
              </Banner>
            )}
            {/* Raft DS Dialog: Cancel (ghost) on the left, the confirm's colour
                says the consequence — restarting or resetting the session
                interrupts but recovers (orange); a full reset cannot be undone (red). */}
            <DialogCardFooter className="mt-4">
              <Button size="lg"
                variant="ghost"
                type="button"
                onClick={closeResetOptions}
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <Button size="lg"
                variant={bulkResetMode === "full" ? "danger" : "warning"}
                type="button"
                onClick={resetSelectedAgents}
                disabled={bulkAction !== null}
              >
                <RotateCcw size={16} />
                {bulkAction
                  ? formatMessage({ id: "machine.detail.restarting" })
                  : bulkResetOptions.find((opt) => opt.mode === bulkResetMode)!.label}
              </Button>
            </DialogCardFooter>
        </DialogCard>
      )}

      {showStopConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "machine.detail.stopAgentsTitle" })}
          message={formatMessage({ id: "machine.detail.stopAgentsMessage" }, { count: selectedOnlineAgents.length })}
          confirmLabel={formatMessage({ id: "machine.detail.stopAgentsConfirm" })}
          loadingLabel={formatMessage({ id: "machine.detail.stopping" })}
          confirmVariant="warning"
          onConfirm={stopSelectedAgents}
          onClose={closeStopConfirm}
        />
      )}
    </>
  );
}
