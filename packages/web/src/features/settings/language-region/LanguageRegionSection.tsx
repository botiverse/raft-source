import {
  ListRow,
  ListRowBody,
  ListRowGroup,
  ListRowTitle,
  Select,
  SelectContent,
  SelectIcon,
  SelectList,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
} from "@botiverse/raft-ui";
import { useCallback, useEffect, useMemo } from "react";
import { Clock, Languages } from "lucide-react";
import type { TimeFormatPreference } from "@botiverse/raft-shared";
import { useServerStore } from "../../../store/serverStore";
import AssistantSettingChanges from "../../../components/settings/AssistantSettingChanges";
import Banner from "../../../components/ui/Banner";
import { useIntl } from "react-intl";
import { useLocale } from "../../../i18n/LocaleProvider";
import { SUPPORTED_LOCALES, LOCALE_LABELS, htmlLangForLocale } from "../../../i18n/locale";
import type { Locale } from "../../../i18n/locale";
import { persistDisplayLanguage } from "../../../i18n/persistDisplayLanguage";
import SectionHeader from "../../../components/ui/SectionHeader";
import { ImmediateSaveStatus, apiErrorText, useImmediateSave } from "../../../components/settings/ImmediateSetting";
import {
  FOLLOW_DISPLAY_LANGUAGE_TARGET,
  getTimezoneOptions,
  getTranslationLanguageOptions,
  useTranslationStore,
} from "../../../store/translationStore";
import type { PreferredTranslationMode } from "../../../store/translationStore";
import { getSelectMenuOptions } from "../shared/selectOptions";
import { renderSelectItems } from "../shared/renderSelectItems";
import type { PublicTranslationSettingsContext } from "./publicTranslationSettingsContext";

/** What a personal assistant may change on this page, listed under it. */
const LANGUAGE_REGION_ASSISTANT_SETTINGS = ["displayLanguage", "preferredTimezone"] as const;

