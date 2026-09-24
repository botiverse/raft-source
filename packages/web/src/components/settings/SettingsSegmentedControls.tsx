import { PRO_PACK_ANNUAL_DISCOUNT_PERCENT } from "@botiverse/raft-shared";
import type { BillingInterval } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { SegmentedControl, SegmentedControlCount, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
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

export type ConnectedAppsTabOption = {
  value: ConnectedAppsTab;
  label: string;
  count: number;
  testId: string;
};

export function BillingIntervalSegmentedControl({
  value,
  disabled,
  onValueChange,
}: {
  value: BillingInterval;
  disabled?: boolean;
  onValueChange: (value: BillingInterval) => void;
}) {
  const { formatMessage } = useIntl();
  const billingIntervalOptions = [
    { value: "monthly" as const, label: formatMessage({ id: "billing.monthly" }), testId: "billing-interval-monthly" },
    {
      value: "annual" as const,
      label: (
        <span className="inline-flex items-center gap-1.5">
          <span>{formatMessage({ id: "billing.yearly" })}</span>
          <span className="whitespace-nowrap text-[10px] font-mono font-bold uppercase text-black/60">{formatMessage({ id: "billing.saveAnnualPercent" }, { percent: PRO_PACK_ANNUAL_DISCOUNT_PERCENT })}</span>
        </span>
      ),
      testId: "billing-interval-annual",
    },
  ];

  return (
    <SegmentedControl<BillingInterval>
      value={value}
      aria-label={formatMessage({ id: "billing.billingInterval" })}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      {billingIntervalOptions.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          data-testid={option.testId}
        >
          <SegmentedControlLabel>{option.label}</SegmentedControlLabel>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

export function ConnectedAppsTabSegmentedControl({
  value,
  options,
  onValueChange,
  className,
}: {
  value: ConnectedAppsTab;
  options: ConnectedAppsTabOption[];
  onValueChange: (value: ConnectedAppsTab) => void;
  className?: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <SegmentedControl<ConnectedAppsTab>
      value={value}
      aria-label={formatMessage({ id: "settings.connectedApps.viewAria" })}
      onValueChange={onValueChange}
      className={className}
    >
      {options.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          data-testid={option.testId}
        >
          <SegmentedControlLabel>{option.label}</SegmentedControlLabel>
          {option.count > 0 ? (
            <SegmentedControlCount>{option.count}</SegmentedControlCount>
          ) : null}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

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
