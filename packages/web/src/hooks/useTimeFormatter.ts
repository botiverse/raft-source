import { useMemo } from "react";
import { useIntl } from "react-intl";
import { useTranslationStore } from "../store/translationStore";
import {
  formatClock,
  formatClock24,
  formatClockWithSeconds,
  formatMediumDateTime,
  formatMediumDateTime24,
  formatMessageTime,
  formatShortDateTime,
} from "../utils/timeFormatting";
import type {
  TimeFormatOptions,
} from "../utils/timeFormatting";

export function useTimeFormatter() {
  const { formatMessage, locale } = useIntl();
  const effectiveTimezone = useTranslationStore((state) => state.settings.effectiveTimezone);
  const effectiveTimeFormat = useTranslationStore((state) => state.settings.effectiveTimeFormat);

  return useMemo(() => {
    const base: TimeFormatOptions = {
      timeZone: effectiveTimezone,
      timeFormat: effectiveTimeFormat,
      locale,
      yesterdayLabel: formatMessage({ id: "message.dateDivider.yesterday" }),
    };

    return {
      options: base,
      formatClock: (value: Date | string | number | null | undefined) => formatClock(value, base),
      formatClock24: (value: Date | string | number | null | undefined) => formatClock24(value, base),
      formatClockWithSeconds: (value: Date | string | number | null | undefined) => formatClockWithSeconds(value, base),
      formatMediumDateTime24: (value: Date | string | number | null | undefined) => formatMediumDateTime24(value, base),
      formatMessageTime: (value: Date | string | number | null | undefined) => formatMessageTime(value, base),
      formatShortDateTime: (value: Date | string | number | null | undefined) => formatShortDateTime(value, base),
      formatMediumDateTime: (value: Date | string | number | null | undefined) => formatMediumDateTime(value, base),
    };
  }, [effectiveTimeFormat, effectiveTimezone, formatMessage, locale]);
}
