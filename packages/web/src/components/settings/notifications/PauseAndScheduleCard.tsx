// Settings › Notifications › Pause and schedule (design §4.3 item 2): pause
// for a while, and daily quiet hours in the browser's time zone. Account-wide:
// the server applies them on every device.

import { useCallback, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { Moon } from "lucide-react";
import {
  Button,
  Input,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@botiverse/raft-ui";
import type { NotificationQuietHours } from "@botiverse/raft-shared";
import type { MessageId } from "../../../i18n/messages";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import { detectBrowserTimezone } from "../../../utils/timeFormatting";
import { PAUSE_PRESETS, pausedUntilForPreset } from "../../../notifications/pause";
import type { PausePreset } from "../../../notifications/pause";
import { useNotificationSettingsStore } from "../../../store/notificationSettingsStore";
import type { AccountNotificationSettingsPatch } from "../../../notifications/notificationApi";
import { usePausedUntil } from "../../notifications/PausedNotificationsIndicator";
import Banner from "../../ui/Banner";
import SectionHeader from "../../ui/SectionHeader";

const PRESET_LABEL: Record<PausePreset, MessageId> = {
  "30m": "settings.notifications.pause.30m",
  "1h": "settings.notifications.pause.1h",
  "2h": "settings.notifications.pause.2h",
  tomorrow: "settings.notifications.pause.tomorrow",
};

type PauseChoice = PausePreset | "custom";

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function browserTimeZone(): string {
  try {
    return detectBrowserTimezone() || "UTC";
  } catch {
    return "UTC";
  }
}

/** `datetime-local` value for a Date in local time. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A quiet-hours time: typed into a local draft and saved once, on blur or
 * Enter (a time field changes on every segment: 0 → 09 → 09:3 → 09:30). It
 * stays enabled while a save is in flight, so it never drops focus mid-edit;
 * while not being edited it follows the saved value.
 */
function QuietTimeInput({ minutes, onCommit, disabled, testId }: {
  minutes: number;
  onCommit: (minutes: number) => void;
  disabled: boolean;
  testId: string;
}) {
  const saved = minutesToTime(minutes);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = useCallback(() => {
    if (draft === null) return;
    const next = timeToMinutes(draft);
    setDraft(null);
    if (next !== null && next !== minutes) onCommit(next);
  }, [draft, minutes, onCommit]);
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value), []);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setDraft(null);
  }, [commit]);
  return (
    <Input
      type="time"
      value={draft ?? saved}
      onChange={handleChange}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      className="w-36"
      data-testid={testId}
    />
  );
}

