import { Button, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import type { Ref } from "react";
import { LogOut } from "lucide-react";
import { useAuthStore } from "../../../store/authStore";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";

/** `headingRef`: the section's heading (level 3, under the settings panel's h2), focusable from script (tabIndex -1) for focus that has nowhere nearer to go. */
export function AccountSignOutSection({ headingRef }: { headingRef?: Ref<HTMLDivElement> } = {}) {
  const { formatMessage } = useIntl();
  const logout = useAuthStore((s) => s.logout);
  const [showConfirm, setShowConfirm] = useState(false);
  const handleOpenConfirm = useCallback(() => setShowConfirm(true), []);
  const handleCloseConfirm = useCallback(() => setShowConfirm(false), []);
  const handleConfirmLogout = useCallback(() => { logout(); }, [logout]);

  return (
    <div id="sign-out" className="mb-6">
      <div ref={headingRef} role="heading" aria-level={3} tabIndex={-1} className="mb-3 rounded-control outline-none focus-visible:shadow-focus">
        <SectionHeader
          icon={<LogOut size={16} />}
          label={formatMessage({ id: "settings.session.sectionLabel" })}
        />
      </div>

      {/* A settings row (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220): Log
          Out at its end, under the text where the row is under 32rem wide. */}
      <ListRowGroup className="@container">
        <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
          <ListRowBody>
            <ListRowTitle>{formatMessage({ id: "settings.session.logOutTitle" })}</ListRowTitle>
            <ListRowDescription wrap>{formatMessage({ id: "settings.session.logOutDescription" })}</ListRowDescription>
          </ListRowBody>
          <div className="shrink-0 @max-lg:basis-full">
            <Button
              variant="warning" size="md"
              type="button"
              onClick={handleOpenConfirm}
              data-testid="account-logout"
            >
              {formatMessage({ id: "settings.session.logOutAction" })}
            </Button>
          </div>
        </ListRow>
      </ListRowGroup>

      {showConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "settings.session.confirmTitle" })}
          message={formatMessage({ id: "settings.session.confirmMessage" })}
          confirmLabel={formatMessage({ id: "settings.session.confirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.session.confirmLoadingLabel" })}
          confirmVariant="warning"
          confirmTestId="account-logout-confirm-button"
          onConfirm={handleConfirmLogout}
          onClose={handleCloseConfirm}
        />
      )}
    </div>
  );
}
