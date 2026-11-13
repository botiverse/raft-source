import { useCallback, useEffect, useId } from "react";
import { Languages } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import Banner from "../../../components/ui/Banner";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import { ImmediateSwitchRow, apiErrorText, useImmediateSave } from "../../../components/settings/ImmediateSetting";
import { useTranslationStore } from "../../../store/translationStore";
import { showUndoToast } from "./showUndoToast";

export function ServerTranslationSection() {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const currentServer = useServerStore((s) => s.current);
  const settings = useTranslationStore((s) => s.settings);
  const settingsLoading = useTranslationStore((s) => s.settingsLoading);
  const settingsError = useTranslationStore((s) => s.settingsError);
  const loadSettings = useTranslationStore((s) => s.loadSettings);
  const updateServerTranslationEnabled = useTranslationStore((s) => s.updateServerTranslationEnabled);
  // The translation store applies the change at once and puts the old value
  // back when the request fails, so the switch reads the store.
  const enabledSave = useImmediateSave();
  const enabled = settings.serverTranslationEnabled;

  useEffect(() => {
    void loadSettings(currentServer?.id);
  }, [currentServer?.id, loadSettings]);

  const runEnabledSave = enabledSave.run;
  const saveEnabled = useCallback((checked: boolean) => runEnabledSave(
    () => updateServerTranslationEnabled(checked),
    (err) => apiErrorText(err, formatMessage({ id: "settings.serverTranslation.failedUpdate" })),
  ), [formatMessage, runEnabledSave, updateServerTranslationEnabled]);
  // Turning translation off stops it for every member, and it can be turned
  // back on: it applies at once with Undo on a toast. Turning it on needs none.
  const handleEnabledChange = useCallback((checked: boolean) => {
    const serverId = useServerStore.getState().current?.id;
    void saveEnabled(checked).then((saved) => {
      if (!saved || checked || !serverId) return;
      showUndoToast({
        title: formatMessage({ id: "settings.serverTranslation.turnedOff" }),
        serverId,
        formatMessage,
        undo: () => void saveEnabled(true),
      });
    });
  }, [formatMessage, saveEnabled]);

  if (!currentServer) return null;

  const showProviderWarning = enabled && !settings.providerAvailable;
  const footer = showProviderWarning || settingsError ? (
    <div className="stack-y-2">
      {showProviderWarning && (
        <Banner intent="warning" density="sm">
          {formatMessage({ id: "settings.serverTranslation.providerWarning" })}
        </Banner>
      )}
      {settingsError && (
        <Banner intent="warning" density="sm">{settingsError}</Banner>
      )}
    </div>
  ) : null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Languages size={16} />}
        label={formatMessage({ id: "settings.serverTranslation.sectionLabel" })}
      />
      <ImmediateSwitchRow
        idPrefix={idPrefix}
        testId="server-translation-setting"
        title={formatMessage({ id: "settings.serverTranslation.enableTitle" })}
        description={formatMessage({ id: "settings.serverTranslation.enableDescription" })}
        checked={enabled}
        disabled={enabledSave.saving || settingsLoading || !settings.canManageServerTranslation}
        onCheckedChange={handleEnabledChange}
        feedback={enabledSave.feedback}
        footer={footer}
      />
    </div>
  );
}
