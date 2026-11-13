import { Badge, Button, Spinner, Status } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { RefreshCw, FolderOpen } from "lucide-react";
import Banner from "../../components/ui/Banner";
import { useMachineStore } from "../../store/machineStore";
import type { MachineWorkspaceEntry } from "../../store/machineStore";
import ConfirmDialog from "../../components/ConfirmDialog";
import SectionHeader from "../../components/ui/SectionHeader";
import { formatFileSizeBytes } from "../../utils/fileSizePresentation";
import { WorkspaceDeleteButton } from "../../components/machine/WorkspaceDeleteButton";
import { DETAIL_EMPTY_NOTE_CLASS_NAME } from "./machineDetailClassNames";

const EMPTY_WORKSPACES: MachineWorkspaceEntry[] = [];

/** Workspace status → its Raft DS status light (active online, an orphan is
 *  the problem, stopped / deleted are offline stone). */
function workspaceStatusTone(status: MachineWorkspaceEntry["status"]): "success" | "warning" | "default" {
  if (status === "active") return "success";
  if (status === "orphan") return "warning";
  return "default";
}

// A filesystem path, not prose. Daemons before 1.0.46 do not report it and
// only ever kept workspaces under ~/.slock/agents/.
function workspaceLocation(ws: MachineWorkspaceEntry): string {
  return ws.displayPath ?? `~/.slock/agents/${ws.directoryName}/`;
}

export function WorkspacesSection({ machineId, canManageMachines }: { machineId: string; canManageMachines: boolean }) {
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

  const handleScan = useCallback(async () => {
    await scanMachineWorkspaces(machineId);
    setScanned(true);
  }, [machineId, scanMachineWorkspaces]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    await deleteMachineWorkspace(machineId, deleteTarget);
    setDeleteTarget(null);
  }, [deleteMachineWorkspace, deleteTarget, machineId]);
  const closeDeleteDialog = useCallback(() => setDeleteTarget(null), []);

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
        icon={<FolderOpen size={14} className="text-foreground-muted" />}
        label={formatMessage({ id: "machine.detail.agentWorkspaces" })}
        action={
          <Button size="md"
            variant="outline"
            onClick={handleScan}
            disabled={loading}
          >
            {loading ? <Spinner size="xs" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            {loading
              ? formatMessage({ id: "machine.detail.scanning" })
              : scanned
                ? formatMessage({ id: "machine.detail.rescan" })
                : formatMessage({ id: "machine.detail.scan" })}
          </Button>
        }
      />

      {!scanned && !loading && (
        <div className={DETAIL_EMPTY_NOTE_CLASS_NAME}>
          {formatMessage({ id: "machine.detail.workspacesPrompt" })}
        </div>
      )}

      {scanned && workspaces.length === 0 && (
        <div className={DETAIL_EMPTY_NOTE_CLASS_NAME}>
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
        <Banner intent="info" density="sm" live={false} className="mb-2">
          {formatMessage(
            { id: "machine.detail.deletedWorkspaceBanner" },
            { count: deletedCount, strong: (chunks) => <strong key="strong">{chunks}</strong> },
          )}
        </Banner>
      )}

      {sortedWorkspaces.length > 0 && (
        // One row per workspace (surface, hairline, container radius). A row
        // with no matching agent is the problem: orange-soft; a retained
        // deleted agent's row sits on the sunken surface.
        <div className="stack-y-1.5">
          {sortedWorkspaces.map((ws: MachineWorkspaceEntry) => (
            <div
              key={ws.directoryName}
              className={`flex items-center gap-3 rounded-container border border-line-hairline px-3 py-2.5 ${
                ws.status === "orphan"
                  ? "bg-warning-soft"
                  : ws.status === "deleted"
                    ? "bg-fill-muted"
                    : "bg-layer-card"
              }`}
            >
              <FolderOpen size={16} className="shrink-0 text-foreground-muted" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-callout font-semibold text-foreground">
                    {ws.agentName || ws.directoryName}
                  </span>
                  {/* Raft DS StatusChip: soft wash + square pixel + one word. */}
                  <Badge appearance="soft" variant={workspaceStatusTone(ws.status)}>
                    <Status size="md" variant={workspaceStatusTone(ws.status)} aria-hidden="true" />
                    {formatWorkspaceStatus(ws.status)}
                  </Badge>
                </div>
                <div className="mt-0.5 break-all font-mono text-mono-meta text-foreground-hint">
                  {workspaceLocation(ws)}
                </div>
                {ws.status === "deleted" && (
                  <div className="mt-0.5 text-caption text-foreground-muted">
                    {formatMessage({ id: "machine.detail.agentDeletedWorkspaceRetained" })}
                  </div>
                )}
                {ws.status === "orphan" && (
                  <div className="mt-0.5 text-caption font-semibold text-warning-strong">
                    {formatMessage({ id: "machine.detail.noMatchingAgentRecord" })}
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-3 font-mono text-mono-meta text-foreground-hint">
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
                <WorkspaceDeleteButton directoryName={ws.directoryName} onRequestDelete={setDeleteTarget} />
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
          onClose={closeDeleteDialog}
        />
      )}
    </div>
  );
}
