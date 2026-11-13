import { CreateChannelDialog } from "../../components/channel/DeferredCreateChannelDialog";
import { CreateJointChannelDialog } from "../../components/channel/DeferredCreateJointChannelDialog";
import ConfirmDialog from "../../components/ConfirmDialog";
import LeaveChannelConfirmDialog from "../../components/channel/LeaveChannelConfirmDialog";
import { AgentArchiveDialog } from "../../components/agentArchive/AgentArchiveDialog";
import SidebarSectionDialog from "../../components/layout/SidebarSectionDialog";
import SidebarSectionAddConversationsDialog from "../../components/layout/SidebarSectionAddConversationsDialog";
import type { SidebarData } from "./hooks/useSidebarData";
import type { SidebarViewState } from "./hooks/useSidebarViewState";
import type { SidebarMenuActions } from "./hooks/useSidebarMenuActions";

/**
 * The Sidebar's dialogs: create channel / joint channel, the delete, archive
 * and leave confirmations, and the custom-section dialogs.
 */
export function SidebarDialogs({ data, view, menuActions }: {
  data: SidebarData;
  view: SidebarViewState;
  menuActions: SidebarMenuActions;
}) {
  const {
    formatMessage, allAgents, showCreateChannel, showCreateJointChannel, externalChannelsEnabled,
  } = data;
  const {
    sectionDialog, deleteSectionConfirm, deleteConfirm, archiveConfirm, leaveConfirm, canCreateJointChannel,
  } = view;
  const {
    closeCreateChannelDialog, closeCreateJointChannelDialog, closeDeleteConfirm, confirmDelete,
    closeArchiveConfirm, confirmArchive, closeLeaveConfirm, confirmLeave, closeSectionDialog,
    sectionAddCandidates, submitCreateSection, editSectionConversations, submitAddToSection, submitEditSection, closeDeleteSectionConfirm,
    confirmDeleteSection,
  } = menuActions;
  return (
    <>
      {showCreateChannel && (
        <CreateChannelDialog
          onClose={closeCreateChannelDialog}
        />
      )}

      {/* The Joint Channels / External section's create entries: with
          external_channels_v1 on, Create Channel with External chosen;
          off, the Joint Channel dialog. */}
      {showCreateJointChannel && canCreateJointChannel && (externalChannelsEnabled ? (
        <CreateChannelDialog
          prefilledVisibility="external"
          inviteEntry={showCreateJointChannel}
          onClose={closeCreateJointChannelDialog}
        />
      ) : (
        <CreateJointChannelDialog onClose={closeCreateJointChannelDialog} />
      ))}

      {deleteConfirm?.type === "agent" && (() => {
        const agent = allAgents.find((candidate) => candidate.id === deleteConfirm.id);
        return agent ? <AgentArchiveDialog agent={agent} onClose={closeDeleteConfirm} /> : null;
      })()}
      {deleteConfirm?.type === "channel" && (() => {
        const label = {
          title: formatMessage({ id: "layout.sidebar.deleteChannelTitle" }),
          confirmLabel: formatMessage({ id: "layout.sidebar.deleteChannelTitle" }),
          message: formatMessage({ id: "layout.sidebar.deleteChannelMessage" }, { name: deleteConfirm.name }),
        };
        return (
          <ConfirmDialog
            chromeLocale="active"
            title={label.title}
            message={label.message}
            confirmLabel={label.confirmLabel}
            loadingLabel={formatMessage({ id: "layout.sidebar.deletingLabel" })}
            onConfirm={confirmDelete}
            onClose={closeDeleteConfirm}
          />
        );
      })()}

      {archiveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "layout.sidebar.archiveChannelTitle" })}
          message={formatMessage({ id: "layout.sidebar.archiveChannelMessage" }, { name: archiveConfirm.name })}
          confirmLabel={formatMessage({ id: "layout.sidebar.archiveChannelConfirm" })}
          loadingLabel={formatMessage({ id: "layout.sidebar.archivingLabel" })}
          confirmVariant="warning"
          onConfirm={confirmArchive}
          onClose={closeArchiveConfirm}
        />
      )}

      {leaveConfirm && (
        <LeaveChannelConfirmDialog
          channelId={leaveConfirm.id}
          channelName={leaveConfirm.name}
          confirmTestId="sidebar-leave-channel-confirm"
          onConfirm={confirmLeave}
          onClose={closeLeaveConfirm}
        />
      )}

      {sectionDialog?.mode === "create" && (
        <SidebarSectionDialog
          title={formatMessage({ id: "layout.sidebar.newSectionTitle" })}
          submitLabel={formatMessage({ id: "layout.sidebar.createSectionAndAdd" })}
          stepLabel={formatMessage({ id: "layout.sidebar.createSectionStep" })}
          onSubmit={submitCreateSection}
          onClose={closeSectionDialog}
        />
      )}

      {sectionDialog?.mode === "add" && (
        <SidebarSectionAddConversationsDialog
          sectionName={sectionDialog.sectionName}
          candidates={sectionAddCandidates}
          initialSelectedKeys={sectionDialog.initialKeys}
          onSubmit={submitAddToSection}
          onClose={closeSectionDialog}
        />
      )}

      {sectionDialog?.mode === "edit" && (
        <SidebarSectionDialog
          title={formatMessage({ id: "layout.sidebar.editSectionTitle" })}
          initialName={sectionDialog.section.name}
          initialEmoji={sectionDialog.section.emoji ?? ""}
          submitLabel={formatMessage({ id: "layout.sidebar.saveSection" })}
          conversations={editSectionConversations}
          onSubmit={submitEditSection}
          onClose={closeSectionDialog}
        />
      )}

      {deleteSectionConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "layout.sidebar.deleteSection" })}
          message={formatMessage(
            { id: "layout.sidebar.deleteSectionMessage" },
            { name: deleteSectionConfirm.name },
          )}
          confirmLabel={formatMessage({ id: "layout.sidebar.deleteSection" })}
          loadingLabel={formatMessage({ id: "layout.sidebar.deletingLabel" })}
          onConfirm={confirmDeleteSection}
          onClose={closeDeleteSectionConfirm}
        />
      )}
    </>
  );
}
