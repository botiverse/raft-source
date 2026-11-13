import { ListRow, ListRowBody, ListRowDescription, ListRowGroup } from "@botiverse/raft-ui";
import { useCallback, useState, useEffect } from "react";
import { Mail } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import ConfirmDialog from "../../../components/ConfirmDialog";
import api from "../../../api/client";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import { PendingInviteRow } from "../../../components/settings/PendingInviteRow";
import type { PendingInvite } from "../shared/inviteRecords";

export function InvitesSection() {
  const { formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const serverId = current?.id;
  const { capabilities } = useServerPermissions();

  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PendingInvite | null>(null);

  const canInvite = capabilities.inviteMembers;

  const loadInvites = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/servers/${serverId}/invites`);
      setInvites(data);
    } catch {
      // Ignore errors
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  // Reload when the active server id (via `loadInvites`) or permission changes.
  useEffect(() => {
    if (serverId && canInvite) {
      void loadInvites();
    }
  }, [canInvite, loadInvites, serverId]);

  const handleRevoke = useCallback(async (inviteId: string) => {
    if (!serverId) return;
    try {
      await api.delete(`/servers/${serverId}/invites/${inviteId}`);
      await loadInvites();
    } catch {
      // Ignore
    }
  }, [loadInvites, serverId]);

  const handleConfirmRevoke = useCallback(
    () => (revokeTarget ? handleRevoke(revokeTarget.id) : undefined),
    [handleRevoke, revokeTarget],
  );
  const handleCloseRevoke = useCallback(() => setRevokeTarget(null), []);

  if (!canInvite) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Mail size={16} />}
        label={formatMessage({ id: "settings.invites.sectionLabel" })}
        count={invites.length > 0 ? invites.length : null}
      />

      {/* A row per pending invite in a ListRowGroup, which draws the hairlines
          (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220). */}
      {invites.length > 0 || !loading ? (
        <ListRowGroup data-testid="invites-rows">
          {invites.length > 0 ? (
            invites.map((invite) => (
              <PendingInviteRow key={invite.id} invite={invite} onRequestRevoke={setRevokeTarget} />
            ))
          ) : (
            <ListRow variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowDescription wrap>{formatMessage({ id: "settings.invites.emptyState" })}</ListRowDescription>
              </ListRowBody>
            </ListRow>
          )}
        </ListRowGroup>
      ) : null}

      {revokeTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.invites.confirmTitle" })}
          message={formatMessage({ id: "settings.invites.confirmMessage" }, { email: revokeTarget.invitedEmail })}
          confirmLabel={formatMessage({ id: "settings.invites.confirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.invites.revoking" })}
          onConfirm={handleConfirmRevoke}
          onClose={handleCloseRevoke}
        />
      )}
    </div>
  );
}
