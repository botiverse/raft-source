/**
 * Settings › Account › Danger zone: Delete Account (#triage:c3d9bd7c,
 * #triage:d10ace06), the last thing on the page (Forms: danger zone). Its
 * button opens the
 * Delete Account page, /s/<slug>/settings/account/delete (DeleteAccountPage),
 * keeping the query (the App's embed params).
 */
import { AlertTriangle, Trash2 } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";

import SectionHeader from "../../../components/ui/SectionHeader";
import { useServerStore } from "../../../store/serverStore";
import { DangerActionRow } from "../shared/DangerActionRow";

export function DeleteAccountSection() {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((state) => state.current?.slug ?? null);
  const navigate = useNavigate();
  const { search } = useLocation();
  const handleOpen = useCallback(() => {
    if (serverSlug) navigate(`/s/${encodeURIComponent(serverSlug)}/settings/account/delete${search}`);
  }, [navigate, search, serverSlug]);

  if (!serverSlug) return null;
  return (
    <div id="delete-account" className="mb-6" data-testid="account-deletion-section">
      <SectionHeader
        className="mb-3"
        icon={<AlertTriangle size={16} />}
        label={formatMessage({ id: "settings.dangerZone.sectionLabel" })}
      />
      <DangerActionRow
        testId="account-deletion-card"
        actionTestId="account-deletion-open"
        title={formatMessage({ id: "accountDeletion.rowTitle" })}
        description={formatMessage({ id: "accountDeletion.rowDescription" })}
        actionLabel={formatMessage({ id: "accountDeletion.action" })}
        actionIcon={<Trash2 size={14} />}
        onAction={handleOpen}
      />
    </div>
  );
}
