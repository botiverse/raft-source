import { useIntl } from "react-intl";
import { SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "@botiverse/raft-ui";
import { MESSAGE_BODY_FONT_SIZE_OPTIONS } from "../../store/appearanceStore";
import type { MessageBodyFontSize } from "../../store/appearanceStore";
import type { MessageId } from "../../i18n/messages/en";

/** Font-size value -> catalog id (the store no longer holds display text). */
export const MESSAGE_FONT_SIZE_LABEL_ID: Record<MessageBodyFontSize, MessageId> = {
  sm: "settings.appearance.fontSizeSmall",
  md: "settings.appearance.fontSizeMedium",
  lg: "settings.appearance.fontSizeLarge",
};

export type ConnectedAppsTab = "marketplace" | "installed" | "myapps";

export function MessageBodyFontSizeSegmentedControl({
  value,
  disabled,
  onValueChange,
}: {
  value: MessageBodyFontSize;
  disabled?: boolean;
  onValueChange: (value: MessageBodyFontSize) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <SegmentedControl
      value={value}
      aria-label={formatMessage({ id: "settings.appearance.fontSizeAria" })}
      disabled={disabled}
      onValueChange={onValueChange}
    >
      {MESSAGE_BODY_FONT_SIZE_OPTIONS.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          data-testid={`message-font-size-${option.value}`}
        >
          <SegmentedControlLabel>{formatMessage({ id: MESSAGE_FONT_SIZE_LABEL_ID[option.value] })}</SegmentedControlLabel>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