export function LanguageRegionSection({ publicContext }: { publicContext?: PublicTranslationSettingsContext }) {
  const currentServer = useServerStore((s) => s.current);
  const translationServerId = publicContext?.serverId ?? currentServer?.id;
  const settings = useTranslationStore((s) => s.settings);
  const settingsLoading = useTranslationStore((s) => s.settingsLoading);
  const settingsError = useTranslationStore((s) => s.settingsError);
  const loadSettings = useTranslationStore((s) => s.loadSettings);
  const updatePreferredLanguage = useTranslationStore((s) => s.updatePreferredLanguage);
  const updatePreferredTimezone = useTranslationStore((s) => s.updatePreferredTimezone);
  const updatePreferredTranslationMode = useTranslationStore((s) => s.updatePreferredTranslationMode);
  const updatePreferredTranslationDisplay = useTranslationStore((s) => s.updatePreferredTranslationDisplay);
  const updatePreferredTimeFormat = useTranslationStore((s) => s.updatePreferredTimeFormat);
  // Each choice here stands alone and applies the moment it is made (Raft DS ›
  // Forms, "Settings that apply at once"): one request per change and nothing
  // said once it is stored; on a failure the control shows the stored value
  // again (the translation store puts its value back; the display language is
  // put back here) and the failure appears under it.
  const displayLanguageSave = useImmediateSave();
  const translationModeSave = useImmediateSave();
  const translationTargetSave = useImmediateSave();
  const translationDisplaySave = useImmediateSave();
  const timezoneSave = useImmediateSave();
  const timeFormatSave = useImmediateSave();
  const translationTarget = settings.preferredLanguage ?? FOLLOW_DISPLAY_LANGUAGE_TARGET;
  const translationMode = settings.preferredTranslationMode;
  const translationDisplay = settings.preferredTranslationDisplay;
  const timezone = settings.preferredTimezone ?? "";
  const timeFormat = settings.effectiveTimeFormat === "24h" ? "24h" : "12h";

  // UI display language (app-chrome i18n) — distinct from the translation
  // target above. `locale` is the live client locale, and the select shows it.
  const { formatMessage } = useIntl();
  const { locale, setLocale } = useLocale();
  const displayLanguageOptions = useMemo(
    () => SUPPORTED_LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code], lang: htmlLangForLocale(code) })),
    [],
  );

  useEffect(() => {
    void loadSettings(translationServerId, publicContext);
  }, [loadSettings, publicContext, translationServerId]);

  const languageOptions = useMemo(
    () => getTranslationLanguageOptions(htmlLangForLocale(locale), formatMessage),
    [formatMessage, locale],
  );
  const timezoneOptions = useMemo(
    () => getTimezoneOptions(settings.effectiveTimezone, formatMessage),
    [formatMessage, settings.effectiveTimezone],
  );
  const hiddenTimezoneOptionValues = useMemo(
    () => [
      "",
      ...(!settings.preferredTimezone && settings.effectiveTimezone ? [settings.effectiveTimezone] : []),
    ],
    [settings.effectiveTimezone, settings.preferredTimezone],
  );
  // Keep `items` as the full collection so the trigger can resolve the current
  // value label; filter only the popup rows to preserve the old menu behavior.
  const languageMenuOptions = getSelectMenuOptions(languageOptions, translationTarget, { hideSelectedOption: true });
  const timezoneMenuOptions = getSelectMenuOptions(timezoneOptions, timezone, {
    hideSelectedOption: true,
    hiddenOptionValues: hiddenTimezoneOptionValues,
  });

  const languageFailure = useCallback(
    (error: unknown) => apiErrorText(error, formatMessage({ id: "settings.language.updateFailed" })),
    [formatMessage],
  );
  const dateTimeFailure = useCallback(
    (error: unknown) => apiErrorText(error, formatMessage({ id: "settings.dateTime.updateFailed" })),
    [formatMessage],
  );

  const runDisplayLanguageSave = displayLanguageSave.run;
  const handleDisplayLanguageChange = useCallback((next: string | null) => {
    if (next == null || next === locale) return;
    const previous = locale;
    void runDisplayLanguageSave(async () => {
      const result = await persistDisplayLanguage(next as Locale, setLocale);
      if (result === "failed") {
        setLocale(previous);
        throw new Error("display language not saved");
      }
    }, languageFailure);
  }, [languageFailure, locale, runDisplayLanguageSave, setLocale]);

  const runTranslationModeSave = translationModeSave.run;
  const handleTranslationModeChange = useCallback((next: PreferredTranslationMode) => {
    if (next === translationMode) return;
    void runTranslationModeSave(() => updatePreferredTranslationMode(next), languageFailure);
  }, [languageFailure, runTranslationModeSave, translationMode, updatePreferredTranslationMode]);

  const runTranslationTargetSave = translationTargetSave.run;
  const handleTranslationTargetChange = useCallback((next: string | null) => {
    if (next == null || next === translationTarget) return;
    void runTranslationTargetSave(
      () => updatePreferredLanguage(next === FOLLOW_DISPLAY_LANGUAGE_TARGET ? null : next),
      languageFailure,
    );
  }, [languageFailure, runTranslationTargetSave, translationTarget, updatePreferredLanguage]);

  const runTranslationDisplaySave = translationDisplaySave.run;
  const handleTranslationDisplayChange = useCallback((next: "translated" | "original" | "bilingual") => {
    if (next === translationDisplay) return;
    void runTranslationDisplaySave(() => updatePreferredTranslationDisplay(next), languageFailure);
  }, [languageFailure, runTranslationDisplaySave, translationDisplay, updatePreferredTranslationDisplay]);

  const runTimezoneSave = timezoneSave.run;
  const handleTimezoneChange = useCallback((next: string | null) => {
    if (next == null || next === timezone) return;
    void runTimezoneSave(() => updatePreferredTimezone(next || null), dateTimeFailure);
  }, [dateTimeFailure, runTimezoneSave, timezone, updatePreferredTimezone]);

  const runTimeFormatSave = timeFormatSave.run;
  const handleTimeFormatChange = useCallback((next: "12h" | "24h") => {
    if (next === timeFormat) return;
    void runTimeFormatSave(() => updatePreferredTimeFormat(next as TimeFormatPreference), dateTimeFailure);
  }, [dateTimeFailure, runTimeFormatSave, timeFormat, updatePreferredTimeFormat]);

  if (!translationServerId) return null;

  return (
    <>
      <div className="mb-6">
        <SectionHeader
          className="mb-3"
          icon={<Languages size={16} />}
          label={formatMessage({ id: "settings.language.sectionLabel" })}
        />

        {/* Settings rows (DS Forms › A setting's row; Jasper + cindyz, #triage:c95a5e53): every
            select and segmented control ends its row; under 32rem of the row's width it goes
            under the text, up to 24rem. On a wide row a select is as wide as its longest option
            (`fit`, 11-20rem). */}
        <ListRowGroup className="@container" data-testid="language-region-card">
          <ListRow id="display-language" variant="plain" interactive={false} className="@max-lg:flex-wrap">
            <ListRowBody>
              <ListRowTitle id="display-language-label">{formatMessage({ id: "settings.language.displayLanguageTitle" })}</ListRowTitle>
              <ImmediateSaveStatus feedback={displayLanguageSave.feedback} testId="display-language-status" />
            </ListRowBody>
            <div className="shrink-0 @max-lg:basis-full">
              <Select
                value={locale}
                onValueChange={handleDisplayLanguageChange}
                disabled={displayLanguageSave.saving || settingsLoading}
                items={displayLanguageOptions}
              >
                <SelectTrigger fit className="@max-lg:w-full @max-lg:max-w-sm" aria-labelledby="display-language-label" data-testid="display-language-select">
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {renderSelectItems(displayLanguageOptions)}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
          </ListRow>
          <ListRow id="translation-mode" variant="plain" interactive={false} className="@max-lg:flex-wrap">
            <ListRowBody>
              <ListRowTitle>{formatMessage({ id: "settings.language.translationMode" })}</ListRowTitle>
              {/* The menu action needs the server gate AND a configured provider;
                  without this line the mode control silently does nothing. */}
              {!settingsLoading && !settings.available ? (
                <div className="text-caption font-bold text-warning-strong" data-testid="translation-unavailable-notice">
                  {formatMessage({
                    id: !settings.serverTranslationEnabled
                      ? settings.canManageServerTranslation
                        ? "settings.language.translationServerOffAdmin"
                        : "settings.language.translationServerOff"
                      : "settings.language.translationProviderMissing",
                  })}
                </div>
              ) : null}
              <ImmediateSaveStatus feedback={translationModeSave.feedback} testId="translation-mode-status" />
            </ListRowBody>
            <div className="shrink-0 @max-lg:basis-full">
              <SegmentedControl<PreferredTranslationMode>
                value={translationMode}
                aria-label={formatMessage({ id: "settings.language.translationModeAria" })}
                onValueChange={handleTranslationModeChange}
                disabled={translationModeSave.saving || settingsLoading}
              >
                <SegmentedControlItem value="auto" data-testid="translation-mode-auto">
                  <SegmentedControlLabel>{formatMessage({ id: "settings.language.modeAuto" })}</SegmentedControlLabel>
                </SegmentedControlItem>
                <SegmentedControlItem value="manual" data-testid="translation-mode-manual">
                  <SegmentedControlLabel>{formatMessage({ id: "settings.language.modeManual" })}</SegmentedControlLabel>
                </SegmentedControlItem>
                <SegmentedControlItem value="off" data-testid="translation-mode-off">
                  <SegmentedControlLabel>{formatMessage({ id: "settings.language.modeOff" })}</SegmentedControlLabel>
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
          </ListRow>
          {translationMode !== "off" ? (
            <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
              <ListRowBody>
                <ListRowTitle id="translation-target-label">{formatMessage({ id: "settings.language.translationTarget" })}</ListRowTitle>
                <ImmediateSaveStatus feedback={translationTargetSave.feedback} testId="translation-target-status" />
              </ListRowBody>
              {/* "Same as display language": the display language is the select in the row above. */}
              <div className="shrink-0 @max-lg:basis-full">
                <Select
                  value={translationTarget}
                  onValueChange={handleTranslationTargetChange}
                  disabled={translationTargetSave.saving || settingsLoading}
                  items={languageOptions}
                >
                  <SelectTrigger fit className="@max-lg:w-full @max-lg:max-w-sm" aria-labelledby="translation-target-label" data-testid="translation-target-select">
                    <SelectValue placeholder={formatMessage({ id: "settings.language.preferredLanguagePlaceholder" })} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                      {renderSelectItems(languageMenuOptions)}
                    </SelectList>
                  </SelectContent>
                </Select>
              </div>
            </ListRow>
          ) : null}
          {translationMode !== "off" ? (
            <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
              <ListRowBody>
                <ListRowTitle>{formatMessage({ id: "settings.language.defaultView" })}</ListRowTitle>
                <ImmediateSaveStatus feedback={translationDisplaySave.feedback} testId="translation-display-status" />
              </ListRowBody>
              <div className="shrink-0 @max-lg:basis-full">
                <SegmentedControl<"translated" | "original" | "bilingual">
                  value={translationDisplay}
                  aria-label={formatMessage({ id: "settings.language.defaultViewAria" })}
                  onValueChange={handleTranslationDisplayChange}
                  disabled={translationDisplaySave.saving || settingsLoading}
                >
                  <SegmentedControlItem value="translated" data-testid="translation-display-translated">
                    <SegmentedControlLabel>{formatMessage({ id: "settings.language.displayTranslated" })}</SegmentedControlLabel>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="original" data-testid="translation-display-original">
                    <SegmentedControlLabel>{formatMessage({ id: "settings.language.displayOriginal" })}</SegmentedControlLabel>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="bilingual" data-testid="translation-display-bilingual">
                    <SegmentedControlLabel>{formatMessage({ id: "settings.language.displayBilingual" })}</SegmentedControlLabel>
                  </SegmentedControlItem>
                </SegmentedControl>
              </div>
            </ListRow>
          ) : null}
        </ListRowGroup>
        {settingsError && (
          <Banner intent="warning" density="sm" className="mt-3">
            {settingsError}
          </Banner>
        )}
      </div>

      <div className="mb-6">
        <SectionHeader
          className="mb-3"
          icon={<Clock size={16} />}
          label={formatMessage({ id: "settings.dateTime.sectionLabel" })}
        />

        <ListRowGroup className="@container" data-testid="date-time-card">
          <ListRow id="timezone" variant="plain" interactive={false} className="@max-lg:flex-wrap">
            <ListRowBody>
              <ListRowTitle id="timezone-label">{formatMessage({ id: "settings.dateTime.timezone" })}</ListRowTitle>
              <ImmediateSaveStatus feedback={timezoneSave.feedback} testId="timezone-status" />
            </ListRowBody>
            <div className="shrink-0 @max-lg:basis-full">
              <Select
                value={timezone}
                onValueChange={handleTimezoneChange}
                disabled={timezoneSave.saving || settingsLoading}
                items={timezoneOptions}
              >
                <SelectTrigger fit className="@max-lg:w-full @max-lg:max-w-sm" aria-labelledby="timezone-label" data-testid="timezone-select">
                  <SelectValue placeholder={formatMessage({ id: "settings.dateTime.timezonePlaceholder" })} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {renderSelectItems(timezoneMenuOptions)}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
          </ListRow>
          <ListRow id="time-format" variant="plain" interactive={false} className="@max-lg:flex-wrap">
            <ListRowBody>
              <ListRowTitle>{formatMessage({ id: "settings.dateTime.timeFormat" })}</ListRowTitle>
              <ImmediateSaveStatus feedback={timeFormatSave.feedback} testId="time-format-status" />
            </ListRowBody>
            <div className="shrink-0 @max-lg:basis-full">
              <SegmentedControl<"12h" | "24h">
                value={timeFormat}
                aria-label={formatMessage({ id: "settings.dateTime.timeFormatAria" })}
                onValueChange={handleTimeFormatChange}
                disabled={timeFormatSave.saving || settingsLoading}
              >
                <SegmentedControlItem value="12h" data-testid="time-format-12h">
                  <SegmentedControlLabel>{formatMessage({ id: "settings.dateTime.formatTwelveHour" })}</SegmentedControlLabel>
                </SegmentedControlItem>
                <SegmentedControlItem value="24h" data-testid="time-format-24h">
                  <SegmentedControlLabel>{formatMessage({ id: "settings.dateTime.formatTwentyFourHour" })}</SegmentedControlLabel>
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
          </ListRow>
        </ListRowGroup>
        {settingsError && (
          <Banner intent="warning" density="sm" className="mt-3">
            {settingsError}
          </Banner>
        )}
      </div>
      {publicContext ? null : <AssistantSettingChanges settings={LANGUAGE_REGION_ASSISTANT_SETTINGS} />}
    </>
  );
}
