import { useCallback, useState, useId } from "react";
import { Eye } from "lucide-react";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import { ImmediateSwitchRow, apiErrorText, useImmediateSave } from "../../../components/settings/ImmediateSetting";
import { useChannelStore } from "../../../store/channelStore";

export function SystemChannelsSection() {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const { capabilities } = useServerPermissions();
  const channels = useChannelStore((s) => s.channels);
  const channelsLoading = useChannelStore((s) => s.loading);
  const restoreAllChannel = useChannelStore((s) => s.restoreAllChannel);
  const hideAllChannel = useChannelStore((s) => s.hideAllChannel);
  const allChannel = channels.find((channel) => channel.name === "all");
  const currentAllChannelHidden = !allChannel;
  const showSystemChannelSettings = capabilities.changeChannelVisibility && !channelsLoading;
  // The switch shows the change while it is on its way, then the channel list's answer.
  const [pendingAllChannelHidden, setPendingAllChannelHidden] = useState<boolean | null>(null);
  const hideAllSave = useImmediateSave();
  // Hiding #all takes it away from everyone, so it is confirmed first, with the
  // same confirmation as the channel's own settings; bringing it back is at once.
  const [confirmHideAll, setConfirmHideAll] = useState(false);

  const runHideAllSave = hideAllSave.run;
  const saveAllChannelHidden = useCallback((checked: boolean) => {
    setPendingAllChannelHidden(checked);
    return runHideAllSave(
      // Previously went through the generic channel-visibility PATCH. The
      // server now refuses #all on that field; hiding has its own endpoint,
      // and it needs no channel id.
      () => (checked ? hideAllChannel() : restoreAllChannel()),
      (err) => apiErrorText(err, formatMessage({ id: "settings.systemChannels.failedUpdate" })),
    ).finally(() => setPendingAllChannelHidden(null));
  }, [formatMessage, hideAllChannel, restoreAllChannel, runHideAllSave]);
  const handleAllChannelHiddenChange = useCallback((checked: boolean) => {
    if (checked) {
      setConfirmHideAll(true);
      return;
    }
    void saveAllChannelHidden(false);
  }, [saveAllChannelHidden]);
  const handleConfirmHideAll = useCallback(async () => {
    await saveAllChannelHidden(true);
  }, [saveAllChannelHidden]);
  const closeConfirmHideAll = useCallback(() => setConfirmHideAll(false), []);

  if (!showSystemChannelSettings) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Eye size={16} />}
        label={formatMessage({ id: "settings.systemChannels.sectionLabel" })}
      />
      <ImmediateSwitchRow
        idPrefix={idPrefix}
        testId="hide-all-channel-setting"
        title={formatMessage({ id: "settings.systemChannels.hideAllTitle" })}
        description={formatMessage({ id: "settings.systemChannels.hideAllDescription" })}
        checked={pendingAllChannelHidden ?? currentAllChannelHidden}
        disabled={hideAllSave.saving}
        onCheckedChange={handleAllChannelHiddenChange}
        feedback={hideAllSave.feedback}
      />
      {confirmHideAll ? (
        <ConfirmDialog
          title={formatMessage({ id: "channel.edit.hideAll" })}
          message={formatMessage({ id: "channel.edit.confirmHideAll" })}
          confirmLabel={formatMessage({ id: "channel.edit.confirmHideAllAction" })}
          loadingLabel={formatMessage({ id: "channel.edit.updating" })}
          confirmVariant="warning"
          confirmTestId="hide-all-channel-confirm"
          onConfirm={handleConfirmHideAll}
          onClose={closeConfirmHideAll}
        />
      ) : null}
    </div>
  );
}
