import { useCallback, useEffect, useReducer, useState } from "react";
import { useIntl } from "react-intl";
import { Button, DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm } from "@botiverse/raft-ui";
import { AGENT_ARCHIVE_UPDATED_EVENT } from "@botiverse/raft-shared";
import type { AgentArchiveView } from "@botiverse/raft-shared";
import { getSocket } from "../../api/socket";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import type { Agent } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import {
  archiveErrorMessageId,
  archiveRequestErrorMessage,
  fetchAgentArchive,
  requestAgentArchiveWorkspaceDelete,
} from "./archiveApi";

/** `archive` is undefined while loading; `error` when the first read failed. */
type ArchiveState = { archive: AgentArchiveView | null | undefined; error: boolean };
type ArchiveStateAction = { type: "loaded"; archive: AgentArchiveView | null } | { type: "failed" };
const INITIAL_ARCHIVE_STATE: ArchiveState = { archive: undefined, error: false };

function archiveStateReducer(state: ArchiveState, action: ArchiveStateAction): ArchiveState {
  return action.type === "loaded" ? { archive: action.archive, error: false } : { ...state, error: true };
}

/**
 * Profile tab of an archived agent: when and where it was archived, where its
 * workspace is now, and (for people who may manage it) deleting the workspace.
 */
export function AgentArchiveSection({ agent, canManage }: { agent: Agent; canManage: boolean }) {
  const { formatMessage, formatDate } = useIntl();
  const members = useServerStore((s) => s.members);
  const [{ archive, error: loadError }, dispatch] = useReducer(archiveStateReducer, INITIAL_ARCHIVE_STATE);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let canceled = false;
    const apply = (action: ArchiveStateAction) => {
      if (!canceled) dispatch(action);
    };
    const load = () => fetchAgentArchive(agent.id)
      .then((view) => apply({ type: "loaded", archive: view }))
      .catch(() => apply({ type: "failed" }));
    void load();
    // The event carries only the agent id; details are re-read with a permission check.
    const socket = getSocket();
    const onUpdated = (event: { agentId?: unknown } | null) => {
      if (event?.agentId === agent.id) void load();
    };
    socket?.on(AGENT_ARCHIVE_UPDATED_EVENT, onUpdated);
    return () => {
      canceled = true;
      socket?.off(AGENT_ARCHIVE_UPDATED_EVENT, onUpdated);
    };
  }, [agent.id]);

  const openDeleteWorkspace = useCallback(() => setConfirmDelete(true), []);
  const closeConfirm = useCallback(() => setConfirmDelete(false), []);
  const confirmDeleteWorkspace = useCallback(async () => {
    try {
      dispatch({ type: "loaded", archive: await requestAgentArchiveWorkspaceDelete(agent.id) });
    } catch (err: unknown) {
      throw new Error(archiveRequestErrorMessage(err, formatMessage) ?? formatMessage({ id: "agent.archive.failed" }));
    }
  }, [agent.id, formatMessage]);

  const computer = archive?.machineName ?? formatMessage({ id: "agent.archive.unknownComputer" });
  const workspaceText = !archive
    ? formatMessage({ id: "agent.archive.workspace.unknown" })
    : archive.pendingOp
      ? formatMessage({ id: "agent.archive.workspace.deleting" }, { computer })
      : archive.workspaceState === "on_computer"
        ? formatMessage({ id: "agent.archive.workspace.onComputer" }, { computer })
        : archive.workspaceState === "deleted"
          ? formatMessage({ id: "agent.archive.workspace.deleted" })
          : formatMessage({ id: "agent.archive.workspace.unknown" });
  const archivedAtText = archive ? formatDate(archive.archivedAt, { dateStyle: "medium", timeStyle: "short" }) : "";
  const archivedBy = archive?.archivedByUserId ? members.find((member) => member.userId === archive.archivedByUserId) : undefined;
  const archivedByName = archivedBy ? archivedBy.displayName || archivedBy.name : null;
  const canDeleteWorkspace = canManage && Boolean(archive) && !archive?.pendingOp && archive?.workspaceState === "on_computer";

  return (
    <section
      aria-labelledby="agent-archive-section-title"
      className="px-(--surface-inset) py-4 border-t border-line-hairline"
      data-testid="agent-archive-section"
    >
      <h3 id="agent-archive-section-title" className="mb-3">
        <SectionEyebrow>{formatMessage({ id: "agent.archive.sectionTitle" })}</SectionEyebrow>
      </h3>
      {loadError && (
        <Banner intent="warning" density="sm">{formatMessage({ id: "agent.archive.loadFailed" })}</Banner>
      )}
      {/* DS PropertyList, stacked (labels above values) for the narrow profile
          column; the archive time is Space Mono. */}
      <DescriptionList className={loadError ? "mt-3" : undefined}>
        {archive && (
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agent.archive.archivedAt" })}</DescriptionTerm>
            <DescriptionDetails>
              <span>
                {archivedByName
                  ? formatMessage(
                      { id: "agent.archive.archivedAtBy" },
                      { date: <time key="date" dateTime={archive.archivedAt} className="font-mono text-mono-meta">{archivedAtText}</time>, name: archivedByName },
                    )
                  : <time dateTime={archive.archivedAt} className="font-mono text-mono-meta">{archivedAtText}</time>}
              </span>
            </DescriptionDetails>
          </DescriptionItem>
        )}
        <DescriptionItem>
          <DescriptionTerm>{formatMessage({ id: "agent.archive.workspaceLabel" })}</DescriptionTerm>
          <DescriptionDetails data-testid="agent-archive-workspace-state">{workspaceText}</DescriptionDetails>
          {archive?.waitingForComputer && (
            <dd className="m-0 text-caption text-foreground-hint">
              {formatMessage({ id: "agent.archive.waitingForComputer" }, { computer })}
            </dd>
          )}
        </DescriptionItem>
      </DescriptionList>
      {archive?.lastErrorCode && (
        <Banner intent="warning" density="sm" withIcon className="mt-3" data-testid="agent-archive-error">
          {formatMessage({
            id: !archive.pendingOp
              ? archiveErrorMessageId(archive.lastErrorCode)
              : archive.lastErrorCode === "ARCHIVE_DELETE_TIMED_OUT" ? "agent.archive.stillDeleting" : "agent.archive.retrying",
          }, { computer })}
        </Banner>
      )}
      {/* The trigger is an ordinary ink-outline action; the irreversible red
          button lives in the confirm dialog (DS Button › danger). */}
      {canDeleteWorkspace && (
        <div className="mt-3">
          <Button variant="outline" size="md" className="w-full" onClick={openDeleteWorkspace} data-testid="agent-archive-delete-workspace-button">
            {formatMessage({ id: "agent.archive.action.deleteWorkspace" })}
          </Button>
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.archive.action.deleteWorkspace" })}
          message={formatMessage({ id: "agent.archive.confirm.deleteWorkspace" }, { computer })}
          confirmLabel={formatMessage({ id: "agent.archive.action.deleteWorkspace" })}
          confirmVariant="danger"
          chromeLocale="active"
          onConfirm={confirmDeleteWorkspace}
          onClose={closeConfirm}
        />
      )}
    </section>
  );
}
