import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "raft-ui";
import { useIntl } from "react-intl";
import { Trash2, Monitor, Check, Copy, RefreshCw, FolderOpen, Play, Plus, X, Pencil, Square, RotateCcw, CheckCircle, AlertCircle, Terminal, ChevronRight } from "lucide-react";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import ProgressBar from "../ui/ProgressBar";
import { getMachineRuntimeDisplayOptions, isDaemonOutdated, runtimeAvailabilitySuffix } from "@botiverse/raft-shared";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useMachineStore } from "../../store/machineStore";
import type { Machine, MachineWorkspaceEntry } from "../../store/machineStore";
import { computeAgentDisplayState, selectAgentActivitiesSlice, useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useProfileStore } from "../../store/profileStore";
import { useAuthStore } from "../../store/authStore";
import api from "../../api/client";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { getServerUrl } from "../../utils/server";
import { formatRelativeTime } from "../../utils/relativeTime";
import { getComputerCommands, getDaemonConnectCommand } from "../../utils/computerSetupCommand";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import ConfirmDialog from "../ConfirmDialog";
import CreateAgentDialog from "../agent/CreateAgentDialog";
import ComputerCommandGuide from "./ComputerCommandGuide";
import StatusDot from "../ui/StatusDot";
import PanelHeader from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";
import SectionHeader from "../ui/SectionHeader";
import KeyValueRow from "../ui/KeyValueRow";
import AvatarSlot from "../ui/AvatarSlot";
import SurfaceListItem from "../ui/SurfaceListItem";
import AvatarListRow from "../ui/AvatarListRow";
import CheckMarker from "../ui/CheckMarker";
import { formatActivityText } from "../../utils/activity";
import { RuntimeAccountUsageGateChip } from "./RuntimeAccountUsageChip";
import { formatFileSizeBytes } from "../../utils/fileSizePresentation";

const EMPTY_WORKSPACES: MachineWorkspaceEntry[] = [];
type CommandCopyTarget =
  | "computer-install"
  | "computer-setup"
  | "computer-install-restart"
  | "terminal-status"
  | "terminal-doctor"
  | "terminal-restart";

