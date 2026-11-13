import { useCallback, useState, useId } from "react";
import { Users } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import { ImmediateSwitchRow, apiErrorText, useImmediateSave } from "../../../components/settings/ImmediateSetting";
import { showUndoToast } from "./showUndoToast";

export function MemberPermissionsSection() {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const server = useServerStore((s) => s.current);
  const updateServerProfile = useServerStore((s) => s.updateServerProfile);
  const { capabilities } = useServerPermissions();
  const canEdit = capabilities.editServerSettings;
  const storedHideHumans = server?.hideHumansFromMembers ?? false;
  // The switch shows the change while it is on its way, then the server's value.
  const [pendingHideHumans, setPendingHideHumans] = useState<boolean | null>(null);
  const hideHumansSave = useImmediateSave();

  const runHideHumansSave = hideHumansSave.run;
  const saveHideHumans = useCallback((checked: boolean) => {
    setPendingHideHumans(checked);
    return runHideHumansSave(
      () => updateServerProfile({ hideHumansFromMembers: checked }),
      (err) => apiErrorText(err, formatMessage({ id: "settings.memberPermissions.failedUpdate" })),
    ).finally(() => setPendingHideHumans(null));
  }, [formatMessage, runHideHumansSave, updateServerProfile]);
  // Hiding the directory changes what every member sees, and it can be turned
  // back: it applies at once with Undo on a toast (Raft DS › Feedback,
  // "Confirming"). Showing it again needs no Undo.
  const handleHideHumansChange = useCallback((checked: boolean) => {
    const serverId = useServerStore.getState().current?.id;
    void saveHideHumans(checked).then((saved) => {
      if (!saved || !checked || !serverId) return;
      showUndoToast({
        title: formatMessage({ id: "settings.memberPermissions.hideHumansApplied" }),
        serverId,
        formatMessage,
        undo: () => void saveHideHumans(false),
      });
    });
  }, [formatMessage, saveHideHumans]);

  if (!server) return null;

  return (
    <div id="member-permissions" className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Users size={16} />}
        label={formatMessage({ id: "settings.memberPermissions.sectionLabel" })}
      />
      <ImmediateSwitchRow
        idPrefix={idPrefix}
        testId="hide-humans-setting"
        title={formatMessage({ id: "settings.memberPermissions.hideHumansTitle" })}
        description={formatMessage({ id: "settings.memberPermissions.hideHumansDescription" })}
        checked={pendingHideHumans ?? storedHideHumans}
        disabled={!canEdit || hideHumansSave.saving}
        onCheckedChange={handleHideHumansChange}
        feedback={hideHumansSave.feedback}
      />
    </div>
  );
}
