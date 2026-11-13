import { useCallback, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { useAuthStore } from "../../../store/authStore";
import { requestServerSelection } from "../../../utils/serverSelectionRequest";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import DeleteServerConfirmDialog from "../../../components/settings/DeleteServerConfirmDialog";
import { DangerActionRow } from "../shared/DangerActionRow";
import { MemberRemovalImpactNote } from "../../../components/member/MemberRemovalImpactNote";
import { useMemberRemovalImpact } from "../../../components/member/useMemberRemovalImpact";

// Owner sees Delete Server (destructive).
// Admin/member see Leave Server (non-destructive, warning level).
export function DangerZoneSection() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const leaveServer = useServerStore((s) => s.leaveServer);
  const { isOwner, role } = useServerPermissions();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  const handleCloseDelete = useCallback(() => setShowDeleteConfirm(false), []);

  const handleLeave = useCallback(async () => {
    requestServerSelection();
    await leaveServer();
  }, [leaveServer]);

  const handleOpenLeave = useCallback(() => setShowLeaveConfirm(true), []);
  const handleCloseLeave = useCallback(() => setShowLeaveConfirm(false), []);
  const handleOpenDelete = useCallback(() => setShowDeleteConfirm(true), []);

  if (!server) return null;
  const canLeave = role === "admin" || role === "member" || role === "guest";

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<AlertTriangle size={16} />}
        label={formatMessage({ id: "settings.dangerZone.sectionLabel" })}
      />

      {/* An owner can't leave and only an owner deletes: one row or the other. */}
      {canLeave && (
        <DangerActionRow
          id="leave-server"
          testId="server-danger-leave-card"
          actionTestId="server-danger-leave-button"
          actionVariant="warning"
          title={formatMessage({ id: "settings.dangerZone.leaveServerTitle" })}
          description={formatMessage({ id: "settings.dangerZone.leaveServerDescription" })}
          actionLabel={formatMessage({ id: "settings.dangerZone.leaveServer" })}
          onAction={handleOpenLeave}
        />
      )}

      {isOwner && (
        <DangerActionRow
          testId="server-danger-delete-card"
          actionTestId="server-danger-delete-button"
          title={formatMessage({ id: "settings.dangerZone.deleteServerTitle" })}
          description={formatMessage({ id: "settings.dangerZone.deleteServerDescription" })}
          actionLabel={formatMessage({ id: "settings.dangerZone.deleteServer" })}
          actionIcon={<Trash2 size={14} />}
          onAction={handleOpenDelete}
        />
      )}

      {showLeaveConfirm && (
        <LeaveServerConfirmDialog
          serverId={server.id}
          serverName={server.name}
          isGuest={role === "guest"}
          onConfirm={handleLeave}
          onClose={handleCloseLeave}
        />
      )}

      {showDeleteConfirm && <DeleteServerConfirmDialog onClose={handleCloseDelete} />}
    </div>
  );
}

/**
 * Leave server: also says which Computers you attached go offline (#13527),
 * read with your own member id when it opens. A Guest attaches none, so
 * nothing is read. The confirm waits for the read, which gives up after a few
 * seconds, and stays available when it fails.
 */
function LeaveServerConfirmDialog({
  serverId,
  serverName,
  isGuest,
  onConfirm,
  onClose,
}: {
  serverId: string;
  serverName: string;
  isGuest: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const userId = useAuthStore((s) => s.user?.id);
  const impact = useMemberRemovalImpact(serverId, isGuest ? null : userId);
  return (
    <ConfirmDialog
      chromeLocale="active"
      title={formatMessage({ id: "settings.dangerZone.leaveServerTitle" })}
      message={(
        <>
          {formatMessage({ id: "settings.dangerZone.leaveConfirmMessage" }, { serverName })}
          <MemberRemovalImpactNote state={impact} banner />
        </>
      )}
      confirmLabel={formatMessage({ id: "settings.dangerZone.leaveServerConfirm" })}
      loadingLabel={formatMessage({ id: "settings.dangerZone.leaving" })}
      confirmVariant="warning"
      confirmDisabled={impact.kind === "loading"}
      confirmTestId="server-leave-confirm-button"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