function WorkspacesSection({ machineId, canManageMachines }: { machineId: string; canManageMachines: boolean }) {
  const { formatDate, formatMessage } = useIntl();
  const scanMachineWorkspaces = useMachineStore((s) => s.scanMachineWorkspaces);
  const deleteMachineWorkspace = useMachineStore((s) => s.deleteMachineWorkspace);
  const workspaces = useMachineStore((s) => s.machineWorkspaces[machineId]) ?? EMPTY_WORKSPACES;
  const loading = useMachineStore((s) => s.machineWorkspacesLoading[machineId]) ?? false;
  const [scanned, setScanned] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const deleteEntry = deleteTarget
    ? workspaces.find((w: MachineWorkspaceEntry) => w.directoryName === deleteTarget)
    : null;

  const handleScan = async () => {
    await scanMachineWorkspaces(machineId);
    setScanned(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteMachineWorkspace(machineId, deleteTarget);
    setDeleteTarget(null);
  };

  const formatWorkspaceStatus = (status: MachineWorkspaceEntry["status"]) => {
    switch (status) {
      case "active":
        return formatMessage({ id: "machine.detail.workspaceStatus.active" });
      case "stopped":
        return formatMessage({ id: "machine.detail.workspaceStatus.stopped" });
      case "deleted":
        return formatMessage({ id: "machine.detail.workspaceStatus.deleted" });
      case "orphan":
        return formatMessage({ id: "machine.detail.workspaceStatus.orphan" });
      default:
        return status;
    }
  };

  const sortedWorkspaces = [...workspaces].sort((a: MachineWorkspaceEntry, b: MachineWorkspaceEntry) => {
    const order: Record<string, number> = { orphan: 0, deleted: 1, stopped: 2, active: 3 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  const orphanCount = workspaces.filter((w: MachineWorkspaceEntry) => w.status === "orphan").length;
  const deletedCount = workspaces.filter((w: MachineWorkspaceEntry) => w.status === "deleted").length;

  return (
    <div>
      <SectionHeader
        className="mb-2"
        icon={<FolderOpen size={14} className="text-black" />}
        label={formatMessage({ id: "machine.detail.agentWorkspaces" })}
        action={
          <button
            onClick={handleScan}
            disabled={loading}
            className="btn-brutal-sm bg-white px-2 py-1 text-xs flex items-center gap-1"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {loading
              ? formatMessage({ id: "machine.detail.scanning" })
              : scanned
                ? formatMessage({ id: "machine.detail.rescan" })
                : formatMessage({ id: "machine.detail.scan" })}
          </button>
        }
      />

      {!scanned && !loading && (
        <div className="text-xs text-black/40 italic">
          {formatMessage({ id: "machine.detail.workspacesPrompt" })}
        </div>
      )}

      {scanned && workspaces.length === 0 && (
        <div className="text-xs text-black/40 italic">
          {formatMessage({ id: "machine.detail.noWorkspaceDirectories" })}
        </div>
      )}

      {scanned && orphanCount > 0 && (
        <Banner intent="warning" density="sm" className="mb-2">
          {formatMessage(
            { id: "machine.detail.orphanWorkspaceBanner" },
            { count: orphanCount, strong: (chunks) => <strong key="strong">{chunks}</strong> },
          )}
        </Banner>
      )}

      {scanned && deletedCount > 0 && (
        <div className="mb-2 border-2 border-black bg-gray-200 px-3 py-2 text-xs text-black">
          {formatMessage(
            { id: "machine.detail.deletedWorkspaceBanner" },
            { count: deletedCount, strong: (chunks) => <strong key="strong">{chunks}</strong> },
          )}
        </div>
      )}

      {sortedWorkspaces.length > 0 && (
        <div className="space-y-1.5">
          {sortedWorkspaces.map((ws: MachineWorkspaceEntry) => (
            <div
              key={ws.directoryName}
              className={`flex items-center gap-2 border-2 px-3 py-2 ${
                ws.status === "orphan"
                  ? "border-brutal-orange bg-brutal-orange/10"
                  : ws.status === "deleted"
                    ? "border-black bg-gray-100"
                    : "border-black/30"
              }`}
            >
              <FolderOpen size={14} className="shrink-0 text-black/40" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xs text-black truncate">
                    {ws.agentName || ws.directoryName}
                  </span>
                  <span
                    className={`inline-block border border-black px-1.5 text-[10px] font-bold uppercase leading-4 ${
                      ws.status === "active"
                        ? "bg-brutal-lime"
                        : ws.status === "stopped"
                          ? "bg-gray-200"
                          : ws.status === "deleted"
                            ? "bg-gray-300"
                            : "bg-brutal-orange"
                    }`}
                  >
                    {formatWorkspaceStatus(ws.status)}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-black/40 font-mono break-all">
                  ~/.slock/agents/{ws.directoryName}/
                </div>
                {ws.status === "deleted" && (
                  <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-black/60">
                    {formatMessage({ id: "machine.detail.agentDeletedWorkspaceRetained" })}
                  </div>
                )}
                {ws.status === "orphan" && (
                  <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-brutal-orange">
                    {formatMessage({ id: "machine.detail.noMatchingAgentRecord" })}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-black/50 font-mono">
                  <span>{formatFileSizeBytes(ws.totalSizeBytes, formatMessage)}</span>
                  <span>{formatMessage({ id: "machine.detail.fileCount" }, { count: ws.fileCount })}</span>
                  <span>
                    {formatMessage(
                      { id: "machine.detail.modifiedDate" },
                      {
                        date: formatDate(ws.lastModified, {
                          month: "short",
                          day: "numeric",
                        }),
                      },
                    )}
                  </span>
                </div>
              </div>
              {canManageMachines && (
                <button
                  onClick={() => setDeleteTarget(ws.directoryName)}
                  className="shrink-0 btn-brutal-sm bg-white p-1"
                  title={formatMessage({ id: "machine.detail.deleteWorkspace" })}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={formatMessage({ id: "machine.detail.deleteWorkspaceTitle" })}
          message={formatMessage(
            { id: "machine.detail.deleteWorkspaceMessage" },
            { name: deleteEntry?.agentName || deleteTarget },
          )}
          confirmLabel={formatMessage({ id: "machine.detail.deleteWorkspaceTitle" })}
          loadingLabel={formatMessage({ id: "machine.detail.deleting" })}
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// Isolated component — subscribes to current display-state projections only for agents on this machine,
// preventing activity changes from re-rendering the entire MachineDetailPanel.
function MachineAgentList({ machine, canManageMachines }: { machine: Machine; canManageMachines: boolean }) {
  const { formatMessage } = useIntl();
  const allAgents = useAgentStore((s) => s.agents);
  const startAgent = useAgentStore((s) => s.startAgent);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const resetAgent = useAgentStore((s) => s.resetAgent);
  const nav = useAppNavigate();
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<"start" | "stop" | "restart" | "session" | "full" | null>(null);
  const [bulkError, setBulkError] = useState("");
  const [showResetOptions, setShowResetOptions] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [bulkResetMode, setBulkResetMode] = useState<"restart" | "session" | "full">("restart");

  const machineAgents = allAgents.filter((a) => !a.deletedAt && a.machineId === machine.id);
  // Subscribe via the store's named stable slice selector and compute display
  // states in render. Building this map inside a store selector returned
  // fresh objects per snapshot -> useShallow never equal -> React #185
  // (2026-07-07 prod incident). The slice values are store-held objects, so
  // this subscription only fires on real activity changes.
  const activitiesSlice = useAgentStore(selectAgentActivitiesSlice);
  const displayStateFor = (agent: (typeof machineAgents)[number]) =>
    computeAgentDisplayState(allAgents, activitiesSlice, agent.id, agent);
  const selectedAgents = machineAgents.filter((a) => selectedAgentIds.has(a.id));
  const selectedOfflineAgents = selectedAgents.filter((a) => !displayStateFor(a).isOnline);
  const selectedOnlineAgents = selectedAgents.filter((a) => displayStateFor(a).isOnline);
  const machineAgentIdKey = machineAgents.map((a) => a.id).join("\0");
  const selectedCount = selectedAgents.length;
  const allSelected = machineAgents.length > 0 && selectedCount === machineAgents.length;
  const canStartLike = machine.status === "online";
  const bulkResetOptions: {
    mode: "restart" | "session" | "full";
    label: string;
    desc: string;
    selectedClass: string;
  }[] = [
    {
      mode: "restart",
      label: formatMessage({ id: "machine.detail.bulkRestart" }),
      desc: formatMessage({ id: "machine.detail.bulkRestartDescription" }),
      selectedClass: "border-black bg-brutal-cyan/20 shadow-brutal-sm",
    },
    {
      mode: "session",
      label: formatMessage({ id: "machine.detail.bulkResetSession" }),
      desc: formatMessage({ id: "machine.detail.bulkResetSessionDescription" }),
      selectedClass: "border-black bg-brutal-orange/20 shadow-brutal-sm",
    },
    {
      mode: "full",
      label: formatMessage({ id: "machine.detail.bulkFullReset" }),
      desc: formatMessage({ id: "machine.detail.bulkFullResetDescription" }),
      selectedClass: "border-black bg-brutal-red/20 shadow-brutal-sm",
    },
  ];

  // oxlint-disable react-hooks/exhaustive-deps -- reconcile the selection against the current agent set keyed by the stable `machineAgentIdKey`; depending on the `machineAgents` array (a fresh ref every render) would re-run every render.
  // `selectedAgentIds` is a user-driven multi-select Set; this effect cleans
  // stale ids when the underlying agent set shrinks (socket-pushed). The
  // functional updater reads `current` and computes the next Set against
  // `validIds` — NOT a mirror-prop pattern (no single source prop), it's a
  // stale-cleanup. react-doctor's no-derived-state suggested fix
  // (compute during render) can't express "drop ids that have disappeared
  // since last user selection."
  useEffect(() => {
    const validIds = new Set(machineAgents.map((a) => a.id));
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
  // oxlint-enable react-hooks/exhaustive-deps

  const toggleAgentSelection = (agentId: string) => {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const selectAllAgents = () => {
    setSelectionMode(true);
    setSelectedAgentIds(new Set(machineAgents.map((a) => a.id)));
  };

  const clearSelection = () => {
    setSelectionMode(false);
    setSelectedAgentIds(new Set());
    setBulkError("");
  };

  const runBulkAction = async (action: "start" | "stop" | "restart" | "session" | "full") => {
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
  };

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
                    <button
                      type="button"
                      onClick={allSelected ? () => setSelectedAgentIds(new Set()) : selectAllAgents}
                      className="btn-brutal-sm bg-white px-2 py-1 text-xs flex items-center gap-1"
                    >
                      <Check size={12} />
                      {allSelected
                        ? formatMessage({ id: "machine.detail.clearAll" })
                        : formatMessage({ id: "machine.detail.selectAll" })}
                    </button>
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="btn-brutal-sm bg-white px-2 py-1 text-xs flex items-center gap-1"
                    >
                      <X size={12} />
                      {formatMessage({ id: "common.confirm.cancel" })}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSelectionMode(true)}
                    className="btn-brutal-sm bg-white px-2 py-1 text-xs flex items-center gap-1"
                  >
                    <Check size={12} />
                    {formatMessage({ id: "machine.detail.select" })}
                  </button>
                )
              )}
              {canManageMachines && !selectionMode && (
                <button
                  onClick={() => setShowCreateAgent(true)}
                  className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs flex items-center gap-1"
                >
                  <Plus size={12} />
                  {formatMessage({ id: "machine.detail.create" })}
                </button>
              )}
            </div>
          }
        />
        {machineAgents.length === 0 ? (
          <div className="text-sm text-black/40 italic">
            {formatMessage({ id: "machine.detail.noAgentsAssigned" })}
          </div>
        ) : (
          <div className="space-y-2">
            {canManageMachines && selectedCount > 0 && (
              <SurfaceListItem selected interactive={false} className="bg-gray-100 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <SectionEyebrow className="mr-auto !text-black">
                    {formatMessage({ id: "machine.detail.selectedCount" }, { count: selectedCount })}
                  </SectionEyebrow>
                  <button
                    type="button"
                    onClick={() => runBulkAction("start")}
                    disabled={bulkAction !== null || selectedOfflineAgents.length === 0 || !canStartLike}
                    className="btn-brutal-sm flex items-center gap-1 bg-brutal-lime px-2 py-1 text-xs disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-black/40"
                    title={
                      !canStartLike
                        ? formatMessage({ id: "machine.detail.mustBeOnlineToStartAgents" })
                        : formatMessage({ id: "machine.detail.startSelectedOfflineAgents" })
                    }
                  >
                    <Play size={12} />
                    {bulkAction === "start"
                      ? formatMessage({ id: "machine.detail.starting" })
                      : formatMessage({ id: "machine.detail.start" })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowStopConfirm(true)}
                    disabled={bulkAction !== null || selectedOnlineAgents.length === 0}
                    className="btn-brutal-sm flex items-center gap-1 bg-white px-2 py-1 text-xs disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-black/40"
                    title={formatMessage({ id: "machine.detail.stopSelectedOnlineAgents" })}
                  >
                    <Square size={12} />
                    {formatMessage({ id: "machine.detail.stop" })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowResetOptions(true)}
                    disabled={bulkAction !== null || !canStartLike}
                    className="btn-brutal-sm flex items-center gap-1 bg-white px-2 py-1 text-xs disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-black/40"
                    title={
                      !canStartLike
                        ? formatMessage({ id: "machine.detail.mustBeOnlineToRestartAgents" })
                        : formatMessage({ id: "machine.detail.restartOrResetSelectedAgents" })
                    }
                  >
                    <RotateCcw size={12} />
                    {formatMessage({ id: "machine.detail.restartReset" })}
                  </button>
                </div>
                {bulkError && (
                  <Banner intent="warning" density="sm" className="mt-2 font-bold">
                    {bulkError}
                  </Banner>
                )}
              </SurfaceListItem>
            )}
            {machineAgents.map((agent) => {
              const displayState = displayStateFor(agent);
              const activityText = formatActivityText(
                formatMessage,
                displayState.activity,
                displayState.activityDetail,
                displayState.activityDetailKind,
              );
              const selected = selectedAgentIds.has(agent.id);
              const avatar = <AvatarSlot context="surface-list" type="agent" agentAvatarUrl={agent.avatarUrl} />;
              const rightStatus = (
                <>
                  <StatusDot activity={displayState.activity} title={activityText} />
                  <span
                    className="hidden max-w-[min(32rem,42vw)] truncate align-middle text-xs font-mono text-black/50 sm:inline-block"
                    title={activityText}
                  >
                    {activityText}
                  </span>
                </>
              );
              if (selectionMode) {
                // Selection mode adds a leading CheckMarker column that
                // is outside AvatarListRow's slot contract. Keep the inline
                // SurfaceListItem here — the row body still mirrors the
                // primitive's avatar / name / subtitle / rightContent layout
                // so the visual is identical to the normal-mode AvatarListRow.
                return (
                  <SurfaceListItem
                    key={agent.id}
                    selected={canManageMachines && selected}
                    className={`group px-3 py-2 ${selected ? "" : "bg-gray-100 hover:bg-white"}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleAgentSelection(agent.id)}
                      className="flex w-full min-w-0 items-center gap-3 text-left"
                      title={
                        selected
                          ? formatMessage({ id: "machine.detail.deselectAgent" })
                          : formatMessage({ id: "machine.detail.selectAgent" })
                      }
                      aria-label={
                        selected
                          ? formatMessage({ id: "machine.detail.deselectAgentName" }, { name: agent.displayName || agent.name })
                          : formatMessage({ id: "machine.detail.selectAgentName" }, { name: agent.displayName || agent.name })
                      }
                    >
                      <CheckMarker
                        checked={selected}
                        size="lg"
                        tone="yellow-fill"
                        previewOnHover
                        className="mt-0"
                      />
                      {avatar}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                          <span className="truncate text-sm font-bold text-black">
                            {agent.displayName || agent.name}
                          </span>
                          <span className="text-xs font-mono text-black/50">
                            {formatRuntimeLabelWithStatus(agent.runtime, formatMessage)}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">{rightStatus}</div>
                    </button>
                  </SurfaceListItem>
                );
              }
              return (
                <AvatarListRow
                  key={agent.id}
                  avatar={avatar}
                  name={agent.displayName || agent.name}
                  subtitle={formatRuntimeLabelWithStatus(agent.runtime, formatMessage)}
                  rightContent={rightStatus}
                  onClick={() => nav.toAgent(agent.id)}
                  selected={false}
                  className="bg-gray-100 hover:bg-white"
                />
              );
            })}
          </div>
        )}
      </div>

      {canManageMachines && showCreateAgent && (
        <CreateAgentDialog
          defaultMachineId={machine.id}
          onClose={() => setShowCreateAgent(false)}
        />
      )}

      {showResetOptions && (
        <DialogCard title={formatMessage({ id: "machine.detail.restartAgentCount" }, { count: selectedCount })} onClose={() => setShowResetOptions(false)}>
            <div className="space-y-3">
              {bulkResetOptions.map((opt) => (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => setBulkResetMode(opt.mode)}
                  disabled={bulkAction !== null}
                  className={`w-full border-2 p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    bulkResetMode === opt.mode
                      ? opt.selectedClass
                      : "border-black/30 bg-white hover:border-black"
                  }`}
                >
                  <div className="text-sm font-bold uppercase">{opt.label}</div>
                  <p className="mt-1 text-xs text-black/60">{opt.desc}</p>
                </button>
              ))}
            </div>
            {bulkResetMode === "full" && (
              <Banner intent="warning" density="sm" withIcon className="mt-3 font-bold">
                {formatMessage({ id: "machine.detail.fullResetWarning" })}
              </Banner>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowResetOptions(false)}
                className="btn-brutal bg-white px-4 py-2 text-sm"
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </button>
              <button
                type="button"
                onClick={() => runBulkAction(bulkResetMode)}
                disabled={bulkAction !== null}
                className={`btn-brutal flex items-center gap-1.5 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
                  bulkResetMode === "full" ? "bg-brutal-red" : bulkResetMode === "session" ? "bg-brutal-orange" : "bg-brutal-cyan"
                }`}
              >
                <RotateCcw size={14} />
                {bulkAction
                  ? formatMessage({ id: "machine.detail.restarting" })
                  : bulkResetOptions.find((opt) => opt.mode === bulkResetMode)!.label}
              </button>
            </div>
        </DialogCard>
      )}

      {showStopConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "machine.detail.stopAgentsTitle" })}
          message={formatMessage({ id: "machine.detail.stopAgentsMessage" }, { count: selectedOnlineAgents.length })}
          confirmLabel={formatMessage({ id: "machine.detail.stopAgentsTitle" })}
          loadingLabel={formatMessage({ id: "machine.detail.stopping" })}
          confirmColor="bg-brutal-orange"
          onConfirm={() => runBulkAction("stop")}
          onClose={() => setShowStopConfirm(false)}
        />
      )}
    </>
  );
}

export default function MachineDetailPanel({
  machine,
  workspaceEmbedded = false,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
}: {
  machine: Machine;
  workspaceEmbedded?: boolean;
  deploymentEnv?: string;
}) {
  const { formatDate, formatMessage, locale } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const deleteMachine = useMachineStore((s) => s.deleteMachine);
  const renameMachine = useMachineStore((s) => s.renameMachine);
  const updateMachineDetails = useMachineStore((s) => s.updateMachineDetails);
  const rotateApiKey = useMachineStore((s) => s.rotateApiKey);
  const latestDaemonVersion = useMachineStore((s) => s.latestDaemonVersion);
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  const openProfile = useProfileStore((s) => s.openProfile);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const allAgents = useAgentStore((s) => s.agents);
  const { capabilities } = useServerPermissions();
  const machineAgents = allAgents.filter((a) => !a.deletedAt && a.machineId === machine.id);
  const serverName = useServerStore((s) => s.current?.name) || "server";
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}/settings` : "/");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Collapsed-by-default install/setup fallback on the offline Computer
  // recovery card. The primary path remains start/status/doctor, while this
  // plainly labelled escape hatch also works when the binary is not installed.
  const [showRecoverySetup, setShowRecoverySetup] = useState(false);
  const [recoveryGuideContext, setRecoveryGuideContext] = useState<{
    machineId: string;
    status: Machine["status"];
  }>({ machineId: machine.id, status: machine.status });
  const [recoveryGuideDisclosure, setRecoveryGuideDisclosure] = useState<boolean | null>(null);
  const recoveryGuideContentId = `computer-recovery-guide-content-${useId()}`;
  if (recoveryGuideContext.machineId !== machine.id || recoveryGuideContext.status !== machine.status) {
    setRecoveryGuideContext({ machineId: machine.id, status: machine.status });
    setRecoveryGuideDisclosure(null);
  }
  const [copiedCommand, setCopiedCommand] = useState<CommandCopyTarget | null>(null);
  const [rotating, setRotating] = useState(false);
  const [editingName, setEditingName] = useState(false);
  // Per-machine Computer operation progress (upgrade/restart) — from machineStore.
  // oxlint-disable-next-line react-doctor/no-event-handler -- per-machine hot-slice selector mandated by the Render-cost contract (docs/frontend/render-cost-contract.md): it must close over the machine.id prop to subscribe to ONLY this machine's progress entry. Subscribing to the whole computerOperationProgress record to avoid the prop would re-render this panel on every machine's progress change — the exact cost the contract forbids. Heuristic false positive, YMNNE-family.
  const computerOperationProgress = useMachineStore((s) => s.computerOperationProgress[machine.id] ?? null);
  const setComputerOperation = useMachineStore((s) => s.setComputerOperation);
  // draftName is only read while editingName=true. handleStartRename seeds
  // it from machine.name before flipping editingName, so an empty initial
  // value never reaches the rendered input. Initializing with the prop
  // would freeze the mirror on first mount and is what react-doctor's
  // no-derived-useState guards against.
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState("");
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  const serverUrl = getServerUrl();
  const savedKey = localStorage.getItem(`slock_machine_apikey_${machine.id}`);
  // Validate cached key against server's apiKeyPrefix to detect stale keys
  const isKeyValid = savedKey && machine.apiKeyPrefix && savedKey.startsWith(machine.apiKeyPrefix);
  if (savedKey && !isKeyValid) {
    localStorage.removeItem(`slock_machine_apikey_${machine.id}`);
  }
  const macLinuxConnectCommand = isKeyValid
    ? getDaemonConnectCommand({ apiKey: savedKey, platform: "mac-linux", serverName, serverUrl })
    : null;
  const windowsConnectCommand = isKeyValid
    ? getDaemonConnectCommand({ apiKey: savedKey, platform: "windows", serverName, serverUrl })
    : null;
  const setupMachineId = machine.isComputer ? null : machine.id;
  const computerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    legacyApiKey: isKeyValid ? savedKey : null,
    // Identity-carried migration (task #239): this page knows WHICH row the
    // computer is, so the setup command adopts it directly (--machine <id>) —
    // no fingerprint matching, works after key rotation. Legacy rows only;
    // Computer rows keep the plain setup command.
    machineId: setupMachineId,
  });
  const windowsMachine = machine.os?.toLowerCase().startsWith("win") ?? false;
  const windowsComputerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    legacyApiKey: isKeyValid ? savedKey : null,
    machineId: setupMachineId,
    platform: "windows",
  });
  const computerFreshInstallCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    legacyApiKey: isKeyValid ? savedKey : null,
    machineId: setupMachineId,
    platform: windowsMachine ? "windows" : "mac-linux",
    version: latestComputerVersion,
  });
  const machineComputerCommands = windowsMachine ? windowsComputerCommands : computerCommands;
  const computerSetupCommand = machineComputerCommands?.setup ?? null;
  const computerInstall = machineComputerCommands?.install ?? null;
  const computerFreshInstall = computerFreshInstallCommands?.install ?? null;
  const computerInstallRestartCommand = computerFreshInstallCommands?.restartService ?? null;
  // Address recovery to the current server. Restart handles both local
  // failure shapes the server sees as "offline": a stopped service (stop is
  // a no-op, then start) and a live runner whose server connection is stuck.
  // The CLI's supervisor restart can cycle other managed runners in the same
  // home; taking this from the command bundle keeps staging/slockdev on their
  // per-server RAFT_HOME + binary path.
  const computerRecoveryRestartCommand = machineComputerCommands?.restart ?? null;
  const terminalStatusCommands = machineComputerCommands
    ? [
        { command: machineComputerCommands.status, target: "terminal-status" as const },
        { command: machineComputerCommands.doctor, target: "terminal-doctor" as const },
      ]
    : [];
  const terminalRestartCommand = machineComputerCommands?.restart ?? null;
  // A user choice applies only to the current machine + current health state.
  // When either changes, fall back to the product default immediately: healthy
  // Computers stay collapsed, while an offline Computer exposes recovery.
  const showRecoveryGuide = recoveryGuideDisclosure ?? machine.status !== "online";
  const canManageMachines = machine.computerAttachedByCurrentUser === true
    || (currentUserId !== null && machine.creator?.id === currentUserId)
    || [
    capabilities.editMachines,
    capabilities.controlComputers,
    capabilities.removeMachines,
    capabilities.rotateMachineKeys,
    capabilities.createAgents,
    capabilities.migrateAgents,
    ].some(Boolean);
  const canViewRuntimeAccountUsage = canViewMachineRuntimeAccountUsage(machine, currentUserId, capabilities);
  const handleDelete = async () => {
    await deleteMachine(machine.id);
    setShowDeleteConfirm(false);
  };

  const handleCopy = async (target: CommandCopyTarget, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedCommand(target);
    setTimeout(() => {
      setCopiedCommand((current) => (current === target ? null : current));
    }, 2000);
  };


  const handleRotateKey = async () => {
    setRotating(true);
    try {
      await rotateApiKey(machine.id);
    } catch {
      // handled in store
    } finally {
      setRotating(false);
    }
  };

  // Remote Computer controls (managed Computer only). The server relays
  // a command to the machine's live connection, which forwards it to the
  // Computer service IPC (restart = restart-service, upgrade = upgrade-start).
  // Upgrade drives the ProgressBar via `computer:upgrade:progress`/`:done` WS
  // frames; Restart uses an indeterminate bar until the machine comes back online.
  const handleComputerControl = async (action: "restart" | "upgrade") => {
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    const consentedTargetVersion = action === "upgrade"
      ? machine.computerBroadcastPolicy?.targetVersion ?? null
      : null;
    // The button renders this exact version. Carry it back so the Server can
    // reject a policy change between render and click instead of upgrading to
    // a different version the user never approved.
    if (action === "upgrade" && !consentedTargetVersion) return;
    // Optimistically enter progress state before the POST returns.
    setComputerOperation(machine.id, {
      operation: action,
      ...(action === "upgrade" ? { phase: "downloading" as const } : {}),
    });
    try {
      const { data } = await api.post(
        `/servers/${serverId}/machines/${machine.id}/computer/${action}`,
        action === "upgrade" ? { targetVersion: consentedTargetVersion } : {},
        { headers: { "X-Server-Id": serverId } },
      );
      if (action === "restart") {
        const requestId = (data as { requestId?: string })?.requestId;
        if (requestId) {
          setComputerOperation(machine.id, {
            operation: "restart",
            requestId,
          });
        }
      } else {
        // For upgrade, the requestId is used to correlate WS progress frames.
        const requestId = (data as { requestId?: string })?.requestId;
        if (requestId) {
          setComputerOperation(machine.id, {
            operation: "upgrade",
            requestId,
            phase: "downloading",
            progressValue: 0,
          });
        }
      }
    } catch (err) {
      const errorData = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      const code = errorData?.code;
      const serverError = typeof errorData?.error === "string" && errorData.error.trim().length > 0
        ? errorData.error
        : null;
      let errorMsg = serverError ?? formatMessage({ id: "machine.detail.computerRequestFailed" }, { action });
      if (code === "computer_offline") {
        errorMsg = formatMessage({ id: "machine.detail.computerOffline" });
      }
      setComputerOperation(machine.id, {
        operation: action,
        done: true,
        error: errorMsg,
      });
      // Auto-clear error after 4s so the button reappears.
      setTimeout(() => setComputerOperation(machine.id, null), 4000);
    }
  };

  // Clear terminal operation state after a display pause.
  useEffect(() => {
    if (computerOperationProgress?.done) {
      const t = setTimeout(() => setComputerOperation(machine.id, null), 3000);
      return () => clearTimeout(t);
    }
  }, [computerOperationProgress?.done, machine.id, setComputerOperation]);

  // Safety timeout: if an operation is in progress but no WS frames arrive
  // (e.g. HTTP server down, daemon didn't receive the command), reset to
  // buttons after 60s so the user isn't stuck with no way to retry.
  useEffect(() => {
    if (computerOperationProgress && !computerOperationProgress.done) {
      const t = setTimeout(() => {
        setComputerOperation(machine.id, {
          ...computerOperationProgress,
          done: true,
          error:
            computerOperationProgress.operation === "restart"
              ? formatMessageRef.current({ id: "machine.detail.restartTimedOut" })
              : formatMessageRef.current({ id: "machine.detail.upgradeTimedOut" }),
        });
      }, 60_000);
      return () => clearTimeout(t);
    }
  }, [computerOperationProgress, machine.id, setComputerOperation]);

  const handleStartRename = () => {
    setDraftName(machine.name);
    setNameError("");
    setEditingName(true);
  };

  const handleSaveRename = async () => {
    const nextName = draftName.trim();
    if (!nextName) {
      setNameError(formatMessage({ id: "machine.detail.computerNameRequired" }));
      return;
    }
    if (nextName === machine.name) {
      setEditingName(false);
      setDraftName(machine.name);
      return;
    }
    setNameError("");
    setSavingName(true);
    try {
      await renameMachine(machine.id, nextName);
      setEditingName(false);
    } catch {
      setNameError(formatMessage({ id: "machine.detail.renameComputerFailed" }));
    } finally {
      setSavingName(false);
    }
  };

  const handleCancelRename = () => {
    setDraftName(machine.name);
    setNameError("");
    setEditingName(false);
  };

  const handleStartEditDescription = () => {
    setDraftDescription(machine.description ?? "");
    setDescriptionError("");
    setEditingDescription(true);
  };

  const handleSaveDescription = async () => {
    const nextDescription = draftDescription.trim();
    if (nextDescription.length > 500) {
      setDescriptionError(formatMessage({ id: "machine.detail.descriptionTooLong" }));
      return;
    }
    const currentDescription = machine.description ?? "";
    if (nextDescription === currentDescription) {
      setEditingDescription(false);
      setDraftDescription(currentDescription);
      return;
    }
    setDescriptionError("");
    setSavingDescription(true);
    try {
      await updateMachineDetails(machine.id, { description: nextDescription || null });
      setEditingDescription(false);
    } catch {
      setDescriptionError(formatMessage({ id: "machine.detail.updateDescriptionFailed" }));
    } finally {
      setSavingDescription(false);
    }
  };

  const handleCancelDescription = () => {
    setDraftDescription(machine.description ?? "");
    setDescriptionError("");
    setEditingDescription(false);
  };

  const createdDate = formatDate(machine.createdAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const lastHeartbeatText = formatRelativeTime(machine.lastHeartbeat, locale);
  const lastHeartbeatParenthetical = lastHeartbeatText
    ? formatMessage({ id: "machine.detail.lastSeenParenthetical" }, { time: lastHeartbeatText })
    : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!workspaceEmbedded && (
        <PanelHeader
          title={machine.name}
          icon={<Monitor size={18} />}
          iconBg="bg-soft-signal text-black"
          iconAlwaysVisible
          onMobileBack={onMobileBack}
          mobileBackProps={{
            "data-testid": "machine-mobile-back",
            title: formatMessage({ id: "common.announcement.back" }),
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto bg-white">
        {/* Profile info — machine icon + name + status */}
        <div className="flex items-start gap-4 px-5 py-5 border-b border-black/10">
          <div className="flex size-16 shrink-0 items-center justify-center border-2 border-black bg-soft-signal text-black">
            <Monitor size={28} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="min-w-0 truncate text-lg font-bold leading-tight text-black" title={machine.name}>{machine.name}</div>
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot
                tone={machine.status === "online" ? "bg-brutal-lime" : "bg-gray-400"}
                className="shrink-0"
              />
              <span className="shrink-0 text-sm text-black/60 font-mono">
                {machine.status === "online"
                  ? formatMessage({ id: "machine.detail.connected" })
                  : formatMessage({ id: "machine.detail.offline" })}
              </span>
            </div>
            {machine.hostname && (
              <div className="truncate text-sm text-black/50 font-mono" title={machine.hostname}>{machine.hostname}</div>
            )}
          </div>
        </div>

        {/* Name */}
        <div className="px-5 py-4 border-b border-black/10">
          <div className="flex items-center gap-2 mb-1">
            <SectionEyebrow as="div">
              {formatMessage({ id: "machine.detail.name" })}
            </SectionEyebrow>
            {canManageMachines && !editingName && (
              <button
                type="button"
                onClick={handleStartRename}
                className="text-black/40 hover:text-black transition-colors"
                title={formatMessage({ id: "machine.detail.editComputerName" })}
              >
                <Pencil size={12} />
              </button>
            )}
          </div>
          {canManageMachines && editingName ? (
            <div className="space-y-[5px]">
              <input
                ref={nameInputRef}
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value.replace(/[\r\n]+/g, " "));
                  if (nameError) setNameError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveRename();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelRename();
                  }
                }}
                className="h-8 w-full border-2 border-black px-2 py-1 text-sm shadow-brutal-sm focus:outline-none focus:shadow-brutal-sm"
                placeholder={formatMessage({ id: "machine.detail.computerName" })}
                autoFocus
                disabled={savingName}
              />
            <div className="flex items-center gap-1.5">
              <button
                  onClick={() => void handleSaveRename()}
                  disabled={savingName}
                  className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {formatMessage({ id: "machine.detail.save" })}
                </button>
                <button
                  onClick={handleCancelRename}
                  disabled={savingName}
                  className="btn-brutal-sm bg-white px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                {formatMessage({ id: "common.confirm.cancel" })}
              </button>
            </div>
            {nameError && (
              <div className="text-xs font-bold text-brutal-orange">
                {nameError}
              </div>
            )}
            </div>
          ) : (
            <p className="text-sm text-black">{machine.name}</p>
          )}
        </div>

        {/* Description */}
        <div className="px-5 py-4 border-b border-black/10">
          <div className="flex items-center gap-2 mb-1">
            <SectionEyebrow as="div">
              {formatMessage({ id: "machine.detail.description" })}
            </SectionEyebrow>
            {canManageMachines && !editingDescription && (
              <button
                type="button"
                onClick={handleStartEditDescription}
                className="text-black/40 hover:text-black transition-colors"
                title={formatMessage({ id: "machine.detail.editComputerDescription" })}
              >
                <Pencil size={12} />
              </button>
            )}
          </div>
          {canManageMachines && editingDescription ? (
            <div className="space-y-[5px]">
              <textarea
                ref={descriptionInputRef}
                value={draftDescription}
                onChange={(e) => {
                  setDraftDescription(e.target.value);
                  if (descriptionError) setDescriptionError("");
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveDescription();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelDescription();
                  }
                }}
                className="min-h-20 w-full resize-y border-2 border-black px-2 py-1 text-sm leading-relaxed shadow-brutal-sm focus:outline-none focus:shadow-brutal-sm"
                placeholder={formatMessage({ id: "machine.detail.descriptionPlaceholder" })}
                maxLength={500}
                autoFocus
                disabled={savingDescription}
              />
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => void handleSaveDescription()}
                    disabled={savingDescription}
                    className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {formatMessage({ id: "machine.detail.save" })}
                  </button>
                  <button
                    onClick={handleCancelDescription}
                    disabled={savingDescription}
                    className="btn-brutal-sm bg-white px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {formatMessage({ id: "common.confirm.cancel" })}
                  </button>
                </div>
                <span className="text-[11px] text-black/40 font-mono">
                  {draftDescription.length}/500
                </span>
              </div>
              {descriptionError && (
                <div className="text-xs font-bold text-brutal-orange">
                  {descriptionError}
                </div>
              )}
            </div>
          ) : (
            <p className={`whitespace-pre-wrap text-sm leading-relaxed ${machine.description ? "text-black" : "text-black/40 italic"}`}>
              {machine.description || formatMessage({ id: "machine.detail.noDescription" })}
            </p>
          )}
        </div>

        {/* Info */}
        <div className="px-5 py-4 border-b border-black/10">
          <SectionEyebrow as="div" className="mb-3">
            {formatMessage({ id: "machine.detail.info" })}
          </SectionEyebrow>
          <div className="space-y-3">
            {/* OS */}
            {machine.os && <KeyValueRow label={formatMessage({ id: "machine.detail.osLabel" })} value={machine.os} mono />}
            {/* Version — run-kind (Computer vs daemon) is conveyed by the
                label itself, not a separate Type field (tygg msg=ba39de5b).
                A managed Computer shows its own `@botiverse/raft-computer`
                version (computerVersion); a raw daemon shows daemonVersion. */}
            {machine.isComputer ? (
              <KeyValueRow
                label={formatMessage({ id: "machine.detail.computerVersion" })}
                value={
                  machine.computerVersion ? (
                    <div className="flex items-center gap-1.5">
                      <span className={`text-sm font-mono ${machine.computerUpgradeAvailable === true ? "text-brutal-orange font-bold" : "text-black"}`}>
                        v{machine.computerVersion}
                      </span>
                      {machine.computerUpgradeAvailable === true && (
                        <span className="text-xs text-brutal-orange font-bold">
                          {formatMessage({ id: "machine.detail.updateAvailableParenthetical" })}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-black/40 italic">—</span>
                  )
                }
              />
            ) : (
              <KeyValueRow
                label={formatMessage({ id: "machine.detail.daemonVersion" })}
                value={
                  machine.daemonVersion ? (
                    <div className="flex items-center gap-1.5">
                      <span className={`text-sm font-mono ${isDaemonOutdated(machine.daemonVersion, latestDaemonVersion) ? "text-brutal-orange font-bold" : "text-black"}`}>
                        v{machine.daemonVersion}
                      </span>
                      {isDaemonOutdated(machine.daemonVersion, latestDaemonVersion) && (
                        <span className="text-xs text-brutal-orange font-bold">
                          {formatMessage({ id: "machine.detail.updateAvailableParenthetical" })}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-black/40 italic">—</span>
                  )
                }
              />
            )}
            {/* Detected Runtimes */}
            <KeyValueRow
              label={formatMessage({ id: "machine.detail.detectedRuntimes" })}
              value={
                <div className="flex items-center gap-1.5 flex-wrap">
                  {getMachineRuntimeDisplayOptions().map((r) => {
                    const detected = machine.runtimes.includes(r.id);
                    const chipClassName = detected
                      ? "h-6 border-2 border-black bg-brutal-cyan px-2 py-0.5 text-xs font-bold text-black"
                      : "h-6 border-2 border-black/30 bg-gray-100 px-2 py-0.5 text-xs font-bold text-black/40";
                    return (
                      <RuntimeAccountUsageGateChip
                        key={r.id}
                        enabled={detected && canViewRuntimeAccountUsage}
                        runtimeId={r.id}
                        runtimeVersion={machine.runtimeVersions?.[r.id]}
                        serverId={serverId}
                        machineId={machine.id}
                        className={chipClassName}
                      >
                        {formatRuntimeLabelWithStatus(r.id, formatMessage)}{formatRuntimeAvailabilitySuffix(runtimeAvailabilitySuffix(r, machine.runtimes), formatMessage)}
                      </RuntimeAccountUsageGateChip>
                    );
                  })}
                </div>
              }
            />
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              {/* Created */}
              <KeyValueRow label={formatMessage({ id: "machine.detail.created" })} value={createdDate} mono />
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
                        className="flex items-center gap-2 text-sm text-black hover:underline"
                      >
                        <AvatarSlot
                          context="creator-link"
                          type="human"
                          humanAvatarUrl={machine.creator.avatarUrl}
                          gravatarHash={machine.creator.gravatarHash}
                        />
                        <span className="font-bold">{machine.creator.displayName || machine.creator.name}</span>
                        <span className="font-mono text-xs text-black/50">
                          {formatMessage({ id: "common.handle" }, { name: machine.creator.name })}
                        </span>
                      </button>
                    ) : (
                      <span className="text-sm italic text-black/40">
                        {formatMessage({ id: "agent.detail.noCreatorAssigned" })}
                      </span>
                    )
                  }
                />
              )}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 space-y-6">
          {/* Legacy daemon: intent-stable command sections (task #239 v2.3
              §19.web). Structure is decided by user INTENT — Migrate primary
              (always, any status), stay-legacy secondary (offline only) —
              never by credential state: actions fill content in place and
              must not restructure the page (the generate-jump defect class,
              #wg-raft-computer:5473a4ca). */}
          {!machine.isComputer && canManageMachines && (
            <div className="space-y-6">
              {computerSetupCommand && computerInstall && (
                <div data-testid="computer-migrate-block">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <SectionEyebrow as="div">
                      {formatMessage(
                        { id: "machine.detail.migrateToComputer" },
                        { platform: windowsMachine ? formatMessage({ id: "machine.detail.windowsX64Suffix" }) : "" },
                      )}
                    </SectionEyebrow>
                    {windowsMachine ? <Badge.Experimental /> : null}
                  </div>
                  <p className="mb-2 text-xs leading-5 text-black/60">
                    {formatMessage(
                      { id: "machine.detail.migrateDescription" },
                      {
                        platform: windowsMachine
                          ? formatMessage({ id: "machine.detail.windowsPowerShell" })
                          : formatMessage({ id: "machine.detail.macLinux" }),
                      },
                    )}
                  </p>
                  <div className="space-y-3">
                    {([
                      ["computer-install", formatMessage({ id: "machine.detail.installStep" }), computerInstall],
                      ["computer-setup", formatMessage({ id: "machine.detail.setupStep" }), computerSetupCommand],
                    ] as const).map(([target, label, command]) => (
                      <div key={target}>
                        <div className="mb-1 text-xs font-bold text-black/60">{label}</div>
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all">
                            {command}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopy(target, command)}
                            className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                            aria-label={formatMessage({ id: "machine.detail.copyCommandLabel" }, { label })}
                          >
                            {copiedCommand === target ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {machine.status === "offline" && (
                <div data-testid="legacy-daemon-block">
                  <SectionEyebrow as="div" className="mb-2">
                    {formatMessage({ id: "machine.detail.keepUsingLegacyDaemon" })}
                  </SectionEyebrow>
                  {macLinuxConnectCommand && windowsConnectCommand ? (
                    <ComputerCommandGuide
                      computerCommand={null}
                      computerInstallCommand={null}
                      macLinuxDaemonCommand={macLinuxConnectCommand}
                      windowsDaemonCommand={windowsConnectCommand}
                    />
                  ) : (
                    <div>
                      <p className="mb-2 text-xs leading-5 text-black/60">
                        {formatMessage({ id: "machine.detail.savedDaemonKeyUnavailable" })}
                      </p>
                      <button
                        onClick={handleRotateKey}
                        disabled={rotating}
                        className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5"
                      >
                        <RefreshCw size={12} className={rotating ? "animate-spin" : ""} />
                        {rotating
                          ? formatMessage({ id: "machine.detail.generating" })
                          : formatMessage({ id: "machine.detail.generateConnectCommand" })}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {!machine.isComputer && !canManageMachines && machine.status === "offline" && (
            <div>
              <SectionEyebrow as="div" className="mb-2">
                {formatMessage({ id: "machine.detail.connection" })}
              </SectionEyebrow>
              <div className="text-xs text-black/40 font-mono">
                {formatMessage({ id: "machine.detail.connectCommandsAdminOnly" })}
              </div>
            </div>
          )}

          {machine.isComputer && machine.status !== "online" && (
            <div data-testid="computer-recovery-card">
              <div className="mb-2 flex items-center gap-2">
                <Terminal size={16} className="text-black" />
                <SectionEyebrow as="div">{formatMessage({ id: "machine.detail.bringComputerOnline" })}</SectionEyebrow>
              </div>

              {canManageMachines ? (
                <div className="space-y-4">
                  {/* Primary remedy — a local command, platform-independent.
                      Web remote restart/upgrade only works while online (live
                      WS relay), so an offline Computer cannot get a web button. */}
                  {computerRecoveryRestartCommand && (
                    <div>
                      <p className="mb-2 text-xs leading-5 text-black/60">
                        {formatMessage({ id: "machine.detail.recoveryRestartDescription" }, { serverSlug })}
                      </p>
                      <div className="flex items-center gap-2">
                        <code
                          className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all"
                          data-testid="computer-recovery-restart"
                        >
                          {computerRecoveryRestartCommand}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopy("terminal-restart", computerRecoveryRestartCommand)}
                          className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                          title={formatMessage({ id: "machine.detail.copyCommand" })}
                          aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                        >
                          {copiedCommand === "terminal-restart" ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Diagnostics — reuse the existing status/doctor commands. */}
                  <div>
                    <p className="mb-2 text-xs leading-5 text-black/60">
                      {formatMessage({ id: "machine.detail.offlineDiagnosticsPrompt" })}
                    </p>
                    <div className="space-y-2">
                      {terminalStatusCommands.map(({ command, target }) => (
                        <div key={command} className="flex items-center gap-2">
                          <code
                            className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all"
                            data-testid={`computer-recovery-${target === "terminal-status" ? "status" : "doctor"}`}
                          >
                            {command}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopy(target, command)}
                            className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                            title={formatMessage({ id: "machine.detail.copyCommand" })}
                            aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                          >
                            {copiedCommand === target ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* last-seen — let the user judge if the machine is just
                      off; no offline-reason guessing (frontend can't tell). */}
                  {machine.lastHeartbeat && (
                    <p className="text-xs leading-5 text-black/50">
                      {formatMessage(
                        { id: "machine.detail.lastSeen" },
                        { time: lastHeartbeatText },
                      )}
                    </p>
                  )}

                  {/* Secondary: an explicit command-not-found path exposes
                      install + setup without displacing the normal start path. */}
                  <div className="border-t border-black/10 pt-3">
                    <button
                      type="button"
                      onClick={() => setShowRecoverySetup((v) => !v)}
                      className="text-xs font-bold text-black/60 underline underline-offset-2"
                      aria-expanded={showRecoverySetup}
                      data-testid="computer-recovery-setup-toggle"
                    >
                      {showRecoverySetup
                        ? formatMessage({ id: "machine.detail.hideInstallSetupCommands" })
                        : formatMessage({ id: "machine.detail.commandNotFoundSetup" })}
                    </button>
                    {showRecoverySetup && computerInstall && computerSetupCommand && (
                      <div className="mt-2 space-y-3">
                        <p className="text-xs leading-5 text-black/60">
                          {formatMessage({ id: "machine.detail.installSetupDescription" })}
                          {windowsMachine ? ` ${formatMessage({ id: "machine.detail.windowsInstallerX64Only" })}` : ""}
                        </p>
                        {([
                          ["computer-install", formatMessage({ id: "machine.detail.installStep" }), computerInstall],
                          ["computer-setup", formatMessage({ id: "machine.detail.setupStep" }), computerSetupCommand],
                        ] as const).map(([target, label, command]) => (
                          <div key={target}>
                            <div className="mb-1 text-xs font-bold text-black/60">{label}</div>
                            <div className="flex items-center gap-2">
                              <code
                                className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all"
                                data-testid={target === "computer-install" ? "computer-recovery-install" : "computer-recovery-setup"}
                              >
                                {command}
                              </code>
                              <button
                                type="button"
                                onClick={() => handleCopy(target, command)}
                                className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                                title={
                                  target === "computer-install"
                                    ? formatMessage({ id: "machine.detail.copyInstallCommand" })
                                    : formatMessage({ id: "machine.detail.copySetupCommand" })
                                }
                                aria-label={
                                  target === "computer-install"
                                    ? formatMessage({ id: "machine.detail.copyInstallCommand" })
                                    : formatMessage({ id: "machine.detail.copySetupCommand" })
                                }
                              >
                                {copiedCommand === target ? <Check size={14} /> : <Copy size={14} />}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs leading-5 text-black/50">
                  {formatMessage(
                    { id: "machine.detail.offlineAdminOnly" },
                    { time: lastHeartbeatParenthetical },
                  )}
                </p>
              )}
            </div>
          )}

          {/* Agents on this machine — isolated to prevent activity re-renders */}
          <MachineAgentList machine={machine} canManageMachines={canManageMachines} />

          {/* Agent Workspaces — only when machine is online */}
          {machine.status === "online" && (
            <div className="mt-2 border-t border-black/10 pt-4">
              <WorkspacesSection machineId={machine.id} canManageMachines={canManageMachines} />
            </div>
          )}

          {/* Actions */}
          {canManageMachines && (
            <div className="mt-2 border-t border-black/10 pt-4">
              <SectionEyebrow as="div" className="mb-3">
                {formatMessage({ id: "machine.detail.actions" })}
              </SectionEyebrow>
              {/* Remote restart / upgrade — managed Computer only (a raw
                  daemon has no remotely-controllable service). Online-only:
                  offline recovery is the recovery card's job (task #247). */}
              {machine.isComputer && machine.status === "online" && (
                <div className="border-2 border-black bg-white shadow-brutal-sm p-4 mb-3" data-testid="computer-service-actions">
                  <div className="text-sm font-bold text-black mb-1">
                    {formatMessage({ id: "machine.detail.computer" })}
                  </div>
                  {computerOperationProgress ? (
                    /* Progress mode — show bar instead of buttons */
                    <div className="space-y-2">
                      {computerOperationProgress.done ? (
                        <div className={`flex items-center gap-2 text-xs font-mono ${computerOperationProgress.error ? "text-brutal-red" : "text-black/70"}`}>
                          {computerOperationProgress.error ? (
                            <AlertCircle size={14} className="shrink-0" />
                          ) : (
                            <CheckCircle size={14} className="shrink-0" />
                          )}
                          {computerOperationProgress.error
                            ? (
                              computerOperationProgress.error === "restart_failed"
                                ? formatMessage({ id: "machine.restartFailed" })
                                : computerOperationProgress.error
                            )
                            : computerOperationProgress.rolledBack
                              ? formatMessage({ id: "machine.detail.rolledBack" })
                              : computerOperationProgress.newVersion
                                ? formatMessage(
                                    { id: "machine.detail.upgradedToVersion" },
                                    { version: computerOperationProgress.newVersion },
                                  )
                                : computerOperationProgress.operation === "restart"
                                  ? formatMessage({ id: "machine.detail.restarted" })
                                  : formatMessage({ id: "machine.detail.done" })}
                        </div>
                      ) : (
                        <>
                          <ProgressBar
                            value={computerOperationProgress.progressValue ?? null}
                            tone={computerOperationProgress.operation === "upgrade" ? "pink" : "cyan"}
                            label={
                              computerOperationProgress.message ??
                              (computerOperationProgress.operation === "restart"
                                ? formatMessage({ id: "machine.detail.restarting" })
                                : computerOperationProgress.phase
                                  ? {
                                      downloading: formatMessage({ id: "machine.detail.downloading" }),
                                      verifying: formatMessage({ id: "machine.detail.verifying" }),
                                      applying: formatMessage({ id: "machine.detail.applying" }),
                                      restarting: formatMessage({ id: "machine.detail.restarting" }),
                                    }[computerOperationProgress.phase]
                                  : formatMessage({ id: "machine.detail.working" }))
                            }
                          />
                        </>
                      )}
                    </div>
                  ) : (
                    /* Default mode — show buttons */
                    (() => {
                      // Upgrade state and target are one per-machine closed
                      // server decision. The web never compares against the
                      // top-level published-artifact hint.
                      const policy = machine.computerBroadcastPolicy;
                      const policyTargetVersion = policy?.targetVersion ?? null;
                      const controlledMigration = policy?.migrationClass === "controlled_reinstall_repair";
                      const upgradeAvailable = machine.computerUpgradeAvailable === true
                        && policy?.eligibility === "eligible"
                        && Boolean(policyTargetVersion);
                      const policyDenied = policy?.eligibility === "no_broadcast";
                      const legacyKnownNoUpgrade = !policy && machine.computerUpgradeAvailable === false;
                      const upgradeDisabled = !upgradeAvailable;
                      const showFreshInstallUpgradePath = Boolean(
                        machine.computerVersion
                        && !upgradeAvailable
                        && !legacyKnownNoUpgrade
                        && computerFreshInstall
                        && computerInstallRestartCommand,
                      );
                      const upgradeTitle = policyDenied
                        ? formatMessage({ id: "machine.detail.upgradeUnavailableSource" })
                        : legacyKnownNoUpgrade
                        ? formatMessage({ id: "machine.detail.computerAlreadyLatest" })
                        : upgradeAvailable
                          ? formatMessage(
                              {
                                id: controlledMigration
                                  ? "machine.detail.runControlledMigrationToVersion"
                                  : "machine.detail.upgradeToVersion",
                              },
                              { version: policyTargetVersion },
                            )
                          : formatMessage({ id: "machine.detail.upgradeNotAuthorized" });
                      return (
                        <>
                          <p className="text-xs text-black/60 mb-3">
                            {!machine.computerVersion
                              ? formatMessage({ id: "machine.detail.versionStillSyncing" })
                              : upgradeAvailable && controlledMigration
                                ? formatMessage(
                                    { id: "machine.detail.restartOrControlledMigration" },
                                    { version: policyTargetVersion },
                                  )
                                : upgradeAvailable
                                  ? formatMessage(
                                      { id: "machine.detail.restartOrUpgrade" },
                                      { version: policyTargetVersion },
                                    )
                                : legacyKnownNoUpgrade
                                  ? formatMessage({ id: "machine.detail.restartLatestVersion" })
                                  : formatMessage({ id: "machine.detail.restartAvailableUpgradeIneligible" })}
                          </p>
                          <p className="mb-3 text-xs leading-5 text-black/60">
                            {formatMessage({ id: "machine.detail.restartIfUnresponsive" })}
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleComputerControl("restart")}
                              className="btn-brutal bg-white px-3 py-2 text-sm font-bold flex items-center gap-1.5"
                              title={formatMessage({ id: "machine.detail.restartComputerService" })}
                            >
                              <RotateCcw size={14} />
                              {formatMessage({ id: "machine.detail.restart" })}
                            </button>
                            <button
                              onClick={() => handleComputerControl("upgrade")}
                              disabled={upgradeDisabled}
                              className="btn-brutal bg-brutal-pink px-3 py-2 text-sm font-bold flex items-center gap-1.5 disabled:opacity-40"
                              title={upgradeTitle}
                            >
                              {legacyKnownNoUpgrade ? <CheckCircle size={14} /> : <Play size={14} />}
                              {legacyKnownNoUpgrade
                                ? formatMessage({ id: "machine.detail.upToDate" })
                                : policyDenied
                                  ? formatMessage({ id: "machine.detail.unavailable" })
                                  : controlledMigration
                                    ? formatMessage({ id: "machine.detail.migrate" })
                                    : formatMessage({ id: "machine.detail.upgrade" })}
                              {upgradeAvailable && policyTargetVersion && (
                                <span className="text-xs font-normal">(v{policyTargetVersion})</span>
                              )}
                            </button>
                          </div>
                          {showFreshInstallUpgradePath && computerFreshInstall && computerInstallRestartCommand && (
                            <div
                              className="mt-4 border-t border-black/10 pt-4"
                              data-testid="computer-upgrade-fresh-install-path"
                            >
                              <div className="text-xs font-bold text-black">
                                {formatMessage({ id: "machine.computer.freshInstallUpgrade.title" })}
                              </div>
                              <p className="mb-3 text-xs leading-5 text-black/60">
                                {formatMessage({ id: "machine.computer.freshInstallUpgrade.description" })}
                                {latestComputerVersion
                                  ? ` ${formatMessage(
                                      { id: "machine.computer.freshInstallUpgrade.pinnedVersion" },
                                      { version: latestComputerVersion },
                                    )}`
                                  : ""}
                              </p>
                              <ol className="space-y-3">
                                <li>
                                  <div className="mb-1 text-xs font-bold text-black/60">
                                    {formatMessage({ id: "machine.computer.freshInstallUpgrade.installStep" })}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <code
                                      className="min-w-0 flex-1 break-all border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm"
                                      data-testid="computer-upgrade-fresh-install"
                                    >
                                      {computerFreshInstall}
                                    </code>
                                    <button
                                      type="button"
                                      onClick={() => handleCopy("computer-install", computerFreshInstall)}
                                      className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                                      title={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyInstall" })}
                                      aria-label={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyInstall" })}
                                    >
                                      {copiedCommand === "computer-install" ? <Check size={14} /> : <Copy size={14} />}
                                    </button>
                                  </div>
                                </li>
                                <li>
                                  <div className="mb-1 text-xs font-bold text-black/60">
                                    {formatMessage({ id: "machine.computer.freshInstallUpgrade.restartStep" })}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <code
                                      className="min-w-0 flex-1 break-all border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm"
                                      data-testid="computer-upgrade-fresh-restart"
                                    >
                                      {computerInstallRestartCommand}
                                    </code>
                                    <button
                                      type="button"
                                      onClick={() => handleCopy("computer-install-restart", computerInstallRestartCommand)}
                                      className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                                      title={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}
                                      aria-label={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}
                                    >
                                      {copiedCommand === "computer-install-restart" ? <Check size={14} /> : <Copy size={14} />}
                                    </button>
                                  </div>
                                </li>
                              </ol>
                            </div>
                          )}
                        </>
                      );
                    })()
                  )}
                  <div className="mt-4 border-t border-black/10 pt-4" data-testid="computer-terminal-verification">
                    <div className="mb-2 flex items-center gap-2">
                      <Terminal size={16} className="text-black" />
                      <SectionEyebrow as="div">
                        {formatMessage({ id: "machine.detail.verifyFromTerminal" })}
                      </SectionEyebrow>
                    </div>
                    <p className="mb-2 text-xs leading-5 text-black/60">
                      {formatMessage({ id: "machine.detail.verifyFromTerminalDescription" })}
                    </p>
                    <div className="space-y-2">
                      {terminalStatusCommands.map(({ command, target }) => (
                        <div key={command} className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all">
                            {command}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopy(target, command)}
                            className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                            title={formatMessage({ id: "machine.detail.copyCommand" })}
                            aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                          >
                            {copiedCommand === target ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                      ))}
                    </div>
                    {terminalRestartCommand && (
                      <>
                        <p className="mb-2 mt-3 text-xs leading-5 text-black/60">
                          {formatMessage({ id: "machine.detail.webButtonsNotResponding" })}
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all">
                            {terminalRestartCommand}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopy("terminal-restart", terminalRestartCommand)}
                            className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                            title={formatMessage({ id: "machine.detail.copyCommand" })}
                            aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                          >
                            {copiedCommand === "terminal-restart" ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
              {machine.isComputer && machineComputerCommands && computerFreshInstall && computerInstallRestartCommand && terminalRestartCommand && (
                <div className="mb-3 border-2 border-black bg-white p-4 shadow-brutal-sm" data-testid="computer-recovery-guide">
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
                      <Terminal size={16} className="text-black" />
                      <SectionEyebrow>{formatMessage({ id: "machine.detail.recoveryGuide" })}</SectionEyebrow>
                    </span>
                    <ChevronRight
                      size={16}
                      aria-hidden="true"
                      className={`shrink-0 text-black/60 transition-transform ${showRecoveryGuide ? "rotate-90" : ""}`}
                      data-testid="computer-recovery-guide-chevron"
                    />
                  </button>
                  {showRecoveryGuide && (
                    <div
                      id={recoveryGuideContentId}
                      className="mt-3 border-t border-black/10 pt-3"
                      data-testid="computer-recovery-guide-content"
                    >
                      <p className="mb-4 text-xs leading-5 text-black/60">
                        {formatMessage({ id: "machine.detail.recoveryGuideDescription" })}
                      </p>
                      <ol className="space-y-4">
                        <li>
                          <div className="mb-2">
                            <div className="text-xs font-bold text-black">
                              {formatMessage({ id: "machine.detail.restartStep" })}
                            </div>
                            <p className="text-xs leading-5 text-black/60">
                              {formatMessage({ id: "machine.detail.restartStepDescription" })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <code
                              className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all"
                              data-testid="computer-recovery-guide-restart"
                            >
                              {terminalRestartCommand}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleCopy("terminal-restart", terminalRestartCommand)}
                              className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                              title={formatMessage({ id: "machine.detail.copyCommand" })}
                              aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                            >
                              {copiedCommand === "terminal-restart" ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                        </li>
                        <li>
                          <div className="mb-2">
                            <div className="text-xs font-bold text-black">
                              {formatMessage(
                                { id: "machine.detail.freshInstallStep" },
                                { platform: windowsMachine ? formatMessage({ id: "machine.detail.windowsX64Suffix" }) : "" },
                              )}
                            </div>
                            <p className="text-xs leading-5 text-black/60">
                              {formatMessage({ id: "machine.computer.recovery.freshInstallDescription" })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <code
                              className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm break-all"
                              data-testid="computer-recovery-guide-install"
                            >
                              {computerFreshInstall}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleCopy("computer-install", computerFreshInstall)}
                              className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                              title={formatMessage({ id: "machine.detail.copyFreshInstallCommand" })}
                              aria-label={formatMessage({ id: "machine.detail.copyFreshInstallCommand" })}
                            >
                              {copiedCommand === "computer-install" ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                        </li>
                        <li>
                          <div className="mb-2">
                            <div className="text-xs font-bold text-black">
                              {formatMessage({ id: "machine.computer.recovery.restartAfterInstallStep" })}
                            </div>
                            <p className="text-xs leading-5 text-black/60">
                              {formatMessage({ id: "machine.computer.recovery.restartAfterInstallDescription" })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <code
                              className="min-w-0 flex-1 break-all border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime shadow-brutal-sm"
                              data-testid="computer-recovery-guide-restart-after-install"
                            >
                              {computerInstallRestartCommand}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleCopy("computer-install-restart", computerInstallRestartCommand)}
                              className="btn-brutal-sm shrink-0 bg-white px-2 py-1.5"
                              title={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}
                              aria-label={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}
                            >
                              {copiedCommand === "computer-install-restart" ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                        </li>
                      </ol>
                    </div>
                  )}
                </div>
              )}
              <div className="border-2 border-black bg-white shadow-brutal-sm p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-black">
                      {formatMessage({ id: "machine.detail.deleteComputer" })}
                    </div>
                    <p className="text-xs text-black/60 mt-0.5">
                      {formatMessage({ id: "machine.detail.deleteComputerDescription" })}
                    </p>
                  </div>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="btn-brutal bg-brutal-red px-4 py-2 text-sm font-bold flex items-center gap-1.5 shrink-0 ml-4"
                  >
                    <Trash2 size={14} />
                    {formatMessage({ id: "machine.detail.deleteComputer" })}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {showDeleteConfirm && (
        machineAgents.length > 0 ? (
          <ConfirmDialog
            title={formatMessage({ id: "machine.detail.cannotDeleteComputer" })}
            message={formatMessage({ id: "machine.detail.cannotDeleteComputerMessage" }, { count: machineAgents.length })}
            confirmLabel={formatMessage({ id: "common.announcement.ok" })}
            confirmColor="bg-white"
            hideCancel
            onConfirm={() => {}}
            onClose={() => setShowDeleteConfirm(false)}
          />
        ) : (
          <ConfirmDialog
            title={formatMessage({ id: "machine.detail.deleteComputer" })}
            message={formatMessage({ id: "machine.detail.deleteComputerMessage" }, { name: machine.name })}
            confirmLabel={formatMessage({ id: "machine.detail.deleteComputer" })}
            loadingLabel={formatMessage({ id: "machine.detail.deleting" })}
            onConfirm={handleDelete}
            onClose={() => setShowDeleteConfirm(false)}
          />
        )
      )}

    </div>
  );
}