export function PauseAndScheduleCard() {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const account = useNotificationSettingsStore((s) => s.account);
  const patchAccount = useNotificationSettingsStore((s) => s.patchAccount);
  const pausedUntil = usePausedUntil();
  const [choice, setChoice] = useState<PauseChoice | null>(null);
  const [custom, setCustom] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = useCallback(async (patch: AccountNotificationSettingsPatch) => {
    setSaving(true);
    setError("");
    const result = await patchAccount(patch);
    if (result.kind === "error") setError(formatMessage({ id: "settings.notifications.saveFailed" }));
    else if (result.kind === "conflict") setError(formatMessage({ id: "settings.notifications.saveConflict" }));
    setSaving(false);
    return result.kind === "ok";
  }, [formatMessage, patchAccount]);

  const pauseOptions = useMemo(() => [
    ...PAUSE_PRESETS.map((preset) => ({ value: preset as PauseChoice, label: formatMessage({ id: PRESET_LABEL[preset] }) })),
    { value: "custom" as PauseChoice, label: formatMessage({ id: "settings.notifications.pause.custom" }) },
  ], [formatMessage]);

  const handlePauseChoice = useCallback((value: unknown) => {
    const next = value as PauseChoice;
    if (next === "custom") {
      setChoice("custom");
      return;
    }
    setChoice(null);
    void save({ pausedUntil: pausedUntilForPreset(next, new Date()).toISOString() });
  }, [save]);

  const handleCustomChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setCustom(event.target.value), []);
  const customDate = useMemo(() => {
    const at = new Date(custom);
    return Number.isFinite(at.getTime()) && at.getTime() > Date.now() ? at : null;
  }, [custom]);
  const applyCustom = useCallback(() => {
    if (!customDate) return;
    void save({ pausedUntil: customDate.toISOString() }).then((ok) => { if (ok) setChoice(null); });
  }, [customDate, save]);
  const resume = useCallback(() => { void save({ pausedUntil: null }); }, [save]);

  const quiet = account?.quietHours;
  const zone = browserTimeZone();
  // Edits made while an earlier one is saving build on it, not on the stale
  // stored value (start, then end, in quick succession).
  const pendingQuiet = useRef<{ base: NotificationQuietHours; value: NotificationQuietHours } | null>(null);
  const saveQuiet = useCallback((next: Partial<NotificationQuietHours>) => {
    if (!quiet) return;
    const from = pendingQuiet.current?.base === quiet ? pendingQuiet.current.value : quiet;
    const value = { ...from, ...next, timeZone: zone };
    pendingQuiet.current = { base: quiet, value };
    void save({ quietHours: value });
  }, [quiet, save, zone]);
  const toggleQuiet = useCallback((checked: boolean) => saveQuiet({ enabled: checked }), [saveQuiet]);
  const commitStart = useCallback((minutes: number) => saveQuiet({ startMinute: minutes }), [saveQuiet]);
  const commitEnd = useCallback((minutes: number) => saveQuiet({ endMinute: minutes }), [saveQuiet]);

  const disabled = !account || saving;

  return (
    <div>
      <SectionHeader className="mb-3" icon={<Moon size={16} />} label={formatMessage({ id: "settings.notifications.pause.sectionLabel" })} />
      {error && <Banner intent="warning" density="sm" className="mb-3">{error}</Banner>}
      {/* Settings rows like every other setting (DS Forms › A setting's row; Jasper + cindyz,
          #triage:c95a5e53): the pause Select ends its row (under the text where the row is
          under 32rem wide; `fit` makes it as wide as its longest option, 11-20rem),
          and a custom time opens as a row of its own under it; quiet hours' Switch
          ends its row, and its times open as a row of their own under it. */}
      <ListRowGroup className="@container" data-testid="notification-pause-card">
        <ListRow id="pause-notifications" variant="plain" interactive={false} className="@max-lg:flex-wrap">
          <ListRowBody>
            <ListRowTitle id="notification-pause-label">{formatMessage({ id: "settings.notifications.pause.title" })}</ListRowTitle>
            {pausedUntil && (
              <ListRowDescription wrap data-testid="notification-paused-until">
                {formatMessage({ id: "settings.notifications.pause.pausedUntil" }, { until: formatShortDateTime(pausedUntil) })}
              </ListRowDescription>
            )}
          </ListRowBody>
          {!pausedUntil && (
            <div className="shrink-0 @max-lg:basis-full">
              <Select value={choice} onValueChange={handlePauseChoice} disabled={disabled} items={pauseOptions}>
                <SelectTrigger fit className="@max-lg:w-full @max-lg:max-w-sm" aria-labelledby="notification-pause-label" data-testid="notification-pause-select">
                  <SelectValue placeholder={formatMessage({ id: "settings.notifications.pause.off" })} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {pauseOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value} data-testid={`notification-pause-${option.value}`}>
                        <SelectItemText>{option.label}</SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                    ))}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
          )}
          {pausedUntil && (
            <Button variant="outline" size="md" type="button" className="shrink-0" onClick={resume} disabled={disabled} data-testid="notification-pause-resume">
              {formatMessage({ id: "settings.notifications.pause.resume" })}
            </Button>
          )}
        </ListRow>
        {/* A custom time: a row of its own under Pause (ListRow › attached), so the select
            keeps the end of Pause's row, at every width. */}
        {!pausedUntil && choice === "custom" && (
          <ListRow
            variant="plain"
            interactive={false}
            attached
            role="group"
            aria-labelledby="notification-pause-label"
            data-testid="notification-pause-custom-row"
          >
            <ListRowBody>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="datetime-local"
                  value={custom}
                  onChange={handleCustomChange}
                  className="w-full max-w-60"
                  aria-label={formatMessage({ id: "settings.notifications.pause.customLabel" })}
                  data-testid="notification-pause-custom-input"
                />
                <Button variant="outline" size="md" type="button" onClick={applyCustom} disabled={disabled || !customDate} data-testid="notification-pause-custom-apply">
                  {formatMessage({ id: "settings.notifications.pause.apply" })}
                </Button>
              </div>
            </ListRowBody>
          </ListRow>
        )}
        <ListRow id="quiet-hours" variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id="notification-quiet-hours-label">{formatMessage({ id: "settings.notifications.quiet.title" })}</ListRowTitle>
            <ListRowDescription wrap>
              {formatMessage({ id: "settings.notifications.quiet.description" }, { timeZone: zone })}
            </ListRowDescription>
          </ListRowBody>
          <Switch
            checked={quiet?.enabled === true}
            disabled={disabled}
            onCheckedChange={toggleQuiet}
            aria-labelledby="notification-quiet-hours-label"
            data-testid="notification-quiet-hours-switch"
          />
        </ListRow>
        {/* The times quiet hours opens: a row of their own under it, so its switch stays
            centered on its own title and description (DS Forms › A setting's row). The row
            belongs to Quiet hours (ListRow › attached): no hairline above it, and a group
            named by Quiet hours' title, since only sight would tie it there otherwise. */}
        {quiet?.enabled && (
          <ListRow
            variant="plain"
            interactive={false}
            attached
            role="group"
            aria-labelledby="notification-quiet-hours-label"
            data-testid="notification-quiet-hours-times"
          >
            <ListRowBody>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-footnote text-foreground-muted">
                  {formatMessage({ id: "settings.notifications.quiet.from" })}
                  <QuietTimeInput minutes={quiet.startMinute} onCommit={commitStart} disabled={!account} testId="notification-quiet-hours-start" />
                </label>
                <label className="flex items-center gap-2 text-footnote text-foreground-muted">
                  {formatMessage({ id: "settings.notifications.quiet.to" })}
                  <QuietTimeInput minutes={quiet.endMinute} onCommit={commitEnd} disabled={!account} testId="notification-quiet-hours-end" />
                </label>
              </div>
              {quiet.timeZone !== zone && (
                <ListRowDescription wrap>
                  {formatMessage({ id: "settings.notifications.quiet.storedZone" }, { timeZone: quiet.timeZone })}
                </ListRowDescription>
              )}
            </ListRowBody>
          </ListRow>
        )}
      </ListRowGroup>
    </div>
  );
}
